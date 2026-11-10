from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)


class Section(Model):
    id: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=100)
    startBar: int = Field(ge=1)
    endBar: int = Field(ge=1)
    color: str = "#5b8cff"

    @model_validator(mode="after")
    def valid_range(self):
        if self.endBar < self.startBar:
            raise ValueError("段落结束小节不能早于开始小节")
        return self


class Chord(Model):
    id: str = Field(min_length=1, max_length=120)
    bar: int = Field(ge=1)
    beat: float = Field(ge=1, le=12)
    label: str = Field(min_length=1, max_length=40)
    start: float = Field(default=0, ge=0)
    end: float = Field(default=0, ge=0)
    source: Literal["demo", "manual", "analysis"] = "manual"
    confidence: float = Field(default=1, ge=0, le=1)
    locked: bool = False


class BassEvent(Model):
    id: str = Field(min_length=1, max_length=120)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    pitchClass: int = Field(ge=0, le=11, strict=True)
    confidence: float = Field(default=1, ge=0, le=1)
    source: Literal["demo", "manual", "analysis"] = "manual"
    locked: bool = False

    @model_validator(mode="after")
    def valid_range(self):
        if self.end <= self.start:
            raise ValueError("贝斯音名结束时间必须晚于开始时间")
        return self


class ScoreColors(Model):
    lyrics: str = Field(default="#1D1D1F", pattern=r"^#[0-9A-Fa-f]{6}$")
    top: str = Field(default="#1D4ED8", pattern=r"^#[0-9A-Fa-f]{6}$")
    fill: str = Field(default="#167047", pattern=r"^#[0-9A-Fa-f]{6}$")
    mark: str = Field(default="#C62828", pattern=r"^#[0-9A-Fa-f]{6}$")


class ScoreStyle(Model):
    lyricFontSize: float = Field(default=20, ge=14, le=32)
    lyricPrintSize: float = Field(default=18, ge=10, le=30)
    colors: ScoreColors = Field(default_factory=ScoreColors)
    printColor: bool = True
    printOrientation: Literal["portrait", "landscape"] = "landscape"
    printPreset: Literal["large", "custom"] | None = None
    topPrintSize: float | None = Field(default=None, ge=16, le=36)
    fillPrintSize: float | None = Field(default=None, ge=12, le=24)
    printBarsPerRow: Literal[2, 4] | None = None


class Lyric(Model):
    id: str = Field(min_length=1, max_length=120)
    text: str = Field(max_length=2000)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    source: Literal["demo", "manual", "analysis"] = "manual"
    locked: bool = False
    # Document order stays stable when a phrase is moved along the audio timeline.
    order: int | None = Field(default=None, ge=0, strict=True)

    @model_validator(mode="after")
    def valid_range(self):
        if self.end < self.start:
            raise ValueError("歌词结束时间不能早于开始时间")
        return self


class NoteNotation(Model):
    value: Literal[1, 2, 4, 8, 16, 32]
    dotted: bool = False
    ghost: bool = False
    dead: bool = False
    rest: bool = False
    tie: bool = False
    slur: bool = False


class Note(Model):
    id: str = Field(min_length=1, max_length=120)
    midi: int = Field(ge=0, le=127)
    start: float = Field(ge=0)
    duration: float = Field(gt=0)
    string: int | None = Field(default=None, ge=1, le=4)
    fret: int | None = Field(default=None, ge=0, le=24)
    source: Literal["demo", "manual", "analysis"] = "manual"
    confidence: float = Field(default=1, ge=0, le=1)
    locked: bool = False
    # Written rhythm is independent of the recorded duration in audio seconds.
    notation: NoteNotation | None = None


class DetectedWord(Model):
    text: str = Field(max_length=2000)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    confidence: float = Field(default=0, ge=0, le=1)

    @model_validator(mode="after")
    def valid_range(self):
        if self.end < self.start:
            raise ValueError("识别字词结束时间不能早于开始时间")
        return self


class DetectedSegment(DetectedWord):
    id: str = Field(min_length=1, max_length=120)
    words: list[DetectedWord] = Field(default_factory=list, max_length=10000)


class LyricDiff(Model):
    kind: Literal["equal", "replace", "insert", "delete"]
    original: str = ""
    detected: str = ""


class AlignmentLine(Model):
    id: str = Field(min_length=1, max_length=120)
    lyricId: str | None = None
    text: str = Field(max_length=2000)
    detectedText: str = Field(default="", max_length=4000)
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, ge=0)
    status: Literal["matched", "pending", "manual"] = "pending"
    confidence: float = Field(default=0, ge=0, le=1)
    diff: list[LyricDiff] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_range(self):
        if self.start is not None and self.end is not None and self.end < self.start:
            raise ValueError("歌词候选结束时间不能早于开始时间")
        return self


class LyricAlignment(Model):
    state: Literal["idle", "running", "complete", "error"] = "idle"
    stage: str = "等待歌词识别与对齐"
    progress: float = Field(default=0, ge=0, le=100)
    detectedSegments: list[DetectedSegment] = Field(default_factory=list, max_length=20000)
    lines: list[AlignmentLine] = Field(default_factory=list, max_length=100000)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    jobId: str | None = None


class Marker(Model):
    id: str = Field(min_length=1, max_length=120)
    time: float = Field(ge=0)
    label: Literal["FILL", "BREAK", "UNISON", "SLIDE", "GHOST"]
    text: str = Field(default="", max_length=2000)
    source: Literal["demo", "manual", "analysis", "suggestion"] = "manual"


class FillConnection(Model):
    kind: Literal["slideUp", "slideDown", "hammer", "pull", "tie"]
    targetNoteId: str = Field(min_length=1, max_length=120)


class FillNotation(Model):
    cut: bool = False
    dead: bool = False
    accent: bool = False
    connection: FillConnection | None = None


class ManualFillNote(Model):
    id: str = Field(min_length=1, max_length=120)
    digit: int = Field(ge=0, le=7, strict=True)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    lines: int = Field(default=0, ge=0, le=2, strict=True)
    octave: int = Field(default=0, ge=-2, le=2, strict=True)
    notation: FillNotation | None = None

    @model_validator(mode="after")
    def valid_range(self):
        if self.end <= self.start:
            raise ValueError("手写加花结束时间必须晚于开始时间")
        return self


class ManualFill(Model):
    id: str = Field(min_length=1, max_length=120)
    notes: list[ManualFillNote] = Field(default_factory=list, max_length=10000)


def valid_fill_connection(note: ManualFillNote, target: ManualFillNote | None) -> bool:
    link = note.notation.connection if note.notation else None
    if link is None:
        return True
    if (target is None or target.id != link.targetNoteId or target.start <= note.start
            or note.digit == 0 or target.digit == 0 or note.notation.dead
            or (target.notation is not None and target.notation.dead)):
        return False
    return link.kind != "tie" or (note.digit == target.digit and note.octave == target.octave
                                   and abs(note.end - target.start) <= 1e-6)


class Stem(Model):
    id: Literal["original", "bass", "drums", "vocals", "other", "backing"]
    name: str
    url: str = ""
    enhancedUrl: str | None = None
    gainDb: float | None = Field(default=None, le=12)
    available: bool = False
    peaks: list[float] = Field(default_factory=list, max_length=3000)


class Analysis(Model):
    state: Literal["idle", "running", "complete", "error"] = "idle"
    stage: str = "等待分析"
    progress: float = Field(default=0, ge=0, le=100)
    warnings: list[str] = Field(default_factory=list)


class PerformanceNotes(Model):
    effectsPreset: str = Field(default="", max_length=10000)
    technique: str = Field(default="", max_length=10000)
    reminders: str = Field(default="", max_length=10000)
    includeInExport: bool = True


class KeyCandidate(Model):
    key: str = Field(max_length=40)
    score: float = Field(ge=-1, le=1)


class KeyAnalysis(Analysis):
    stage: str = "调性尚未识别"
    candidates: list[KeyCandidate] = Field(default_factory=list, max_length=24)
    detectedKey: str | None = None
    confirmed: bool = False


class LyricAnchor(Model):
    id: str = Field(min_length=1, max_length=120)
    lyricId: str = Field(min_length=1, max_length=120)
    startOffset: int = Field(ge=0)
    endOffset: int = Field(gt=0)
    text: str = Field(min_length=1, max_length=2000)
    eventId: str = Field(min_length=1, max_length=120)
    track: Literal["bass", "chords"]
    disabled: bool = False

    @model_validator(mode="after")
    def valid_offsets(self):
        if self.endOffset <= self.startOffset:
            raise ValueError('歌词关联范围必须包含文字')
        return self


class Project(Model):
    id: str
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="", max_length=300)
    duration: float = Field(gt=0, le=86400)
    originalKey: str = Field(default="C", max_length=40)
    key: str = Field(default="C", max_length=40)
    bpm: float = Field(default=96, ge=20, le=400)
    meter: str = "4/4"
    offset: float = Field(default=0, ge=0)
    beatTimes: list[float] = Field(default_factory=list, max_length=200000)
    sections: list[Section] = Field(default_factory=list, max_length=20000)
    chords: list[Chord] = Field(default_factory=list, max_length=100000)
    bassEvents: list[BassEvent] = Field(default_factory=list, max_length=100000)
    topTrack: Literal["bass", "chords"] = "chords"
    scoreStyle: ScoreStyle = Field(default_factory=ScoreStyle)
    performanceNotes: PerformanceNotes = Field(default_factory=PerformanceNotes)
    keyAnalysis: KeyAnalysis | None = None
    harmonyAnalysis: Analysis = Field(default_factory=Analysis)
    backingAnalysis: Analysis = Field(default_factory=Analysis)
    audioSource: Literal["original", "uploaded_bass"] = "original"
    lyricAnchors: list[LyricAnchor] = Field(default_factory=list, max_length=100000)
    lyrics: list[Lyric] = Field(default_factory=list, max_length=100000)
    lyricsOriginal: str = Field(default="", max_length=100000)
    lyricAlignment: LyricAlignment = Field(default_factory=LyricAlignment)
    notes: list[Note] = Field(default_factory=list, max_length=200000)
    markers: list[Marker] = Field(default_factory=list, max_length=20000)
    # Personal scale-degree hints are independent of analyzed bass/MIDI notes.
    manualFills: list[ManualFill] = Field(default_factory=list, max_length=20000)
    stems: list[Stem] = Field(default_factory=list, max_length=6)
    analysis: Analysis = Field(default_factory=Analysis)
    updatedAt: str = Field(default_factory=utc_now)
    revision: int = Field(default=1, ge=1)
    isDemo: bool = False

    @field_validator("meter")
    @classmethod
    def valid_meter(cls, value: str):
        pieces = value.split("/")
        if len(pieces) != 2 or not all(p.isdigit() for p in pieces):
            raise ValueError("拍号格式应为 4/4、3/4 或 6/8")
        if not 1 <= int(pieces[0]) <= 12 or int(pieces[1]) not in (2, 4, 8, 16):
            raise ValueError("不支持的拍号")
        return value

    @model_validator(mode="after")
    def validate_timeline(self):
        if any(not math.isfinite(t) or t < 0 for t in self.beatTimes):
            raise ValueError("节拍时间必须是非负有限数值")
        if any(b <= a for a, b in zip(self.beatTimes, self.beatTimes[1:])):
            raise ValueError("节拍时间必须严格递增")
        beats_per_bar = int(self.meter.split("/")[0])
        if any(c.beat >= beats_per_bar + 1 for c in self.chords):
            raise ValueError("和弦拍点超出当前拍号")
        if self.offset > self.duration:
            raise ValueError("第一拍时间不能超出音频长度")
        for name in ("sections", "chords", "bassEvents", "lyrics", "notes", "markers", "manualFills", "stems"):
            ids = [item.id for item in getattr(self, name)]
            if len(ids) != len(set(ids)):
                raise ValueError(f"{name} 存在重复事件 ID")
        self.validate_manual_fills()
        self.validate_bass_events()
        return self

    def validate_manual_fills(self) -> None:
        note_ids = [note.id for group in self.manualFills for note in group.notes]
        if len(note_ids) != len(set(note_ids)):
            raise ValueError("manualFills 存在重复数字 ID")
        if any(note.end > self.duration for group in self.manualFills for note in group.notes):
            raise ValueError("手写加花时间必须位于音频范围内")
        for group in self.manualFills:
            ordered = sorted(group.notes, key=lambda note: (note.start, note.id))
            for index, note in enumerate(ordered):
                if note.digit == 0 and note.notation and (note.notation.cut or note.notation.dead or note.notation.accent):
                    raise ValueError("休止符不能设置切音、闷音或重音")
                link = note.notation.connection if note.notation else None
                if link is None:
                    continue
                target = ordered[index + 1] if index + 1 < len(ordered) else None
                if not valid_fill_connection(note, target):
                    raise ValueError("演奏法连线必须连接同组的下一个非休止、非闷音；延音线要求同音且时间连续")

    def clean_restored_fill_notation(self) -> None:
        """Drop obsolete links restored for an old client after its note edits."""
        for group in self.manualFills:
            ordered = sorted(group.notes, key=lambda note: (note.start, note.id))
            for note in ordered:
                if note.digit == 0 and note.notation:
                    note.notation = None
            for index, note in enumerate(ordered):
                target = ordered[index + 1] if index + 1 < len(ordered) else None
                if note.notation and not valid_fill_connection(note, target):
                    note.notation.connection = None

    def validate_bass_events(self) -> None:
        if any(event.end > self.duration for event in self.bassEvents):
            raise ValueError("贝斯音名时间必须位于音频范围内")


class AnalyzeRequest(Model):
    separate: bool = False
    transcribe: bool = False
    source: Literal["original", "bass", "uploaded_bass"] = "original"


class LyricsAlignRequest(Model):
    originalText: str | None = Field(default=None, max_length=100000)
    lyricId: str | None = Field(default=None, max_length=120)
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, ge=0)
    language: str | None = Field(default=None, max_length=12, pattern=r"^[a-z]{2,3}(?:-[A-Za-z]{2})?$")
    model: Literal["tiny", "base", "small", "medium", "large-v3"] = "tiny"
    mode: Literal["recognize", "align"] = "align"
    revision: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def valid_range(self):
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ValueError("识别区间结束时间必须晚于开始时间")
        return self
