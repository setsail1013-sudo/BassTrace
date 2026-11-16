"""Rules for the guitar-chart layer. These tests do not measure OCR or alignment accuracy."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import storage
from backend.chord_chart import (
    CANNOT_MATCH,
    COLLISION_WARNING,
    Glyph,
    IMPORT_NOTE,
    NO_CHORDS,
    NO_LYRIC_CONFIRM,
    NO_LYRICS,
    REPEAT_WARNING,
    UNTIMED_GRID,
    WRONG_SONG,
    glyphs_to_candidates,
)
from backend.chord_pdf import ChartToolError, extract_glyphs, missing_tools, parse_bbox_html, parse_tesseract_tsv
from backend.main import app
from backend.models import (
    BassEvent, Chord, GuitarChord, Lyric, ManualFill, ManualFillNote, Marker, Note, Project,
)
from backend.timeline import beat_to_time


PROJECT_ID = "c0ffee00-71cc-4b5a-bf3c-a1dc2b9cb9ca"
LYRICS = (
    ("L1", "该怎么去形容你", 10, 14),
    ("L2", "最贴切的那个字", 14, 18),
    ("L3", "我把夜色唱成歌", 20, 24),
)
PROTECTED = ("chords", "bassEvents", "lyrics", "manualFills", "notes", "markers", "sections", "title", "key", "bpm")


def song(**changes):
    fields = dict(
        id=PROJECT_ID, title="版面对齐", duration=60, bpm=120,
        lyrics=[Lyric(id=lyric_id, text=text, start=start, end=end, source="manual", locked=True, order=index)
                for index, (lyric_id, text, start, end) in enumerate(LYRICS)],
        chords=[Chord(id="harmony-1", bar=1, beat=1, label="Cmaj7", source="manual", locked=True)],
        bassEvents=[BassEvent(id="bass-1", start=1, end=2, pitchClass=7, source="manual", locked=True)],
        manualFills=[ManualFill(id="fill-1", notes=[ManualFillNote(id="fill-note-1", digit=3, start=2, end=2.25)])],
        notes=[Note(id="note-1", midi=36, start=1, duration=.5, source="manual", locked=True)],
        markers=[Marker(id="mark-1", time=4, label="FILL", text="保留")],
    )
    fields.update(changes)
    return Project(**fields)


def protected(project: Project) -> dict:
    data = project.model_dump()
    return {name: data[name] for name in PROTECTED}


def box(text, x, y, width=16, height=14, page=0) -> Glyph:
    return Glyph(text, x, y, x + width, y + height, page)


def characters(text, x, y, step=18):
    return [box(char, x + index * step, y) for index, char in enumerate(text)]


def two_column_chart() -> list[Glyph]:
    """Left column is the verse; the right column has the chorus and a second print of the verse."""
    glyphs = [box("主歌", 40, 20, 36), box("G", 40, 48), box("A", 112, 48), *characters("该怎么去形容你", 40, 72)]
    glyphs += [box("Bm", 40, 120, 20), *characters("最贴切的那个字", 40, 144)]
    glyphs += [box("副歌", 430, 20, 36), box("E7", 430, 48, 20), *characters("我把夜色唱成歌", 430, 72)]
    glyphs += [box("主歌", 430, 200, 36), box("G", 430, 228), box("A", 430 + 4 * 18, 228)]
    glyphs += [*characters("该怎么去形容你", 430, 252), box("Bm", 430, 300, 20), *characters("最贴切的那个字", 430, 324)]
    return glyphs


def intro_chart() -> list[Glyph]:
    glyphs = [box("前奏", 40, 16, 36)]
    for text, x, width in (("|", 40, 8), ("G", 52, 16), ("-", 74, 12), ("|", 96, 8), ("A", 110, 16), ("-", 132, 12), ("|", 154, 8)):
        glyphs.append(box(text, x, 44, width))
    glyphs += [box("主歌", 40, 90, 36), box("Bm", 40, 118, 20), *characters("该怎么去形容你", 40, 142)]
    return glyphs


def lyric_column(rows) -> list[Glyph]:
    glyphs = []
    y = 20
    for section, chord, text in rows:
        glyphs.append(box(section, 40, y, 36))
        y += 28
        glyphs.append(box(chord, 40, y, 20))
        y += 24
        glyphs.extend(characters(text, 40, y))
        y += 40
    return glyphs


class GuitarChordTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(storage, "DATA_ROOT", Path(self.temporary.name))
        self.root_patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.root_patch.stop()
        self.temporary.cleanup()

    def save(self, project: Project) -> dict:
        storage.save(project)
        return protected(storage.load(PROJECT_ID))

    def post_chart(self, glyphs):
        with patch("backend.guitar_chords.extract_glyphs", return_value=glyphs):
            return self.client.post(
                f"/api/projects/{PROJECT_ID}/chords/import-pdf",
                files={"file": ("chart.pdf", b"%PDF-1.4\n% synthetic chart\n", "application/pdf")},
            )

    def test_symbol_grammar_accepts_chart_marks_only(self):
        accepted = (
            "G", "A", "Bm", "E7", "Gm", "F#m", "Bb", "Cmaj7", "Asus4", "D/F#", "Cadd9",
            "Em7", "Gsus2", "F#m7", "Bbmaj7", "C#m7", "Am7sus4", "G7b9", "G7(b9)", "Bdim",
        )
        for symbol in accepted:
            with self.subTest(symbol=symbol):
                self.assertTrue(GuitarChord(id="mark-" + symbol, symbol=symbol).symbol)
        for symbol in ("H7", "该", "hello", "Gmajor", " "):
            with self.subTest(symbol=symbol):
                with self.assertRaises(ValidationError):
                    GuitarChord(id="bad", symbol=symbol)

    def test_old_project_without_guitar_chords_loads_and_is_not_rewritten(self):
        self.save(song())
        path = storage.project_dir(PROJECT_ID) / "project.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload.pop("guitarChords")
        original = json.dumps(payload, ensure_ascii=False, indent=2)
        path.write_text(original, encoding="utf-8")
        response = self.client.get(f"/api/projects/{PROJECT_ID}")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["guitarChords"], [])
        self.assertEqual(body["lyrics"][0]["text"], "该怎么去形容你")
        self.assertEqual(body["chords"][0]["label"], "Cmaj7")
        self.assertEqual(body["bassEvents"][0]["pitchClass"], 7)
        self.assertEqual(body["manualFills"][0]["notes"][0]["digit"], 3)
        self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_save_without_the_field_keeps_guitar_chords(self):
        project = song()
        project.guitarChords = [GuitarChord(
            id="kept", symbol="G", section="主歌", lyricId="L1", charOffset=0, start=10, end=12,
            status="confirmed", source="pdf",
        )]
        storage.save(project)
        payload = storage.load(PROJECT_ID).model_dump()
        payload.pop("guitarChords")
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        saved = storage.load(PROJECT_ID)
        self.assertEqual(saved.guitarChords[0].id, "kept")
        self.assertEqual(saved.guitarChords[0].status, "confirmed")
        self.assertEqual(saved.bassEvents[0].pitchClass, 7)
        self.assertEqual(saved.manualFills[0].notes[0].digit, 3)
        self.assertEqual(saved.lyrics[0].text, "该怎么去形容你")

    def test_lyric_text_edit_detaches_the_link_without_moving_other_tracks(self):
        project = song()
        project.guitarChords = [GuitarChord(
            id="kept", symbol="G", lyricId="L1", charOffset=0, start=10, end=12, status="confirmed",
        )]
        storage.save(project)
        payload = storage.load(PROJECT_ID).model_dump()
        payload["lyrics"][0]["text"] = "该怎么去形容你呀"
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        saved = storage.load(PROJECT_ID)
        self.assertEqual(saved.lyrics[0].text, "该怎么去形容你呀")
        self.assertIsNone(saved.guitarChords[0].lyricId)
        self.assertIsNone(saved.guitarChords[0].charOffset)
        self.assertEqual((saved.guitarChords[0].symbol, saved.guitarChords[0].start, saved.guitarChords[0].status), ("G", 10, "confirmed"))
        self.assertEqual(saved.bassEvents[0].id, "bass-1")
        self.assertEqual(saved.chords[0].label, "Cmaj7")
        self.assertEqual(saved.manualFills[0].notes[0].digit, 3)

    def test_analysis_merge_does_not_replace_guitar_chords(self):
        project = song()
        project.guitarChords = [GuitarChord(
            id="kept", symbol="E7", lyricId="L3", charOffset=0, start=20, end=24, status="manual", source="manual",
        )]
        storage.save(project)
        merged = storage.merge_candidates(storage.load(PROJECT_ID), {
            "bassEvents": [BassEvent(id="new-bass", start=3, end=4, pitchClass=2, source="analysis")],
            "chords": [Chord(id="new-harmony", bar=2, beat=1, label="D", source="analysis")],
            "lyrics": [Lyric(id="new-lyric", text="替换歌词", start=1, end=2, source="analysis")],
        })
        self.assertEqual([(chord.id, chord.symbol, chord.lyricId) for chord in merged.guitarChords], [("kept", "E7", "L3")])
        self.assertEqual(merged.lyrics[0].text, "该怎么去形容你")
        self.assertEqual(merged.chords[0].label, "Cmaj7")
        self.assertEqual(merged.bassEvents[0].id, "bass-1")

    def test_two_column_repeat_aligns_once_and_leaves_other_tracks(self):
        before = self.save(song())
        direct = glyphs_to_candidates(two_column_chart(), storage.load(PROJECT_ID), grid=True)
        self.assertEqual([(chord.lyricId, chord.charOffset, chord.symbol, chord.section) for chord in direct.chords], [
            ("L1", 0, "G", "主歌"), ("L1", 4, "A", "主歌"), ("L2", 0, "Bm", "主歌"), ("L3", 0, "E7", "副歌"),
        ])
        self.assertEqual([chord.start for chord in direct.chords], [10, 10 + 4 * (4 / len(LYRICS[0][1])), 14, 20])
        self.assertIn(REPEAT_WARNING, direct.warnings)
        response = self.post_chart(two_column_chart())
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["note"], IMPORT_NOTE)
        self.assertIn(REPEAT_WARNING, body["warnings"])
        self.assertTrue(all(chord["status"] == "candidate" for chord in body["added"]))
        saved = storage.load(PROJECT_ID)
        self.assertEqual([(chord.lyricId, chord.charOffset, chord.symbol) for chord in saved.guitarChords], [
            ("L1", 0, "G"), ("L1", 4, "A"), ("L2", 0, "Bm"), ("L3", 0, "E7"),
        ])
        self.assertEqual(protected(saved), before)
        self.assertEqual(saved.revision, 2)

    def test_punctuation_and_leading_spaces_map_back_to_the_saved_lyric(self):
        project = song()
        project.lyrics[0].text = "  该怎么去，形容你"
        storage.save(project)
        draft = glyphs_to_candidates(two_column_chart(), storage.load(PROJECT_ID), grid=False)
        first, second = draft.chords[0], draft.chords[1]
        self.assertEqual((first.lyricId, first.charOffset, first.symbol), ("L1", 2, "G"))
        self.assertEqual((second.lyricId, second.charOffset, second.symbol), ("L1", 7, "A"))
        self.assertAlmostEqual(first.start, 10 + 4 * (2 / len(project.lyrics[0].text)))
        self.assertAlmostEqual(second.start, 10 + 4 * (7 / len(project.lyrics[0].text)))

    def test_intro_without_a_grid_stays_untimed_and_lyric_chords_snap(self):
        before = self.save(song(bpm=96, offset=0, beatTimes=[], sections=[]))
        response = self.post_chart(intro_chart())
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["note"], IMPORT_NOTE)
        self.assertIn(UNTIMED_GRID, body["warnings"])
        saved = storage.load(PROJECT_ID)
        intro = [chord for chord in saved.guitarChords if chord.section == "前奏"]
        lyric = next(chord for chord in saved.guitarChords if chord.lyricId == "L1")
        self.assertEqual([(chord.symbol, chord.start, chord.bar) for chord in intro], [("G", None, None), ("A", None, None)])
        self.assertEqual(sorted(body["untimedIds"]), sorted(chord.id for chord in intro))
        self.assertEqual((lyric.symbol, lyric.charOffset, lyric.start), ("Bm", 0, 10))
        self.assertEqual(protected(saved), before)

    def test_intro_uses_the_measure_grid_when_one_exists(self):
        project = song(beatTimes=[0, .5], offset=0, bpm=120)
        self.save(project)
        response = self.post_chart(intro_chart())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn(UNTIMED_GRID, response.json()["warnings"])
        saved = storage.load(PROJECT_ID)
        intro = [chord for chord in saved.guitarChords if chord.section == "前奏"]
        self.assertEqual([(chord.symbol, chord.bar, chord.beat) for chord in intro], [("G", 1, 1), ("A", 2, 1)])
        self.assertAlmostEqual(intro[0].start, beat_to_time(saved, 1, 1))
        self.assertAlmostEqual(intro[1].start, beat_to_time(saved, 2, 1))
        self.assertEqual(response.json()["untimedIds"], [])

    def test_reimport_preserves_confirmed_and_manual_chords(self):
        before = self.save(song())
        first = self.post_chart(two_column_chart())
        self.assertEqual(first.status_code, 200, first.text)
        initial = {chord["symbol"]: chord for chord in first.json()["project"]["guitarChords"]}
        confirmed = self.client.patch(
            f"/api/projects/{PROJECT_ID}/guitar-chords/{initial['G']['id']}",
            json={"status": "confirmed", "revision": first.json()["project"]["revision"]},
        )
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.assertEqual(confirmed.json()["chord"]["source"], "pdf")
        edited = self.client.patch(
            f"/api/projects/{PROJECT_ID}/guitar-chords/{initial['A']['id']}",
            json={"symbol": "F#m", "revision": confirmed.json()["project"]["revision"]},
        )
        self.assertEqual(edited.status_code, 200, edited.text)
        self.assertEqual((edited.json()["chord"]["status"], edited.json()["chord"]["source"]), ("manual", "manual"))
        second = self.post_chart(two_column_chart())
        self.assertEqual(second.status_code, 200, second.text)
        body = second.json()
        self.assertEqual(body["note"], IMPORT_NOTE)
        self.assertIn(COLLISION_WARNING, body["warnings"])
        saved = storage.load(PROJECT_ID)
        by_symbol = {chord.symbol: chord for chord in saved.guitarChords}
        self.assertEqual(set(by_symbol), {"G", "F#m", "Bm", "E7"})
        self.assertEqual((by_symbol["G"].id, by_symbol["G"].status, by_symbol["G"].source, by_symbol["G"].charOffset),
                         (initial["G"]["id"], "confirmed", "pdf", 0))
        self.assertEqual((by_symbol["F#m"].id, by_symbol["F#m"].status, by_symbol["F#m"].lyricId, by_symbol["F#m"].charOffset),
                         (initial["A"]["id"], "manual", "L1", 4))
        self.assertNotEqual(by_symbol["Bm"].id, initial["Bm"]["id"])
        self.assertEqual(by_symbol["Bm"].status, "candidate")
        self.assertNotIn("A", by_symbol)
        self.assertEqual(protected(saved), before)

    def test_match_failures_return_chinese_detail_and_write_nothing(self):
        before = self.save(song())
        cases = (
            (lyric_column([("主歌", "G", "窗外的雨一直在下"), ("副歌", "A", "路灯照着空空的街")]), WRONG_SONG),
            (lyric_column([("副歌", "E7", LYRICS[2][1]), ("主歌", "Bm", LYRICS[1][1]), ("主歌", "G", LYRICS[0][1])]), CANNOT_MATCH),
            (intro_chart()[:8], NO_LYRIC_CONFIRM),
            (characters("该怎么去形容你", 40, 40), NO_CHORDS),
        )
        for glyphs, detail in cases:
            with self.subTest(detail=detail):
                response = self.post_chart(glyphs)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(response.json()["detail"], detail)
                saved = storage.load(PROJECT_ID)
                self.assertEqual(saved.guitarChords, [])
                self.assertEqual(saved.revision, 1)
                self.assertEqual(protected(saved), before)
        empty = song(lyrics=[])
        self.save(empty)
        missing = self.post_chart(two_column_chart())
        self.assertEqual(missing.status_code, 422, missing.text)
        self.assertEqual(missing.json()["detail"], NO_LYRICS)
        self.assertEqual(storage.load(PROJECT_ID).lyrics, [])
        self.assertEqual(storage.load(PROJECT_ID).guitarChords, [])

    def test_missing_local_tool_and_empty_text_layer_fail_in_chinese(self):
        before = self.save(song())
        with patch("backend.chord_pdf._locate", return_value=(None, None)):
            response = self.client.post(
                f"/api/projects/{PROJECT_ID}/chords/import-pdf",
                files={"file": ("chart.pdf", b"%PDF-1.4\n", "application/pdf")},
            )
        self.assertEqual(response.status_code, 503, response.text)
        detail = response.json()["detail"]
        self.assertIn("缺少", detail)
        self.assertIn("pdftoppm", detail)
        self.assertIn("Tesseract", detail)
        self.assertIn("不会改写工程", detail)
        self.assertEqual(storage.load(PROJECT_ID).revision, 1)
        self.assertEqual(protected(storage.load(PROJECT_ID)), before)

        def locate(_env, name):
            return ("/bin/pdftotext", None) if name == "pdftotext" else (None, None)

        def run(_args, **_kwargs):
            return SimpleNamespace(returncode=0, stdout=b"<doc><page width='10' height='10'></page></doc>", stderr=b"")

        with patch("backend.chord_pdf._locate", side_effect=locate), patch("backend.chord_pdf.subprocess.run", side_effect=run):
            with self.assertRaises(ChartToolError) as caught:
                extract_glyphs(b"%PDF-1.4\n% no text layer\n")
        self.assertIn("缺少", caught.exception.detail)
        self.assertIn("不会改写工程", caught.exception.detail)
        with patch.dict(os.environ, {"BASSCHART_TESSERACT": "/missing/tesseract"}, clear=False):
            self.assertTrue(any("BASSCHART_TESSERACT" in item for item in missing_tools()))

    def test_bbox_and_tsv_keep_coordinates_without_claiming_recognition(self):
        parsed = parse_bbox_html(
            '<page width="200" height="100"><word xMin="10.0" yMin="20" xMax="30" yMax="40">G</word></page>'
        )
        self.assertEqual((parsed[0].text, parsed[0].x0, parsed[0].y0, parsed[0].x1, parsed[0].y1), ("G", 10, 60, 30, 80))
        tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t12\t30\t20\t14\t15\tBm\n"
        word = parse_tesseract_tsv(tsv, 2)[0]
        self.assertEqual((word.text, word.page, word.x0, word.y0, word.x1, word.y1), ("Bm", 2, 12, 30, 32, 44))

    def test_patch_confirms_edits_and_rejects_bad_requests(self):
        self.save(song())
        imported = self.post_chart(two_column_chart())
        chord = next(item for item in imported.json()["project"]["guitarChords"] if item["symbol"] == "Bm")
        revision = imported.json()["project"]["revision"]
        missing = self.client.patch(
            f"/api/projects/{PROJECT_ID}/guitar-chords/missing",
            json={"status": "confirmed", "revision": revision},
        )
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["detail"], "找不到要修改的吉他和弦。")
        stale = self.client.patch(
            f"/api/projects/{PROJECT_ID}/guitar-chords/{chord['id']}",
            json={"status": "confirmed", "revision": revision - 1},
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"], "工程已被更新，请重新加载后保存。")
        bad_symbol = self.client.patch(
            f"/api/projects/{PROJECT_ID}/guitar-chords/{chord['id']}",
            json={"symbol": "不是和弦", "revision": revision},
        )
        self.assertEqual(bad_symbol.status_code, 422)
        self.assertEqual(bad_symbol.json()["detail"], "和弦标记格式无法识别。")
        bad_offset = self.client.patch(
            f"/api/projects/{PROJECT_ID}/guitar-chords/{chord['id']}",
            json={"lyricId": "L2", "charOffset": 80, "revision": revision},
        )
        self.assertEqual(bad_offset.status_code, 422)
        self.assertEqual(bad_offset.json()["detail"], "和弦的字词位置超出歌词长度。")
        bad_lyric = self.client.patch(
            f"/api/projects/{PROJECT_ID}/guitar-chords/{chord['id']}",
            json={"lyricId": "missing-line", "charOffset": 0, "revision": revision},
        )
        self.assertEqual(bad_lyric.status_code, 422)
        self.assertEqual(bad_lyric.json()["detail"], "找不到要对齐的歌词。")
        moved = self.client.patch(
            f"/api/projects/{PROJECT_ID}/guitar-chords/{chord['id']}",
            json={"lyricId": "L3", "charOffset": 1, "status": "confirmed", "revision": revision},
        )
        self.assertEqual(moved.status_code, 200, moved.text)
        updated = moved.json()["chord"]
        self.assertEqual((updated["lyricId"], updated["charOffset"], updated["status"], updated["symbol"]), ("L3", 1, "confirmed", "Bm"))
        self.assertAlmostEqual(updated["start"], 20 + 4 * (1 / len(LYRICS[2][1])))
        self.assertEqual(storage.load(PROJECT_ID).bassEvents[0].pitchClass, 7)
        self.assertEqual(storage.load(PROJECT_ID).lyrics[1].text, "最贴切的那个字")

    def test_upload_rejects_a_non_pdf_without_touching_the_project(self):
        before = self.save(song())
        response = self.client.post(
            f"/api/projects/{PROJECT_ID}/chords/import-pdf",
            files={"file": ("notes.txt", b"hello", "text/plain")},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "上传的文件不是有效的 PDF。")
        empty = self.client.post(
            f"/api/projects/{PROJECT_ID}/chords/import-pdf",
            files={"file": ("chart.pdf", b"", "application/pdf")},
        )
        self.assertEqual(empty.status_code, 400)
        self.assertEqual(empty.json()["detail"], "和弦谱文件为空。")
        self.assertEqual(storage.load(PROJECT_ID).revision, 1)
        self.assertEqual(protected(storage.load(PROJECT_ID)), before)
        health = self.client.get("/api/health")
        self.assertIsInstance(health.json()["capabilities"]["guitarChordPdf"]["available"], bool)
