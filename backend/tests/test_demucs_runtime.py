import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend import audio


class DemucsRuntimeTests(unittest.TestCase):
    def test_default_runtime_keeps_current_python_when_demucs_is_present(self):
        with patch.dict(os.environ, {"BASSCHART_DEMUCS_PYTHON": ""}), \
             patch.object(audio.importlib.util, "find_spec", return_value=object()):
            runtime = audio.demucs_runtime()
        self.assertTrue(runtime["available"])
        self.assertEqual(runtime["python"], sys.executable)

    def test_missing_default_runtime_has_actionable_error(self):
        with patch.dict(os.environ, {"BASSCHART_DEMUCS_PYTHON": ""}), \
             patch.object(audio.importlib.util, "find_spec", return_value=None):
            runtime = audio.demucs_runtime()
        self.assertFalse(runtime["available"])
        self.assertIn("BASSCHART_DEMUCS_PYTHON", runtime["error"])

    def test_explicit_invalid_executable_fails_without_falling_back(self):
        with patch.dict(os.environ, {"BASSCHART_DEMUCS_PYTHON": "Z:/missing/python.exe"}), \
             patch.object(audio.importlib.util, "find_spec", return_value=object()), \
             patch.object(audio.subprocess, "run") as run:
            runtime = audio.demucs_runtime()
        self.assertFalse(runtime["available"])
        self.assertIn("解释器文件不存在", runtime["error"])
        run.assert_not_called()

    def test_existing_independent_runtime_is_probed_once_and_cached(self):
        process = SimpleNamespace(returncode=0, stderr="", stdout="")
        with patch.dict(os.environ, {"BASSCHART_DEMUCS_PYTHON": sys.executable}), \
             patch.dict(audio._DEMUCS_PROBES, {}, clear=True), \
             patch.object(audio.subprocess, "run", return_value=process) as run:
            first, second = audio.demucs_runtime(), audio.demucs_runtime()
        self.assertTrue(first["available"])
        self.assertEqual(second["python"], str(Path(sys.executable).resolve()))
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], [str(Path(sys.executable).resolve()), "-c", "import demucs.separate"])
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_unavailable_external_module_and_timeout_have_clear_errors(self):
        for failure in (SimpleNamespace(returncode=1, stderr="ModuleNotFoundError: No module named demucs", stdout=""),
                        subprocess.TimeoutExpired("python", 30)):
            with self.subTest(failure=failure), patch.dict(os.environ, {"BASSCHART_DEMUCS_PYTHON": sys.executable}), \
                 patch.dict(audio._DEMUCS_PROBES, {}, clear=True):
                with patch.object(audio.subprocess, "run", **({"side_effect": failure} if isinstance(failure, Exception) else {"return_value": failure})):
                    runtime = audio.demucs_runtime()
            self.assertFalse(runtime["available"])
            self.assertIn("独立", runtime["error"])

    def test_separation_uses_the_selected_python_and_returns_real_output_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "song name.wav"
            directory = root / "separated" / "htdemucs" / "song name"
            directory.mkdir(parents=True)
            for name in ("bass", "drums", "vocals", "other"):
                (directory / f"{name}.wav").touch()
            external = "C:/existing model/python.exe"
            with patch.object(audio, "demucs_runtime", return_value={"available": True, "python": external, "error": None}), \
                 patch.object(audio.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
                result = audio.separate_stems(original, root)
            self.assertEqual(run.call_args.args[0][0:3], [external, "-m", "demucs"])
            self.assertEqual(run.call_args.args[0][-1], str(original))
            self.assertNotIn("shell", run.call_args.kwargs)
            self.assertEqual(set(result), {"bass", "drums", "vocals", "other"})
            self.assertTrue(all(path.is_file() for path in result.values()))

    def test_invalid_runtime_prevents_separation_and_reports_configuration_error(self):
        with patch.object(audio, "demucs_runtime", return_value={"available": False, "python": None, "error": "独立解释器配置无效"}), \
             patch.object(audio.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "独立解释器配置无效"):
                audio.separate_stems(Path("song.wav"), Path("project"))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
