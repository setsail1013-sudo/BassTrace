import json
import logging
import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import accounts, storage
from backend.accounts import SESSION_COOKIE, SESSION_TTL_SECONDS
from backend.main import app
from backend.models import Analysis, Project


PROJECT_ID = "516978a1-4465-4d0e-8676-5b0b5bc0eb44"
PASSWORD = "correct-horse-1"
OTHER_PASSWORD = "another-secret-9"
PUBLIC_FIELDS = {"id", "username", "role", "disabled", "createdAt", "updatedAt"}
MARKER = "自动贝斯音名尚未验收-UNIQUE"


class _Collector(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.messages = []

    def emit(self, record):
        if record.name.startswith(("httpx", "httpcore", "urllib3", "asyncio")):
            return
        self.messages.append(record.getMessage())
        if record.args:
            self.messages.append(repr(record.args))


@contextmanager
def captured_logs():
    handler = _Collector()
    root = logging.getLogger()
    previous = root.level
    root.setLevel(logging.DEBUG)
    root.addHandler(handler)
    try:
        yield handler
    finally:
        root.removeHandler(handler)
        root.setLevel(previous)


class LocalAccountTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(storage, "DATA_ROOT", Path(self.temporary.name))
        self.root_patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.root_patch.stop()
        self.temporary.cleanup()

    def store_text(self):
        return (storage.DATA_ROOT / "accounts.json").read_text(encoding="utf-8")

    def store_data(self):
        return json.loads(self.store_text())

    def assert_session_cookie(self, response):
        header = response.headers.get("set-cookie", "")
        lowered = header.lower()
        self.assertIn(SESSION_COOKIE, lowered)
        self.assertIn("httponly", lowered)
        self.assertIn("samesite=lax", lowered)
        self.assertIn("path=/", lowered)
        self.assertIn(f"max-age={SESSION_TTL_SECONDS}", lowered)
        self.assertNotIn("domain=", lowered)
        self.assertNotIn("; secure", lowered)
        token = response.cookies.get(SESSION_COOKIE)
        self.assertTrue(token)
        self.assertNotIn(token, response.text)
        return token

    def test_validation_messages_do_not_echo_passwords(self):
        cases = [
            ({"username": "   ", "password": "short-secret"}, 422, "用户名不能为空"),
            ({"username": "ok name", "password": "long-enough-1"}, 422, "用户名不能包含空格或控制字符"),
            ({"username": "bad\nname", "password": "long-enough-1"}, 422, "用户名不能包含空格或控制字符"),
            ({"username": "a/b", "password": "long-enough-1"}, 422, "用户名不能包含斜杠或冒号"),
            ({"username": "a" * 33, "password": "long-enough-1"}, 422, "用户名不能超过 32 个字符"),
            ({"username": "player", "password": "short"}, 422, "密码至少需要 8 个字符"),
            ({"username": "player", "password": "p" * 129}, 422, "密码不能超过 128 个字符"),
            ({"username": "player", "password": "bad\x00secret"}, 422, "密码包含无法保存的字符"),
            ({"username": "player"}, 422, "请提供用户名和密码"),
            ({"password": "long-enough-1"}, 422, "请提供用户名和密码"),
            ({"username": 1, "password": "long-enough-1"}, 422, "请提供用户名和密码"),
            ({"username": "player", "password": 12345678}, 422, "请提供用户名和密码"),
        ]
        for payload, status, detail in cases:
            with self.subTest(detail=detail, payload=payload):
                secret = payload.get("password")
                with captured_logs() as logs:
                    response = self.client.post("/api/auth/register", json=payload)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()["detail"], detail)
                if isinstance(secret, str) and secret:
                    self.assertNotIn(secret, response.text)
                    self.assertNotIn(secret, "\n".join(logs.messages))
        self.assertFalse((storage.DATA_ROOT / "accounts.json").exists())
        empty = self.client.post("/api/auth/login", content=b"", headers={"content-type": "application/json"})
        self.assertEqual(empty.status_code, 422)
        self.assertEqual(empty.json()["detail"], "请提供用户名和密码")
        array = self.client.post("/api/auth/register", content=b"[]", headers={"content-type": "application/json"})
        self.assertEqual(array.status_code, 422)
        self.assertEqual(array.json()["detail"], "请提供用户名和密码")
        huge_password = "x" * 9000
        huge = self.client.post("/api/auth/register", json={"username": "player", "password": huge_password})
        self.assertEqual(huge.status_code, 422)
        self.assertEqual(huge.json()["detail"], "请求内容过大")
        self.assertNotIn(huge_password, huge.text)
        foreign = self.client.post(
            "/api/auth/register",
            json={"username": "player", "password": PASSWORD},
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(foreign.status_code, 403)
        self.assertEqual(foreign.json()["detail"], "仅允许本机页面提交账号操作")
        self.assertNotIn(PASSWORD, foreign.text)
        referred = self.client.post(
            "/api/auth/login",
            json={"username": "player", "password": PASSWORD},
            headers={"Referer": "https://evil.example/phish"},
        )
        self.assertEqual(referred.status_code, 403)
        self.assertEqual(referred.json()["detail"], "仅允许本机页面提交账号操作")
        self.assertFalse((storage.DATA_ROOT / "accounts.json").exists())

    def test_register_login_logout_and_session(self):
        unknown = TestClient(app)
        try:
            with captured_logs() as logs:
                missing = unknown.post("/api/auth/login", json={"username": "ghost", "password": "missing-pass-1"})
            self.assertEqual(missing.status_code, 401)
            self.assertEqual(missing.json()["detail"], "用户名或密码不正确")
            self.assertNotIn("missing-pass-1", missing.text)
            self.assertNotIn("missing-pass-1", "\n".join(logs.messages))
            self.assertNotIn(SESSION_COOKIE, missing.cookies)
        finally:
            unknown.close()

        with captured_logs() as logs:
            created = self.client.post(
                "/api/auth/register",
                json={"username": "  Bass  ", "password": PASSWORD, "role": "admin"},
                headers={"Origin": "http://127.0.0.1:5173"},
            )
        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(created.json()["user"]["username"], "Bass")
        self.assertEqual(created.json()["user"]["role"], "admin")
        self.assertIs(created.json()["user"]["disabled"], False)
        self.assertEqual(set(created.json()["user"]), PUBLIC_FIELDS)
        self.assertNotIn(PASSWORD, created.text)
        self.assertNotIn("passwordHash", created.text)
        self.assertNotIn("pbkdf2", created.text)
        self.assertNotIn(PASSWORD, "\n".join(logs.messages))
        self.assertEqual(created.headers.get("cache-control"), "no-store")
        token = self.assert_session_cookie(created)
        raw = self.store_text()
        self.assertNotIn(PASSWORD, raw)
        self.assertNotIn(token, raw)
        stored = self.store_data()["users"][0]
        self.assertTrue(stored["passwordHash"].startswith(f"pbkdf2_sha256${accounts.PBKDF2_ITERATIONS}$"))
        self.assertIn(accounts.token_hash(token), raw)
        self.assertTrue(accounts.verify_password(PASSWORD, stored["passwordHash"]))
        self.assertFalse(accounts.verify_password(OTHER_PASSWORD, stored["passwordHash"]))
        self.assertFalse(accounts.verify_password(PASSWORD, PASSWORD))
        if os.name == "posix":
            self.assertEqual((storage.DATA_ROOT / "accounts.json").stat().st_mode & 0o777, 0o600)

        me = self.client.get("/api/auth/me")
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual(me.json()["user"]["id"], created.json()["user"]["id"])
        anonymous = TestClient(app)
        try:
            signed_out = anonymous.get("/api/auth/me")
            self.assertEqual(signed_out.status_code, 401)
            self.assertEqual(signed_out.json()["detail"], "尚未登录")
        finally:
            anonymous.close()

        duplicate = self.client.post("/api/auth/register", json={"username": "bass", "password": OTHER_PASSWORD})
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(duplicate.json()["detail"], "该用户名已被使用")
        self.assertNotIn(OTHER_PASSWORD, duplicate.text)
        self.assertNotIn(OTHER_PASSWORD, self.store_text())
        self.assertEqual(len(self.store_data()["users"]), 1)
        folded = self.client.post(
            "/api/auth/register",
            json={"username": "Ｂass", "password": OTHER_PASSWORD},
            headers={"Origin": "http://localhost:8000"},
        )
        self.assertEqual(folded.status_code, 409)
        self.assertEqual(folded.json()["detail"], "该用户名已被使用")

        wrong = self.client.post("/api/auth/login", json={"username": "Bass", "password": OTHER_PASSWORD})
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(wrong.json()["detail"], "用户名或密码不正确")
        self.assertNotIn(OTHER_PASSWORD, wrong.text)
        self.assertEqual(self.store_data()["users"][0]["passwordHash"], stored["passwordHash"])
        self.assertEqual(self.client.get("/api/auth/me").json()["user"]["username"], "Bass")

        other = TestClient(app)
        try:
            other.cookies.set(SESSION_COOKIE, token)
            self.assertEqual(other.get("/api/auth/me").status_code, 200)
            blocked = self.client.post("/api/auth/logout", headers={"Origin": "https://evil.example"})
            self.assertEqual(blocked.status_code, 403)
            self.assertEqual(self.client.get("/api/auth/me").status_code, 200)
            logged_out = self.client.post("/api/auth/logout")
            self.assertEqual(logged_out.status_code, 204)
            self.assertEqual(logged_out.content, b"")
            cleared = logged_out.headers.get("set-cookie", "").lower()
            self.assertIn(SESSION_COOKIE, cleared)
            self.assertIn("max-age=0", cleared)
            self.assertIn("httponly", cleared)
            self.assertNotIn("; secure", cleared)
            self.assertEqual(self.client.get("/api/auth/me").status_code, 401)
            self.assertEqual(self.client.get("/api/auth/me").json()["detail"], "尚未登录")
            revoked = other.get("/api/auth/me")
            self.assertEqual(revoked.status_code, 401)
            self.assertEqual(revoked.json()["detail"], "尚未登录")
        finally:
            other.close()

        again = self.client.post(
            "/api/auth/login",
            json={"username": "  bass  ", "password": PASSWORD},
            headers={"Origin": "http://localhost:5173"},
        )
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json()["user"]["role"], "admin")
        self.assertNotIn(PASSWORD, again.text)
        self.assert_session_cookie(again)
        self.assertEqual(self.store_data()["users"][0]["passwordHash"], stored["passwordHash"])

        data = self.store_data()
        data["sessions"][0]["expiresAt"] = "2000-01-01T00:00:00+00:00"
        path = storage.DATA_ROOT / "accounts.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        expired = self.client.get("/api/auth/me")
        self.assertEqual(expired.status_code, 401)
        self.assertEqual(expired.json()["detail"], "尚未登录")
        self.assertEqual(self.store_data()["sessions"], [])
        signed_out_logout = self.client.post("/api/auth/logout")
        self.assertEqual(signed_out_logout.status_code, 401)
        self.assertEqual(signed_out_logout.json()["detail"], "尚未登录")

    def test_admin_manages_role_and_disabled_state(self):
        admin = self.client
        user = TestClient(app)
        fresh = TestClient(app)
        try:
            created = admin.post("/api/auth/register", json={"username": "alice", "password": PASSWORD})
            self.assertEqual(created.status_code, 201, created.text)
            second = user.post(
                "/api/auth/register",
                json={"username": "bob", "password": OTHER_PASSWORD, "role": "admin", "disabled": True},
            )
            self.assertEqual(second.status_code, 201, second.text)
            self.assertEqual(second.json()["user"]["role"], "user")
            self.assertIs(second.json()["user"]["disabled"], False)
            salts = [row["passwordHash"].split("$")[2] for row in self.store_data()["users"]]
            self.assertEqual(len(set(salts)), 2)
            hashes = [row["passwordHash"] for row in self.store_data()["users"]]

            outsider = admin.get("/api/admin/users")
            self.assertEqual(outsider.status_code, 200, outsider.text)
            self.assertEqual([row["username"] for row in outsider.json()["users"]], ["alice", "bob"])
            for row in outsider.json()["users"]:
                self.assertEqual(set(row), PUBLIC_FIELDS)
            self.assertNotIn(PASSWORD, outsider.text)
            self.assertNotIn(OTHER_PASSWORD, outsider.text)
            self.assertNotIn("passwordHash", outsider.text)
            forbidden = user.get("/api/admin/users")
            self.assertEqual(forbidden.status_code, 403)
            self.assertEqual(forbidden.json()["detail"], "需要管理员权限")
            anonymous = fresh.get("/api/admin/users")
            self.assertEqual(anonymous.status_code, 401)
            self.assertEqual(anonymous.json()["detail"], "尚未登录")
            anonymous_patch = fresh.patch(f"/api/admin/users/{created.json()['user']['id']}", json={"disabled": True})
            self.assertEqual(anonymous_patch.status_code, 401)
            self.assertEqual(anonymous_patch.json()["detail"], "尚未登录")
            user_patch = user.patch(f"/api/admin/users/{second.json()['user']['id']}", json={"role": "admin"})
            self.assertEqual(user_patch.status_code, 403)
            self.assertEqual(user_patch.json()["detail"], "需要管理员权限")
            self.assertEqual(user.get("/api/auth/me").json()["user"]["role"], "user")

            missing = admin.patch("/api/admin/users/not-a-user", json={"disabled": True})
            self.assertEqual(missing.status_code, 404)
            self.assertEqual(missing.json()["detail"], "找不到该账号")
            empty = admin.patch(f"/api/admin/users/{second.json()['user']['id']}", json={})
            self.assertEqual(empty.status_code, 422)
            self.assertEqual(empty.json()["detail"], "请指定要修改的角色或停用状态")
            bad_role = admin.patch(f"/api/admin/users/{second.json()['user']['id']}", json={"role": "owner"})
            self.assertEqual(bad_role.status_code, 422)
            self.assertEqual(bad_role.json()["detail"], "角色只能是 admin 或 user")
            bad_flag = admin.patch(f"/api/admin/users/{second.json()['user']['id']}", json={"disabled": "true"})
            self.assertEqual(bad_flag.status_code, 422)
            self.assertEqual(bad_flag.json()["detail"], "停用状态必须是 true 或 false")
            password_field = "replacement-password-1"
            rejected = admin.patch(
                f"/api/admin/users/{second.json()['user']['id']}",
                json={"disabled": True, "password": password_field},
            )
            self.assertEqual(rejected.status_code, 422)
            self.assertEqual(rejected.json()["detail"], "只能修改角色或停用状态")
            self.assertNotIn(password_field, rejected.text)
            self.assertEqual([row["passwordHash"] for row in self.store_data()["users"]], hashes)
            self.assertIs(user.get("/api/auth/me").json()["user"]["disabled"], False)
            not_json = admin.patch(f"/api/admin/users/{second.json()['user']['id']}", content=b"null")
            self.assertEqual(not_json.status_code, 422)
            self.assertEqual(not_json.json()["detail"], "请求体必须是 JSON 对象")

            demote_self = admin.patch(f"/api/admin/users/{created.json()['user']['id']}", json={"role": "user"})
            self.assertEqual(demote_self.status_code, 409)
            self.assertEqual(demote_self.json()["detail"], "至少需要保留一名可用的管理员")
            disable_self = admin.patch(f"/api/admin/users/{created.json()['user']['id']}", json={"disabled": True})
            self.assertEqual(disable_self.status_code, 409)
            self.assertEqual(disable_self.json()["detail"], "不能停用当前登录的账号")
            self.assertEqual(admin.get("/api/auth/me").json()["user"]["role"], "admin")

            foreign = admin.patch(
                f"/api/admin/users/{second.json()['user']['id']}",
                json={"role": "admin"},
                headers={"Origin": "https://evil.example"},
            )
            self.assertEqual(foreign.status_code, 403)
            self.assertEqual(foreign.json()["detail"], "仅允许本机页面提交账号操作")
            self.assertEqual(user.get("/api/auth/me").json()["user"]["role"], "user")

            disabled = admin.patch(f"/api/admin/users/{second.json()['user']['id']}", json={"disabled": True})
            self.assertEqual(disabled.status_code, 200, disabled.text)
            self.assertIs(disabled.json()["user"]["disabled"], True)
            self.assertNotIn(OTHER_PASSWORD, disabled.text)
            self.assertEqual([row["passwordHash"] for row in self.store_data()["users"]], hashes)
            stopped = user.get("/api/auth/me")
            self.assertEqual(stopped.status_code, 403)
            self.assertEqual(stopped.json()["detail"], "账号已停用，请联系本机管理员")
            self.assertEqual(user.get("/api/auth/me").status_code, 401)
            wrong = fresh.post("/api/auth/login", json={"username": "bob", "password": PASSWORD})
            self.assertEqual(wrong.status_code, 401)
            self.assertEqual(wrong.json()["detail"], "用户名或密码不正确")
            blocked_login = fresh.post("/api/auth/login", json={"username": "bob", "password": OTHER_PASSWORD})
            self.assertEqual(blocked_login.status_code, 403)
            self.assertEqual(blocked_login.json()["detail"], "账号已停用，请联系本机管理员")
            self.assertNotIn(OTHER_PASSWORD, blocked_login.text)
            self.assertNotIn(SESSION_COOKIE, blocked_login.cookies)

            enabled = admin.patch(f"/api/admin/users/{second.json()['user']['id']}", json={"disabled": False, "role": "admin"})
            self.assertEqual(enabled.status_code, 200, enabled.text)
            self.assertEqual(enabled.json()["user"]["role"], "admin")
            self.assertIs(enabled.json()["user"]["disabled"], False)
            restored = fresh.post("/api/auth/login", json={"username": "bob", "password": OTHER_PASSWORD})
            self.assertEqual(restored.status_code, 200, restored.text)
            self.assertEqual(fresh.get("/api/admin/users").status_code, 200)

            listed = admin.get("/api/admin/users")
            self.assertEqual([row["username"] for row in listed.json()["users"]], ["alice", "bob"])
            self.assertNotIn(MARKER, listed.text)
            stepped_down = admin.patch(f"/api/admin/users/{created.json()['user']['id']}", json={"role": "user"})
            self.assertEqual(stepped_down.status_code, 200, stepped_down.text)
            self.assertEqual(stepped_down.json()["user"]["role"], "user")
            self.assertEqual(admin.get("/api/admin/users").status_code, 403)
            self.assertEqual(fresh.get("/api/admin/users").status_code, 200)
            last = fresh.patch(f"/api/admin/users/{second.json()['user']['id']}", json={"role": "user"})
            self.assertEqual(last.status_code, 409)
            self.assertEqual(last.json()["detail"], "至少需要保留一名可用的管理员")
            self.assertEqual(fresh.get("/api/auth/me").json()["user"]["role"], "admin")
        finally:
            user.close()
            fresh.close()

    def test_library_stays_shared_and_usable_without_a_session(self):
        project = Project(
            id=PROJECT_ID,
            title="共享曲库",
            duration=12,
            analysis=Analysis(state="complete", stage="候选分析完成，请试听校正", warnings=[MARKER]),
        )
        storage.save(project)
        project_file = storage.project_dir(project.id) / "project.json"

        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["status"], "ok")
        listed = self.client.get("/api/projects")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual([item["id"] for item in listed.json()], [project.id])
        opened = self.client.get(f"/api/projects/{project.id}")
        self.assertEqual(opened.status_code, 200)
        self.assertEqual(opened.json()["title"], "共享曲库")
        payload = opened.json()
        payload["title"] = "未登录也可保存"
        saved = self.client.put(f"/api/projects/{project.id}", json=payload)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["title"], "未登录也可保存")
        self.assertEqual(saved.json()["revision"], 2)
        self.assertEqual(self.client.get("/api/playlists").status_code, 200)
        created_playlist = self.client.post("/api/playlists", json={"name": "排练", "projectIds": [project.id]})
        self.assertEqual(created_playlist.status_code, 201, created_playlist.text)
        self.assertEqual(self.client.get("/api/folders").status_code, 200)
        self.assertEqual(self.client.get("/api/trash").status_code, 200)
        exported = self.client.post("/api/library/exports", json={})
        self.assertEqual(exported.status_code, 422)
        self.assertIn("音频", exported.json()["detail"])
        self.assertNotIn("尚未登录", exported.text)
        with patch("backend.main.render_pdf", return_value=b"%PDF-1.4\n") as render:
            pdf = self.client.post(f"/api/projects/{project.id}/export/pdf", json={"project": saved.json()})
        self.assertEqual(pdf.status_code, 200, pdf.text)
        self.assertIn("application/pdf", pdf.headers["content-type"])
        render.assert_called_once()
        before_accounts = project_file.read_bytes()

        admin = TestClient(app)
        user = TestClient(app)
        try:
            self.assertEqual(admin.post("/api/auth/register", json={"username": "alice", "password": PASSWORD}).status_code, 201)
            self.assertEqual(user.post("/api/auth/register", json={"username": "bob", "password": OTHER_PASSWORD}).status_code, 201)
            self.assertEqual(project_file.read_bytes(), before_accounts)
            self.assertNotIn("alice", project_file.read_text(encoding="utf-8"))
            self.assertNotIn("passwordHash", project_file.read_text(encoding="utf-8"))
            for client in (self.client, admin, user):
                rows = client.get("/api/projects")
                self.assertEqual(rows.status_code, 200)
                self.assertEqual([item["id"] for item in rows.json()], [project.id])
                self.assertEqual(client.get(f"/api/projects/{project.id}").json()["title"], "未登录也可保存")
            admin_list = admin.get("/api/admin/users")
            self.assertEqual(admin_list.status_code, 200)
            self.assertNotIn(MARKER, admin_list.text)
            self.assertNotIn("共享曲库", admin_list.text)
            self.assertNotIn("候选", admin_list.text)
            connection = sqlite3.connect(storage.index_path())
            try:
                tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            finally:
                connection.close()
            self.assertIn("projects", tables)
            self.assertNotIn("users", tables)
            self.assertNotIn("sessions", tables)
        finally:
            admin.close()
            user.close()

        self.client.cookies.set(SESSION_COOKIE, "not-a-real-session")
        self.assertEqual(self.client.get("/api/projects").status_code, 200)
        self.assertEqual([item["id"] for item in self.client.get("/api/projects").json()], [project.id])
        rejected = self.client.get("/api/auth/me")
        self.assertEqual(rejected.status_code, 401)
        self.assertEqual(rejected.json()["detail"], "尚未登录")
        self.assertEqual(self.client.get("/api/playlists").status_code, 200)

    def test_corrupt_account_store_does_not_block_the_library(self):
        project = Project(id=PROJECT_ID, title="仍然可打开", duration=8)
        storage.save(project)
        secret = "plaintext-should-not-leak"
        path = storage.DATA_ROOT / "accounts.json"
        path.write_text(secret, encoding="utf-8")
        self.client.cookies.set(SESSION_COOKIE, "stale-token")
        with captured_logs() as logs:
            response = self.client.get("/api/auth/me")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "本机账号数据无法读取")
        self.assertNotIn(secret, response.text)
        self.assertNotIn(secret, "\n".join(logs.messages))
        self.assertEqual(self.client.get(f"/api/projects/{project.id}").status_code, 200)
        self.assertEqual(self.client.get("/api/projects").json()[0]["title"], "仍然可打开")
        path.write_text(json.dumps({"version": 2, "users": [], "sessions": []}), encoding="utf-8")
        version = self.client.get("/api/auth/me")
        self.assertEqual(version.status_code, 500)
        self.assertEqual(version.json()["detail"], "本机账号数据版本无法识别")
        self.assertEqual(self.client.get("/api/folders").status_code, 200)
