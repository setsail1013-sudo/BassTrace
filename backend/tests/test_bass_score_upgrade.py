import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import adapters, audio, storage
from backend.main import app, run_analysis
from backend.models import (
    AnalyzeRequest, BassEvent, FillConnection, FillNotation, ManualFill,
    ManualFillNote, Project, ScoreColors, ScoreStyle, Stem,
)


PROJECT_ID = "a7927656-d01e-4349-9290-2e7c5c40bf32"


def event(event_id="bass-1", start=0, end=1, pitch=4, **changes):
    return BassEvent(id=event_id, start=start, end=end, pitchClass=pitch, source="analysis", **changes)


class BassScoreUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(storage, "DATA_ROOT", Path(self.temporary.name))
        self.root_patch.start()
        self.client = TestClient(app)
        self.directory = storage.project_dir(PROJECT_ID)
        self.directory.mkdir()
        self.rate = 11025
        self.times = np.arange(self.rate * 8) / self.rate
        self.samples = .1 * np.sin(2 * np.pi * 41.203445 * self.times)
        sf.write(self.directory / "original.wav", self.samples, self.rate, subtype="FLOAT")

    def tearDown(self):
        self.client.close()
        self.root_patch.stop()
        self.temporary.cleanup()

    def fixture(self, **changes):
        values = dict(id=PROJECT_ID, title="音名与谱面测试", duration=8, bpm=120)
        values.update(changes)
        project = Project(**values)
        storage.save(project)
        return project

    def bass_file(self):
        target = self.directory / "bass.wav"
        sf.write(target, self.samples, self.rate, subtype="FLOAT")
        return target

    def result(self):
        return {"bassEvents": [event()], "bpm": 120, "offset": 0, "warnings": []}

    def test_legacy_defaults_do_not_migrate_chords_or_notes(self):
        project = self.fixture()
        self.assertEqual(project.bassEvents, [])
        self.assertEqual(project.topTrack, "chords")
        self.assertEqual(project.scoreStyle.lyricFontSize, 20)
        self.assertEqual(project.scoreStyle.lyricPrintSize, 18)
        self.assertEqual(project.scoreStyle.colors.mark, "#C62828")
        self.assertTrue(project.scoreStyle.printColor)
        self.assertEqual(project.scoreStyle.printOrientation, "landscape")

    def test_old_and_partial_clients_preserve_nested_notation_style_and_bass(self):
        group = ManualFill(id="fill", notes=[
            ManualFillNote(id="one", digit=1, start=1, end=1.5,
                           notation=FillNotation(accent=True, connection=FillConnection(kind="slideUp", targetNoteId="two"))),
            ManualFillNote(id="two", digit=3, start=1.5, end=2, notation=FillNotation(cut=True)),
        ])
        original = self.fixture(bassEvents=[event()], topTrack="bass", manualFills=[group],
                                scoreStyle=ScoreStyle(lyricFontSize=24, lyricPrintSize=15,
                                                      colors=ScoreColors(fill="#123456"), printColor=False,
                                                      printOrientation="landscape"))
        payload = original.model_dump()
        for key in ("bassEvents", "topTrack"):
            payload.pop(key)
        payload["scoreStyle"] = {"colors": {"top": "#112233"}}
        payload["manualFills"][0]["notes"][0].pop("notation")
        payload["manualFills"][0]["notes"][1]["notation"] = {"accent": True}
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        saved = storage.load(PROJECT_ID)
        self.assertEqual(saved.bassEvents, original.bassEvents)
        self.assertEqual(saved.topTrack, "bass")
        self.assertEqual(saved.manualFills[0].notes[0].notation, group.notes[0].notation)
        self.assertTrue(saved.manualFills[0].notes[1].notation.cut)
        self.assertTrue(saved.manualFills[0].notes[1].notation.accent)
        self.assertEqual(saved.scoreStyle.lyricFontSize, 24)
        self.assertEqual(saved.scoreStyle.colors.fill, "#123456")
        self.assertEqual(saved.scoreStyle.colors.top, "#112233")
        self.assertFalse(saved.scoreStyle.printColor)
        self.assertEqual(saved.scoreStyle.printOrientation, "landscape")
        payload = saved.model_dump()
        payload["manualFills"][0]["notes"][0]["notation"] = None
        self.assertEqual(self.client.put(f"/api/projects/{PROJECT_ID}", json=payload).status_code, 200)
        self.assertIsNone(storage.load(PROJECT_ID).manualFills[0].notes[0].notation)

    def test_invalid_style_pitch_time_and_connections_are_rejected(self):
        for values in ({"bassEvents": [dict(id="a", start=0, end=1, pitchClass=12)]},
                       {"bassEvents": [event(end=9)]},
                       {"scoreStyle": {"colors": {"mark": "url(x)"}}},
                       {"scoreStyle": {"lyricFontSize": 13}},
                       {"scoreStyle": {"lyricPrintSize": 31}}):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                Project(id=PROJECT_ID, title="bad", duration=8, **values)
        for target in ("missing", "one"):
            with self.subTest(target=target), self.assertRaises(ValidationError):
                Project(id=PROJECT_ID, title="bad", duration=8, manualFills=[ManualFill(id="fill", notes=[
                    ManualFillNote(id="one", digit=1, start=1, end=2,
                                   notation=FillNotation(connection=FillConnection(kind="tie", targetNoteId=target)))])])

    def test_song_length_is_server_owned_for_bass_edits(self):
        project = self.fixture()
        payload = project.model_dump()
        payload.update(duration=80, bassEvents=[event(end=50).model_dump()])
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(storage.load(PROJECT_ID).bassEvents, [])

    def test_gain_preserves_frames_channels_and_original_without_clipping(self):
        raw = self.directory / "stereo.wav"
        samples = np.column_stack([self.samples * .01, self.samples * .02])
        sf.write(raw, samples, self.rate, subtype="FLOAT")
        before = raw.read_bytes()
        target = self.directory / "enhanced.wav"
        gain = audio.enhance_bass(raw, target)
        actual, rate = sf.read(target, always_2d=True)
        self.assertEqual(gain, 12)
        self.assertEqual(rate, self.rate)
        self.assertEqual(actual.shape, samples.shape)
        np.testing.assert_allclose(actual, samples * 10 ** (12 / 20), rtol=2e-7, atol=1e-8)
        self.assertEqual(raw.read_bytes(), before)
        loud = self.directory / "loud.wav"
        sf.write(loud, np.array([[.99, -.9], [0, .1]], dtype=np.float32), self.rate, subtype="FLOAT")
        gain = audio.enhance_bass(loud, target)
        actual, _ = sf.read(target, always_2d=True)
        self.assertLessEqual(np.max(np.abs(actual)), 10 ** (-3 / 20) + 1e-7)
        self.assertLess(gain, 0)

    def test_silent_gain_and_pitch_remain_silent(self):
        path = self.directory / "silence.wav"
        target = self.directory / "silent-enhanced.wav"
        sf.write(path, np.zeros(self.rate * 8), self.rate)
        self.assertEqual(audio.enhance_bass(path, target), 0)
        samples, _ = sf.read(target)
        self.assertEqual(np.count_nonzero(samples), 0)
        self.assertEqual(audio.analyze_bass_roots(self.fixture(), target)["bassEvents"], [])

    def test_default_full_song_requires_separation_and_analyzes_enhanced_bass(self):
        project = self.fixture()
        raw = self.bass_file()
        order = []
        def separate(*_args):
            order.append("separate")
            return {"bass": raw}
        def analyze(_project, path, **_kwargs):
            order.append("analyze")
            self.assertEqual(path, (self.directory / "bass-enhanced.wav").resolve())
            latest = storage.load(PROJECT_ID)
            stem = next(item for item in latest.stems if item.id == "bass")
            self.assertEqual(stem.url, f"/media/{PROJECT_ID}/bass.wav")
            self.assertIsNotNone(stem.enhancedUrl)
            return self.result()
        with (patch.object(adapters.DEFAULT.separator, "separate", side_effect=separate),
              patch.object(adapters.DEFAULT.bass_analyzer, "analyze", side_effect=analyze),
              patch.object(adapters.DEFAULT.analyzer, "analyze") as fullmix,
              patch.object(adapters.DEFAULT.transcriber, "transcribe") as notes):
            run_analysis(project.id, AnalyzeRequest())
        self.assertEqual(order, ["separate", "analyze"])
        fullmix.assert_not_called()
        notes.assert_not_called()
        self.assertEqual(storage.load(PROJECT_ID).topTrack, "bass")

    def test_valid_cache_reused_force_separation_failure_never_falls_back(self):
        self.bass_file()
        project = self.fixture(stems=[Stem(id="bass", name="贝斯", available=True, url=f"/media/{PROJECT_ID}/bass.wav")])
        with (patch.object(adapters.DEFAULT.separator, "separate") as separator,
              patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=self.result())):
            run_analysis(project.id, AnalyzeRequest())
            separator.assert_not_called()
        with (patch.object(adapters.DEFAULT.separator, "separate", side_effect=RuntimeError("分离失败")),
              patch.object(adapters.DEFAULT.bass_analyzer, "analyze") as analyzer,
              self.assertLogs(level="ERROR")):
            run_analysis(project.id, AnalyzeRequest(separate=True))
            analyzer.assert_not_called()
        self.assertEqual(storage.load(PROJECT_ID).analysis.state, "error")
        self.assertEqual(storage.load(PROJECT_ID).bassEvents, self.result()["bassEvents"])

    def test_invalid_cache_separates_and_failed_pitch_keeps_completed_stem(self):
        self.fixture(stems=[Stem(id="bass", name="贝斯", available=True, url=f"/media/{PROJECT_ID}/bad.wav")])
        (self.directory / "bad.wav").write_bytes(b"not audio")
        raw = self.bass_file()
        with (patch.object(adapters.DEFAULT.separator, "separate", return_value={"bass": raw}) as separator,
              patch.object(adapters.DEFAULT.bass_analyzer, "analyze", side_effect=RuntimeError("音高失败")),
              self.assertLogs(level="ERROR")):
            run_analysis(PROJECT_ID, AnalyzeRequest())
        separator.assert_called_once()
        latest = storage.load(PROJECT_ID)
        self.assertEqual(latest.analysis.state, "error")
        self.assertEqual(latest.stems[0].url, f"/media/{PROJECT_ID}/bass.wav")
        self.assertTrue(latest.stems[0].enhancedUrl)

    def test_explicit_isolated_input_only_bypass_and_no_later_original_alias(self):
        self.fixture()
        with (patch.object(adapters.DEFAULT.separator, "separate") as separator,
              patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=self.result())):
            run_analysis(PROJECT_ID, AnalyzeRequest(source="uploaded_bass"))
            separator.assert_not_called()
        with (patch.object(adapters.DEFAULT.separator, "separate", return_value={"bass": self.bass_file()}) as separator,
              patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=self.result())):
            run_analysis(PROJECT_ID, AnalyzeRequest())
            separator.assert_called_once()

    def test_deleted_spans_survive_changed_candidate_ids_and_keep_other_audio(self):
        original = self.fixture(bassEvents=[event("deleted", 2, 3), event("manual", 4, 5)])
        changed = original.model_copy(deep=True)
        changed.bassEvents = changed.bassEvents[1:]
        changed.bassEvents[0].pitchClass = 9
        saved = storage.save_user_edit(original, changed)
        merged = storage.merge_candidates(saved, {"bassEvents": [event("new-grid-id", 0, 8)]})
        actual = [(e.start, e.end, e.pitchClass) for e in merged.bassEvents]
        self.assertEqual(actual, [(0, 2, 4), (3, 4, 4), (4, 5, 9), (5, 8, 4)])
        self.assertTrue(next(e for e in merged.bassEvents if e.id == "manual").locked)

    def test_concurrent_edits_preserved_in_new_bass_result(self):
        original = self.fixture(bassEvents=[event("delete", 2, 3)])
        def analyze(*_args, **_kwargs):
            latest = storage.load(PROJECT_ID)
            changed = latest.model_copy(deep=True)
            changed.bassEvents = [event("added", 4, 5, 9, locked=True)]
            changed.scoreStyle.lyricFontSize = 26
            storage.save_user_edit(latest, changed)
            return {"bassEvents": [event("regenerated", 0, 8)], "warnings": []}
        with patch.object(adapters.DEFAULT.bass_analyzer, "analyze", side_effect=analyze):
            run_analysis(PROJECT_ID, AnalyzeRequest(source="uploaded_bass"))
        latest = storage.load(PROJECT_ID)
        self.assertEqual(latest.analysis.state, "complete")
        self.assertEqual(latest.scoreStyle.lyricFontSize, 26)
        self.assertEqual([(e.start, e.end, e.pitchClass) for e in latest.bassEvents],
                         [(0, 2, 4), (3, 4, 4), (4, 5, 9), (5, 8, 4)])

    def test_manual_variable_six_eight_grid_drives_analysis_without_changes(self):
        original = self.fixture()
        changed = original.model_copy(deep=True)
        changed.meter = "6/8"
        changed.bpm = 100
        changed.beatTimes = [0, .25, .6, .9, 1.1, 1.45, 1.7, 2.1]
        saved = storage.save_user_edit(original, changed)
        with patch.object(adapters.DEFAULT.bass_analyzer, "analyze", wraps=adapters.DEFAULT.bass_analyzer.analyze) as analyze:
            run_analysis(PROJECT_ID, AnalyzeRequest(source="uploaded_bass"))
        self.assertTrue(analyze.call_args.kwargs["preserve_grid"])
        latest = storage.load(PROJECT_ID)
        self.assertEqual((latest.bpm, latest.meter, latest.beatTimes), (saved.bpm, saved.meter, saved.beatTimes))
        self.assertTrue(latest.bassEvents)

    def test_silence_splits_sustained_same_pitch_into_separate_phrases(self):
        path = self.directory / "phrase.wav"
        samples = self.samples.copy()
        samples[(self.times >= 2) & (self.times < 4)] = 0
        sf.write(path, samples, self.rate)
        result = audio.analyze_bass_roots(self.fixture(), path, preserve_grid=True)
        events = result["bassEvents"]
        self.assertEqual(len(events), 2)
        self.assertEqual([e.pitchClass for e in events], [4, 4])
        self.assertLess(events[0].end, 2.3)
        self.assertGreater(events[1].start, 3.7)

    def test_pickup_before_first_downbeat_keeps_absolute_audio_times(self):
        path = self.bass_file()
        grids = [
            {"offset": .75},
            {"offset": 1.1, "meter": "6/8", "beatTimes": [0, .3, .65, 1, 1.4, 1.75, 2.1]},
        ]
        for grid in grids:
            with self.subTest(grid=grid):
                project = self.fixture(**grid)
                result = audio.analyze_bass_roots(project, path, preserve_grid=True)
                events = result["bassEvents"]
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0].start, 0)
                self.assertEqual(events[0].pitchClass, 4)
                self.assertGreater(events[0].end, 7.7)
                self.assertLessEqual(events[0].end, project.duration)
                self.assertNotIn("offset", result)


if __name__ == "__main__":
    unittest.main()
