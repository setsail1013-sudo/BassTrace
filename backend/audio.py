from __future__ import annotations

import importlib.util
import math
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from .models import BassEvent, Chord, Note, Project, Section
from .timeline import beat_seconds, beat_to_time, time_to_beat

FFMPEG_CANDIDATE = Path(r"D:\zzMUSIC\ffmpeg-2025-10-16-git-cd4b01707d-essentials_build\bin\ffmpeg.exe")
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_DEMUCS_PROBES: dict[tuple[str, int], tuple[float, dict]] = {}
_DEMUCS_PROBE_LOCK = threading.Lock()


def ffmpeg_path() -> str | None:
    return str(FFMPEG_CANDIDATE) if FFMPEG_CANDIDATE.is_file() else shutil.which("ffmpeg")


def demucs_runtime() -> dict:
    configured = os.environ.get("BASSCHART_DEMUCS_PYTHON")
    if not configured:
        available = importlib.util.find_spec("demucs") is not None
        return {"available": available, "python": sys.executable if available else None,
                "error": None if available else "未安装 Demucs。可设置 BASSCHART_DEMUCS_PYTHON 指向已有 Demucs 的 Python；基础分析仍可运行。"}
    executable = Path(configured).expanduser()
    if not executable.is_file():
        return {"available": False, "python": None,
                "error": "BASSCHART_DEMUCS_PYTHON 指定的解释器文件不存在，请检查完整 python.exe 路径。"}
    executable = executable.resolve()
    key = (str(executable), executable.stat().st_mtime_ns)
    with _DEMUCS_PROBE_LOCK:
        cached = _DEMUCS_PROBES.get(key)
        if cached and time.monotonic() - cached[0] < (300 if cached[1]["available"] else 5):
            return dict(cached[1])
        try:
            process = subprocess.run([str(executable), "-c", "import demucs.separate"],
                                     capture_output=True, text=True, encoding="utf-8", errors="replace",
                                     timeout=30, creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
            if process.returncode:
                result = {"available": False, "python": str(executable),
                          "error": "指定的独立 Python 无法加载 Demucs，请选择已有可用模型依赖的环境。 " + process.stderr[-500:]}
            else:
                result = {"available": True, "python": str(executable), "error": None}
        except (OSError, subprocess.TimeoutExpired) as exc:
            result = {"available": False, "python": str(executable),
                      "error": "独立 Demucs 环境启动失败，请检查解释器与依赖。 " + str(exc)[-500:]}
        _DEMUCS_PROBES[key] = (time.monotonic(), result)
        return dict(result)


def capabilities() -> dict:
    from .lyrics import whisper_capabilities
    demucs = demucs_runtime()
    return {
        "ffmpeg": bool(ffmpeg_path()),
        "demucs": demucs["available"],
        "demucsPython": demucs["python"],
        "demucsError": demucs["error"],
        **whisper_capabilities(),
        "basicAnalysis": True,
        "bassTranscription": True,
        "local": True,
    }


def decode(source: Path, target: Path) -> float:
    executable = ffmpeg_path()
    if executable:
        process = subprocess.run(
            [executable, "-v", "error", "-nostdin", "-y", "-i", str(source),
             "-vn", "-ar", "22050", "-ac", "2", "-c:a", "pcm_s16le", str(target)],
            capture_output=True, timeout=300,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        if process.returncode:
            raise ValueError("无法解码音频，请检查文件是否完整。" + process.stderr.decode(errors="replace")[-300:])
    else:
        try:
            samples, rate = sf.read(source, dtype="float32", always_2d=True)
            sf.write(target, samples, rate, subtype="PCM_16")
        except Exception as exc:
            raise ValueError("该格式需要 FFmpeg。请安装 FFmpeg 或改用 WAV/FLAC 文件。") from exc
    info = sf.info(target)
    if info.duration <= 0 or info.duration > 3600:
        raise ValueError("请导入时长大于 0 且不超过 60 分钟的音频。")
    return float(info.duration)


def read_mono(path: Path, rate: int = 11025) -> tuple[np.ndarray, int]:
    samples, source_rate = sf.read(path, dtype="float32", always_2d=True)
    mono = samples.mean(axis=1)
    if source_rate != rate:
        divisor = math.gcd(source_rate, rate)
        mono = resample_poly(mono, rate // divisor, source_rate // divisor).astype(np.float32)
    return mono, rate


def enhance_bass(source: Path, target: Path) -> float:
    """Write a listening copy with bounded linear gain and unchanged sample timing."""
    peak = 0.0
    with sf.SoundFile(source) as stream:
        sample_rate, channels = stream.samplerate, stream.channels
        for block in stream.blocks(blocksize=65536, dtype="float32", always_2d=True):
            if not np.isfinite(block).all():
                raise ValueError("贝斯音轨包含无效采样")
            peak = max(peak, float(np.max(np.abs(block), initial=0)))
    ceiling = 10 ** (-3 / 20)
    gain = min(10 ** (12 / 20), ceiling / peak) if peak > 1e-8 else 1.0
    temporary = target.with_name(target.stem + ".tmp.wav")
    try:
        with sf.SoundFile(source) as stream, sf.SoundFile(temporary, "w", samplerate=sample_rate,
                                                         channels=channels, subtype="FLOAT") as output:
            for block in stream.blocks(blocksize=65536, dtype="float32", always_2d=True):
                output.write(block * gain)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return round(20 * math.log10(gain), 4)


def valid_stem_audio(path: Path, duration: float) -> bool:
    try:
        info = sf.info(path)
        return (info.frames > 0 and info.channels in (1, 2) and info.samplerate > 0
                and abs(info.duration - duration) <= max(.1, duration * .001))
    except (RuntimeError, OSError):
        return False


def peaks(path: Path, count: int = 720) -> list[float]:
    samples, _ = sf.read(path, dtype="float32", always_2d=True)
    samples = np.max(np.abs(samples), axis=1)
    if not len(samples):
        return []
    edges = np.linspace(0, len(samples), min(count, len(samples)) + 1, dtype=int)
    values = [float(np.max(samples[a:b])) for a, b in zip(edges, edges[1:])]
    maximum = max(values) or 1
    return [round(value / maximum, 4) for value in values]


def estimate_tempo(samples: np.ndarray, rate: int) -> tuple[float, float, list[str]]:
    hop = max(1, rate // 100)
    trim = len(samples) // hop * hop
    if trim < 500 * hop:
        return 96, 0, ["音频过短，速度暂用 96 BPM，请手工确认。"]
    envelope = np.sqrt(np.mean(samples[:trim].reshape(-1, hop) ** 2, axis=1))
    onset = np.maximum(0, np.diff(envelope, prepend=envelope[0]))
    onset -= onset.mean()
    size = 1 << (2 * len(onset) - 1).bit_length()
    spectrum = np.fft.rfft(onset, size)
    autocorrelation = np.fft.irfft(spectrum * spectrum.conj(), size)[:len(onset)]
    low, high = int(6000 / 180), int(6000 / 55)
    lags = np.arange(low, min(high, len(onset) - 1) + 1)
    if not len(lags) or np.max(autocorrelation[lags]) <= 1e-10:
        return 96, 0, ["缺少稳定起音，速度暂用 96 BPM，请手工确认。"]
    scores = autocorrelation[lags] / np.maximum(1, len(onset) - lags)
    lag = int(lags[int(np.argmax(scores))])
    bpm = round(6000 / lag, 1)
    # The phase is only a beat-grid candidate; it cannot determine the downbeat.
    phase_scores = [onset[index::lag].sum() for index in range(lag)]
    offset = int(np.argmax(phase_scores)) / 100
    return bpm, offset, ["BPM、第一拍及拍号属于候选结果；请试听确认半速/倍速和强拍位置。"]


def chromagram(samples: np.ndarray, rate: int) -> tuple[np.ndarray, np.ndarray]:
    window, hop = 4096, 1024
    if len(samples) < window:
        samples = np.pad(samples, (0, window - len(samples)))
    frames = np.lib.stride_tricks.sliding_window_view(samples, window)[::hop]
    frequencies = np.fft.rfftfreq(window, 1 / rate)
    selected = np.flatnonzero((frequencies >= 50) & (frequencies <= 2200))
    midi = np.rint(69 + 12 * np.log2(frequencies[selected] / 440)).astype(int)
    result = np.zeros((len(frames), 12), dtype=np.float32)
    hann = np.hanning(window).astype(np.float32)
    # Batches bound temporary FFT memory even for longer recordings.
    for start in range(0, len(frames), 256):
        magnitude = np.abs(np.fft.rfft(frames[start:start + 256] * hann, axis=1))[:, selected]
        for pitch in range(12):
            result[start:start + len(magnitude), pitch] = magnitude[:, midi % 12 == pitch].sum(axis=1)
    totals = result.sum(axis=1, keepdims=True)
    result /= np.maximum(totals, 1e-10)
    return result, (np.arange(len(frames)) * hop + window / 2) / rate


def estimate_key(chroma: np.ndarray) -> tuple[str, float]:
    values = chroma.mean(axis=0)
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    candidates = []
    for tonic in range(12):
        for suffix, template in (("", major), ("m", minor)):
            score = float(np.corrcoef(values, np.roll(template, tonic))[0, 1]) if values.std() > 0 else 0
            candidates.append((score if np.isfinite(score) else 0, PITCH_CLASSES[tonic] + suffix))
    score, label = max(candidates)
    return label, max(0, min(1, score))


def analyze_basic(project: Project, original: Path) -> dict:
    samples, rate = read_mono(original)
    bpm, offset, warnings = estimate_tempo(samples, rate)
    chroma, times = chromagram(samples, rate)
    key, key_confidence = estimate_key(chroma)
    grid = project.model_copy(update={"bpm": bpm, "offset": offset, "beatTimes": []})
    beats_per_bar = int(project.meter.split("/")[0])
    half_bar = beats_per_bar / 2
    bar_count = max(1, math.ceil((project.duration - offset) / (beat_seconds(grid) * beats_per_bar)))
    templates = []
    for root in range(12):
        for suffix, intervals in (("", [0, 4, 7]), ("m", [0, 3, 7]), ("7", [0, 4, 7, 10]),
                                  ("maj7", [0, 4, 7, 11]), ("m7", [0, 3, 7, 10])):
            template = np.zeros(12)
            template[[(root + interval) % 12 for interval in intervals]] = 1
            template[root] = 1.25
            template /= np.linalg.norm(template)
            templates.append((PITCH_CLASSES[root] + suffix, template))
    matrix = np.array([template for _, template in templates])
    chords = []
    for bar in range(1, bar_count + 1):
        previous = None
        for beat in (1, 1 + half_bar):
            start, end = beat_to_time(grid, bar, beat), beat_to_time(grid, bar, beat + half_bar)
            values = chroma[(times >= start) & (times < end)]
            if not len(values):
                continue
            vector = values.mean(axis=0)
            scores = matrix @ vector / max(float(np.linalg.norm(vector)), 1e-10)
            order = np.argsort(scores)
            label = templates[int(order[-1])][0]
            confidence = float(np.clip((scores[order[-1]] - scores[order[-2]]) * 3 + .35, .2, .75))
            if label != previous:
                chords.append(Chord(id=f"analysis-chord-{bar}-{beat}", bar=bar, beat=beat,
                                    label=label, source="analysis", confidence=round(confidence, 2)))
                previous = label
    sections = [Section(id=f"analysis-section-{start}", name=f"候选段落 {(start - 1) // 8 + 1}",
                        startBar=start, endBar=min(start + 7, bar_count), color="#5b8cff")
                for start in range(1, bar_count + 1, 8)]
    warnings.extend([
        f"调性候选：{key}（相似度 {key_confidence:.0%}）；和弦由全混音色度估计，需校正转位及复杂和弦。",
        "段落目前按 8 小节粗分，尚未自动识别主歌/副歌；请根据试听修改名称与边界。",
        "本次音乐分析不自动生成歌词。可导入 LRC，或使用独立歌词识别与对齐工具。",
    ])
    return {"bpm": bpm, "offset": offset, "key": key, "originalKey": key,
            "chords": chords, "sections": sections, "warnings": warnings}


def analyze_bass_roots(project: Project, bass: Path, *, preserve_grid: bool = False) -> dict:
    """Estimate performed bass pitch classes, without inferring full harmony.

    Fundamental/harmonic scores vote within each half-bar. Passing notes, octave
    jumps and separation bleed make these uncertain bass-tone candidates, not
    evidence for major/minor/extended chords. This path never creates Note events.
    """
    samples, rate = read_mono(bass)
    bpm, offset, warnings = estimate_tempo(samples, rate)
    grid = project if preserve_grid else project.model_copy(update={"bpm": bpm, "offset": offset, "beatTimes": []})
    beats_per_bar = int(project.meter.split("/")[0])
    half_bar = beats_per_bar / 2
    last_bar, last_beat = time_to_beat(grid, project.duration)
    bar_count = max(1, last_bar - (1 if last_beat <= 1.000001 else 0))
    window, hop = 4096, 512
    # Center frames on the audio timeline, including zero. Without edge padding,
    # the first frame is centred at 186 ms: a short pickup then has too few
    # votes and gets discarded even when the bass is sustained from audio zero.
    padded = np.pad(samples, (window // 2, window // 2))
    frames = np.lib.stride_tricks.sliding_window_view(padded, window)[::hop] if len(samples) >= window else []
    times = np.arange(len(frames)) * hop / rate
    pitches = np.zeros(len(frames), dtype=int)
    weights = np.zeros(len(frames), dtype=np.float32)
    if len(frames):
        energy = np.concatenate([np.sqrt(np.mean(frames[start:start + 256] ** 2, axis=1))
                                 for start in range(0, len(frames), 256)])
        threshold = max(.0004, float(np.percentile(energy, 85)) * .08)
        # Include low B and detuned four-string basses. Octave uncertainty does
        # not alter a pitch-class candidate; no TAB or fingering is inferred.
        midi_candidates = np.arange(23, 68)
        fundamentals = 440 * 2 ** ((midi_candidates - 69) / 12)
        hann = np.hanning(window)
        for start in range(0, len(frames), 256):
            spectrum = np.abs(np.fft.rfft(frames[start:start + 256] * hann, axis=1))
            scores = np.zeros((len(spectrum), len(midi_candidates)))
            for harmonic, weight in ((1, 1), (2, .55), (3, .3)):
                positions = fundamentals * harmonic / (rate / window)
                bins = np.clip(np.floor(positions).astype(int), 1, spectrum.shape[1] - 2)
                fraction = positions - bins
                scores += (spectrum[:, bins] * (1 - fraction) + spectrum[:, bins + 1] * fraction) * weight
            chosen = np.argmax(scores, axis=1)
            strongest = scores[np.arange(len(scores)), chosen]
            # Broadband/noise and silence must not acquire a fabricated root.
            tonal = strongest / np.maximum(spectrum.sum(axis=1), 1e-10)
            valid = (energy[start:start + len(spectrum)] > threshold) & (tonal >= .03)
            pitches[start:start + len(spectrum)] = midi_candidates[chosen] % 12
            weights[start:start + len(spectrum)] = np.where(valid, energy[start:start + len(spectrum)], 0)
    bass_events = []
    # The first downbeat can follow a pickup. Analyze those earlier half-bars
    # too, clipping only the sampling window to audio zero. Bass events use
    # absolute seconds and therefore do not need a negative stored bar number.
    first_bar, _ = time_to_beat(grid, 0)
    for bar in range(min(1, first_bar), bar_count + 1):
        for beat in (1, 1 + half_bar):
            start = max(0, beat_to_time(grid, bar, beat))
            end = min(project.duration, beat_to_time(grid, bar, beat + half_bar))
            if end <= start:
                continue
            selected = (times >= start) & (times < end) & (weights > 0)
            if not np.any(selected):
                continue
            # A rest is real space. Do not connect two phrases through a silent
            # stretch just because both fall inside the same half-bar.
            indices = np.flatnonzero(selected)
            chunks = np.split(indices, np.flatnonzero(np.diff(indices) * hop / rate > .18) + 1)
            for chunk in chunks:
                if len(chunk) * hop / rate < .12:
                    continue
                votes = np.bincount(pitches[chunk], weights=weights[chunk], minlength=12)
                root = int(np.argmax(votes))
                share = float(votes[root] / max(float(votes.sum()), 1e-10))
                if share < .45:
                    continue
                beginning = max(0, start, float(times[chunk[0]] - hop / rate / 2))
                finish = min(project.duration, end, float(times[chunk[-1]] + hop / rate / 2))
                if beginning <= window / rate / 2 and start <= 0:
                    beginning = 0.0
                if finish <= beginning:
                    continue
                confidence = round(min(.75, share * .75), 2)
                if bass_events and bass_events[-1].pitchClass == root and beginning - bass_events[-1].end <= hop / rate * 1.5:
                    previous = bass_events[-1]
                    previous.confidence = round((previous.confidence * (previous.end - previous.start)
                                                  + confidence * (finish - beginning)) / (finish - previous.start), 2)
                    previous.end = round(finish, 6)
                else:
                    bass_events.append(BassEvent(id=f"analysis-bass-{round(beginning * 1000)}", start=round(beginning, 6),
                                                 end=round(finish, 6), pitchClass=root, source="analysis", confidence=confidence))
    sections = [Section(id=f"analysis-section-{start}", name=f"候选段落 {(start - 1) // 8 + 1}",
                        startBar=start, endBar=min(start + 7, bar_count), color="#5b8cff")
                for start in range(1, bar_count + 1, 8)]
    warnings.extend([
        "仅分析独立贝斯轨：谱面音名表示贝斯主要音高候选；经过音、转位及串音可能影响结果，请试听校正。",
        "贝斯模式不自动生成音符或加花；已保存的音符、加花与演奏备注继续保留。",
        "段落目前按 8 小节粗分，尚未自动识别主歌/副歌；请根据试听修改名称与边界。",
        "本次音乐分析不自动生成歌词。可导入 LRC，或使用独立歌词识别与对齐工具。",
    ])
    if not bass_events:
        warnings.append("未检测到可靠的低音音高，未填入音名候选。请检查贝斯轨并试听后手工填写音名。")
    result = {"bassEvents": bass_events, "sections": sections, "warnings": warnings}
    if not preserve_grid:
        result.update(bpm=bpm, offset=offset)
    return result


def recommend_fingering(notes: list[Note]) -> list[Note]:
    """Choose standard E-A-D-G positions with a whole-phrase movement cost."""
    tunings = {1: 43, 2: 38, 3: 33, 4: 28}
    candidates = []
    for note in notes:
        options = [(string, note.midi - pitch) for string, pitch in tunings.items()
                   if 0 <= note.midi - pitch <= 24]
        candidates.append(options or [(None, None)])
    if not candidates:
        return notes
    cost_rows, parents = [], []
    for index, options in enumerate(candidates):
        row, parent = [], []
        for string, fret in options:
            local = max(0, (fret or 0) - 12) * .25
            if index == 0:
                row.append(local + (fret or 0) * .1)
                parent.append(0)
            else:
                transitions = []
                for previous, (prev_string, prev_fret) in enumerate(candidates[index - 1]):
                    movement = abs((fret or 0) - (prev_fret or 0)) * .6
                    crossing = abs((string or 0) - (prev_string or 0)) * .4
                    transitions.append(cost_rows[-1][previous] + movement + crossing + local)
                best = int(np.argmin(transitions))
                row.append(transitions[best])
                parent.append(best)
        cost_rows.append(row)
        parents.append(parent)
    selected = int(np.argmin(cost_rows[-1]))
    for index in range(len(notes) - 1, -1, -1):
        notes[index].string, notes[index].fret = candidates[index][selected]
        selected = parents[index][selected]
    return notes


def transcribe_bass(path: Path) -> list[Note]:
    samples, rate = read_mono(path, 11025)
    window, hop = 2048, 220
    if len(samples) < window:
        return []
    frames = np.lib.stride_tricks.sliding_window_view(samples, window)[::hop]
    energy = np.sqrt(np.mean(frames ** 2, axis=1))
    threshold = max(.0004, float(np.percentile(energy, 85)) * .08)
    frequencies = np.fft.rfftfreq(window, 1 / rate)
    midi_candidates = np.arange(28, 68)
    fundamentals = 440 * 2 ** ((midi_candidates - 69) / 12)
    pitches, confidence = [], []
    for start in range(0, len(frames), 256):
        spectrum = np.abs(np.fft.rfft(frames[start:start + 256] * np.hanning(window), axis=1))
        scores = np.zeros((len(spectrum), len(midi_candidates)))
        for harmonic, weight in ((1, 1), (2, .55), (3, .3)):
            positions = fundamentals * harmonic / (rate / window)
            bins = np.clip(np.floor(positions).astype(int), 1, len(frequencies) - 2)
            fraction = positions - bins
            # Interpolate at the actual frequency. Taking the maximum across
            # neighboring bins makes adjacent semitones tie at low bass pitches.
            magnitude = spectrum[:, bins] * (1 - fraction) + spectrum[:, bins + 1] * fraction
            scores += magnitude * weight
        chosen = np.argmax(scores, axis=1)
        pitches.extend(midi_candidates[chosen].tolist())
        confidence.extend((scores[np.arange(len(scores)), chosen] / np.maximum(scores.sum(axis=1), 1e-10)).tolist())
    notes = []
    active = None
    start_index = 0
    for index in range(len(frames) + 1):
        pitch = pitches[index] if index < len(frames) and energy[index] > threshold else None
        # A sharp amplitude rise at the same pitch starts a repeated note.
        attack = index > 0 and index < len(frames) and energy[index] > energy[index - 1] * 1.8
        if pitch != active or (attack and active is not None) or index == len(frames):
            duration = (index - start_index) * hop / rate
            if active is not None and duration >= .10:
                start_time = start_index * hop / rate
                notes.append(Note(id=f"analysis-note-{len(notes)}", midi=active, start=round(start_time, 3),
                                  duration=round(duration, 3), source="analysis",
                                  confidence=round(min(.75, float(np.mean(confidence[start_index:index])) * 2), 2)))
            active, start_index = pitch, index
    return recommend_fingering(notes)


def separate_stems(original: Path, project_dir: Path) -> dict[str, Path]:
    runtime = demucs_runtime()
    if not runtime["available"]:
        raise RuntimeError(runtime["error"])
    log_path = project_dir / "separation.log"
    environment = __import__("os").environ.copy()
    ffmpeg = ffmpeg_path()
    if ffmpeg:
        environment["PATH"] = str(Path(ffmpeg).parent) + __import__("os").pathsep + environment.get("PATH", "")
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.run(
            [runtime["python"], "-m", "demucs", "--name", "htdemucs", "--device", "cpu",
             "--jobs", "1", "-o", str(project_dir / "separated"), str(original)],
            stdout=log, stderr=subprocess.STDOUT, env=environment, timeout=1800,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    directory = project_dir / "separated" / "htdemucs" / original.stem
    result = {name: directory / f"{name}.wav" for name in ("bass", "drums", "vocals", "other")}
    if process.returncode or not all(path.is_file() for path in result.values()):
        detail = log_path.read_text(encoding="utf-8", errors="replace")[-900:]
        raise RuntimeError("Demucs 分离失败（初次运行需下载模型，CPU 运行可能较慢）。" + detail)
    return result
