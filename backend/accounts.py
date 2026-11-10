"""Optional local accounts for the loopback BassTrace service.

Accounts are identities on this computer. They do not partition or hide the
shared song library: ``project.json`` and the SQLite index stay the source of
truth. Every existing library route keeps working with no signed-in user.

The first account written to an empty local store becomes the admin. There is
no cloud identity provider and no default password. If the last admin is lost,
stop the server and delete ``accounts.json`` in the local project data
directory (``backend/data/projects/accounts.json``), then register again.
Songs are left untouched.

Passwords are stored as PBKDF2-HMAC-SHA256 with a random salt. This module
never returns them, never writes them in plaintext, and does not log them.
Session cookies are httpOnly and meant for http://127.0.0.1 (or localhost)
on the same machine. Account payloads are identity records only; they do not
carry bass-note or lyric-recognition output and must not be read as accepted
accuracy.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import NoReturn
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from . import storage
from .models import utc_now

SESSION_COOKIE = "basstrace_session"
SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
PBKDF2_ITERATIONS = 600_000
MAX_BODY_BYTES = 8 * 1024
_HASH_SCHEME = "pbkdf2_sha256"
_STORE_NAME = "accounts.json"
_PUBLIC_FIELDS = ("id", "username", "role", "disabled", "createdAt", "updatedAt")
_LOCAL_ORIGIN = re.compile(r"https?://(localhost|127\.0\.0\.1)(:\d+)?\Z", re.IGNORECASE)
_DUMMY_LOCK = threading.Lock()
_DUMMY_HASH: str | None = None

router = APIRouter(tags=["local-accounts"])


class AccountHTTPError(Exception):
    def __init__(self, status_code: int, detail: str, *, clear_session: bool = False) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.clear_session = clear_session


def fail(status_code: int, detail: str, *, clear_session: bool = False) -> NoReturn:
    # ``from None`` drops chained JSON or file errors so a password or store
    # snippet cannot ride along in a traceback context.
    raise AccountHTTPError(status_code, detail, clear_session=clear_session) from None


def account_http_error(_request: Request, exc: AccountHTTPError) -> JSONResponse:
    response = JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    response.headers["Cache-Control"] = "no-store"
    if exc.clear_session:
        clear_session_cookie(response)
    return response


def store_path():
    return storage.DATA_ROOT / _STORE_NAME


def hash_password(password: str, *, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "$".join((
        _HASH_SCHEME,
        str(iterations),
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    ))


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iteration_text, salt_b64, digest_b64 = stored.split("$")
        iterations = int(iteration_text)
        salt = base64.b64decode(salt_b64, validate=True)
        expected = base64.b64decode(digest_b64, validate=True)
    except (ValueError, TypeError):
        return False
    if scheme != _HASH_SCHEME or not 100_000 <= iterations <= 1_000_000:
        return False
    if not 16 <= len(salt) <= 64 or len(expected) != 32:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(digest, expected)


def dummy_hash() -> str:
    global _DUMMY_HASH
    with _DUMMY_LOCK:
        if _DUMMY_HASH is None:
            _DUMMY_HASH = hash_password("local-account-timing-pad")
        return _DUMMY_HASH


def password_matches(password: str, stored: str | None) -> bool:
    if stored is None:
        verify_password(password, dummy_hash())
        return False
    return verify_password(password, stored)


def public_user(user: dict) -> dict:
    return {field: user[field] for field in _PUBLIC_FIELDS}


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_TTL_SECONDS,
        path="/",
        secure=False,
        httponly=True,
        samesite="lax",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", secure=False, httponly=True, samesite="lax")


def private_json(body: dict, status_code: int = 200) -> JSONResponse:
    response = JSONResponse(body, status_code=status_code)
    response.headers["Cache-Control"] = "no-store"
    return response


def assert_local_request(request: Request) -> None:
    """Reject cross-site browser posts. Loopback pages and non-browser clients stay allowed."""
    origin = request.headers.get("origin")
    if origin is not None:
        if not _LOCAL_ORIGIN.fullmatch(origin.strip()):
            fail(403, "仅允许本机页面提交账号操作")
        return
    referer = request.headers.get("referer")
    if not referer:
        return
    parts = urlsplit(referer.strip())
    if not _LOCAL_ORIGIN.fullmatch(f"{parts.scheme}://{parts.netloc}"):
        fail(403, "仅允许本机页面提交账号操作")


def normalize_username(value: object) -> str:
    if not isinstance(value, str):
        fail(422, "请提供用户名和密码")
    cleaned = unicodedata.normalize("NFKC", value).strip()
    if not cleaned:
        fail(422, "用户名不能为空")
    if len(cleaned) > 32:
        fail(422, "用户名不能超过 32 个字符")
    if any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in cleaned):
        fail(422, "用户名不能包含空格或控制字符")
    if any(char in "/\\:" for char in cleaned):
        fail(422, "用户名不能包含斜杠或冒号")
    return cleaned


def validate_password(value: object) -> str:
    if not isinstance(value, str):
        fail(422, "请提供用户名和密码")
    if len(value) < 8:
        fail(422, "密码至少需要 8 个字符")
    if len(value) > 128:
        fail(422, "密码不能超过 128 个字符")
    if "\x00" in value:
        fail(422, "密码包含无法保存的字符")
    return value


async def read_object(request: Request) -> dict:
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        fail(422, "请求内容过大")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail(422, "请求体不是有效的 JSON")
    if not isinstance(data, dict):
        fail(422, "请求体必须是 JSON 对象")
    return data


async def read_credentials(request: Request) -> tuple[str, str]:
    try:
        data = await read_object(request)
    except AccountHTTPError as exc:
        if exc.detail == "请求内容过大":
            raise
        fail(422, "请提供用户名和密码")
    if "username" not in data or "password" not in data:
        fail(422, "请提供用户名和密码")
    return normalize_username(data["username"]), validate_password(data["password"])


def parse_account_update(payload: dict) -> tuple[str | None, bool | None]:
    unknown = set(payload) - {"role", "disabled"}
    if unknown:
        fail(422, "只能修改角色或停用状态")
    if "role" not in payload and "disabled" not in payload:
        fail(422, "请指定要修改的角色或停用状态")
    role = payload.get("role")
    disabled = payload.get("disabled")
    if "role" in payload and role not in ("admin", "user"):
        fail(422, "角色只能是 admin 或 user")
    if "disabled" in payload and not isinstance(disabled, bool):
        fail(422, "停用状态必须是 true 或 false")
    return (role if "role" in payload else None), (disabled if "disabled" in payload else None)


def load_store() -> tuple[list[dict], list[dict]]:
    """Caller must hold ``storage.LOCK`` before a later ``save_store``."""
    path = store_path()
    if not path.is_file():
        return [], []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail(500, "本机账号数据无法读取")
    if not isinstance(data, dict):
        fail(500, "本机账号数据无法读取")
    if data.get("version", 1) != 1:
        fail(500, "本机账号数据版本无法识别")
    users = data.get("users", [])
    sessions = data.get("sessions", [])
    if not isinstance(users, list) or not isinstance(sessions, list):
        fail(500, "本机账号数据无法读取")
    if any(not isinstance(row, dict) for row in sessions):
        fail(500, "本机账号数据无法读取")
    return validated_users(users), sessions


def validated_users(rows: list) -> list[dict]:
    users = []
    for row in rows:
        if not isinstance(row, dict):
            fail(500, "本机账号数据无法读取")
        try:
            user = {field: row[field] for field in (*_PUBLIC_FIELDS, "passwordHash")}
        except KeyError:
            fail(500, "本机账号数据无法读取")
        text_fields = ("id", "username", "passwordHash", "createdAt", "updatedAt")
        if (
            not all(isinstance(user[field], str) and user[field] for field in text_fields)
            or user["role"] not in ("admin", "user")
            or not isinstance(user["disabled"], bool)
            or not user["passwordHash"].startswith(_HASH_SCHEME + "$")
        ):
            fail(500, "本机账号数据无法读取")
        users.append(user)
    return users


def save_store(users: list[dict], sessions: list[dict]) -> None:
    path = store_path()
    storage.write_json(path, {"version": 1, "users": users, "sessions": sessions})
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def username_taken(users: list[dict], username: str) -> bool:
    folded = username.casefold()
    return any(row["username"].casefold() == folded for row in users)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def hashes_equal(left: str, right: str) -> bool:
    if len(left) != len(right):
        return False
    return hmac.compare_digest(left, right)


def parse_time(value: object) -> datetime:
    if not isinstance(value, str):
        raise TypeError
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def parse_expiry(row: dict) -> datetime:
    try:
        return parse_time(row.get("expiresAt"))
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)


def valid_session(row: dict) -> bool:
    return all(isinstance(row.get(field), str) and row.get(field) for field in ("tokenHash", "userId", "createdAt", "expiresAt"))


def active_sessions(
    sessions: list[dict],
    *,
    now: datetime,
    drop_token: str | None = None,
    drop_user: str | None = None,
) -> list[dict]:
    digest = token_hash(drop_token) if drop_token else None
    kept = []
    for row in sessions:
        if not valid_session(row):
            continue
        if digest is not None and hashes_equal(row["tokenHash"], digest):
            continue
        if drop_user is not None and row["userId"] == drop_user:
            continue
        if parse_expiry(row) <= now:
            continue
        kept.append(row)
    return kept


def start_session(sessions: list[dict], user_id: str, presented: str | None) -> tuple[str, list[dict]]:
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    kept = active_sessions(sessions, now=now, drop_token=presented)
    kept.append({
        "tokenHash": token_hash(token),
        "userId": user_id,
        "createdAt": now.isoformat(),
        "expiresAt": (now + timedelta(seconds=SESSION_TTL_SECONDS)).isoformat(),
    })
    return token, kept


def resolve(token: str | None) -> tuple[dict | None, str]:
    if not token:
        return None, "none"
    now = datetime.now(timezone.utc)
    with storage.LOCK:
        users, sessions = load_store()
        digest = token_hash(token)
        match = next((row for row in sessions if valid_session(row) and hashes_equal(row["tokenHash"], digest)), None)
        if match is None or parse_expiry(match) <= now:
            if match is not None:
                save_store(users, active_sessions(sessions, now=now, drop_token=token))
            return None, "invalid"
        user = next((row for row in users if row["id"] == match["userId"]), None)
        if user is None:
            save_store(users, active_sessions(sessions, now=now, drop_token=token))
            return None, "invalid"
        if user["disabled"]:
            save_store(users, active_sessions(sessions, now=now, drop_user=user["id"]))
            return None, "disabled"
        return public_user(user), "ok"


def require_user(request: Request) -> dict:
    user, reason = resolve(request.cookies.get(SESSION_COOKIE))
    if reason == "disabled":
        fail(403, "账号已停用，请联系本机管理员", clear_session=True)
    if user is None:
        fail(401, "尚未登录", clear_session=reason == "invalid")
    return user


def require_admin(request: Request) -> dict:
    user = require_user(request)
    if user["role"] != "admin":
        fail(403, "需要管理员权限")
    return user


@router.post("/api/auth/register", status_code=201)
async def register(request: Request) -> JSONResponse:
    """Create a local account and sign in. The first account becomes admin."""
    assert_local_request(request)
    username, password = await read_credentials(request)
    with storage.LOCK:
        users, _sessions = load_store()
        if username_taken(users, username):
            fail(409, "该用户名已被使用")
    password_hash = await run_in_threadpool(hash_password, password)
    with storage.LOCK:
        users, sessions = load_store()
        if username_taken(users, username):
            fail(409, "该用户名已被使用")
        now = utc_now()
        user = {
            "id": str(uuid4()),
            "username": username,
            "passwordHash": password_hash,
            "role": "admin" if not users else "user",
            "disabled": False,
            "createdAt": now,
            "updatedAt": now,
        }
        users.append(user)
        token, sessions = start_session(sessions, user["id"], request.cookies.get(SESSION_COOKIE))
        save_store(users, sessions)
    response = private_json({"user": public_user(user)}, 201)
    set_session_cookie(response, token)
    return response


@router.post("/api/auth/login")
async def login(request: Request) -> JSONResponse:
    """Sign in with a local username and password."""
    assert_local_request(request)
    username, password = await read_credentials(request)
    with storage.LOCK:
        users, _sessions = load_store()
        user = next((row for row in users if row["username"].casefold() == username.casefold()), None)
        stored = user["passwordHash"] if user else None
    matched = await run_in_threadpool(password_matches, password, stored)
    if user is None or not matched:
        fail(401, "用户名或密码不正确")
    with storage.LOCK:
        users, sessions = load_store()
        current = next((row for row in users if row["id"] == user["id"]), None)
        if (
            current is None
            or current["passwordHash"] != stored
            or current["username"].casefold() != username.casefold()
        ):
            fail(401, "用户名或密码不正确")
        if current["disabled"]:
            fail(403, "账号已停用，请联系本机管理员")
        token, sessions = start_session(sessions, current["id"], request.cookies.get(SESSION_COOKIE))
        save_store(users, sessions)
    response = private_json({"user": public_user(current)})
    set_session_cookie(response, token)
    return response


@router.post("/api/auth/logout", status_code=204)
async def logout(request: Request) -> Response:
    """End the current local session."""
    assert_local_request(request)
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        fail(401, "尚未登录")
    with storage.LOCK:
        users, sessions = load_store()
        now = datetime.now(timezone.utc)
        match = next((row for row in sessions if valid_session(row) and hashes_equal(row["tokenHash"], token_hash(token))), None)
        if match is None or parse_expiry(match) <= now:
            if match is not None:
                save_store(users, active_sessions(sessions, now=now, drop_token=token))
            fail(401, "尚未登录", clear_session=True)
        user = next((row for row in users if row["id"] == match["userId"]), None)
        if user is None:
            save_store(users, active_sessions(sessions, now=now, drop_token=token))
            fail(401, "尚未登录", clear_session=True)
        if user["disabled"]:
            save_store(users, active_sessions(sessions, now=now, drop_user=user["id"]))
            fail(403, "账号已停用，请联系本机管理员", clear_session=True)
        save_store(users, active_sessions(sessions, now=now, drop_token=token))
    response = Response(status_code=204)
    response.headers["Cache-Control"] = "no-store"
    clear_session_cookie(response)
    return response


@router.get("/api/auth/me")
def me(request: Request) -> JSONResponse:
    """Return the signed-in local account, or 401 when there is no session."""
    return private_json({"user": require_user(request)})


@router.get("/api/admin/users")
def list_users(request: Request) -> JSONResponse:
    """List local accounts. Admin only. Does not include songs or recognition results."""
    require_admin(request)
    with storage.LOCK:
        users, _sessions = load_store()
    listed = [public_user(user) for user in sorted(users, key=lambda user: (user["createdAt"], user["id"]))]
    return private_json({"users": listed})


@router.patch("/api/admin/users/{user_id}")
async def update_user(user_id: str, request: Request) -> JSONResponse:
    """Change an account role or disabled flag. Admin only."""
    assert_local_request(request)
    admin = require_admin(request)
    role, disabled = parse_account_update(await read_object(request))
    with storage.LOCK:
        users, sessions = load_store()
        caller = next((row for row in users if row["id"] == admin["id"]), None)
        if caller is None or caller["role"] != "admin":
            fail(403, "需要管理员权限")
        if caller["disabled"]:
            fail(403, "账号已停用，请联系本机管理员", clear_session=True)
        target = next((row for row in users if row["id"] == user_id), None)
        if target is None:
            fail(404, "找不到该账号")
        updated = dict(target)
        if role is not None:
            updated["role"] = role
        if disabled is True and target["id"] == caller["id"]:
            fail(409, "不能停用当前登录的账号")
        if disabled is not None:
            updated["disabled"] = disabled
        others_admin = any(
            row["id"] != updated["id"] and row["role"] == "admin" and not row["disabled"]
            for row in users
        )
        keeps_admin = updated["role"] == "admin" and not updated["disabled"]
        if not others_admin and not keeps_admin:
            fail(409, "至少需要保留一名可用的管理员")
        if updated["role"] != target["role"] or updated["disabled"] != target["disabled"]:
            updated["updatedAt"] = utc_now()
            users = [updated if row["id"] == target["id"] else row for row in users]
            # Keep the session until the next request so a disabled account gets an
            # explicit error. resolve() then drops that user's sessions.
            sessions = active_sessions(sessions, now=datetime.now(timezone.utc))
            save_store(users, sessions)
        else:
            updated = target
    return private_json({"user": public_user(updated)})
