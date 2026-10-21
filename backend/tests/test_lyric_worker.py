import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend import lyric_worker, lyrics
from backend.models import DetectedSegment, DetectedWord


class LyricWorkerTests(unittest.TestCase):
    def test_current_python_is_preferred_when_it_can_import_the_model(self):
        with patch.object(lyrics, "_direct_whisper_capabilities", return_value={"available": True, "installed": True, "error": None}), \
             patch.object(lyrics, "worker_python") as worker:
            result = lyrics.whisper_capabilities()
        self.assertTrue(result["whisper"])
        self.assertEqual(result["whisperRuntime"], "direct")
        worker.assert_not_called()

    def test_available_worker_is_reported_by_health_and_import_probe_is_cached(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "__init__.py"
            marker.touch()
            executable = Path(sys.executable)
            process = SimpleNamespace(returncode=0, stdout=json.dumps({"available": True, "installed": True, "error": None}), stderr="")
            with patch.dict(lyrics._WORKER_PROBES, {}, clear=True), \
                 patch.object(lyrics, "_direct_whisper_capabilities", return_value={"available": False, "installed": False, "error": None}), \
                 patch.object(lyrics, "worker_python", return_value=executable), \
                 patch.object(lyrics, "_module_marker", return_value=marker), \
                 patch.object(lyrics.subprocess, "run", return_value=process) as run:
                first = lyrics.whisper_capabilities()
                second = lyrics.whisper_capabilities()
            self.assertTrue(first["whisper"])
            self.assertTrue(second["whisperInstalled"])
            self.assertEqual(first["whisperRuntime"], "worker")
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0], [str(executable), "-m", "backend.lyric_worker", "--probe"])
            self.assertEqual(run.call_args.kwargs["cwd"], lyrics.PROJECT_ROOT)
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_worker_dispatch_uses_argument_array_and_validates_timed_result(self):
        segment = DetectedSegment(id="recognized", text="原唱歌词", start=2, end=4, confidence=.9,
                                  words=[DetectedWord(text="原唱歌词", start=2, end=4, confidence=.9)])
        process = SimpleNamespace(returncode=0, stdout=json.dumps({"ok": True, "segments": [segment.model_dump()]}, ensure_ascii=True), stderr="")
        with patch.object(lyrics, "require_whisper", return_value="worker"), \
             patch.object(lyrics, "worker_python", return_value=Path(sys.executable)), \
             patch.object(lyrics.subprocess, "run", return_value=process) as run:
            result = lyrics.FasterWhisperLyrics().transcribe(Path("vocal file.wav"), model="tiny", language="zh", start=1, end=5)
        self.assertEqual(result[0].text, "原唱歌词")
        self.assertEqual((result[0].start, result[0].end), (2, 4))
        self.assertEqual(run.call_args.args[0], [sys.executable, "-m", "backend.lyric_worker"])
        request = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(request["model"], "tiny")
        self.assertEqual(request["start"], 1)
        self.assertTrue(Path(request["vocals"]).is_absolute())
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_worker_errors_and_malformed_output_are_not_successful_recognition(self):
        cases = [SimpleNamespace(returncode=1, stdout='{"ok": false, "error": "模型下载失败"}', stderr=""),
                 SimpleNamespace(returncode=0, stdout="not-json", stderr=""),
                 SimpleNamespace(returncode=0, stdout='{"ok": true, "segments": "instructions"}', stderr="")]
        for process in cases:
            with self.subTest(output=process.stdout), patch.object(lyrics, "worker_python", return_value=Path(sys.executable)), \
                 patch.object(lyrics.subprocess, "run", return_value=process):
                with self.assertRaises(RuntimeError):
                    lyrics._run_worker(Path("vocals.wav"), model="tiny", language=None, start=0, end=5)
        with patch.object(lyrics, "worker_python", return_value=Path(sys.executable)), \
             patch.object(lyrics.subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 3600)):
            with self.assertRaisesRegex(RuntimeError, "超过 60 分钟"):
                lyrics._run_worker(Path("vocals.wav"), model="tiny", language=None, start=0, end=5)

    def test_worker_keeps_library_stdout_out_of_json_protocol(self):
        with tempfile.TemporaryDirectory() as temporary:
            vocals = Path(temporary) / "vocals.wav"
            vocals.touch()
            data = {"vocals": str(vocals), "model": "tiny", "start": 1, "end": 4}
            output, logs = io.StringIO(), io.StringIO()
            def transcribe(*_args, **_kwargs):
                print("third-party library log")
                return [DetectedSegment(id="one", text="词", start=1, end=2, confidence=.9)]
            with patch.object(sys, "argv", ["lyric_worker"]), patch.object(sys, "stdin", io.StringIO(json.dumps(data))), \
                 contextlib.redirect_stdout(output), contextlib.redirect_stderr(logs), \
                 patch.object(lyrics, "_direct_whisper_capabilities", return_value={"available": True, "installed": True, "error": None}), \
                 patch.object(lyrics.FasterWhisperLyrics, "transcribe_local", side_effect=transcribe):
                code = lyric_worker.main()
            self.assertEqual(code, 0)
            result = json.loads(output.getvalue())
            self.assertTrue(result["ok"])
            self.assertEqual(result["segments"][0]["text"], "词")
            self.assertIn("third-party library log", logs.getvalue())

    def test_real_probe_process_returns_json_from_fixed_project_module(self):
        process = subprocess.run([sys.executable, "-m", "backend.lyric_worker", "--probe"],
                                 cwd=lyrics.PROJECT_ROOT, capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        self.assertIsInstance(result["available"], bool)
        self.assertIsInstance(result["installed"], bool)


if __name__ == "__main__":
    unittest.main()
