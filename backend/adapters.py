"""Replaceable local audio adapters.

All adapters receive local pathlib.Paths and return backend models or plain
analysis candidates. They never persist projects: main.run_analysis owns status,
manual-result merging and storage. To add another model, implement its Protocol
and replace the corresponding field in DEFAULT during application setup.

Decoder: must create a playable WAV at target and return its duration in seconds.
Analyzer: bpm uses quarter notes; chords use 1-based bar/beat positions following
the meter denominator. Return optional key/originalKey/chords/sections/lyrics/notes
and a warnings list. Label uncertainty explicitly; do not claim structural labels
or automatic lyric alignment unless the adapter actually produced them.
Separator: returns genuine bass/drums/vocals/other WAV paths within project_dir.
Transcriber: consumes an isolated bass WAV and returns timed Note candidates.
Every result remains subject to the shared manual-edit protection merge.

VocalTranscriber consumes an isolated vocal WAV and returns independent timed
recognition segments. The optional faster-whisper implementation never receives
the original lyric text as a prompt. Phoneme forced alignment, MusicFM structure,
advanced harmony and Basic Pitch remain future adapters.
"""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from . import audio
from .models import DetectedSegment, Note, Project
from .lyrics import FasterWhisperLyrics


class Decoder(Protocol):
    def decode(self, source: Path, target: Path) -> float: ...


class Analyzer(Protocol):
    def analyze(self, project: Project, original: Path) -> dict: ...


class BassAnalyzer(Protocol):
    def analyze(self, project: Project, bass: Path, *, preserve_grid: bool = False) -> dict: ...


class Separator(Protocol):
    def separate(self, original: Path, project_dir: Path) -> dict[str, Path]: ...


class BassTranscriber(Protocol):
    def transcribe(self, bass: Path) -> list[Note]: ...


class VocalTranscriber(Protocol):
    def transcribe(self, vocals: Path, *, model: str, language: str | None,
                   start: float, end: float) -> list[DetectedSegment]: ...


class FFmpegDecoder:
    def decode(self, source: Path, target: Path) -> float:
        return audio.decode(source, target)


class HeuristicAnalyzer:
    def analyze(self, project: Project, original: Path) -> dict:
        return audio.analyze_basic(project, original)


class BassRootAnalyzer:
    def analyze(self, project: Project, bass: Path, *, preserve_grid: bool = False) -> dict:
        return audio.analyze_bass_roots(project, bass, preserve_grid=preserve_grid)


class DemucsSeparator:
    def separate(self, original: Path, project_dir: Path) -> dict[str, Path]:
        return audio.separate_stems(original, project_dir)


class SpectralBassTranscriber:
    def transcribe(self, bass: Path) -> list[Note]:
        return audio.transcribe_bass(bass)


@dataclass
class AdapterSet:
    decoder: Decoder
    analyzer: Analyzer
    separator: Separator
    transcriber: BassTranscriber
    lyrics: VocalTranscriber = field(default_factory=FasterWhisperLyrics)
    bass_analyzer: BassAnalyzer = field(default_factory=BassRootAnalyzer)


DEFAULT = AdapterSet(FFmpegDecoder(), HeuristicAnalyzer(), DemucsSeparator(), SpectralBassTranscriber(), FasterWhisperLyrics())
