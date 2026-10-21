import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from backend import adapters, audio, storage
from backend.main import app, run_analysis
from backend.models import AnalyzeRequest, BassEvent, Chord, Lyric, Marker, Note, Project, Section, Stem
from backend.timeline import beat_to_time


PROJECT_ID = "f528d192-6716-4cce-83b1-338c6838cdaa"


class BassAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(storage, "DATA_ROOT", Path(self.temporary.name))
        self.root_patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.root_patch.stop()
        self.temporary.cleanup()

    def fixture(self, *, bass=True):
        directory = storage.project_dir(PROJECT_ID)
        directory.mkdir(parents=True)
        rate = 11025
        timeline = np.arange(rate * 8) / rate
        sf.write(directory / "original.wav", .15 * np.sin(2 * np.pi * 220 * timeline), rate)
        stems = [Stem(id="original", name="原曲", available=True, url=f"/media/{PROJECT_ID}/original.wav")]
        if bass:
            # An arbitrary registered path proves selection follows the actual
            # server-owned stem rather than guessing a Demucs filename.
            (directory / "isolated").mkdir()
            sf.write(directory / "isolated" / "live-bass.wav", .15 * np.sin(2 * np.pi * 41.203445 * timeline), rate)
            stems.append(Stem(id="bass", name="贝斯", available=True,
                              url=f"/media/{PROJECT_ID}/isolated/live-bass.wav"))
        project = Project(id=PROJECT_ID, title="原创测试", duration=8, bpm=120, key="Dm", originalKey="Dm",
                          stems=stems, chords=[Chord(id="harmony", bar=1, beat=1, label="Am7", source="analysis", confidence=.8)],
                          notes=[Note(id="existing-note", midi=36, start=1, duration=.5,
                                                  source="analysis", confidence=.4)],
                          lyrics=[Lyric(id="existing-lyric", text="保留原文", start=1, end=3, locked=True)],
                          markers=[Marker(id="existing-marker", time=2, label="FILL", text="个人备注")])
        storage.save(project)
        return project, directory

    def root_result(self):
        return {"bpm": 120, "offset": 0,
                "bassEvents": [BassEvent(id="root", start=0, end=1, pitchClass=4, source="analysis", confidence=.5)],
                "warnings": ["贝斯主要音名候选，请试听校正。"]}

    def test_original_is_default_and_unknown_source_is_rejected(self):
        self.assertEqual(AnalyzeRequest().source, "original")
        project, _ = self.fixture(bass=False)
        with patch("backend.main.EXECUTOR.submit") as submit:
            response = self.client.post(f"/api/projects/{project.id}/analyze", json={"source": "anything"})
            self.assertEqual(response.status_code, 422)
            submit.assert_not_called()
            response = self.client.post(f"/api/projects/{project.id}/analyze", json={})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(submit.call_args.args[2].source, "original")

    def test_real_bass_pitch_is_marked_uncertain_without_harmony_or_notes(self):
        project, directory = self.fixture()
        with patch.object(audio, "transcribe_bass", side_effect=AssertionError("must not transcribe notes")):
            result = audio.analyze_bass_roots(project, directory / "isolated" / "live-bass.wav")
        self.assertTrue(result["bassEvents"])
        self.assertEqual({event.pitchClass for event in result["bassEvents"]}, {4})
        self.assertTrue(all(0 < event.confidence <= .75 for event in result["bassEvents"]))
        self.assertEqual(len(result["bassEvents"]), 1)
        self.assertNotIn("chords", result)
        self.assertNotIn("key", result)
        self.assertNotIn("originalKey", result)
        self.assertNotIn("notes", result)
        self.assertNotIn("markers", result)
        self.assertTrue(any("贝斯主要音高" in warning for warning in result["warnings"]))

    def test_silent_bass_does_not_receive_an_invented_root(self):
        project, directory = self.fixture()
        sf.write(directory / "silent.wav", np.zeros(11025 * 8), 11025)
        result = audio.analyze_bass_roots(project, directory / "silent.wav")
        self.assertEqual(result["bassEvents"], [])
        self.assertTrue(any("未检测到可靠" in warning for warning in result["warnings"]))

    def test_registered_bass_used_and_existing_events_preserved(self):
        project, directory = self.fixture()
        with (patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=self.root_result()) as bass,
             patch.object(adapters.DEFAULT.analyzer, "analyze") as original,
             patch.object(adapters.DEFAULT.transcriber, "transcribe") as transcribe):
            run_analysis(project.id, AnalyzeRequest(source="bass", transcribe=True))
        bass.assert_called_once()
        self.assertEqual(bass.call_args.args[1], (directory / "bass-enhanced.wav").resolve())
        original.assert_not_called()
        transcribe.assert_not_called()
        analyzed = storage.load(project.id)
        self.assertEqual(analyzed.analysis.state, "complete")
        self.assertEqual(analyzed.chords, project.chords)
        self.assertEqual(analyzed.bassEvents, self.root_result()["bassEvents"])
        self.assertEqual(analyzed.topTrack, "bass")
        self.assertFalse(any(chord.label.endswith("?") for chord in analyzed.chords))
        self.assertEqual(analyzed.key, "Dm")
        self.assertEqual(analyzed.originalKey, "Dm")
        self.assertEqual(analyzed.notes, project.notes)
        self.assertEqual(analyzed.lyrics, project.lyrics)
        self.assertEqual(analyzed.markers, project.markers)
        self.assertTrue(any("跳过音符" in warning for warning in analyzed.analysis.warnings))

    def test_uploaded_bass_uses_imported_audio_and_filters_forbidden_results(self):
        project, directory = self.fixture()
        result = self.root_result()
        result.update({"key": "E", "originalKey": "E", "notes": [], "markers": [], "lyrics": []})
        with (patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=result) as bass,
              patch.object(adapters.DEFAULT.analyzer, "analyze") as original):
            run_analysis(project.id, AnalyzeRequest(source="uploaded_bass"))
        self.assertEqual(bass.call_args.args[1], (directory / "bass-enhanced.wav").resolve())
        original.assert_not_called()
        analyzed = storage.load(project.id)
        self.assertEqual(analyzed.analysis.state, "complete")
        self.assertEqual(analyzed.key, project.key)
        self.assertEqual(analyzed.chords, project.chords)
        self.assertEqual(analyzed.notes, project.notes)
        self.assertEqual(analyzed.lyrics, project.lyrics)
        self.assertEqual(analyzed.markers, project.markers)

    def test_half_speed_bass_grid_keeps_chords_at_the_same_audio_times(self):
        project, _ = self.fixture()
        project.chords = [
            Chord(id="automatic", bar=2, beat=1, label="Cmaj7", source="analysis", confidence=.7),
            Chord(id="confirmed", bar=3, beat=1.5, label="G7", source="manual", locked=True, confidence=.93),
        ]
        storage.save(project)
        original_times = {chord.id: beat_to_time(project, chord.bar, chord.beat) for chord in project.chords}
        result = self.root_result()
        result["bpm"] = 60
        with patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=result):
            run_analysis(project.id, AnalyzeRequest(source="bass"))
        analyzed = storage.load(project.id)
        self.assertEqual(analyzed.bpm, 60)
        self.assertEqual((analyzed.chords[0].bar, analyzed.chords[0].beat), (1, 3))
        for before, after in zip(project.chords, analyzed.chords):
            self.assertAlmostEqual(beat_to_time(analyzed, after.bar, after.beat), original_times[after.id], places=9)
            self.assertEqual((after.id, after.label, after.source, after.locked, after.confidence),
                             (before.id, before.label, before.source, before.locked, before.confidence))
        self.assertEqual(analyzed.lyrics, project.lyrics)
        self.assertEqual(analyzed.notes, project.notes)
        self.assertEqual(analyzed.markers, project.markers)

    def test_nonuniform_bass_grid_preserves_harmony_times_and_deleted_ids(self):
        project, _ = self.fixture()
        project.offset = .05
        project.beatTimes = [0, .47, 1.05, 1.55, 2.2, 2.72, 3.35, 3.86, 4.49, 5.03, 5.6, 6.21, 6.7, 7.35, 7.92]
        project.chords = [
            Chord(id="automatic", bar=1, beat=3.375, label="Cmaj7", source="analysis", confidence=.8),
            Chord(id="confirmed", bar=2, beat=2.25, label="G7", source="manual", locked=True, confidence=.95),
        ]
        storage.save(project)
        flags = {"deleted_chords": ["previously-deleted"], "deleted_lyrics": [], "deleted_notes": []}
        storage.write_json(storage.project_dir(project.id) / "edits.json", flags)
        original_times = {chord.id: beat_to_time(project, chord.bar, chord.beat) for chord in project.chords}
        result = self.root_result()
        result.update({"bpm": 84, "offset": .1,
                       "beatTimes": [.1, .8, 1.55, 2.36, 3.07, 3.87, 4.7, 5.4, 6.2, 6.91, 7.68, 8.45]})
        with patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=result):
            run_analysis(project.id, AnalyzeRequest(source="uploaded_bass"))
        analyzed = storage.load(project.id)
        self.assertEqual(analyzed.beatTimes, result["beatTimes"])
        self.assertEqual(analyzed.offset, .1)
        for before, after in zip(project.chords, analyzed.chords):
            self.assertAlmostEqual(beat_to_time(analyzed, after.bar, after.beat), original_times[after.id], places=9)
            self.assertEqual((after.id, after.label, after.source, after.locked, after.confidence),
                             (before.id, before.label, before.source, before.locked, before.confidence))
        self.assertEqual(storage.edit_flags(project.id), flags)
        self.assertEqual(analyzed.lyrics, project.lyrics)
        self.assertEqual(analyzed.notes, project.notes)
        self.assertEqual(analyzed.markers, project.markers)

    def test_new_first_beat_does_not_push_an_earlier_saved_chord_to_bar_one(self):
        project, _ = self.fixture()
        project.sections = [Section(id="original-section", name="Intro", startBar=1, endBar=4)]
        storage.save(project)
        result = self.root_result()
        result.update({"bpm": 60, "offset": 1,
                       "sections": [Section(id="candidate-section", name="候选段落", startBar=1, endBar=2)]})
        with patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=result):
            run_analysis(project.id, AnalyzeRequest(source="bass"))
        analyzed = storage.load(project.id)
        self.assertEqual(analyzed.analysis.state, "complete")
        self.assertEqual((analyzed.bpm, analyzed.offset, analyzed.beatTimes),
                         (project.bpm, project.offset, project.beatTimes))
        self.assertEqual(analyzed.chords, project.chords)
        self.assertEqual(analyzed.sections, project.sections)
        self.assertTrue(any("候选首拍晚于" in warning for warning in analyzed.analysis.warnings))

    def test_bass_retiming_uses_edits_saved_while_analysis_is_running(self):
        project, _ = self.fixture()

        def analyze(_current, _path, **_kwargs):
            latest = storage.load(project.id)
            edited = latest.model_copy(deep=True)
            edited.chords = [Chord(id="during-analysis", bar=2, beat=3, label="Dm7", source="manual", locked=True)]
            storage.save_user_edit(latest, edited)
            result = self.root_result()
            result["bpm"] = 60
            return result

        with patch.object(adapters.DEFAULT.bass_analyzer, "analyze", side_effect=analyze):
            run_analysis(project.id, AnalyzeRequest(source="bass"))
        analyzed = storage.load(project.id)
        self.assertEqual(len(analyzed.chords), 1)
        chord = analyzed.chords[0]
        self.assertEqual((chord.id, chord.label, chord.source, chord.locked),
                         ("during-analysis", "Dm7", "manual", True))
        self.assertEqual((chord.bar, chord.beat), (1, 4))
        self.assertAlmostEqual(chord.start, 3)
        self.assertEqual(storage.edit_flags(project.id)["deleted_chords"], ["harmony"])

    def test_separation_precedes_bass_analysis_and_saves_actual_stem(self):
        project, directory = self.fixture(bass=False)
        separated = directory / "separated-bass.wav"
        sf.write(separated, np.ones(11025 * 8) * .01, 11025)
        calls = []

        def separate(original, project_dir):
            calls.append("separate")
            self.assertEqual(original, directory / "original.wav")
            return {"bass": separated}

        def analyze(current, path, **_kwargs):
            calls.append("analyze")
            self.assertEqual(path, (directory / "bass-enhanced.wav").resolve())
            self.assertTrue(any(stem.id == "bass" and stem.available for stem in storage.load(project.id).stems))
            return self.root_result()

        with (patch.object(adapters.DEFAULT.separator, "separate", side_effect=separate),
              patch.object(adapters.DEFAULT.bass_analyzer, "analyze", side_effect=analyze)):
            run_analysis(project.id, AnalyzeRequest(source="bass", separate=True))
        self.assertEqual(calls, ["separate", "analyze"])
        analyzed = storage.load(project.id)
        self.assertEqual(analyzed.analysis.state, "complete")
        stem = next(item for item in analyzed.stems if item.id == "bass")
        self.assertTrue(stem.available)
        self.assertEqual(stem.url, f"/media/{project.id}/separated-bass.wav")

    def test_missing_or_invalid_bass_fails_without_using_original(self):
        project, directory = self.fixture(bass=False)
        for stem in (None,
                     Stem(id="bass", name="贝斯", available=True, url=f"/media/{project.id}/missing.wav"),
                     Stem(id="bass", name="贝斯", available=True, url=f"/media/{project.id}/../outside.wav")):
            with self.subTest(stem=stem):
                project.stems = project.stems[:1] + ([stem] if stem else [])
                storage.save(project)
                with patch("backend.main.EXECUTOR.submit") as submit:
                    response = self.client.post(f"/api/projects/{project.id}/analyze", json={"source": "bass"})
                self.assertEqual(response.status_code, 200, response.text)
                submit.assert_called_once()
                project.analysis.state = "idle"
                storage.save(project)
        with (patch.object(adapters.DEFAULT.bass_analyzer, "analyze") as bass,
             patch.object(adapters.DEFAULT.analyzer, "analyze") as original,
             patch.object(adapters.DEFAULT.separator, "separate", side_effect=RuntimeError("真实分离失败"))):
            run_analysis(project.id, AnalyzeRequest(source="bass", separate=True))
        bass.assert_not_called()
        original.assert_not_called()
        failed = storage.load(project.id)
        self.assertEqual(failed.analysis.state, "error")
        self.assertTrue(any("真实分离失败" in warning for warning in failed.analysis.warnings))
        self.assertEqual(failed.notes, project.notes)

    def test_default_analysis_uses_cached_bass_and_never_transcribes_notes(self):
        project, directory = self.fixture()
        with (patch.object(adapters.DEFAULT.analyzer, "analyze", return_value={"key": "G", "warnings": []}) as original,
             patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=self.root_result()) as bass,
             patch.object(adapters.DEFAULT.transcriber, "transcribe", return_value=[]) as transcribe):
            run_analysis(project.id, AnalyzeRequest(transcribe=True))
        original.assert_not_called()
        bass.assert_called_once()
        self.assertEqual(bass.call_args.args[1], (directory / "bass-enhanced.wav").resolve())
        transcribe.assert_not_called()
        analyzed = storage.load(project.id)
        self.assertEqual(analyzed.key, project.key)
        self.assertEqual(analyzed.notes, project.notes)

    def test_full_song_keeps_legacy_chords_and_has_independent_bass_events(self):
        project, directory = self.fixture()
        project.chords = [Chord(id="analysis-bass-root-1", bar=1, beat=1, label="E?", source="analysis", confidence=.5)]
        storage.save(project)
        harmony = [Chord(id="analysis-chord-1", bar=1, beat=1.5, label="Cmaj7", source="analysis", confidence=.8),
                   Chord(id="analysis-chord-2", bar=1, beat=3.5, label="G7", source="analysis", confidence=.8)]
        with (patch.object(adapters.DEFAULT.analyzer, "analyze", return_value={"chords": harmony, "warnings": []}) as original,
              patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=self.root_result()) as bass,
              patch.object(adapters.DEFAULT.transcriber, "transcribe") as transcribe):
            run_analysis(project.id, AnalyzeRequest())
        original.assert_not_called()
        bass.assert_called_once()
        transcribe.assert_not_called()
        analyzed = storage.load(project.id)
        self.assertEqual(analyzed.chords, project.chords)
        self.assertEqual(analyzed.bassEvents, self.root_result()["bassEvents"])
        self.assertEqual(analyzed.notes, project.notes)
        self.assertEqual(analyzed.lyrics, project.lyrics)
        self.assertEqual(analyzed.markers, project.markers)

    def test_manual_grid_and_confirmed_chords_are_preserved_with_explanation(self):
        project, _ = self.fixture()
        project.chords = [Chord(id="confirmed", bar=1, beat=1, label="Am7", source="manual", locked=True)]
        storage.save(project)
        edited = project.model_copy(deep=True)
        edited.bpm = 60
        storage.save_user_edit(project, edited)
        with patch.object(adapters.DEFAULT.bass_analyzer, "analyze", return_value=self.root_result()):
            run_analysis(project.id, AnalyzeRequest(source="bass"))
        analyzed = storage.load(project.id)
        self.assertEqual(analyzed.analysis.state, "complete")
        self.assertEqual(analyzed.bpm, 60)
        self.assertEqual(analyzed.chords, edited.chords)
        self.assertTrue(any("人工节拍网格" in warning and "不会替换" in warning
                            for warning in analyzed.analysis.warnings))
        self.assertTrue(any("人工确认的和弦" in warning for warning in analyzed.analysis.warnings))


if __name__ == "__main__":
    unittest.main()
