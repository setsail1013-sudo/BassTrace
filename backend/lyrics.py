"""Local vocal recognition and conservative, editable lyric timing candidates.

Recognition never receives the user's lyrics as a prompt or replaces that text.
Whisper word timing is a candidate; matching is not phoneme forced alignment.
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
from collections import defaultdict, deque
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from .models import AlignmentLine, DetectedSegment, DetectedWord, Lyric, LyricDiff, Project


class LyricsDependencyError(RuntimeError):
    pass


_MODELS: dict[tuple[str, str, str, str], object] = {}
_MODEL_LOCK = threading.Lock()
PROJECT_ROOT = Path(__file__).resolve().parent.parent
_WORKER_PROBES: dict[tuple[str, int, int], tuple[float, dict]] = {}
_PROBE_LOCK = threading.Lock()


def _direct_whisper_capabilities() -> dict:
    try:
        installed = importlib.util.find_spec("faster_whisper") is not None
    except (ValueError, ImportError):
        installed = False
    available, error = False, None
    if installed:
        try:
            module = importlib.import_module("faster_whisper")
            available = callable(getattr(module, "WhisperModel", None))
        except Exception as exc:
            error = f"faster-whisper 无法加载：{str(exc)[-300:]}"
    return {"available": available, "installed": installed, "error": error}


def worker_python() -> Path | None:
    configured = os.environ.get("BASSCHART_AI_PYTHON")
    candidate = Path(configured).expanduser() if configured else PROJECT_ROOT / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    return candidate.resolve() if candidate.is_file() else None


def _module_marker(executable: Path) -> Path | None:
    for prefix in (executable.parent, executable.parent.parent):
        marker = prefix / "Lib" / "site-packages" / "faster_whisper" / "__init__.py"
        if marker.is_file():
            return marker
        for marker in prefix.glob("lib/python*/site-packages/faster_whisper/__init__.py"):
            if marker.is_file():
                return marker
    return None


def _worker_probe(executable: Path) -> dict:
    marker = _module_marker(executable)
    # The default project venv can be inspected cheaply while optional packages
    # are being installed. An explicit executable may use another layout.
    if marker is None and not os.environ.get("BASSCHART_AI_PYTHON"):
        return {"available": False, "installed": False, "error": None}
    key = (str(executable), executable.stat().st_mtime_ns, marker.stat().st_mtime_ns if marker else 0)
    with _PROBE_LOCK:
        cached = _WORKER_PROBES.get(key)
        if cached and time.monotonic() - cached[0] < (300 if cached[1]["available"] else 5):
            return dict(cached[1])
        try:
            process = subprocess.run([str(executable), "-m", "backend.lyric_worker", "--probe"],
                                     cwd=PROJECT_ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                     timeout=20, creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
            result = json.loads(process.stdout)
            if not isinstance(result, dict) or not isinstance(result.get("available"), bool) or not isinstance(result.get("installed"), bool):
                raise ValueError("歌词模型环境返回了无效状态")
            if process.returncode != 0:
                result["available"] = False
            result = {"available": result["available"], "installed": result["installed"], "error": result.get("error")}
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            result = {"available": False, "installed": marker is not None,
                      "error": f"独立歌词环境不可用：{str(exc)[-400:]}"}
        _WORKER_PROBES[key] = (time.monotonic(), result)
        return dict(result)


def whisper_capabilities() -> dict:
    direct = _direct_whisper_capabilities()
    worker, executable = {"available": False, "installed": False, "error": None}, None
    if not direct["available"]:
        executable = worker_python()
        if executable:
            worker = _worker_probe(executable)
    runtime = "direct" if direct["available"] else "worker" if worker["available"] else None
    return {"whisper": runtime is not None, "whisperInstalled": direct["installed"] or worker["installed"],
            "whisperAdapter": True, "whisperBackend": "faster-whisper", "whisperRuntime": runtime,
            "whisperWorkerPython": str(executable) if runtime == "worker" else None,
            "whisperError": None if runtime else worker["error"] or direct["error"]}


def require_whisper() -> str:
    capabilities = whisper_capabilities()
    if not capabilities["whisper"]:
        raise LyricsDependencyError(capabilities["whisperError"] or
                                    "尚未安装可用的 faster-whisper。请在项目 .venv 安装 requirements-ai.txt，或设置 BASSCHART_AI_PYTHON 指向已安装模型依赖的 Python；不会生成占位识别结果。")
    return capabilities["whisperRuntime"]


def _run_worker(vocals: Path, *, model: str, language: str | None, start: float, end: float | None) -> list[DetectedSegment]:
    executable = worker_python()
    if executable is None:
        raise LyricsDependencyError("独立歌词 Python 环境不可用，请检查 BASSCHART_AI_PYTHON 或项目 .venv")
    request = {"vocals": str(vocals.resolve()), "model": model, "language": language, "start": start, "end": end}
    try:
        process = subprocess.run([str(executable), "-m", "backend.lyric_worker"], cwd=PROJECT_ROOT,
                                 input=json.dumps(request, ensure_ascii=True), capture_output=True,
                                 text=True, encoding="utf-8", errors="replace", timeout=3600,
                                 creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
        result = json.loads(process.stdout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("歌词模型运行超过 60 分钟，任务已停止；请按段落识别或使用更小模型。") from exc
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"歌词模型子进程没有返回有效结果：{str(exc)[-400:]}") from exc
    if not isinstance(result, dict) or result.get("ok") is not True or process.returncode != 0:
        message = result.get("error") if isinstance(result, dict) else None
        raise RuntimeError(str(message or process.stderr[-1200:] or "独立歌词模型运行失败")[-1200:])
    segments = result.get("segments")
    if not isinstance(segments, list) or len(segments) > 20000:
        raise RuntimeError("独立歌词模型返回的识别片段无效")
    # Treat subprocess output as data, never shell text or executable instructions.
    return [DetectedSegment.model_validate(segment) for segment in segments]


class FasterWhisperLyrics:
    def transcribe(self, vocals: Path, *, model: str = "tiny", language: str | None = None,
                   start: float = 0, end: float | None = None) -> list[DetectedSegment]:
        runtime = require_whisper()
        if runtime == "worker":
            return _run_worker(vocals, model=model, language=language, start=start, end=end)
        return self.transcribe_local(vocals, model=model, language=language, start=start, end=end)

    def transcribe_local(self, vocals: Path, *, model: str = "tiny", language: str | None = None,
                         start: float = 0, end: float | None = None) -> list[DetectedSegment]:
        device = os.environ.get("BASSCHART_WHISPER_DEVICE", "cpu")
        compute = os.environ.get("BASSCHART_WHISPER_COMPUTE_TYPE", "int8" if device == "cpu" else "float16")
        cache_root = os.environ.get("BASSCHART_WHISPER_CACHE", str(PROJECT_ROOT / "backend" / "data" / "models" / "hub"))
        cache_key = (model, device, compute, cache_root)
        with _MODEL_LOCK:
            if cache_key not in _MODELS:
                whisper = importlib.import_module("faster_whisper")
                _MODELS[cache_key] = whisper.WhisperModel(model, device=device, compute_type=compute, download_root=cache_root)
            engine = _MODELS[cache_key]
        with sf.SoundFile(vocals) as source:
            rate = source.samplerate
            actual_end = min(float(len(source)) / rate, end if end is not None else math.inf)
            if actual_end <= start:
                raise ValueError("人声音轨没有覆盖所选识别时间区间")
            source.seek(min(len(source), round(start * rate)))
            samples = source.read(max(0, round((actual_end - start) * rate)), dtype="float32", always_2d=True).mean(axis=1)
        if rate != 16000:
            divisor = math.gcd(rate, 16000)
            samples = resample_poly(samples, 16000 // divisor, rate // divisor).astype(np.float32)
        if not len(samples):
            raise ValueError("所选识别区间没有音频数据")
        segments, _info = engine.transcribe(samples, language=language, word_timestamps=True,
                                           beam_size=5, vad_filter=False, condition_on_previous_text=False)
        result = []
        for index, segment in enumerate(segments):
            text = str(segment.text).strip()
            if not text or getattr(segment, "no_speech_prob", 0) >= .85:
                continue
            beginning = max(start, min(actual_end, start + float(segment.start)))
            finish = max(beginning, min(actual_end, start + float(segment.end)))
            words = []
            for word in segment.words or []:
                word_start = max(beginning, min(finish, start + float(word.start)))
                word_end = max(word_start, min(finish, start + float(word.end)))
                words.append(DetectedWord(text=str(word.word), start=word_start, end=word_end,
                                          confidence=max(0, min(1, float(word.probability)))))
            confidence = (sum(word.confidence for word in words) / len(words) if words else
                          math.exp(min(0, float(getattr(segment, "avg_logprob", -10)))))
            result.append(DetectedSegment(id=f"detected-{index}", text=text, start=beginning, end=finish,
                                          confidence=max(0, min(1, confidence)), words=words))
        return result


def _characters(text: str) -> str:
    # Preserve the original string separately; normalization only guides matching.
    return "".join(character for character in unicodedata.normalize("NFKC", text).casefold()
                   if character.isalnum())


def _timed_characters(segments: list[DetectedSegment]) -> list[tuple[str, float, float, float]]:
    result = []
    for segment in sorted(segments, key=lambda item: item.start):
        units = segment.words or [DetectedWord(text=segment.text, start=segment.start,
                                               end=segment.end, confidence=segment.confidence)]
        for word in units:
            text = _characters(word.text)
            for index, character in enumerate(text):
                result.append((character, word.start + (word.end - word.start) * index / len(text),
                               word.start + (word.end - word.start) * (index + 1) / len(text), word.confidence))
    return result


def _diff(original: str, detected: str) -> list[LyricDiff]:
    return [LyricDiff(kind=kind, original=original[a:b], detected=detected[c:d])
            for kind, a, b, c, d in SequenceMatcher(None, original, detected, autojunk=False).get_opcodes()]


def _recognized_excerpt(segments: list[DetectedSegment], start: float, end: float, fallback: str) -> str:
    pieces = []
    for segment in sorted(segments, key=lambda item: item.start):
        for word in segment.words:
            if word.start < end - 1e-8 and word.end > start + 1e-8:
                pieces.append(word.text)
    return "".join(pieces).strip() if pieces else fallback


_LRC_STAMP = re.compile(r"\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]")
_LRC_META = re.compile(r"\[(?:ti|ar|al|au|by|offset|re|ve|length|la):[^\]]*\]", re.IGNORECASE)


def lyric_source_lines(original: str) -> list[str]:
    """Read matching bodies without modifying the stored original document.

    In LRC, each valid timestamp is a separate occurrence. Sorting occurrences
    keeps repeated phrases in performance order and matches the imported tokens.
    TXT bodies use the same outer whitespace trimming as the import editor.
    """
    offset_match = re.search(r"\[offset:\s*([+-]?\d{1,12})\s*\]", original, re.IGNORECASE)
    offset = int(offset_match.group(1)) / 1000 if offset_match else 0
    plain, timed = [], []
    has_timestamps = False
    for line in original.lstrip("\ufeff").splitlines():
        content = _LRC_META.sub("", line)
        stamps = [stamp for stamp in _LRC_STAMP.finditer(content)
                  if len(stamp.group(1)) <= 8 and int(stamp.group(2)) < 60]
        if stamps:
            has_timestamps = True
            body = _LRC_STAMP.sub(lambda stamp: "" if len(stamp.group(1)) <= 8 and int(stamp.group(2)) < 60 else stamp.group(0), content).strip()
            for stamp in stamps:
                seconds = int(stamp.group(1)) * 60 + int(stamp.group(2)) + (float("0." + stamp.group(3)) if stamp.group(3) else 0) + offset
                if body:
                    timed.append((max(0, seconds), len(timed), body))
        elif content.strip():
            plain.append(content.strip())
    return [item[2] for item in sorted(timed)] if has_timestamps else plain


def align_text(original: str, segments: list[DetectedSegment], existing: list[Lyric] | None = None,
               *, target_id: str | None = None) -> list[AlignmentLine]:
    """Return monotonic phrase candidates; unmatched/ambiguous lines stay pending."""
    raw_lines = lyric_source_lines(original)
    if any(len(line) > 2000 for line in raw_lines):
        raise ValueError("请将原歌词按句换行，每个片段最多 2000 个字符")
    normalized = [_characters(line) for line in raw_lines]
    source_text = "".join(normalized)
    timed = _timed_characters(segments)
    detected_text = "".join(item[0] for item in timed)
    if len(source_text) > 30000 or len(detected_text) > 60000:
        raise ValueError("歌词过长，请按段落分别识别和对齐")
    matched = {}
    for block in SequenceMatcher(None, source_text, detected_text, autojunk=False).get_matching_blocks():
        matched.update((block.a + index, block.b + index) for index in range(block.size))
    by_text = defaultdict(deque)
    for lyric in sorted(existing or [], key=lambda item: item.start):
        by_text[lyric.text.strip()].append(lyric)
    lines, offset = [], 0
    for index, (text, canonical) in enumerate(zip(raw_lines, normalized)):
        linked = next((item for item in existing or [] if item.id == target_id), None) if target_id else (by_text[text].popleft() if by_text[text] else None)
        if linked:
            text = linked.text  # Keep the user's existing token content exact.
        indices = [matched[position] for position in range(offset, offset + len(canonical)) if position in matched]
        offset += len(canonical)
        beginning = finish = None
        candidate_text = ""
        coverage = len(indices) / len(canonical) if canonical else 0
        confidence = 0.0
        if indices:
            first, last = min(indices), max(indices)
            beginning, finish = timed[first][1], timed[last][2]
            candidate_text = _recognized_excerpt(segments, beginning, finish, "".join(item[0] for item in timed[first:last + 1]))
            # Insertion errors and sparse matches reduce reliability instead of
            # interpolating an apparently exact time for words never recognized.
            precision = len(indices) / (last - first + 1)
            confidence = coverage * precision * sum(timed[item][3] for item in indices) / len(indices)
        elif segments:
            best = max(segments, key=lambda item: SequenceMatcher(None, canonical, _characters(item.text), autojunk=False).ratio())
            candidate_text = best.text
        ambiguous = bool(canonical) and detected_text.count(canonical) > source_text.count(canonical)
        reliable = (coverage >= .85 and confidence >= .60 and beginning is not None and finish is not None
                    and finish > beginning and not ambiguous)
        status = "manual" if linked and linked.locked and reliable else "matched" if reliable else "pending"
        lines.append(AlignmentLine(id=f"alignment-{linked.id if linked else index}", lyricId=linked.id if linked else None,
                                   text=text, detectedText=candidate_text, start=beginning if reliable else None,
                                   end=finish if reliable else None, status=status, confidence=round(confidence, 4),
                                   diff=_diff(text, candidate_text)))
    return lines


def apply_alignment(project: Project, lines: list[AlignmentLine]) -> None:
    """Apply only reliable, unlocked candidates, retaining the user's exact text."""
    by_id = {lyric.id: lyric for lyric in project.lyrics}
    for line in lines:
        existing = by_id.get(line.lyricId or "")
        if existing and existing.locked:
            if line.start is not None and line.end is not None:
                line.status = "manual"
            continue
        if line.status != "matched" or line.start is None or line.end is None:
            continue
        beginning, finish = max(0, line.start), min(project.duration, line.end)
        if finish <= beginning:
            line.status, line.start, line.end = "pending", None, None
            continue
        if existing:
            # A concurrent text edit invalidates a candidate even if unlocked.
            if existing.text != line.text:
                line.status, line.start, line.end = "pending", None, None
                continue
            existing.start, existing.end = beginning, finish
        else:
            lyric_id = f"aligned-{line.id}"
            if lyric_id in by_id:
                line.status = "pending"
                continue
            created = Lyric(id=lyric_id, text=line.text, start=beginning, end=finish, source="analysis", locked=False)
            project.lyrics.append(created)
            by_id[created.id] = created
            line.lyricId = created.id
    project.lyrics.sort(key=lambda item: item.start)
