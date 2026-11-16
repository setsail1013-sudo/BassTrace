"""Local guitar-chart layout and lyric alignment.

Guitar chords are their own ``guitarChords`` list. This module never edits bass
events, handwritten fills, lyrics, harmony chords, or section data.

The geometry rules below decide whether a chart may be written at all. They are
refusal gates for a human review queue, not a measure of OCR accuracy.
"""
from __future__ import annotations

import re
import statistics
import unicodedata
from dataclasses import dataclass, field
from uuid import uuid4

from .models import GuitarChord, Project, normalize_chord_symbol, valid_chord_symbol
from .timeline import beat_to_time, time_to_beat

IMPORT_NOTE = "这些和弦来自本地版面提取，尚未经过人工核对，不能视为已验收的识别准确率。"
NO_LYRICS = "当前工程没有歌词，无法把吉他和弦对齐到歌词。请先导入并保存歌词。"
WRONG_SONG = "这份和弦谱与当前工程不是同一首歌，未写入和弦。"
CANNOT_MATCH = "这份和弦谱的歌词无法与当前工程歌词对齐，未写入和弦。"
NO_CHORDS = "没有从和弦谱版面中提取到和弦，未写入。"
NO_LYRIC_CONFIRM = "这份和弦谱没有可对齐的歌词，无法确认是否为当前歌曲，未写入和弦。"
UNTIMED_GRID = "前奏、间奏等没有歌词的和弦未写入时间：工程没有可用的节拍网格，请人工指定。"
UNTIMED_POSITION = "部分没有歌词的和弦无法确定小节位置，未写入时间。"
REPEAT_WARNING = "和弦谱中重复印刷的段落已忽略，没有重复写入。"
PARTIAL_WARNING = "有部分带和弦的歌词没能与工程歌词逐字对齐，这些行的和弦没有写入。"
COLLISION_WARNING = "已保留人工确认或手改的和弦，相同位置的新候选没有覆盖它们。"

_SECTIONS = (
    ("预副歌", "预副歌"),
    ("前奏", "前奏"),
    ("主歌", "主歌"),
    ("副歌", "副歌"),
    ("间奏", "间奏"),
    ("桥段", "桥段"),
    ("尾奏", "结尾"),
    ("尾声", "结尾"),
    ("结尾", "结尾"),
    ("导歌", "导歌"),
    ("插曲", "插曲"),
    ("独奏", "独奏"),
    ("过门", "间奏"),
    ("intro", "前奏"),
    ("verse", "主歌"),
    ("chorus", "副歌"),
    ("bridge", "桥段"),
    ("interlude", "间奏"),
    ("outro", "结尾"),
    ("solo", "独奏"),
)
_OPENING_SECTIONS = {"前奏", "导歌"}


class ChartError(Exception):
    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class Glyph:
    """One text box in top-left, y-down page coordinates."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    page: int = 0


@dataclass
class _Token:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    kind: str


@dataclass
class _Line:
    tokens: list[_Token]
    y0: float
    y1: float
    x0: float
    x1: float
    role: str


@dataclass
class _LyricMark:
    symbol: str
    offset: int


@dataclass
class _BarMark:
    symbol: str
    bar_index: int
    beat: float


@dataclass
class _Item:
    kind: str
    section: str | None
    text: str = ""
    norm: str = ""
    lyric_chords: list[_LyricMark] = field(default_factory=list)
    bar_chords: list[_BarMark] = field(default_factory=list)


@dataclass
class _LyricRef:
    lyric: object
    norm: str


@dataclass
class ImportDraft:
    chords: list[GuitarChord]
    warnings: list[str]


@dataclass
class MergeResult:
    chords: list[GuitarChord]
    added: list[GuitarChord]
    preserved_ids: list[str]
    collided: bool


def measure_grid_available(project: Project, edited: dict | None = None) -> bool:
    """The untouched 96 BPM / offset 0 template is not a measure grid."""
    if len(project.beatTimes) >= 2:
        return True
    if edited and any(edited.get(name) for name in ("bpm", "meter", "offset", "beatTimes")):
        return True
    if project.sections:
        return True
    if project.offset > 0 or abs(project.bpm - 96) > 1e-9:
        return True
    return False


def normalize_with_map(text: str) -> tuple[str, list[int]]:
    chars: list[str] = []
    indexes: list[int] = []
    for index, raw in enumerate(text):
        for piece in unicodedata.normalize("NFKC", raw).casefold():
            if piece.isspace() or unicodedata.category(piece)[:1] in {"P", "S", "Z", "C"}:
                continue
            chars.append(piece)
            indexes.append(index)
    return "".join(chars), indexes


def section_name(text: str) -> str | None:
    cleaned = unicodedata.normalize("NFKC", text).strip().casefold()
    cleaned = cleaned.strip("[]【】()（）:：.· ")
    cleaned = "".join(cleaned.split())
    number = ""
    if cleaned and cleaned[-1].isdigit():
        body = cleaned.rstrip("0123456789")
        number = cleaned[len(body):]
        if body:
            cleaned = body
    for key, label in _SECTIONS:
        if cleaned == key.casefold():
            return label + number
    return None


def glyphs_to_candidates(glyphs: list[Glyph], project: Project, *, grid: bool) -> ImportDraft:
    beats = int(project.meter.split("/")[0])
    items = layout_items(glyphs, beats)
    matched, repeats, warnings = match_lyrics(items, project)
    return ImportDraft(place_chords(items, matched, repeats, project, grid=grid, warnings=warnings), warnings)


def merge_guitar_chords(existing: list[GuitarChord], candidates: list[GuitarChord], project: Project) -> MergeResult:
    """Keep confirmed and manual chords. Drop previous candidates."""
    protected = [chord.model_copy(deep=True) for chord in existing if chord.status in {"confirmed", "manual"}]
    protected_keys: list[tuple] = []
    for chord in protected:
        protected_keys.append(_slot(chord, protected_keys))
    used = set(protected_keys)
    added: list[GuitarChord] = []
    collided = False
    candidate_keys: list[tuple] = []
    for chord in candidates:
        key = _slot(chord, candidate_keys)
        candidate_keys.append(key)
        if key in used:
            if key in used and key in set(protected_keys):
                collided = True
            continue
        used.add(key)
        added.append(chord)
    added_ids = {chord.id for chord in added}
    merged = _sort_chords(protected + added, project)
    return MergeResult(merged, [chord for chord in merged if chord.id in added_ids], [chord.id for chord in protected], collided)


def layout_items(glyphs: list[Glyph], beats_per_bar: int) -> list[_Item]:
    by_page: dict[int, list[Glyph]] = {}
    for glyph in glyphs:
        for piece in _explode(glyph):
            by_page.setdefault(piece.page, []).append(piece)
    items: list[_Item] = []
    section: str | None = None
    for page in sorted(by_page):
        for column in _split_columns(by_page[page]):
            lines, typical = _group_lines(column)
            section, produced = _read_lines(lines, typical, section, beats_per_bar)
            items.extend(produced)
    return _coalesce(items)


def _explode(glyph: Glyph) -> list[Glyph]:
    text = unicodedata.normalize("NFKC", glyph.text).replace("♯", "#").replace("♭", "b").strip()
    if not text:
        return []
    parts = re.findall(r"[|｜‖]|[^\s|｜‖]+", text)
    atoms: list[str] = []
    for part in parts:
        match = re.fullmatch(r"(.+?)([-—–－~～]+)", part)
        head = normalize_chord_symbol(match.group(1)) if match else ""
        if match and valid_chord_symbol(head):
            atoms.append(match.group(1))
            atoms.append(match.group(2))
        else:
            atoms.append(part)
    atoms = [atom for atom in atoms if atom.strip()]
    if len(atoms) <= 1:
        return [Glyph(atoms[0] if atoms else text, glyph.x0, glyph.y0, glyph.x1, glyph.y1, glyph.page)]
    width = max(glyph.x1 - glyph.x0, 1.0)
    total = sum(max(1, len(atom)) for atom in atoms)
    cursor = glyph.x0
    pieces = []
    for atom in atoms:
        piece_width = width * max(1, len(atom)) / total
        pieces.append(Glyph(atom, cursor, glyph.y0, cursor + piece_width, glyph.y1, glyph.page))
        cursor += piece_width
    return pieces


def _split_columns(glyphs: list[Glyph]) -> list[list[Glyph]]:
    if len(glyphs) < 4:
        return [glyphs]
    left_edge = min(glyph.x0 for glyph in glyphs)
    right_edge = max(glyph.x1 for glyph in glyphs)
    width = right_edge - left_edge
    if width <= 1:
        return [glyphs]
    bins = 48
    occupancy = [0] * bins
    for glyph in glyphs:
        start = int((glyph.x0 - left_edge) / width * (bins - 1))
        end = int((max(glyph.x1, glyph.x0) - left_edge) / width * (bins - 1))
        for index in range(max(0, start), min(bins, end + 1)):
            occupancy[index] += 1
    best: tuple[int, int] | None = None
    index = 0
    while index < bins:
        if occupancy[index] != 0:
            index += 1
            continue
        end = index
        while end < bins and occupancy[end] == 0:
            end += 1
        midpoint = (index + end - 1) / 2 / bins
        if end - index >= 2 and 0.28 <= midpoint <= 0.72 and (best is None or end - index > best[1] - best[0]):
            best = (index, end)
        index = end
    if best is None:
        return [glyphs]
    gap_x = left_edge + ((best[0] + best[1]) / 2) / bins * width
    left = [glyph for glyph in glyphs if (glyph.x0 + glyph.x1) / 2 < gap_x]
    right = [glyph for glyph in glyphs if (glyph.x0 + glyph.x1) / 2 >= gap_x]
    if len(left) < 2 or len(right) < 2:
        return [glyphs]
    return [left, right]


def _group_lines(glyphs: list[Glyph]) -> tuple[list[_Line], float]:
    ordered = sorted(glyphs, key=lambda glyph: (glyph.y0, glyph.x0))
    heights = [glyph.y1 - glyph.y0 for glyph in ordered if glyph.y1 > glyph.y0]
    typical = statistics.median(heights) if heights else 12.0
    grouped: list[list[Glyph]] = []
    for glyph in ordered:
        if grouped:
            current = grouped[-1]
            y0 = min(item.y0 for item in current)
            y1 = max(item.y1 for item in current)
            if abs((glyph.y0 + glyph.y1) / 2 - (y0 + y1) / 2) <= max(typical, y1 - y0, 1) * 0.55:
                current.append(glyph)
                continue
        grouped.append([glyph])
    lines = []
    for tokens in grouped:
        tokens.sort(key=lambda glyph: glyph.x0)
        classified = [_classify(glyph) for glyph in tokens if _classify(glyph).kind != "noise"]
        if not classified:
            continue
        lines.append(_Line(
            classified,
            min(token.y0 for token in classified),
            max(token.y1 for token in classified),
            min(token.x0 for token in classified),
            max(token.x1 for token in classified),
            _line_role(classified),
        ))
    return lines, typical


def _classify(glyph: Glyph) -> _Token:
    text = glyph.text.strip()
    kind = "noise"
    if text and text.casefold() not in {"有谱么", "yopu", "yopu.co", "www.yopu.co"} and not re.fullmatch(r"[-–—]?\d{1,3}[-–—]?", text):
        if text in {"|", "｜", "‖"}:
            kind = "bar"
        elif re.fullmatch(r"[-—–－~～]+", text):
            kind = "dash"
        elif section_name(text) and not valid_chord_symbol(normalize_chord_symbol(text)):
            kind = "section"
        elif valid_chord_symbol(normalize_chord_symbol(text)):
            kind = "chord"
        elif any(_cjk(char) for char in text):
            kind = "lyric"
        else:
            kind = "other"
    return _Token(text, glyph.x0, glyph.y0, glyph.x1, glyph.y1, kind)


def _cjk(char: str) -> bool:
    code = ord(char)
    return 0x3400 <= code <= 0x9FFF or 0xF900 <= code <= 0xFAFF


def _line_role(tokens: list[_Token]) -> str:
    kinds = {token.kind for token in tokens}
    if "lyric" in kinds:
        return "lyric"
    if "chord" in kinds or "bar" in kinds:
        return "chord"
    if "section" in kinds:
        return "section"
    return "other"


def _read_lines(lines: list[_Line], typical: float, section: str | None, beats_per_bar: int) -> tuple[str | None, list[_Item]]:
    items: list[_Item] = []
    pending: _Line | None = None

    def flush(line: _Line | None, attached: _Line | None = None) -> None:
        nonlocal pending
        if line is None:
            return
        label = _line_section(line.tokens) or section
        if attached is not None:
            text, marks = _lyric_marks(attached, line)
            norm, _indexes = normalize_with_map(text)
            if norm:
                items.append(_Item("lyric", label, text, norm, marks))
        else:
            bars = _bar_marks(line.tokens, beats_per_bar)
            if bars:
                items.append(_Item("instrumental", label, bar_chords=bars))
        pending = None

    for line in lines:
        label = _line_section(line.tokens)
        if line.role == "section":
            flush(pending)
            if label:
                section = label
            continue
        if line.role == "chord":
            flush(pending)
            if label:
                section = label
            pending = line
            continue
        if label:
            section = label
        if line.role == "lyric":
            if pending is not None and _above(pending, line, typical):
                flush(pending, line)
            else:
                flush(pending)
                text, _marks = _lyric_marks(line, None)
                norm, _indexes = normalize_with_map(text)
                if norm:
                    items.append(_Item("lyric", section, text, norm))
            continue
    flush(pending)
    return section, items


def _line_section(tokens: list[_Token]) -> str | None:
    for token in tokens:
        if token.kind == "section":
            return section_name(token.text)
    return None


def _above(chord_line: _Line, lyric_line: _Line, typical: float) -> bool:
    gap = lyric_line.y0 - chord_line.y1
    if not -typical * 0.45 <= gap <= max(typical * 2.4, 8):
        return False
    overlap = min(chord_line.x1, lyric_line.x1) - max(chord_line.x0, lyric_line.x0)
    return overlap > 0


def _lyric_marks(lyric_line: _Line, chord_line: _Line | None) -> tuple[str, list[_LyricMark]]:
    boxes: list[tuple[float, float]] = []
    pieces: list[str] = []
    for token in lyric_line.tokens:
        if token.kind != "lyric":
            continue
        text = token.text.strip()
        if not text:
            continue
        width = max(token.x1 - token.x0, 1e-6)
        step = width / len(text)
        for index, _char in enumerate(text):
            boxes.append((token.x0 + index * step, token.x0 + (index + 1) * step))
        pieces.append(text)
    marks: list[_LyricMark] = []
    if chord_line is not None and boxes:
        seen: set[int] = set()
        for token in chord_line.tokens:
            if token.kind != "chord":
                continue
            symbol = normalize_chord_symbol(token.text)
            if not valid_chord_symbol(symbol):
                continue
            center = (token.x0 + token.x1) / 2
            offset = _offset_at(center, boxes)
            if offset in seen:
                continue
            seen.add(offset)
            marks.append(_LyricMark(symbol, offset))
    return "".join(pieces), marks


def _offset_at(center: float, boxes: list[tuple[float, float]]) -> int:
    for index, (left, right) in enumerate(boxes):
        if left - 0.51 <= center <= right + 0.51:
            return index
    centers = [((left + right) / 2, index) for index, (left, right) in enumerate(boxes)]
    return min(centers, key=lambda item: abs(item[0] - center))[1]


def _bar_marks(tokens: list[_Token], beats_per_bar: int) -> list[_BarMark]:
    useful = [token for token in tokens if token.kind in {"chord", "bar", "dash"}]
    if not any(token.kind == "chord" for token in useful):
        return []
    if not any(token.kind == "bar" for token in useful):
        chords = [token for token in useful if token.kind == "chord"]
        return [_BarMark(_symbol(token), index, 1.0) for index, token in enumerate(chords)]
    groups: list[list[_Token]] = []
    current: list[_Token] = []
    for token in useful:
        if token.kind == "bar":
            if current:
                groups.append(current)
                current = []
            continue
        current.append(token)
    if current:
        groups.append(current)
    marks: list[_BarMark] = []
    for index, group in enumerate(groups):
        chords = [token for token in group if token.kind == "chord"]
        for chord_index, beat in enumerate(_beats(len(chords), beats_per_bar)):
            if chord_index >= len(chords):
                break
            if beat >= beats_per_bar + 1:
                continue
            marks.append(_BarMark(_symbol(chords[chord_index]), index, beat))
    return marks


def _beats(count: int, beats_per_bar: int) -> list[float]:
    if count <= 1:
        return [1.0]
    if beats_per_bar % count == 0:
        step = beats_per_bar // count
        return [float(1 + index * step) for index in range(count)]
    step = beats_per_bar / count
    return [1 + index * step for index in range(count)]


def _symbol(token: _Token) -> str:
    return normalize_chord_symbol(token.text)


def _coalesce(items: list[_Item]) -> list[_Item]:
    merged: list[_Item] = []
    for item in items:
        previous = merged[-1] if merged else None
        if item.kind == "instrumental" and previous and previous.kind == "instrumental" and previous.section == item.section:
            shift = previous.bar_chords[-1].bar_index + 1 if previous.bar_chords else 0
            for chord in item.bar_chords:
                chord.bar_index += shift
            previous.bar_chords.extend(item.bar_chords)
            continue
        merged.append(item)
    return [item for item in merged if item.kind == "lyric" or item.bar_chords]


def match_lyrics(items: list[_Item], project: Project) -> tuple[dict[int, object], set[int], list[str]]:
    lines = _project_lines(project)
    if not lines:
        raise ChartError(NO_LYRICS)
    pdf_lyrics = [item for item in items if item.kind == "lyric" and item.norm]
    chord_lines = [item for item in pdf_lyrics if item.lyric_chords]
    instrumental = [item for item in items if item.kind == "instrumental" and item.bar_chords]
    if not chord_lines and not instrumental:
        raise ChartError(NO_CHORDS)
    if not pdf_lyrics:
        raise ChartError(NO_LYRIC_CONFIRM)

    matched: dict[int, _LyricRef] = {}
    seen_norms: set[str] = set()
    repeats: set[int] = set()
    cursor = 0
    for item in pdf_lyrics:
        found = None
        for index in range(cursor, len(lines)):
            if lines[index].norm == item.norm:
                found = index
                break
        if found is not None:
            matched[id(item)] = lines[found]
            seen_norms.add(item.norm)
            cursor = found + 1
        elif item.norm in seen_norms:
            repeats.add(id(item))

    strong = [item.norm for item in pdf_lyrics if id(item) in matched and len(item.norm) >= 2]
    counted = [item for item in pdf_lyrics if id(item) not in repeats and (item.lyric_chords or id(item) in matched)]
    pdf_chars = sum(len(item.norm) for item in counted)
    matched_chars = sum(len(item.norm) for item in counted if id(item) in matched)
    coverage = matched_chars / pdf_chars if pdf_chars else 0
    overlap = _overlap([item.norm for item in pdf_lyrics], [line.norm for line in lines])
    bad = [item for item in chord_lines if id(item) not in matched and id(item) not in repeats]
    if sum(len(text) for text in strong) < 4 or (coverage < 0.6 and overlap < 0.5):
        raise ChartError(WRONG_SONG if overlap < 0.35 else CANNOT_MATCH)
    if chord_lines and len(bad) / len(chord_lines) > 0.4:
        raise ChartError(CANNOT_MATCH)
    if not chord_lines and overlap < 0.5:
        raise ChartError(WRONG_SONG if overlap < 0.35 else CANNOT_MATCH)
    warnings = []
    if bad:
        warnings.append(PARTIAL_WARNING)
    return matched, repeats, warnings


def _project_lines(project: Project) -> list[_LyricRef]:
    ordered = sorted(
        enumerate(project.lyrics),
        key=lambda item: (item[1].order is None, item[1].order if item[1].order is not None else 0, item[1].start, item[0]),
    )
    result = []
    for _index, lyric in ordered:
        norm, _indexes = normalize_with_map(lyric.text)
        if norm:
            result.append(_LyricRef(lyric, norm))
    return result


def _overlap(pdf_lines: list[str], project_lines: list[str]) -> float:
    from collections import Counter

    left = Counter("".join(pdf_lines))
    right = Counter("".join(project_lines))
    if not left or not right:
        return 0.0
    common = sum(min(left[char], right[char]) for char in left)
    return common / min(sum(left.values()), sum(right.values()))


def place_chords(items, matched, repeats, project: Project, *, grid: bool, warnings: list[str]) -> list[GuitarChord]:
    drafts: list[GuitarChord] = []
    cursor: int | None = None
    seen_runs: list[tuple] = []
    repeated = False
    missing_grid = False
    missing_position = False
    opening = True
    for item in items:
        if item.kind == "lyric":
            opening = False
            lyric_ref = matched.get(id(item))
            if lyric_ref is None:
                if id(item) in repeats and item.lyric_chords:
                    repeated = True
                continue
            drafts.extend(_from_lyric(item, lyric_ref.lyric, project))
            if grid:
                bar, beat = time_to_beat(project, min(lyric_ref.lyric.end, project.duration))
                cursor = bar if beat <= 1.01 else bar + 1
                cursor = max(1, cursor)
            continue
        if not item.bar_chords:
            continue
        signature = (item.section or "", tuple((chord.bar_index, chord.beat, chord.symbol) for chord in item.bar_chords))
        if signature in seen_runs:
            repeated = True
            continue
        seen_runs.append(signature)
        start_bar = _start_bar(project, item.section, cursor, grid, opening)
        opening = False
        if start_bar is None:
            if grid:
                missing_position = True
            else:
                missing_grid = True
            for chord in item.bar_chords:
                drafts.append(_candidate(chord.symbol, item.section))
            continue
        timed: list[tuple[_BarMark, int, float, float]] = []
        for chord in item.bar_chords:
            bar = start_bar + chord.bar_index
            start = beat_to_time(project, bar, chord.beat)
            if bar < 1 or start > project.duration:
                missing_position = True
                drafts.append(_candidate(chord.symbol, item.section))
                continue
            timed.append((chord, bar, chord.beat, min(start, project.duration)))
        for index, (chord, bar, beat, start) in enumerate(timed):
            following = next((item_start for *_rest, item_start in timed[index + 1:]), None)
            end = following if following is not None else beat_to_time(project, bar + 1, 1.0)
            end = min(max(end, start), project.duration)
            drafts.append(_candidate(chord.symbol, item.section, start=start, end=end, bar=bar, beat=beat))
        if timed:
            cursor = timed[-1][1] + 1
    if repeated:
        warnings.append(REPEAT_WARNING)
    if missing_grid:
        warnings.append(UNTIMED_GRID)
    elif missing_position:
        warnings.append(UNTIMED_POSITION)
    return _sort_chords(drafts, project)


def _start_bar(project: Project, section: str | None, cursor: int | None, grid: bool, opening: bool) -> int | None:
    if not grid:
        return None
    named = _named_bar(project, section)
    if named is not None:
        return named
    if cursor is not None:
        return cursor
    if opening or (section or "") in _OPENING_SECTIONS or section is None:
        return 1
    return None


def _named_bar(project: Project, section: str | None) -> int | None:
    if not section:
        return None
    wanted = section_name(section) or section
    for existing in project.sections:
        if section_name(existing.name) == wanted or existing.name.strip() == section:
            return existing.startBar
    return None


def _from_lyric(item: _Item, lyric, project: Project) -> list[GuitarChord]:
    placed: list[tuple[int, str]] = []
    for mark in sorted(item.lyric_chords, key=lambda chord: chord.offset):
        offset = _project_offset(item.text, mark.offset, lyric.text)
        if offset is None or (placed and placed[-1][0] == offset):
            continue
        placed.append((offset, mark.symbol))
    length = max(len(lyric.text), 1)
    span = max(0.0, lyric.end - lyric.start)
    timed = []
    for offset, symbol in placed:
        start = lyric.start + span * (offset / length)
        start = min(max(start, 0.0), project.duration, lyric.end if lyric.end >= lyric.start else project.duration)
        timed.append((offset, symbol, start))
    drafts = []
    for index, (offset, symbol, start) in enumerate(timed):
        end = timed[index + 1][2] if index + 1 < len(timed) else min(lyric.end, project.duration)
        end = min(max(end, start), project.duration)
        drafts.append(_candidate(symbol, item.section, lyric_id=lyric.id, offset=offset, start=start, end=end))
    return drafts


def _project_offset(pdf_text: str, pdf_offset: int, lyric_text: str) -> int | None:
    pdf_norm, pdf_map = normalize_with_map(pdf_text)
    lyric_norm, lyric_map = normalize_with_map(lyric_text)
    if pdf_norm != lyric_norm or not lyric_map:
        return None
    norm_index = next((index for index, original in enumerate(pdf_map) if original >= pdf_offset), None)
    if norm_index is None:
        return lyric_map[-1]
    return lyric_map[norm_index]


def _candidate(symbol: str, section: str | None, **fields) -> GuitarChord:
    payload = dict(
        id="guitar-" + uuid4().hex,
        symbol=symbol,
        section=section,
        status="candidate",
        source="pdf",
        lyricId=fields.get("lyric_id"),
        charOffset=fields.get("offset"),
        start=fields.get("start"),
        end=fields.get("end"),
        bar=fields.get("bar"),
        beat=fields.get("beat"),
    )
    return GuitarChord(**payload)


def _sort_chords(chords: list[GuitarChord], project: Project) -> list[GuitarChord]:
    positions = {lyric.id: index for index, lyric in enumerate(project.lyrics)}
    order = {id(chord): index for index, chord in enumerate(chords)}
    return sorted(chords, key=lambda chord: (
        chord.start is None,
        chord.start if chord.start is not None else 0.0,
        positions.get(chord.lyricId or "", 10**6),
        chord.charOffset if chord.charOffset is not None else 10**6,
        chord.bar if chord.bar is not None else 10**6,
        chord.beat or 0,
        order[id(chord)],
    ))


def _slot(chord: GuitarChord, earlier: list[tuple]) -> tuple:
    if chord.lyricId is not None and chord.charOffset is not None:
        return ("lyric", chord.lyricId, chord.charOffset)
    if chord.bar is not None and chord.beat is not None:
        return ("bar", chord.section or "", chord.bar, round(float(chord.beat), 3))
    base = ("loose", chord.section or "", chord.symbol)
    occurrence = sum(1 for key in earlier if key[:3] == base)
    return (*base, occurrence)
