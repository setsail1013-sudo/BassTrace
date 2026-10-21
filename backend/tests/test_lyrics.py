import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import adapters, lyrics, main, storage
from backend.models import (AlignmentLine, DetectedSegment, DetectedWord, Lyric, LyricAlignment,
                            Note, NoteNotation, Project, Stem)


PROJECT_ID = "b425ca93-71cc-4b5a-bf3c-a1dc2b9cb9ca"


def detected(text, start, end, confidence=.95):
    return DetectedSegment(id="detected-0", text=text, start=start, end=end, confidence=confidence,
                           words=[DetectedWord(text=text, start=start, end=end, confidence=confidence)])


def sample_project(**changes):
    fields = dict(id=PROJECT_ID, title="歌词测试", duration=20,
                  lyrics=[Lyric(id="line-1", text="城市的灯慢慢亮起", start=1, end=3, source="manual", locked=True)],
                  lyricsOriginal="城市的灯慢慢亮起")
    fields.update(changes)
    return Project(**fields)


class LyricTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(storage, "DATA_ROOT", Path(self.temporary.name))
        self.root_patch.start()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        self.root_patch.stop()
        self.temporary.cleanup()

    def with_vocals(self, **changes):
        project = sample_project(**changes)
        directory = storage.project_dir(project.id)
        directory.mkdir(parents=True, exist_ok=True)
        rate = 8000
        sf.write(directory / "vocals.wav", np.zeros(rate * 20, dtype=np.float32), rate)
        project.stems = [Stem(id="vocals", name="人声", available=True, url=f"/media/{project.id}/vocals.wav")]
        storage.save(project)
        return project

    def queued_job(self, payload):
        executor = MagicMock()
        with patch.object(main, "EXECUTOR", executor), patch.object(lyrics, "require_whisper"):
            response = self.client.post(f"/api/projects/{PROJECT_ID}/lyrics/align", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        submitted = executor.submit.call_args.args
        return response.json(), submitted

    def test_note_notation_is_optional_and_never_replaces_recorded_seconds(self):
        old = Note(id="old", midi=40, start=0, duration=.37)
        self.assertIsNone(old.notation)
        for value in (1, 2, 4, 8, 16, 32):
            note = Note(id=str(value), midi=40, start=1.25, duration=.37,
                        notation=NoteNotation(value=value, dotted=True, ghost=True, tie=True, slur=True))
            restored = Note.model_validate_json(note.model_dump_json())
            self.assertEqual(restored.duration, .37)
            self.assertEqual(restored.start, 1.25)
            self.assertTrue(restored.notation.dotted)
        for invalid in (0, -1, float("nan")):
            with self.assertRaises(ValidationError):
                Note(id="bad", midi=40, start=0, duration=invalid, notation={"value": 4})
        with self.assertRaises(ValidationError):
            NoteNotation(value=3)
        old_project = Project.model_validate({"id": PROJECT_ID, "title": "旧工程", "duration": 20})
        self.assertEqual(old_project.lyricsOriginal, "")
        self.assertEqual(old_project.lyricAlignment.state, "idle")

    def test_exact_chinese_and_english_lines_preserve_user_text_with_timed_candidates(self):
        original = "城市的灯慢慢亮起\nHello, WORLD!"
        segments = [detected("城市的灯慢慢亮起", 4, 7), detected("hello, world!", 8, 10)]
        aligned = lyrics.align_text(original, segments)
        self.assertEqual([line.text for line in aligned], original.splitlines())
        self.assertEqual([line.status for line in aligned], ["matched", "matched"])
        self.assertEqual([(line.start, line.end) for line in aligned], [(4, 7), (8, 10)])
        self.assertEqual(aligned[1].detectedText, "hello, world!")
        self.assertTrue(any(item.kind == "replace" for item in aligned[1].diff))

    def test_missing_text_low_confidence_and_ambiguous_repeats_remain_pending(self):
        cases = [("城市的灯慢慢亮起", [detected("慢慢", 4, 5)]),
                 ("Hello world", [detected("Hello world", 1, 3, .2)]),
                 ("啦啦啦", [detected("啦啦啦", 1, 2), detected("啦啦啦", 5, 6)]),
                 ("完全没有匹配", [])]
        for original, segments in cases:
            with self.subTest(original=original):
                line = lyrics.align_text(original, segments)[0]
                self.assertEqual(line.status, "pending")
                self.assertIsNone(line.start)
                self.assertIsNone(line.end)
                self.assertEqual(line.text, original)
        repeated = lyrics.align_text("啦啦啦\n啦啦啦", [detected("啦啦啦", 1, 2), detected("啦啦啦", 5, 6)])
        self.assertEqual([(line.start, line.end) for line in repeated], [(1, 2), (5, 6)])

    def test_locked_lyrics_keep_their_text_and_time_while_exposing_separate_candidates(self):
        project = sample_project()
        lines = lyrics.align_text(project.lyricsOriginal, [detected(project.lyricsOriginal, 5, 8)], project.lyrics)
        self.assertEqual(lines[0].status, "manual")
        self.assertEqual((lines[0].start, lines[0].end), (5, 8))
        lyrics.apply_alignment(project, lines)
        self.assertEqual((project.lyrics[0].start, project.lyrics[0].end), (1, 3))
        self.assertEqual(project.lyrics[0].text, project.lyricsOriginal)
        self.assertTrue(project.lyrics[0].locked)

    def test_only_reliable_unlocked_lines_are_applied_and_no_pending_time_is_fabricated(self):
        project = sample_project(lyrics=[])
        lines = lyrics.align_text("城市的灯慢慢亮起\n从未被识别", [detected("城市的灯慢慢亮起", 5, 8)])
        lyrics.apply_alignment(project, lines)
        self.assertEqual(len(project.lyrics), 1)
        self.assertEqual(project.lyrics[0].text, "城市的灯慢慢亮起")
        self.assertEqual(project.lyrics[0].source, "analysis")
        self.assertFalse(project.lyrics[0].locked)
        self.assertEqual(lines[1].status, "pending")
        self.assertIsNone(lines[1].start)

    def test_missing_vocals_and_dependency_have_clear_errors_without_fake_results(self):
        storage.save(sample_project())
        response = self.client.post(f"/api/projects/{PROJECT_ID}/lyrics/align", json={})
        self.assertEqual(response.status_code, 422)
        self.assertIn("独立人声", response.json()["detail"])
        project = self.with_vocals()
        with patch.object(lyrics, "require_whisper", side_effect=lyrics.LyricsDependencyError("请安装 requirements-ai.txt")):
            response = self.client.post(f"/api/projects/{PROJECT_ID}/lyrics/align", json={})
        self.assertEqual(response.status_code, 503)
        persisted = storage.load(PROJECT_ID)
        self.assertEqual(persisted.revision, project.revision)
        self.assertEqual(persisted.lyricAlignment.detectedSegments, [])
        self.assertEqual(persisted.lyricsOriginal, project.lyricsOriginal)
        self.assertEqual(persisted.lyrics[0].start, 1)

    def test_vocal_path_must_stay_inside_the_project_directory(self):
        project = self.with_vocals()
        for url in ("https://invalid.example/vocals.wav", f"/media/{PROJECT_ID}/../../outside.wav"):
            project.stems[0].url = url
            storage.save(project)
            response = self.client.post(f"/api/projects/{PROJECT_ID}/lyrics/align", json={})
            self.assertEqual(response.status_code, 422)

    def test_async_alignment_saves_original_and_detected_drafts_independently(self):
        project = self.with_vocals(lyrics=[])
        original = "  城市的灯慢慢亮起  \n未唱出的下一句"
        queued, submitted = self.queued_job({"originalText": original, "revision": project.revision})
        self.assertEqual(queued["lyricsOriginal"], original)
        self.assertEqual(queued["lyricAlignment"]["state"], "running")
        self.assertEqual(queued["revision"], project.revision + 1)
        with patch.object(adapters.DEFAULT.lyrics, "transcribe", return_value=[detected("城市的灯慢慢亮起", 5, 8)]):
            submitted[0](*submitted[1:])
        result = storage.load(PROJECT_ID)
        self.assertEqual(result.lyricsOriginal, original)
        self.assertEqual(result.lyricAlignment.state, "complete")
        self.assertEqual(result.lyricAlignment.detectedSegments[0].text, "城市的灯慢慢亮起")
        self.assertEqual(result.lyricAlignment.lines[0].text, "城市的灯慢慢亮起")
        self.assertEqual(result.lyricAlignment.lines[1].status, "pending")
        self.assertEqual(result.lyrics[0].text, "城市的灯慢慢亮起")

    def test_lrc_metadata_and_multiple_timestamps_link_existing_tokens_in_time_order(self):
        original = "[ar:Original artist]\n[ti:Original title]\n[offset:100]\n[00:02.00][00:08.00]City lights are shining.\n[00:05.00]Keep the rhythm moving."
        existing = [Lyric(id="late", text="City lights are shining.", start=8.1, end=9, locked=True),
                    Lyric(id="middle", text="Keep the rhythm moving.", start=5.1, end=6, locked=True),
                    Lyric(id="early", text="City lights are shining.", start=2.1, end=3, locked=True)]
        project = sample_project(lyrics=existing, lyricsOriginal=original)
        before = [(item.id, item.text, item.start, item.end) for item in project.lyrics]
        segments = [detected("City lights are shining.", 2, 3), detected("Keep the rhythm moving.", 5, 6),
                    detected("City lights are shining.", 8, 9)]
        lines = lyrics.align_text(original, segments, project.lyrics)
        self.assertEqual([item.lyricId for item in lines], ["early", "middle", "late"])
        self.assertEqual([item.status for item in lines], ["manual"] * 3)
        self.assertEqual([item.text for item in lines], ["City lights are shining.", "Keep the rhythm moving.", "City lights are shining."])
        lyrics.apply_alignment(project, lines)
        self.assertEqual(len(project.lyrics), 3)
        self.assertEqual(sorted((item.id, item.text, item.start, item.end) for item in project.lyrics), sorted(before))
        self.assertEqual(project.lyricsOriginal, original)

    def test_indented_txt_links_trimmed_imported_tokens_without_creating_duplicates(self):
        original = "  城市的灯慢慢亮起  \n\t让节奏陪我们前行\t"
        project = sample_project(lyricsOriginal=original, lyrics=[
            Lyric(id="first", text="城市的灯慢慢亮起", start=1, end=3, locked=True),
            Lyric(id="second", text="让节奏陪我们前行", start=4, end=6, locked=True)])
        lines = lyrics.align_text(original, [detected("城市的灯慢慢亮起", 2, 3), detected("让节奏陪我们前行", 5, 6)], project.lyrics)
        self.assertEqual([item.lyricId for item in lines], ["first", "second"])
        lyrics.apply_alignment(project, lines)
        self.assertEqual([item.id for item in project.lyrics], ["first", "second"])
        self.assertEqual([(item.start, item.end) for item in project.lyrics], [(1, 3), (4, 6)])
        self.assertEqual(project.lyricsOriginal, original)

    def test_lrc_async_alignment_preserves_document_and_locked_imported_timings(self):
        original = "[ti:City]\n[ar:Original]\n[00:01.00][00:06.00]City lights are shining."
        project = self.with_vocals(lyricsOriginal=original, lyrics=[
            Lyric(id="first", text="City lights are shining.", start=1, end=2, locked=True),
            Lyric(id="second", text="City lights are shining.", start=6, end=7, locked=True)])
        _, submitted = self.queued_job({})
        with patch.object(adapters.DEFAULT.lyrics, "transcribe", return_value=[
                detected("City lights are shining.", 1.1, 2.1), detected("City lights are shining.", 6.1, 7.1)]):
            submitted[0](*submitted[1:])
        saved = storage.load(PROJECT_ID)
        self.assertEqual(saved.lyricsOriginal, original)
        self.assertEqual(len(saved.lyrics), 2)
        self.assertEqual([(item.id, item.text, item.start, item.end) for item in saved.lyrics],
                         [(item.id, item.text, item.start, item.end) for item in project.lyrics])
        self.assertEqual([item.lyricId for item in saved.lyricAlignment.lines], ["first", "second"])

    def test_recognition_only_does_not_replace_the_original_or_create_user_lyrics(self):
        self.with_vocals()
        _, submitted = self.queued_job({"mode": "recognize"})
        with patch.object(adapters.DEFAULT.lyrics, "transcribe", return_value=[detected("另一份识别初稿", 5, 8)]):
            submitted[0](*submitted[1:])
        result = storage.load(PROJECT_ID)
        self.assertEqual(result.lyricsOriginal, "城市的灯慢慢亮起")
        self.assertEqual(result.lyrics[0].text, "城市的灯慢慢亮起")
        self.assertEqual(result.lyrics[0].start, 1)
        self.assertEqual(result.lyricAlignment.detectedSegments[0].text, "另一份识别初稿")
        self.assertEqual(result.lyricAlignment.lines, [])

    def test_single_sentence_rerun_uses_its_interval_and_keeps_other_candidates(self):
        project = self.with_vocals(lyricAlignment=LyricAlignment(
            state="complete", detectedSegments=[detected("别的段落", 10, 12)],
            lines=[AlignmentLine(id="other", lyricId="other", text="别的段落", status="pending")]))
        _, submitted = self.queued_job({"lyricId": "line-1"})
        with patch.object(adapters.DEFAULT.lyrics, "transcribe", return_value=[detected(project.lyricsOriginal, 1.1, 2.8)]) as transcribe:
            submitted[0](*submitted[1:])
        self.assertEqual(transcribe.call_args.kwargs["start"], 1)
        self.assertEqual(transcribe.call_args.kwargs["end"], 3)
        result = storage.load(PROJECT_ID)
        self.assertEqual(len(result.lyricAlignment.detectedSegments), 2)
        self.assertTrue(any(line.lyricId == "other" for line in result.lyricAlignment.lines))
        self.assertEqual((result.lyrics[0].start, result.lyrics[0].end), (1, 3))

    def test_concurrent_manual_edit_and_original_change_supersede_old_candidates(self):
        self.with_vocals()
        _, submitted = self.queued_job({})
        old = storage.load(PROJECT_ID)
        edited = old.model_copy(deep=True)
        edited.lyrics[0].start, edited.lyrics[0].end = 7, 9
        storage.save_user_edit(old, edited)
        with patch.object(adapters.DEFAULT.lyrics, "transcribe", return_value=[detected("城市的灯慢慢亮起", 4, 6)]):
            submitted[0](*submitted[1:])
        result = storage.load(PROJECT_ID)
        self.assertEqual((result.lyrics[0].start, result.lyrics[0].end), (7, 9))
        _, submitted = self.queued_job({})
        old = storage.load(PROJECT_ID)
        edited = old.model_copy(deep=True)
        edited.lyricsOriginal = "更新后的真实原文"
        saved = storage.save_user_edit(old, edited)
        with patch.object(adapters.DEFAULT.lyrics, "transcribe", return_value=[detected("城市的灯慢慢亮起", 1, 3)]):
            submitted[0](*submitted[1:])
        result = storage.load(PROJECT_ID)
        self.assertEqual(result.lyricsOriginal, "更新后的真实原文")
        self.assertEqual(result.lyricAlignment.state, "idle")
        self.assertEqual(result.revision, saved.revision)

    def test_failed_model_does_not_modify_original_text_or_manual_times(self):
        self.with_vocals()
        _, submitted = self.queued_job({})
        with patch.object(adapters.DEFAULT.lyrics, "transcribe", side_effect=RuntimeError("模型下载失败")), self.assertLogs(level="ERROR"):
            submitted[0](*submitted[1:])
        result = storage.load(PROJECT_ID)
        self.assertEqual(result.lyricAlignment.state, "error")
        self.assertIn("模型下载失败", result.lyricAlignment.error)
        self.assertEqual(result.lyricsOriginal, "城市的灯慢慢亮起")
        self.assertEqual((result.lyrics[0].start, result.lyrics[0].end), (1, 3))
        self.assertEqual(result.lyricAlignment.detectedSegments, [])

    def test_sentence_rerun_does_not_reapply_other_old_candidates(self):
        self.with_vocals(lyricAlignment=LyricAlignment(state="complete", lines=[
            AlignmentLine(id="deleted", lyricId="deleted", text="已删除的别句", start=10, end=12,
                          status="matched", confidence=.95)]))
        _, submitted = self.queued_job({"lyricId": "line-1"})
        with patch.object(adapters.DEFAULT.lyrics, "transcribe", return_value=[detected("城市的灯慢慢亮起", 1, 3)]):
            submitted[0](*submitted[1:])
        self.assertEqual([item.id for item in storage.load(PROJECT_ID).lyrics], ["line-1"])

    def test_sentence_changed_during_recognition_has_no_stale_time_candidate(self):
        self.with_vocals()
        _, submitted = self.queued_job({"lyricId": "line-1"})
        old = storage.load(PROJECT_ID)
        edited = old.model_copy(deep=True)
        edited.lyrics[0].text = "用户修改了这一句"
        storage.save_user_edit(old, edited)
        with patch.object(adapters.DEFAULT.lyrics, "transcribe", return_value=[detected("城市的灯慢慢亮起", 1, 3)]), self.assertLogs(level="ERROR"):
            submitted[0](*submitted[1:])
        result = storage.load(PROJECT_ID)
        self.assertEqual(result.lyrics[0].text, "用户修改了这一句")
        self.assertEqual(result.lyricAlignment.state, "error")
        self.assertIn("片段在识别期间已修改", result.lyricAlignment.error)

    def test_old_client_save_retains_original_and_running_task_state(self):
        project = self.with_vocals()
        _, submitted = self.queued_job({})
        old_client = project.model_dump()
        old_client.pop("lyricsOriginal")
        old_client.pop("lyricAlignment")
        old_client["revision"] = storage.load(PROJECT_ID).revision
        old_client["title"] = "旧客户端标题"
        response = self.client.put(f"/api/projects/{PROJECT_ID}", json=old_client)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["lyricsOriginal"], project.lyricsOriginal)
        self.assertEqual(response.json()["lyricAlignment"]["state"], "running")
        self.assertEqual(response.json()["lyricAlignment"]["jobId"], submitted[3])

    def test_invalid_interval_revision_and_empty_alignment_are_rejected(self):
        project = self.with_vocals(lyrics=[], lyricsOriginal="")
        with patch.object(lyrics, "require_whisper"):
            for payload, code in (({"revision": 99}, 409), ({"start": 3, "end": 2}, 422),
                                  ({"end": 30}, 422), ({}, 422), ({"lyricId": "missing"}, 404)):
                response = self.client.post(f"/api/projects/{PROJECT_ID}/lyrics/align", json=payload)
                self.assertEqual(response.status_code, code, response.text)
        self.assertEqual(storage.load(PROJECT_ID).revision, project.revision)

    def test_restart_marks_an_unowned_lyric_task_as_failed(self):
        self.with_vocals(lyricAlignment=LyricAlignment(state="running", jobId="old-job"))
        with TestClient(main.app) as client:
            result = client.get(f"/api/projects/{PROJECT_ID}").json()
        self.assertEqual(result["lyricAlignment"]["state"], "error")
        self.assertIn("服务已重启", result["lyricAlignment"]["error"])
        self.assertEqual(result["lyricsOriginal"], "城市的灯慢慢亮起")

    def test_faster_whisper_adapter_resamples_actual_vocal_crop_and_returns_absolute_word_time(self):
        project = self.with_vocals()
        word = SimpleNamespace(word=" hello", start=.25, end=1.5, probability=.9)
        segment = SimpleNamespace(text=" hello", start=.25, end=1.5, words=[word], no_speech_prob=.1, avg_logprob=-.2)
        engine = MagicMock()
        engine.transcribe.return_value = (iter([segment]), SimpleNamespace())
        factory = MagicMock(return_value=engine)
        with patch.object(lyrics, "require_whisper"), patch.dict(lyrics._MODELS, {}, clear=True), \
             patch.object(lyrics.importlib, "import_module", return_value=SimpleNamespace(WhisperModel=factory)):
            result = lyrics.FasterWhisperLyrics().transcribe(storage.project_dir(PROJECT_ID) / "vocals.wav",
                                                           model="tiny", language="en", start=2, end=4)
        samples = engine.transcribe.call_args.args[0]
        self.assertEqual(samples.shape, (32000,))
        self.assertEqual(samples.dtype, np.float32)
        self.assertTrue(engine.transcribe.call_args.kwargs["word_timestamps"])
        self.assertNotIn("initial_prompt", engine.transcribe.call_args.kwargs)
        self.assertEqual((result[0].words[0].start, result[0].words[0].end), (2.25, 3.5))
        self.assertEqual(result[0].confidence, .9)


if __name__ == "__main__":
    unittest.main()
