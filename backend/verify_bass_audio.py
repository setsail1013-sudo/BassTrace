"""Read-only smoke check of an existing separated bass; never save its project."""
import hashlib
import json
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from . import audio
from .models import Project


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    root = Path(__file__).resolve().parents[1]
    candidates = sorted((root / "backend/data/projects").glob("*/separated/htdemucs/original/bass.wav"))
    if not candidates:
        raise RuntimeError("No existing separated bass available for a read-only check")
    source = candidates[0]
    project_file = source.parents[3] / "project.json"
    before = {str(path): digest(path) for path in (source, project_file)}
    project = Project.model_validate_json(project_file.read_text(encoding="utf-8"))
    original = sf.info(source)
    assert audio.valid_stem_audio(source, project.duration)
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="basschart-verify-") as directory:
        enhanced = Path(directory) / "enhanced.wav"
        gain = audio.enhance_bass(source, enhanced)
        info = sf.info(enhanced)
        assert (info.frames, info.samplerate, info.channels) == (original.frames, original.samplerate, original.channels)
        peak = 0.0
        with sf.SoundFile(enhanced) as stream:
            for block in stream.blocks(blocksize=65536, dtype="float32", always_2d=True):
                assert np.isfinite(block).all()
                peak = max(peak, float(np.abs(block).max(initial=0)))
        assert peak <= 10 ** (-3 / 20) + 1e-6
        assert gain <= 12
        result = audio.analyze_bass_roots(project, enhanced, preserve_grid=True)
        events = result["bassEvents"]
        assert events and all(0 <= e.start < e.end <= project.duration and 0 <= e.pitchClass <= 11 for e in events)
        assert all(a.end <= b.start for a, b in zip(events, events[1:]))
        assert "notes" not in result and "manualFills" not in result
    assert before == {str(path): digest(path) for path in (source, project_file)}
    evidence = {"passed": True, "sourceProject": project.id, "durationSeconds": project.duration,
                "sampleRate": original.samplerate, "channels": original.channels, "frames": original.frames,
                "gainDb": gain, "enhancedSamplePeak": peak, "bassEvents": len(events),
                "elapsedSeconds": round(time.perf_counter() - started, 3), "userFilesUnchanged": True,
                "scope": "Existing separated full-length bass; no new Demucs run or pitch-accuracy benchmark."}
    target = root / "docs/verification/bass-audio-smoke-results.json"
    target.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=True))


if __name__ == "__main__":
    main()
