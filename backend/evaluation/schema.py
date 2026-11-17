"""Pydantic records for the P0 corpus, gold labels, and local predictions.

Musical labels here are not project files. Loading them does not merge
anything into a saved chart, and confidence is not an input to a metric.
"""
from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PROTOCOL = "basstrace-p0-eval"
PROTOCOL_VERSION = "1"
PITCH_CLASS_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
AUDIO_SUFFIXES = (".wav", ".mp3", ".flac", ".m4a", ".ogg")
STEMS = ("bass", "drums", "vocals", "other")
# Section-name agreement is computed only when every predicted name is in this set.
# Coarse names such as "候选段落 1" stay uncompared instead of becoming a zero.
SEMANTIC_SECTION_NAMES = frozenset({
    "前奏", "主歌", "预副歌", "副歌", "桥段", "间奏", "尾奏",
    "Intro", "Verse", "Pre-Chorus", "Chorus", "Bridge", "Interlude", "Outro",
})
NON_MODEL_IMPLEMENTATIONS = frozenset({"manual", "gold", "reference", "human", "label"})
ACTIVITIES = ("bpm", "sections", "chords", "lyrics", "bassPitch", "notes", "listening")


class EvalModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


def _aware(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field} 需要 ISO 时间") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field} 需要带时区")
    return parsed.astimezone(timezone.utc)


def _date(value: str, field: str) -> datetime:
    if len(value) != 10:
        raise ValueError(f"{field} 需要 YYYY-MM-DD")
    try:
        return datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError(f"{field} 需要 YYYY-MM-DD") from exc


def validate_meter(value: str) -> str:
    pieces = value.split("/")
    if len(pieces) != 2 or not all(piece.isdigit() for piece in pieces):
        raise ValueError("拍号格式应为 4/4、3/4 或 6/8")
    if not 1 <= int(pieces[0]) <= 12 or int(pieces[1]) not in (2, 4, 8, 16):
        raise ValueError("不支持的拍号")
    return value


def _no_overlap(items: list, label: str) -> None:
    ordered = sorted(items, key=lambda item: (item.start, item.end, getattr(item, "text", "")))
    for previous, following in zip(ordered, ordered[1:]):
        if following.start < previous.end - 1e-6:
            raise ValueError(f"{label}时间重叠")


def _ordered_interval(end: float, start: float, label: str) -> None:
    if end <= start:
        raise ValueError(f"{label}结束时间必须晚于开始时间")


class Authorization(EvalModel):
    holder: str = Field(min_length=1, max_length=300)
    scope: str = Field(min_length=1, max_length=2000)
    grantedOn: str
    expiresOn: str
    reference: str = Field(min_length=1, max_length=200)
    localOnly: bool
    redistributionAllowed: bool
    coversTrackIds: list[str] = Field(min_length=1, max_length=30)

    @field_validator("grantedOn")
    @classmethod
    def granted_date(cls, value: str) -> str:
        _date(value, "grantedOn")
        return value

    @field_validator("expiresOn")
    @classmethod
    def expiry_date(cls, value: str) -> str:
        _date(value, "expiresOn")
        return value

    @model_validator(mode="after")
    def local_grant(self):
        if self.localOnly is not True:
            raise ValueError("授权必须声明只在本机使用")
        if self.redistributionAllowed is not False:
            raise ValueError("授权必须声明不可再分发")
        if _date(self.expiresOn, "expiresOn") < _date(self.grantedOn, "grantedOn"):
            raise ValueError("授权到期日不能早于授予日")
        if len(set(self.coversTrackIds)) != len(self.coversTrackIds):
            raise ValueError("授权曲目编号重复")
        return self


class TrackRef(EvalModel):
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$")
    title: str = Field(min_length=1, max_length=300)
    language: str = Field(pattern=r"^(zh|en|ja|other)$")
    durationSeconds: float = Field(gt=0, le=86400)
    audioRelativePath: str = Field(min_length=1, max_length=240)
    hasGoldLabels: bool

    @field_validator("audioRelativePath")
    @classmethod
    def relative_audio(cls, value: str) -> str:
        if value.startswith(("/", "\\")) or ":" in value or "\\" in value:
            raise ValueError("音频路径必须是曲目目录内的相对路径")
        parts = value.split("/")
        if ".." in parts or "" in parts:
            raise ValueError("音频路径不能跳出曲目目录")
        suffix = value[value.rfind("."):].lower() if "." in value else ""
        if suffix not in AUDIO_SUFFIXES:
            raise ValueError("音频后缀需要是 wav、mp3、flac、m4a 或 ogg")
        return value


class CorpusManifest(EvalModel):
    protocol: str
    protocolVersion: str
    authorization: Authorization
    tracks: list[TrackRef] = Field(min_length=1, max_length=30)

    @field_validator("protocol")
    @classmethod
    def known_protocol(cls, value: str) -> str:
        if value != PROTOCOL:
            raise ValueError("protocol 必须是 basstrace-p0-eval")
        return value

    @field_validator("protocolVersion")
    @classmethod
    def known_version(cls, value: str) -> str:
        if value != PROTOCOL_VERSION:
            raise ValueError("protocolVersion 必须是 1")
        return value

    @model_validator(mode="after")
    def unique_tracks(self):
        ids = [track.id for track in self.tracks]
        if len(set(ids)) != len(ids):
            raise ValueError("曲目编号重复")
        return self


class TempoAnnotation(EvalModel):
    bpm: float = Field(ge=20, le=400)
    meter: str
    offsetSeconds: float = Field(ge=0)
    downbeats: list[float] = Field(min_length=1, max_length=200000)

    @field_validator("meter")
    @classmethod
    def meter_value(cls, value: str) -> str:
        return validate_meter(value)

    @model_validator(mode="after")
    def beat_grid(self):
        if any(following <= previous for previous, following in zip(self.downbeats, self.downbeats[1:])):
            raise ValueError("下拍时间必须严格递增")
        if abs(self.downbeats[0] - self.offsetSeconds) > 1e-3:
            raise ValueError("第一拍偏移需要与第一个下拍一致")
        return self


class SectionSpan(EvalModel):
    name: str = Field(min_length=1, max_length=100)
    start: float = Field(ge=0)
    end: float = Field(gt=0)

    @model_validator(mode="after")
    def ordered(self):
        _ordered_interval(self.end, self.start, "段落")
        return self


class ChordAnnotation(EvalModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    label: str = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def ordered(self):
        _ordered_interval(self.end, self.start, "和弦")
        return self


class ChordPrediction(ChordAnnotation):
    # Accepted so an export can carry it. Metric code never reads it.
    confidence: float | None = Field(default=None, ge=0, le=1)


class LyricAnnotation(EvalModel):
    text: str = Field(min_length=1, max_length=2000)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    granularity: str = Field(pattern=r"^(line|word)$")

    @model_validator(mode="after")
    def ordered(self):
        if self.end < self.start:
            raise ValueError("歌词结束时间不能早于开始时间")
        return self


class LyricPrediction(LyricAnnotation):
    confidence: float | None = Field(default=None, ge=0, le=1)


class NoteAnnotation(EvalModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    midi: int = Field(ge=0, le=127)

    @model_validator(mode="after")
    def ordered(self):
        _ordered_interval(self.end, self.start, "音符")
        return self


class NotePrediction(NoteAnnotation):
    confidence: float | None = Field(default=None, ge=0, le=1)


class BassPitchAnnotation(EvalModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    pitchClass: int = Field(ge=0, le=11)

    @model_validator(mode="after")
    def ordered(self):
        _ordered_interval(self.end, self.start, "贝斯音名")
        return self


class BassPitchPrediction(BassPitchAnnotation):
    confidence: float | None = Field(default=None, ge=0, le=1)


class Provenance(EvalModel):
    implementation: str = Field(min_length=1, max_length=120)
    modelName: str | None = Field(default=None, min_length=1, max_length=120)
    modelVersion: str | None = Field(default=None, min_length=1, max_length=120)
    parameters: dict[str, str | int | float | bool] = Field(default_factory=dict)

    @field_validator("parameters")
    @classmethod
    def parameter_size(cls, value: dict) -> dict:
        if len(value) > 40:
            raise ValueError("参数过多")
        for key, item in value.items():
            if not 1 <= len(str(key)) <= 80:
                raise ValueError("参数名长度无效")
            if isinstance(item, str) and len(item) > 200:
                raise ValueError("参数值过长")
        return value


class StemPresence(EvalModel):
    bass: bool
    drums: bool
    vocals: bool
    other: bool


class SeparationRecord(EvalModel):
    status: str = Field(pattern=r"^(completed|failed|missing)$")
    error: str | None = Field(default=None, max_length=2000)
    usedMixdownAsBass: bool
    stems: StemPresence
    provenance: Provenance | None = None

    @model_validator(mode="after")
    def consistent(self):
        if self.usedMixdownAsBass is not False:
            raise ValueError("不能把混音当作贝斯分轨")
        present = (self.stems.bass, self.stems.drums, self.stems.vocals, self.stems.other)
        if self.status == "completed":
            if not all(present):
                raise ValueError("完成的分离必须同时具有贝斯、鼓、人声和其他分轨")
            provenance = self.provenance
            if (provenance is None or provenance.implementation != "demucs"
                    or not provenance.modelName or not provenance.modelVersion):
                raise ValueError("完成的分离必须记录 Demucs 模型名称和版本")
            if self.error:
                raise ValueError("完成的分离不能同时带有错误")
        else:
            if not self.error:
                raise ValueError("分离失败或未运行时必须写明原因")
            if any(present):
                raise ValueError("未完成的分离不能声明已有分轨")
        return self


class WallClock(EvalModel):
    separationSeconds: float | None = Field(default=None, ge=0, le=86400)
    structureSeconds: float | None = Field(default=None, ge=0, le=86400)
    harmonySeconds: float | None = Field(default=None, ge=0, le=86400)
    bassAnalysisSeconds: float | None = Field(default=None, ge=0, le=86400)
    lyricRecognitionSeconds: float | None = Field(default=None, ge=0, le=86400)


class ModelRunEnvironment(EvalModel):
    recordedAt: str
    cpu: str = Field(min_length=1, max_length=300)
    ramBytes: int | None = Field(default=None, ge=0)
    gpu: str | None = Field(default=None, max_length=300)
    os: str = Field(min_length=1, max_length=200)
    python: str = Field(min_length=1, max_length=40)

    @field_validator("recordedAt")
    @classmethod
    def recorded(cls, value: str) -> str:
        _aware(value, "recordedAt")
        return value


class PredictionFile(EvalModel):
    protocol: str
    protocolVersion: str
    trackId: str = Field(min_length=1, max_length=81)
    separation: SeparationRecord
    wallClock: WallClock
    modelRun: ModelRunEnvironment | None = None
    tempo: TempoAnnotation | None = None
    sections: list[SectionSpan] | None = Field(default=None, max_length=20000)
    chords: list[ChordPrediction] | None = Field(default=None, max_length=100000)
    lyrics: list[LyricPrediction] | None = Field(default=None, max_length=100000)
    notes: list[NotePrediction] | None = Field(default=None, max_length=200000)
    bassPitches: list[BassPitchPrediction] | None = Field(default=None, max_length=100000)
    structureProvenance: Provenance | None = None
    harmonyProvenance: Provenance | None = None
    bassProvenance: Provenance | None = None
    noteProvenance: Provenance | None = None
    lyricProvenance: Provenance | None = None

    @field_validator("protocol")
    @classmethod
    def known_protocol(cls, value: str) -> str:
        if value != PROTOCOL:
            raise ValueError("protocol 必须是 basstrace-p0-eval")
        return value

    @field_validator("protocolVersion")
    @classmethod
    def known_version(cls, value: str) -> str:
        if value != PROTOCOL_VERSION:
            raise ValueError("protocolVersion 必须是 1")
        return value


class GoldFile(EvalModel):
    protocol: str
    protocolVersion: str
    trackId: str = Field(min_length=1, max_length=81)
    # Committed formula examples set this true. The runner then records no score.
    syntheticExample: bool = False
    tempo: TempoAnnotation | None = None
    sections: list[SectionSpan] | None = Field(default=None, max_length=20000)
    chords: list[ChordAnnotation] | None = Field(default=None, max_length=100000)
    lyrics: list[LyricAnnotation] | None = Field(default=None, max_length=100000)
    notes: list[NoteAnnotation] | None = Field(default=None, max_length=200000)
    bassPitches: list[BassPitchAnnotation] | None = Field(default=None, max_length=100000)

    @field_validator("protocol")
    @classmethod
    def known_protocol(cls, value: str) -> str:
        if value != PROTOCOL:
            raise ValueError("protocol 必须是 basstrace-p0-eval")
        return value

    @field_validator("protocolVersion")
    @classmethod
    def known_version(cls, value: str) -> str:
        if value != PROTOCOL_VERSION:
            raise ValueError("protocolVersion 必须是 1")
        return value

    @model_validator(mode="after")
    def layers_do_not_overlap(self):
        if self.sections:
            _no_overlap(self.sections, "段落")
        if self.chords:
            _no_overlap(self.chords, "和弦")
        if self.lyrics:
            _no_overlap(self.lyrics, "歌词")
            grains = {item.granularity for item in self.lyrics}
            if len(grains) != 1:
                raise ValueError("同一首精标歌词只能使用一种粒度")
        if self.bassPitches:
            _no_overlap(self.bassPitches, "贝斯音名")
        return self


class StemRating(EvalModel):
    stem: str = Field(pattern=r"^(bass|drums|vocals|other)$")
    bleed: int = Field(ge=1, le=5)
    artifacts: int = Field(ge=1, le=5)
    missingSource: int = Field(ge=1, le=5)


class ListeningSheet(EvalModel):
    protocol: str
    protocolVersion: str
    trackId: str = Field(min_length=1, max_length=81)
    raterId: str = Field(min_length=1, max_length=120)
    ratedAt: str
    playback: str = Field(min_length=1, max_length=300)
    ratings: list[StemRating] = Field(min_length=4, max_length=4)

    @field_validator("protocol")
    @classmethod
    def known_protocol(cls, value: str) -> str:
        if value != PROTOCOL:
            raise ValueError("protocol 必须是 basstrace-p0-eval")
        return value

    @field_validator("protocolVersion")
    @classmethod
    def known_version(cls, value: str) -> str:
        if value != PROTOCOL_VERSION:
            raise ValueError("protocolVersion 必须是 1")
        return value

    @field_validator("ratedAt")
    @classmethod
    def rated(cls, value: str) -> str:
        _aware(value, "ratedAt")
        return value

    @model_validator(mode="after")
    def one_row_per_stem(self):
        found = [item.stem for item in self.ratings]
        if sorted(found) != sorted(STEMS):
            raise ValueError("听感表必须且只能为贝斯、鼓、人声、其他各记一栏")
        return self


class HumanEditFile(EvalModel):
    protocol: str
    protocolVersion: str
    trackId: str = Field(min_length=1, max_length=81)
    editorId: str = Field(min_length=1, max_length=120)
    startedAt: str
    finishedAt: str
    durationSeconds: float = Field(gt=0, le=86400 * 14)
    activities: list[str] = Field(min_length=1, max_length=7)

    @field_validator("protocol")
    @classmethod
    def known_protocol(cls, value: str) -> str:
        if value != PROTOCOL:
            raise ValueError("protocol 必须是 basstrace-p0-eval")
        return value

    @field_validator("protocolVersion")
    @classmethod
    def known_version(cls, value: str) -> str:
        if value != PROTOCOL_VERSION:
            raise ValueError("protocolVersion 必须是 1")
        return value

    @field_validator("activities")
    @classmethod
    def known_activities(cls, value: list[str]) -> list[str]:
        if any(item not in ACTIVITIES for item in value) or len(set(value)) != len(value):
            raise ValueError("人工校正活动无效或重复")
        return value

    @model_validator(mode="after")
    def duration_matches_clock(self):
        started = _aware(self.startedAt, "startedAt")
        finished = _aware(self.finishedAt, "finishedAt")
        elapsed = (finished - started).total_seconds()
        if elapsed <= 0 or abs(elapsed - self.durationSeconds) > 1:
            raise ValueError("人工校正时长需要与起止时间一致")
        return self


def protocol_document() -> dict:
    """Machine-readable field definitions. This is a schema, not a measurement."""
    models = {
        "manifest": CorpusManifest,
        "gold": GoldFile,
        "prediction": PredictionFile,
        "listening": ListeningSheet,
        "humanEdit": HumanEditFile,
    }
    return {
        "kind": "json-schema",
        "protocol": PROTOCOL,
        "protocolVersion": PROTOCOL_VERSION,
        "accuracyClaim": False,
        "measured": False,
        "models": {name: model.model_json_schema() for name, model in models.items()},
    }
