"""Pure metric formulas for the P0 protocol.

Callers pass already validated labels. Nothing here reads audio, downloads
weights, or interprets model confidence. Hand-worked examples belong in the
unit tests and are not song scores.
"""
from __future__ import annotations

import unicodedata

from backend.evaluation.schema import (
    NON_MODEL_IMPLEMENTATIONS,
    PITCH_CLASS_NAMES,
    SEMANTIC_SECTION_NAMES,
)

ONSET_TOLERANCE_SECONDS = 0.05
OFFSET_TOLERANCE_SECONDS = 0.05
SECTION_NAME_IOU = 0.5

METRIC_SPEC = {
    "separationListening": {
        "unit": "score",
        "direction": "higher",
        "kind": "human_listening",
        "definition": "四轨各三项 1–5 听感分的算术平均。5 表示串音更少、伪影更少、目标声部更完整。",
    },
    "bpmAndMeasures": {
        "unit": "seconds",
        "direction": "lower",
        "kind": "error",
        "definition": "按下标对齐的小节下拍平均绝对误差（秒）。原始 BPM 绝对误差另行记录，半速或倍速不替换它。",
    },
    "sectionBoundaries": {
        "unit": "seconds",
        "direction": "lower",
        "kind": "error",
        "definition": "每个人工段落边界到最近预测边界的平均绝对误差（秒），不剔除大误差。",
    },
    "chordAccuracy": {
        "unit": "fraction",
        "direction": "higher",
        "kind": "agreement",
        "definition": "精标和弦时间内，规范化标签完全一致的时长比例。分母不含未标注区间。",
    },
    "lyricTiming": {
        "unit": "seconds",
        "direction": "lower",
        "kind": "error",
        "definition": "规范化文本完全一致的歌词，其开始时间平均绝对误差（秒）。文本不同则不配对。",
    },
    "singingRecognition": {
        "unit": "fraction",
        "direction": "lower",
        "kind": "error_rate",
        "definition": "按开始时间拼接后的字错误率。数值低表示文本更接近精标，它不是听感分。",
    },
    "noteF1": {
        "unit": "fraction",
        "direction": "higher",
        "kind": "agreement",
        "definition": "音高完全一致且起音落在容差内的音符 F1。没有配对时 F1 为空，空集不是 1。",
    },
    "bassPitchClass": {
        "unit": "fraction",
        "direction": "higher",
        "kind": "agreement",
        "definition": "精标贝斯音名时间内，音级一致的时长比例。只使用已分离的贝斯轨结果。",
    },
    "humanCorrectionTime": {
        "unit": "seconds",
        "direction": "cost",
        "kind": "human_time",
        "definition": "记录的人工校正时长（秒）。这是成本记录，不是识别准确率。",
    },
    "processingTime": {
        "unit": "seconds",
        "direction": "cost",
        "kind": "wall_time",
        "definition": "范围内各阶段墙钟时间之和（秒）。缺记的阶段不算作 0。",
    },
}


def _shell(key: str, status: str, value, reason: str | None, detail: str | None, components: dict) -> dict:
    spec = METRIC_SPEC[key]
    return {
        "status": status,
        "value": value,
        "unit": spec["unit"],
        "direction": spec["direction"],
        "kind": spec["kind"],
        "definition": spec["definition"],
        "reason": reason,
        "detail": detail,
        "components": _clean(components),
    }


def blank(key: str, status: str, reason: str, detail: str | None = None) -> dict:
    return _shell(key, status, None, reason, detail, {})


def measured(key: str, value: float, components: dict | None = None, detail: str | None = None) -> dict:
    return _shell(key, "measured", _number(value), None, detail, components or {})


def with_components(key: str, status: str, reason: str, components: dict, detail: str | None = None) -> dict:
    return _shell(key, status, None, reason, detail, components)


def _number(value: float) -> float:
    return round(float(value), 6)


def _clean(value):
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return {str(key): _clean(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_clean(item) for item in value]
    return value


def median(values: list[float]) -> float:
    ordered = sorted(values)
    count = len(ordered)
    middle = count // 2
    if count % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def provenance_is_model(provenance, implementation: str | None = None, require_model_name: bool = False) -> bool:
    if provenance is None or not provenance.implementation or not provenance.modelVersion:
        return False
    if provenance.implementation.casefold() in NON_MODEL_IMPLEMENTATIONS:
        return False
    if implementation is not None and provenance.implementation != implementation:
        return False
    if require_model_name and not provenance.modelName:
        return False
    return True


def bpm_and_measures(gold, prediction) -> dict:
    raw = abs(prediction.bpm - gold.bpm)
    half = abs(prediction.bpm * 2 - gold.bpm)
    double = abs(prediction.bpm * 0.5 - gold.bpm)
    nearest = min(
        (("raw", raw), ("half", half), ("double", double)),
        key=lambda item: (item[1], item[0] != "raw"),
    )
    paired = min(len(gold.downbeats), len(prediction.downbeats))
    errors = [abs(prediction.downbeats[index] - gold.downbeats[index]) for index in range(paired)]
    return measured("bpmAndMeasures", mean(errors), {
        "downbeatMeanAbsoluteErrorSeconds": mean(errors),
        "downbeatMedianAbsoluteErrorSeconds": median(errors),
        "pairedBars": paired,
        "missedGoldBars": len(gold.downbeats) - paired,
        "extraPredictedBars": len(prediction.downbeats) - paired,
        "barCountError": len(prediction.downbeats) - len(gold.downbeats),
        "offsetErrorSeconds": abs(prediction.offsetSeconds - gold.offsetSeconds),
        "bpmAbsoluteError": raw,
        "bpmRelativeError": raw / gold.bpm,
        "nearestOctaveAbsoluteError": nearest[1],
        "nearestOctaveRelation": nearest[0],
    })


def _boundaries(sections) -> list[float]:
    return sorted({span.start for span in sections} | {span.end for span in sections})


def _iou(left, right) -> float:
    intersection = max(0.0, min(left.end, right.end) - max(left.start, right.start))
    union = (left.end - left.start) + (right.end - right.start) - intersection
    return intersection / union if union else 0.0


def section_boundaries(gold_sections, pred_sections) -> dict:
    if _overlaps(pred_sections):
        return blank("sectionBoundaries", "not_evaluated", "prediction_intervals_overlap",
                     "预测段落时间重叠，段落边界没有计算。")
    gold_points = _boundaries(gold_sections)
    pred_points = _boundaries(pred_sections)
    if not gold_points or not pred_points:
        return with_components(
            "sectionBoundaries", "undefined", "no_section_boundaries",
            {"goldBoundaries": len(gold_points), "predictedBoundaries": len(pred_points)},
            "缺少可比较的段落边界，平均误差没有定义。",
        )
    errors = [min(abs(point - other) for other in pred_points) for point in gold_points]
    names = _section_names(gold_sections, pred_sections)
    return measured("sectionBoundaries", mean(errors), {
        "boundaryMeanAbsoluteErrorSeconds": mean(errors),
        "boundaryMedianAbsoluteErrorSeconds": median(errors),
        "goldBoundaries": len(gold_points),
        "predictedBoundaries": len(pred_points),
        "semanticNameAgreement": names,
    })


def _section_names(gold_sections, pred_sections) -> dict:
    if any(span.name not in SEMANTIC_SECTION_NAMES for span in pred_sections):
        return {"status": "not_evaluated", "value": None, "reason": "prediction_section_names_are_not_semantic"}
    unused = set(range(len(pred_sections)))
    matches = 0
    for gold in sorted(gold_sections, key=lambda span: span.start):
        best = None
        best_key = None
        for index in unused:
            score = _iou(gold, pred_sections[index])
            if score < SECTION_NAME_IOU:
                continue
            candidate = (-score, index)
            if best_key is None or candidate < best_key:
                best_key = candidate
                best = index
        if best is None:
            continue
        unused.remove(best)
        if pred_sections[best].name == gold.name:
            matches += 1
    return {"status": "measured", "value": _number(matches / len(gold_sections)), "reason": None}


def chord_accuracy(gold_chords, pred_chords) -> dict:
    if _overlaps(pred_chords):
        return blank("chordAccuracy", "not_evaluated", "prediction_intervals_overlap",
                     "预测和弦时间重叠，和弦准确率没有计算。")
    total = sum(item.end - item.start for item in gold_chords)
    exact = 0.0
    root = 0.0
    root_total = 0.0
    unparsed = 0
    for gold in gold_chords:
        gold_parsed = parse_chord(gold.label)
        duration = gold.end - gold.start
        root_total += duration
        for pred in pred_chords:
            overlap = _overlap_len(gold, pred)
            if overlap <= 0:
                continue
            pred_parsed = parse_chord(pred.label)
            if pred_parsed is None:
                unparsed += 1
                continue
            if gold_parsed == pred_parsed:
                exact += overlap
            if _root_equal(gold_parsed, pred_parsed):
                root += overlap
    return measured("chordAccuracy", exact / total, {
        "exactAccuracy": exact / total,
        "rootAccuracy": root / root_total,
        "goldSeconds": total,
        "exactSeconds": exact,
        "unparsedPredictionOverlaps": unparsed,
        "predictedSecondsOutsideGold": _outside_seconds(gold_chords, pred_chords),
    })


def lyric_metrics(gold_lyrics, pred_lyrics) -> tuple[dict, dict]:
    if {item.granularity for item in gold_lyrics} != {item.granularity for item in pred_lyrics}:
        timing = blank("lyricTiming", "not_evaluated", "granularity_mismatch",
                       "精标与预测的歌词粒度不同，时间误差没有计算。")
    elif _overlaps(pred_lyrics):
        timing = blank("lyricTiming", "not_evaluated", "prediction_intervals_overlap",
                       "预测歌词时间重叠，时间误差没有计算。")
    else:
        pairs = match_lyrics(gold_lyrics, pred_lyrics)
        if not pairs:
            timing = with_components(
                "lyricTiming", "undefined", "no_exact_text_match",
                {"matchedLines": 0, "goldLines": len(gold_lyrics), "predictedLines": len(pred_lyrics)},
                "没有规范化文本完全一致的歌词，时间误差没有定义。",
            )
        else:
            start_errors = [abs(pred.start - gold.start) for gold, pred in pairs]
            end_errors = [abs(pred.end - gold.end) for gold, pred in pairs]
            timing = measured("lyricTiming", mean(start_errors), {
                "startMeanAbsoluteErrorSeconds": mean(start_errors),
                "endMeanAbsoluteErrorSeconds": mean(end_errors),
                "matchedLines": len(pairs),
                "goldLines": len(gold_lyrics),
                "unmatchedGoldLines": len(gold_lyrics) - len(pairs),
                "unmatchedPredictedLines": len(pred_lyrics) - len(pairs),
            })
    gold_text = "".join(normalize_lyric(item.text) for item in sorted(gold_lyrics, key=lambda item: (item.start, item.text)))
    pred_text = "".join(normalize_lyric(item.text) for item in sorted(pred_lyrics, key=lambda item: (item.start, item.text)))
    if not gold_text:
        recognition = blank("singingRecognition", "undefined", "gold_text_empty_after_normalization",
                            "精标歌词规范化后没有可比较的字符。")
    else:
        distance = levenshtein(gold_text, pred_text)
        pairs = match_lyrics(gold_lyrics, pred_lyrics)
        recognition = measured("singingRecognition", distance / len(gold_text), {
            "characterErrorRate": distance / len(gold_text),
            "editDistance": distance,
            "goldCharacters": len(gold_text),
            "exactLineRecall": len(pairs) / len(gold_lyrics),
        })
    return timing, recognition


def note_f1(gold_notes, pred_notes, onset_tolerance: float = ONSET_TOLERANCE_SECONDS) -> dict:
    counts = _note_counts(gold_notes, pred_notes, onset_tolerance)
    components = {
        "truePositives": counts["tp"],
        "falsePositives": counts["fp"],
        "falseNegatives": counts["fn"],
        "precision": counts["precision"],
        "recall": counts["recall"],
        "f1": counts["f1"],
        "offsetMatchRate": counts["offsetMatchRate"],
        "onsetToleranceSeconds": onset_tolerance,
        "offsetToleranceSeconds": OFFSET_TOLERANCE_SECONDS,
        "pitchToleranceSemitones": 0,
    }
    if counts["f1"] is None:
        return with_components("noteF1", "undefined", "undefined_f1", components,
                               "精确率或召回没有定义，音符 F1 留空。空结果不是 1。")
    return measured("noteF1", counts["f1"], components)


def bass_pitch_accuracy(gold_events, pred_events) -> dict:
    if _overlaps(pred_events):
        return blank("bassPitchClass", "not_evaluated", "prediction_intervals_overlap",
                     "预测贝斯音名时间重叠，音级一致率没有计算。")
    total = sum(item.end - item.start for item in gold_events)
    correct = 0.0
    for gold in gold_events:
        for pred in pred_events:
            overlap = _overlap_len(gold, pred)
            if overlap > 0 and gold.pitchClass == pred.pitchClass:
                correct += overlap
    return measured("bassPitchClass", correct / total, {
        "pitchClassAccuracy": correct / total,
        "goldSeconds": total,
        "correctSeconds": correct,
        "uncoveredSeconds": total - correct,
    })


def listening_score(sheet) -> dict:
    scores = [score for rating in sheet.ratings for score in (rating.bleed, rating.artifacts, rating.missingSource)]
    per_stem = {
        rating.stem: _number(mean([rating.bleed, rating.artifacts, rating.missingSource]))
        for rating in sheet.ratings
    }
    return measured("separationListening", mean(scores), {"perStem": per_stem, "scoreCount": len(scores)})


def human_time(record) -> dict:
    return measured("humanCorrectionTime", record.durationSeconds, {
        "durationSeconds": record.durationSeconds,
        "activities": list(record.activities),
    })


def processing_time(wall, required: list[str]) -> dict:
    values = {name: getattr(wall, name) for name in required}
    if any(value is None for value in values.values()):
        missing = [name for name, value in values.items() if value is None]
        return with_components("processingTime", "missing", "wall_time_missing",
                               {"missingStages": missing},
                               "范围内的墙钟时间没有记全，总和留空，缺失阶段不按 0 秒计入。")
    return measured("processingTime", sum(values.values()), dict(values))


def normalize_lyric(text: str) -> str:
    """NFKC, casefold, then drop whitespace, punctuation, and symbols."""
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return "".join(
        character for character in normalized
        if not character.isspace() and unicodedata.category(character)[0] not in {"P", "S"}
    )


def match_lyrics(gold_lyrics, pred_lyrics) -> list[tuple]:
    used: set[int] = set()
    pairs = []
    for gold in sorted(gold_lyrics, key=lambda item: (item.start, item.text)):
        key = normalize_lyric(gold.text)
        if not key:
            continue
        best = None
        best_key = None
        for index, pred in enumerate(pred_lyrics):
            if index in used or normalize_lyric(pred.text) != key:
                continue
            candidate = (abs(pred.start - gold.start), index)
            if best_key is None or candidate < best_key:
                best_key = candidate
                best = index
        if best is not None:
            used.add(best)
            pairs.append((gold, pred_lyrics[best]))
    return pairs


def levenshtein(left: str, right: str) -> int:
    if left == right:
        return 0
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for index, left_char in enumerate(left, 1):
        current = [index]
        for column, right_char in enumerate(right, 1):
            current.append(min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] + (left_char != right_char),
            ))
        previous = current
    return previous[-1]


def parse_chord(label: str):
    """Return ('nc',) or (root, quality, slash). None means the label is unparsed."""
    compact = "".join(label.split())
    if compact.casefold() in {"nc", "n.c.", "n.c"}:
        return ("nc",)
    if not compact:
        return None
    root, rest = _take_root(compact)
    if root is None:
        return None
    slash = None
    if "/" in rest:
        quality_token, bass_token = rest.split("/", 1)
        bass, leftover = _take_root(bass_token)
        if bass is None or leftover:
            return None
        slash = bass
        rest = quality_token
    quality = _quality(rest)
    if quality is None:
        return None
    return (root, quality, slash)


def canonical_chord(parsed) -> str | None:
    if parsed is None:
        return None
    if parsed == ("nc",):
        return "N.C."
    root, quality, slash = parsed
    label = PITCH_CLASS_NAMES[root] + quality
    if slash is not None:
        label += "/" + PITCH_CLASS_NAMES[slash]
    return label


def _take_root(text: str):
    if not text or text[0].upper() not in "CDEFGAB":
        return None, text
    pitch = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[text[0].upper()]
    rest = text[1:]
    if rest[:1] in {"#", "♯"}:
        pitch += 1
        rest = rest[1:]
    elif rest[:1] in {"b", "♭"}:
        pitch -= 1
        rest = rest[1:]
    return pitch % 12, rest


def _quality(token: str) -> str | None:
    table = {
        "": "",
        "maj": "",
        "major": "",
        "M": "",
        "m": "m",
        "min": "m",
        "minor": "m",
        "7": "7",
        "maj7": "maj7",
        "major7": "maj7",
        "M7": "maj7",
        "m7": "m7",
        "min7": "m7",
        "minor7": "m7",
        "dim": "dim",
        "aug": "aug",
        "sus2": "sus2",
        "sus4": "sus4",
        "sus": "sus4",
    }
    if token in table:
        return table[token]
    lowered = token.casefold()
    folded = {
        "maj": "",
        "major": "",
        "min": "m",
        "minor": "m",
        "maj7": "maj7",
        "major7": "maj7",
        "min7": "m7",
        "minor7": "m7",
        "dim": "dim",
        "aug": "aug",
        "sus2": "sus2",
        "sus4": "sus4",
        "sus": "sus4",
    }
    return folded.get(lowered)


def _root_equal(gold, pred) -> bool:
    if gold is None or pred is None:
        return False
    if gold == ("nc",) or pred == ("nc",):
        return gold == pred
    return gold[0] == pred[0]


def _note_counts(gold_notes, pred_notes, onset_tolerance: float) -> dict:
    unused = set(range(len(pred_notes)))
    offset_hits = 0
    for gold in sorted(gold_notes, key=lambda note: (note.start, note.midi)):
        best = None
        best_key = None
        for index in unused:
            pred = pred_notes[index]
            if pred.midi != gold.midi:
                continue
            distance = abs(pred.start - gold.start)
            if distance > onset_tolerance:
                continue
            candidate = (distance, index)
            if best_key is None or candidate < best_key:
                best_key = candidate
                best = index
        if best is None:
            continue
        unused.remove(best)
        if abs(pred_notes[best].end - gold.end) <= OFFSET_TOLERANCE_SECONDS:
            offset_hits += 1
    true_positives = len(pred_notes) - len(unused)
    false_positives = len(unused)
    false_negatives = len(gold_notes) - true_positives
    precision = true_positives / (true_positives + false_positives) if true_positives + false_positives else None
    recall = true_positives / (true_positives + false_negatives) if true_positives + false_negatives else None
    f1 = None
    if precision is not None and recall is not None and precision + recall > 0:
        f1 = 2 * precision * recall / (precision + recall)
    offset_rate = offset_hits / true_positives if true_positives else None
    return {
        "tp": true_positives,
        "fp": false_positives,
        "fn": false_negatives,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "offsetMatchRate": offset_rate,
    }


def _overlaps(items) -> bool:
    ordered = sorted(items, key=lambda item: (item.start, item.end))
    return any(following.start < previous.end - 1e-6 for previous, following in zip(ordered, ordered[1:]))


def _overlap_len(left, right) -> float:
    return max(0.0, min(left.end, right.end) - max(left.start, right.start))


def _outside_seconds(gold, pred) -> float:
    outside = 0.0
    for item in pred:
        remaining = [(item.start, item.end)]
        for gold_item in gold:
            nxt = []
            for left, right in remaining:
                if right <= gold_item.start or left >= gold_item.end:
                    nxt.append((left, right))
                    continue
                if left < gold_item.start:
                    nxt.append((left, gold_item.start))
                if right > gold_item.end:
                    nxt.append((gold_item.end, right))
            remaining = nxt
        outside += sum(right - left for left, right in remaining)
    return outside
