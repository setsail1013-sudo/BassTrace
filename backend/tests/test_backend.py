import io
import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import audio, storage
from backend.main import app, run_analysis
from backend.demo import ensure_demo
from backend.models import Analysis, AnalyzeRequest, Chord, Lyric, Note, Project, Section
from backend.timeline import beat_seconds, beat_to_time, time_to_beat


PROJECT_ID = "b425ca93-71cc-4b5a-bf3c-a1dc2b9cb9ca"


def sample_project(**changes):
    fields = dict(id=PROJECT_ID, title="测试歌曲", duration=20, bpm=120,
                  chords=[Chord(id="c1", bar=1, beat=1, label="C", source="analysis")],
                  lyrics=[Lyric(id="l1", text="原创歌词", start=1, end=3, source="analysis")],
                  notes=[Note(id="n1", midi=36, start=1, duration=.5, source="analysis")])
    fields.update(changes)
    return Project(**fields)


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(storage, "DATA_ROOT", Path(self.temporary.name))
        self.root_patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.root_patch.stop()
        self.temporary.cleanup()

    def test_constant_grid_and_pickup(self):
        project = sample_project(offset=.25)
        self.assertEqual(beat_to_time(project, 2, 3), 3.25)
        self.assertEqual(time_to_beat(project, 3.25), (2, 3))
        pickup_bar, pickup_beat = time_to_beat(project, .1)
        self.assertEqual(pickup_bar, 0)
        self.assertAlmostEqual(pickup_beat, 4.7)

    def test_variable_grid_interpolation_and_extrapolation(self):
        project = sample_project(offset=.2, beatTimes=[.2, .7, 1.3, 1.95, 2.6])
        self.assertAlmostEqual(beat_to_time(project, 1, 2.5), 1.0)
        self.assertEqual(time_to_beat(project, 1.0), (1, 2.5))
        self.assertAlmostEqual(beat_to_time(project, 2, 2), 3.25)
        bar, beat = time_to_beat(project, 3.25)
        self.assertEqual(bar, 2)
        self.assertAlmostEqual(beat, 2)

    def test_meter_denominator_and_absolute_beat_anchor(self):
        for meter, step, bar_start in (("2/4", .5, 1.25), ("3/4", .5, 1.75),
                                      ("6/8", .25, 1.75), ("7/8", .25, 2.0), ("2/2", 1.0, 2.25)):
            with self.subTest(meter=meter):
                project = sample_project(meter=meter, offset=.25)
                self.assertAlmostEqual(beat_seconds(project), step)
                self.assertAlmostEqual(beat_to_time(project, 2, 1), bar_start)
                bar, beat = time_to_beat(project, bar_start)
                self.assertEqual(bar, 2)
                self.assertAlmostEqual(beat, 1)
        project = sample_project(meter="6/8", offset=.2, beatTimes=[.2, .45, .8, 1.1, 1.4, 1.65, 1.95])
        self.assertAlmostEqual(beat_to_time(project, 1, 1), .2)
        self.assertAlmostEqual(beat_to_time(project, 1, 2.5), .625)
        self.assertAlmostEqual(beat_to_time(project, 2, 1), 1.95)
        self.assertEqual(time_to_beat(project, 1.95), (2, 1))
        shifted = project.model_copy(update={"offset": .6})
        self.assertAlmostEqual(beat_to_time(shifted, 1, 1), .6)
        self.assertAlmostEqual(beat_to_time(shifted, 1, 2.5), 1.025)
        self.assertAlmostEqual(beat_to_time(shifted, 0, 6.5), .475)
        self.assertEqual(time_to_beat(shifted, .475), (0, 6.5))

    def test_malformed_timeline_is_rejected(self):
        for values in ({"bpm": float("nan")}, {"meter": "5/3"}, {"beatTimes": [1, .8]},
                       {"lyrics": [{"id": "bad", "text": "x", "start": 2, "end": 1}]},
                       {"chords": [{"id": "bad", "bar": 1, "beat": 5, "label": "C"}]},
                       {"notes": [{"id": "bad", "midi": 36, "start": 0, "duration": 1, "string": 5}]}):
            with self.assertRaises(ValidationError):
                sample_project(**values)

    def test_project_id_and_media_traversal(self):
        for project_id in ("../demo", "C:\\Windows", "demo/../../", "not-an-id"):
            with self.assertRaises(ValueError):
                storage.project_dir(project_id)
        response = self.client.get("/media/demo/..%5C..%5Csecret.wav")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client.get("/media/demo/project.json").status_code, 404)
        self.assertEqual(self.client.get("/api/unknown").status_code, 404)

    def test_manual_edit_and_deletion_survive_reanalysis(self):
        old = sample_project()
        storage.save(old)
        new = old.model_copy(deep=True)
        new.chords[0].label = "Fm7"
        new.lyrics[0].text = "人工修正"
        new.notes = []
        saved = storage.save_user_edit(old, new)
        result = {"chords": [Chord(id="c1", bar=1, beat=1, label="G", source="analysis")],
                  "lyrics": [Lyric(id="l1", text="替换", start=1, end=3, source="analysis")],
                  "notes": [Note(id="n1", midi=40, start=1, duration=.5, source="analysis")]}
        merged = storage.merge_candidates(saved, result)
        self.assertEqual(merged.chords[0].label, "Fm7")
        self.assertTrue(merged.chords[0].locked)
        self.assertEqual(merged.lyrics[0].text, "人工修正")
        self.assertEqual(merged.notes, [])

    def test_manual_grid_and_sections_are_preserved(self):
        old = sample_project()
        storage.save(old)
        new = old.model_copy(deep=True)
        new.bpm, new.offset, new.key, new.originalKey = 100, .8, "D", "Bb"
        new.sections = [Section(id="custom", name="自定义主歌", startBar=1, endBar=4)]
        saved = storage.save_user_edit(old, new)
        merged = storage.merge_candidates(saved, {"bpm": 160, "offset": 0, "key": "F", "originalKey": "F",
              "sections": [Section(id="automatic", name="候选", startBar=1, endBar=8)],
              "chords": [Chord(id="new", bar=1, beat=1, label="F", source="analysis")]})
        self.assertEqual((merged.bpm, merged.offset, merged.key), (100, .8, "D"))
        self.assertEqual(merged.originalKey, "Bb")
        self.assertEqual(merged.sections[0].name, "自定义主歌")
        self.assertEqual(merged.chords[0].label, "C")

    def test_save_conflict_and_server_owned_media(self):
        project = sample_project()
        storage.save(project)
        payload = project.model_dump()
        payload["title"] = "保存后"
        payload["duration"] = 300
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["duration"], 20)
        self.assertEqual(response.json()["revision"], 2)
        self.assertEqual(self.client.put(f"/api/projects/{PROJECT_ID}", json=payload).status_code, 409)

    def test_audio_upload_and_invalid_extension(self):
        stream = io.BytesIO()
        rate = 22050
        sf.write(stream, np.sin(np.arange(rate) / rate * 2 * np.pi * 110) * .15, rate, format="WAV")
        response = self.client.post("/api/projects/upload", files={"file": ("original.wav", stream.getvalue(), "audio/wav")})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertAlmostEqual(data["duration"], 1, places=2)
        self.assertTrue(data["stems"][0]["available"])
        self.assertEqual(self.client.get(data["stems"][0]["url"]).status_code, 200)
        self.assertEqual(self.client.post("/api/projects/upload", files={"file": ("bad.txt", b"hello")}).status_code, 415)

    @unittest.skipUnless(audio.ffmpeg_path(), "FFmpeg is required for format conversion")
    def test_real_mp3_flac_m4a_import(self):
        directory = Path(self.temporary.name) / "format-fixtures"
        directory.mkdir()
        source = directory / "fixture.wav"
        rate = 22050
        sf.write(source, np.sin(np.arange(rate * 2) / rate * 2 * np.pi * 110) * .15, rate)
        for suffix, codec in ((".mp3", "libmp3lame"), (".flac", "flac"), (".m4a", "aac")):
            with self.subTest(format=suffix):
                encoded = directory / ("fixture" + suffix)
                process = subprocess.run([audio.ffmpeg_path(), "-v", "error", "-nostdin", "-y",
                                          "-i", str(source), "-c:a", codec, str(encoded)],
                                         capture_output=True, timeout=30)
                self.assertEqual(process.returncode, 0, process.stderr.decode(errors="replace"))
                response = self.client.post("/api/projects/upload",
                                            files={"file": (encoded.name, encoded.read_bytes(), "audio/octet-stream")})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertAlmostEqual(response.json()["duration"], 2, delta=.15)
                self.assertTrue(response.json()["stems"][0]["peaks"])
                self.assertEqual(self.client.get(response.json()["stems"][0]["url"]).status_code, 200)

    def test_analysis_merges_latest_edit(self):
        project = sample_project()
        storage.save(project)
        sf.write(storage.project_dir(PROJECT_ID) / "original.wav", np.zeros(22050), 11025)

        def analysis_with_concurrent_edit(*_args, **_kwargs):
            latest = storage.load(PROJECT_ID)
            edited = latest.model_copy(deep=True)
            edited.chords[0].label = "Dm7"
            storage.save_user_edit(latest, edited)
            return {"bpm": 120, "offset": 0, "key": "C", "originalKey": "C", "sections": [],
                    "chords": [Chord(id="c1", bar=1, beat=1, label="G", source="analysis")], "warnings": []}

        with patch.object(audio, "analyze_bass_roots", side_effect=analysis_with_concurrent_edit):
            run_analysis(PROJECT_ID, AnalyzeRequest(source="uploaded_bass"))
        self.assertEqual(storage.load(PROJECT_ID).chords[0].label, "Dm7")
        self.assertEqual(storage.load(PROJECT_ID).analysis.state, "complete")
        self.assertEqual(storage.load(PROJECT_ID).revision, 5)
        dirty = storage.load(PROJECT_ID).model_dump()
        dirty["title"] = "仍在编辑的标题"
        dirty["revision"] = 2
        self.assertEqual(self.client.put(f"/api/projects/{PROJECT_ID}", json=dirty).status_code, 409)
        dirty["revision"] = storage.load(PROJECT_ID).revision
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=dirty)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["title"], "仍在编辑的标题")
        self.assertEqual(response.json()["chords"][0]["label"], "Dm7")

    def test_fingering_is_playable_and_preserves_pitch(self):
        notes = [Note(id=str(index), midi=pitch, start=index, duration=.5)
                 for index, pitch in enumerate((28, 33, 36, 43, 48, 52))]
        result = audio.recommend_fingering(notes)
        tuning = {1: 43, 2: 38, 3: 33, 4: 28}
        for note in result:
            self.assertEqual(tuning[note.string] + note.fret, note.midi)

    def test_real_synthetic_audio_analysis_and_manual_protection(self):
        demo = ensure_demo()
        directory = storage.project_dir("demo")
        candidates = audio.analyze_basic(demo, directory / "original.wav")
        self.assertAlmostEqual(candidates["bpm"], 96, delta=3)
        self.assertGreater(len(candidates["chords"]), 20)
        self.assertGreater(len(candidates["sections"]), 1)
        self.assertTrue(candidates["warnings"])
        transcribed = audio.transcribe_bass(directory / "bass.wav")
        self.assertGreater(len(transcribed), 100)
        # Original demonstration opens with C2-G2-C2-C3-A1-E2.
        self.assertEqual([note.midi for note in transcribed[:6]], [36, 43, 36, 48, 33, 40])
        edited = demo.model_copy(deep=True)
        edited.bpm = 100
        edited.chords[0].label = "C6"
        edited.notes[0].midi = 37
        storage.save_user_edit(demo, edited)
        run_analysis("demo", AnalyzeRequest(transcribe=True))
        analyzed = storage.load("demo")
        self.assertEqual(analyzed.analysis.state, "complete")
        self.assertEqual(analyzed.analysis.progress, 100)
        self.assertEqual(analyzed.bpm, 100)
        self.assertEqual(analyzed.chords[0].label, "C6")
        self.assertEqual(analyzed.notes[0].midi, 37)
        self.assertTrue(analyzed.notes[0].locked)

    def test_non_four_four_real_analysis_json_validates(self):
        demo = ensure_demo()
        directory = storage.project_dir("demo")
        for meter, positions in (("2/4", {1, 2}), ("3/4", {1, 2.5}), ("6/8", {1, 4}), ("7/8", {1, 4.5})):
            with self.subTest(meter=meter):
                project = demo.model_copy(deep=True)
                project.meter = meter
                project.chords = []
                project.sections = []
                result = audio.analyze_basic(project, directory / "original.wav")
                self.assertTrue(result["chords"])
                self.assertTrue(all(chord.beat in positions for chord in result["chords"]))
                calculated = project.model_copy(update={"bpm": result["bpm"], "offset": result["offset"]})
                expected = max(1, int(np.ceil((project.duration - result["offset"]) /
                                             (beat_seconds(calculated) * int(meter.split("/")[0])))))
                self.assertEqual(result["sections"][-1].endBar, expected)
                merged = storage.merge_candidates(project, result)
                reparsed = Project.model_validate_json(merged.model_dump_json())
                self.assertEqual(reparsed.meter, meter)

    def test_sqlite_index_updates_and_backfills_from_authoritative_json(self):
        project = sample_project()
        storage.save(project)
        self.assertTrue(storage.index_path().is_file())
        with storage.connect_index() as connection:
            row = connection.execute("SELECT title,revision,path FROM projects WHERE id=?", (PROJECT_ID,)).fetchone()
        self.assertEqual(row, (project.title, 1, f"{PROJECT_ID}/project.json"))
        edited = project.model_copy(deep=True)
        edited.title = "索引更新"
        storage.save_user_edit(project, edited)
        with storage.connect_index() as connection:
            row = connection.execute("SELECT title,revision FROM projects WHERE id=?", (PROJECT_ID,)).fetchone()
        self.assertEqual(row, ("索引更新", 2))
        storage.index_path().unlink()
        listed = storage.list_projects()
        self.assertEqual(listed[0].title, "索引更新")
        self.assertTrue(storage.index_path().is_file())
        # A corrupt/stale index field must never override the JSON source.
        with storage.connect_index() as connection:
            connection.execute("UPDATE projects SET title='无效旧索引',path='../outside/project.json' WHERE id=?", (PROJECT_ID,))
        self.assertEqual(storage.list_projects()[0].title, "索引更新")
        with storage.connect_index() as connection:
            row = connection.execute("SELECT path FROM projects WHERE id=?", (PROJECT_ID,)).fetchone()
        self.assertEqual(row[0], f"{PROJECT_ID}/project.json")

    def test_chord_intervals_recompute_from_grid_and_clamp(self):
        project = sample_project(duration=3, offset=.2, beatTimes=[.2, .4, .9, 1.3, 1.9], chords=[
            Chord(id="late", bar=100, beat=1, label="G", source="analysis"),
            Chord(id="second", bar=1, beat=3, label="Am", source="analysis"),
            Chord(id="first", bar=1, beat=1, label="C", source="analysis"),
        ])
        storage.save(project)
        persisted = json.loads((storage.project_dir(PROJECT_ID) / "project.json").read_text(encoding="utf-8"))
        intervals = {chord["id"]: (chord["start"], chord["end"]) for chord in persisted["chords"]}
        self.assertAlmostEqual(intervals["first"][0], .2)
        self.assertAlmostEqual(intervals["first"][1], .9)
        self.assertAlmostEqual(intervals["second"][0], .9)
        self.assertEqual(intervals["second"][1], 3)
        self.assertEqual(intervals["late"], (3, 3))
        old = storage.load(PROJECT_ID)
        edited = old.model_copy(deep=True)
        edited.beatTimes = []
        edited.offset = .1
        edited.bpm = 60
        # Derived fields are not human edits, even when an old client omits them.
        for chord in edited.chords:
            chord.start = chord.end = 0
        result = storage.save_user_edit(old, edited)
        first = next(chord for chord in result.chords if chord.id == "first")
        self.assertAlmostEqual(first.start, .1)
        self.assertAlmostEqual(first.end, 2.1)
        self.assertEqual(first.source, "analysis")
        self.assertFalse(first.locked)

    def test_restart_marks_unowned_running_analysis_as_error(self):
        project = sample_project(analysis=Analysis(state="running", stage="旧任务", progress=55))
        storage.save(project)
        with TestClient(app) as client:
            response = client.get(f"/api/projects/{PROJECT_ID}")
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["analysis"]["state"], "error")
        self.assertTrue(any("本次服务进程" in warning for warning in result["analysis"]["warnings"]))
        self.assertEqual(result["revision"], 1)
        self.assertEqual(result["chords"][0]["label"], "C")

    def test_tempo_analysis_replaces_only_automatic_grid(self):
        project = sample_project(beatTimes=[0, .5, 1.1, 1.8, 2.5])
        storage.save(project)
        changed = storage.merge_candidates(project, {"bpm": 100, "offset": .2})
        self.assertEqual(changed.beatTimes, [])
        self.assertAlmostEqual(beat_to_time(changed, 1, 3), 1.4)
        edited = changed.model_copy(deep=True)
        edited.beatTimes = [.2, .6, 1.1, 1.7]
        saved = storage.save_user_edit(changed, edited)
        protected = storage.merge_candidates(saved, {"bpm": 160, "offset": 0, "beatTimes": [0, .3, .6]})
        self.assertEqual(protected.beatTimes, [.2, .6, 1.1, 1.7])
        self.assertEqual(protected.bpm, 100)
        self.assertAlmostEqual(beat_to_time(protected, 1, 3), 1.1)


if __name__ == "__main__":
    unittest.main()
