import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import audio, lyrics, storage
from backend.main import app, run_analysis, run_lyric_alignment
from backend.models import (
    AnalyzeRequest, AlignmentLine, DetectedSegment, Lyric, LyricAlignment,
    LyricsAlignRequest, ManualFill, ManualFillNote, Note, Project,
)


PROJECT_ID = "953bfe71-b88e-4b18-b9b5-5325fbcf5381"


def fill(group_id="fill-1", note_id="fill-note-1", **changes):
    fields = dict(id=note_id, digit=3, start=2, end=2.25, lines=1, octave=1)
    fields.update(changes)
    return ManualFill(id=group_id, notes=[ManualFillNote(**fields)])


def project(**changes):
    fields = dict(id=PROJECT_ID, title="三轨测试", duration=20, bpm=120,
                  lyrics=[Lyric(id="lyric-1", text="第一句", start=1, end=3, order=0)],
                  manualFills=[fill()])
    fields.update(changes)
    return Project(**fields)


class ManualFillTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(storage, "DATA_ROOT", Path(self.temporary.name))
        self.root_patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.root_patch.stop()
        self.temporary.cleanup()

    def test_old_project_has_empty_manual_track_without_migrating_bass_notes(self):
        legacy = project(notes=[Note(id="old-bass", midi=36, start=2, duration=.5)]).model_dump()
        legacy.pop("manualFills")
        legacy["lyrics"][0].pop("order")
        parsed = Project.model_validate(legacy)
        self.assertEqual(parsed.manualFills, [])
        self.assertEqual(parsed.lyrics[0].order, None)
        self.assertEqual(parsed.notes[0].midi, 36)
        directory = storage.project_dir(PROJECT_ID)
        directory.mkdir()
        path = directory / "project.json"
        original_json = json.dumps(legacy, ensure_ascii=False)
        path.write_text(original_json, encoding="utf-8")
        loaded = self.client.get(f"/api/projects/{PROJECT_ID}")
        self.assertEqual(loaded.status_code, 200)
        self.assertEqual(loaded.json()["manualFills"], [])
        self.assertEqual(path.read_text(encoding="utf-8"), original_json)

    def test_round_trip_and_explicit_clear(self):
        initial = project()
        storage.save(initial)
        self.assertEqual(storage.load(PROJECT_ID).manualFills, initial.manualFills)
        payload = initial.model_dump()
        payload["manualFills"][0]["notes"][0].update(digit=7, lines=2, octave=-2)
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        note = storage.load(PROJECT_ID).manualFills[0].notes[0]
        self.assertEqual((note.digit, note.lines, note.octave), (7, 2, -2))
        self.assertEqual(response.json()["revision"], 2)
        payload = response.json()
        payload["manualFills"] = []
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(storage.load(PROJECT_ID).manualFills, [])

    def test_old_client_omission_preserves_track_and_can_edit_other_fields(self):
        initial = project()
        storage.save(initial)
        payload = initial.model_dump()
        payload.pop("manualFills")
        payload["title"] = "旧客户端改标题"
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        latest = storage.load(PROJECT_ID)
        self.assertEqual(latest.title, "旧客户端改标题")
        self.assertEqual(latest.manualFills, initial.manualFills)

    def test_stale_tab_cannot_replace_manual_track(self):
        initial = project()
        storage.save(initial)
        stale = initial.model_dump()
        updated = initial.model_dump()
        updated["manualFills"][0]["notes"][0]["digit"] = 5
        self.assertEqual(self.client.put(f"/api/projects/{PROJECT_ID}", json=updated).status_code, 200)
        stale["manualFills"] = []
        self.assertEqual(self.client.put(f"/api/projects/{PROJECT_ID}", json=stale).status_code, 409)
        self.assertEqual(storage.load(PROJECT_ID).manualFills[0].notes[0].digit, 5)

    def test_old_client_preserves_explicit_lyric_order_when_it_omits_field(self):
        initial = project()
        storage.save(initial)
        payload = initial.model_dump()
        payload.pop("manualFills")
        payload["lyrics"][0].pop("order")
        payload["lyrics"][0]["text"] = "旧客户端改歌词"
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(storage.load(PROJECT_ID).lyrics[0].order, 0)

    def test_invalid_event_values_are_rejected(self):
        invalid = [dict(digit=-1), dict(digit=8), dict(digit=True), dict(digit=1.5),
                   dict(lines=-1), dict(lines=3), dict(lines=True), dict(octave=3),
                   dict(octave=-3), dict(octave=True), dict(start=-1), dict(start=float("nan")),
                   dict(end=float("inf")), dict(end=2), dict(start=3, end=2), dict(end=21)]
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                project(manualFills=[fill(**values)])

    def test_rest_all_octaves_and_audio_end_boundary_are_allowed(self):
        for octave in range(-2, 3):
            for lines in range(3):
                with self.subTest(octave=octave, lines=lines):
                    value = project(manualFills=[fill(digit=0, start=19.75, end=20, lines=lines, octave=octave)])
                    self.assertEqual(value.manualFills[0].notes[0].end, 20)

    def test_duplicate_group_and_note_ids_are_rejected(self):
        for groups in ([fill(), fill(note_id="second")],
                       [fill(), fill(group_id="other")],
                       [ManualFill(id="group", notes=[fill().notes[0], fill().notes[0]])]):
            with self.subTest(groups=groups), self.assertRaises(ValidationError):
                project(manualFills=groups)

    def test_put_checks_actual_duration_before_any_project_or_edit_file_write(self):
        initial = project()
        storage.save(initial)
        original = (storage.project_dir(PROJECT_ID) / "project.json").read_text(encoding="utf-8")
        payload = initial.model_dump()
        payload["duration"] = 200
        payload["manualFills"][0]["notes"][0].update(start=100, end=101)
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("音频范围", response.json()["detail"])
        self.assertEqual((storage.project_dir(PROJECT_ID) / "project.json").read_text(encoding="utf-8"), original)
        self.assertFalse((storage.project_dir(PROJECT_ID) / "edits.json").exists())

    def test_existing_legacy_lyrics_may_extend_past_audio_duration(self):
        value = project(lyrics=[Lyric(id="legacy", text="旧歌词", start=30, end=32)])
        storage.save(value)
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=value.model_dump())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["lyrics"][0]["end"], 32)

    def test_grid_changes_and_reanalysis_do_not_remap_manual_note_times(self):
        initial = project()
        storage.save(initial)
        payload = initial.model_dump()
        payload.update(bpm=60, meter="6/8", beatTimes=[.25, .7, 1.4, 2, 2.6, 3.3], offset=.25)
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        latest = storage.load(PROJECT_ID)
        self.assertEqual(latest.manualFills, initial.manualFills)
        latest = storage.merge_candidates(latest, {"bpm": 180, "offset": 0, "manualFills": [fill(digit=7)]})
        self.assertEqual(latest.manualFills, initial.manualFills)

    def test_analysis_merges_manual_track_edited_during_job(self):
        initial = project()
        storage.save(initial)
        sf.write(storage.project_dir(PROJECT_ID) / "original.wav", np.zeros(22050), 11025)

        def analyzing_with_edit(*_args, **_kwargs):
            current = storage.load(PROJECT_ID)
            edited = current.model_copy(deep=True)
            edited.manualFills = [fill(digit=6), fill(group_id="second", note_id="second-note", start=4, end=4.5)]
            storage.save_user_edit(current, edited)
            return {"bpm": 100, "offset": .2, "chords": [], "warnings": [],
                    "manualFills": [fill(digit=7)]}

        with patch.object(audio, "analyze_bass_roots", side_effect=analyzing_with_edit):
            run_analysis(PROJECT_ID, AnalyzeRequest(source="uploaded_bass"))
        latest = storage.load(PROJECT_ID)
        self.assertEqual(latest.analysis.state, "complete")
        self.assertEqual([group.notes[0].digit for group in latest.manualFills], [6, 3])
        self.assertEqual(latest.revision, 5)

    def test_alignment_job_merges_manual_track_edited_during_recognition(self):
        initial = project(lyricsOriginal="第一句", lyrics=[Lyric(id="lyric-1", text="第一句", start=1, end=3,
                                                            source="analysis", order=4)],
                          lyricAlignment=LyricAlignment(state="running", jobId="job"))
        storage.save(initial)

        def recognizing_with_edit(*_args, **_kwargs):
            current = storage.load(PROJECT_ID)
            edited = current.model_copy(deep=True)
            edited.manualFills = [fill(digit=4, octave=2)]
            storage.save_user_edit(current, edited)
            return [DetectedSegment(id="word", text="第一句", start=5, end=7, confidence=1)]

        with patch.object(lyrics.FasterWhisperLyrics, "transcribe", side_effect=recognizing_with_edit):
            run_lyric_alignment(PROJECT_ID, LyricsAlignRequest(), "job", "第一句", "第一句",
                                Path("unused-vocal.wav"), 0, 20)
        latest = storage.load(PROJECT_ID)
        self.assertEqual(latest.lyricAlignment.state, "complete")
        self.assertEqual(latest.manualFills[0].notes[0].digit, 4)
        self.assertEqual(latest.manualFills[0].notes[0].octave, 2)
        self.assertEqual(latest.lyrics[0].order, 4)

    def test_manual_lyric_order_survives_analysis_and_alignment(self):
        value = project(lyrics=[Lyric(id="a", text="原文第一句", start=10, end=11, order=0, locked=True),
                                Lyric(id="b", text="原文第二句", start=1, end=2, order=1, locked=True)])
        storage.save(value)
        merged = storage.merge_candidates(value, {"lyrics": [Lyric(id="new", text="新识别", start=14, end=15,
                                                                  source="analysis")]})
        self.assertEqual([item.id for item in merged.lyrics], ["a", "b", "new"])
        lyrics.apply_alignment(merged, [AlignmentLine(id="a-candidate", lyricId="a", text="原文第一句",
                                                     start=3, end=4, status="matched", confidence=1)])
        self.assertEqual({item.id: item.order for item in merged.lyrics}, {"a": 0, "b": 1, "new": None})


if __name__ == "__main__":
    unittest.main()
