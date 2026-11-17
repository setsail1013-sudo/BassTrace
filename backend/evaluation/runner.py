"""Score a local authorized corpus, or say plainly that scoring did not happen.

The process reads JSON labels and checks that an audio file exists. It does
not open audio, run Demucs, load Whisper weights, upload anything, or write
project files. A missing corpus is an unevaluated report, not a passing score.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import os
import platform
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from backend.evaluation.metrics import (
    METRIC_SPEC,
    bass_pitch_accuracy,
    blank,
    bpm_and_measures,
    chord_accuracy,
    human_time,
    listening_score,
    lyric_metrics,
    mean,
    measured,
    median,
    note_f1,
    parse_chord,
    processing_time,
    provenance_is_model,
    section_boundaries,
)
from backend.evaluation.schema import (
    STEMS,
    CorpusManifest,
    GoldFile,
    HumanEditFile,
    ListeningSheet,
    PredictionFile,
    protocol_document,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
MAX_JSON_BYTES = 2_000_000
EXIT_EVALUATED = 0
EXIT_NOT_EVALUATED = 3
EXIT_INCOMPLETE = 4
GOLD_METRICS = (
    "bpmAndMeasures",
    "sectionBoundaries",
    "chordAccuracy",
    "lyricTiming",
    "singingRecognition",
    "noteF1",
    "bassPitchClass",
    "humanCorrectionTime",
)
JSON_NAMES = {
    "gold": "gold.json",
    "prediction": "prediction.json",
    "listening": "listening.json",
    "human": "human-edit.json",
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="记录 BassTrace P0 授权曲库评估；缺材料时明确报告未评估。")
    parser.add_argument("--corpus", type=Path, default=None, help="仓库外的授权曲库目录")
    parser.add_argument("--output", type=Path, default=None, help="报告写入路径，必须在仓库外")
    parser.add_argument("--schema", action="store_true", help="打印字段定义，不进行评估")
    args = parser.parse_args(argv)
    if args.schema:
        _deliver(protocol_document(), args.output)
        return EXIT_EVALUATED
    report = run_evaluation(args.corpus)
    report, written = _write_outside_repo(report, args.output)
    report["outputWritten"] = written
    _deliver(report, None)
    return exit_code(report)


def exit_code(report: dict) -> int:
    return {"evaluated": EXIT_EVALUATED, "incomplete": EXIT_INCOMPLETE, "not_evaluated": EXIT_NOT_EVALUATED}[report["status"]]


def run_evaluation(corpus: Path | None, today: date | None = None) -> dict:
    today = today or datetime.now(timezone.utc).date()
    report = _empty_report(corpus)
    if corpus is None:
        report["gaps"].append(_gap("corpus_missing", "未提供仓库外的授权曲库路径，准确性评估没有执行。"))
        return _finish(report)
    if _inside_repo(corpus):
        report["corpusPath"] = None
        report["gaps"].append(_gap(
            "corpus_inside_repository",
            "曲库路径在仓库内。授权音频、精标和报告都不能放进仓库，本次没有读取该路径。",
        ))
        return _finish(report)
    if not corpus.exists() or not corpus.is_dir():
        report["gaps"].append(_gap("corpus_missing", "授权曲库目录不存在，准确性评估没有执行。"))
        return _finish(report)

    manifest, problem, detail = _load_model(corpus / "manifest.json", CorpusManifest)
    if problem == "absent":
        report["gaps"].append(_gap("manifest_missing", "曲库目录没有 manifest.json，准确性评估没有执行。"))
        return _finish(report)
    if problem:
        report["gaps"].append(_gap("manifest_invalid", detail or "manifest.json 无法读取。"))
        return _finish(report)

    ids = [track.id for track in manifest.tracks]
    if set(manifest.authorization.coversTrackIds) != set(ids):
        report["gaps"].append(_gap("authorization_track_mismatch", "授权覆盖的曲目编号与清单不一致，这些曲目没有计分。"))
        return _finish(report)
    expires = datetime.strptime(manifest.authorization.expiresOn, "%Y-%m-%d").date()
    if expires < today:
        report["gaps"].append(_gap("authorization_expired", "授权已经到期，这些曲目没有计分。"))
        return _finish(report)

    report["authorization"] = {
        "holder": manifest.authorization.holder,
        "reference": manifest.authorization.reference,
        "scope": manifest.authorization.scope,
        "grantedOn": manifest.authorization.grantedOn,
        "expiresOn": manifest.authorization.expiresOn,
        "localOnly": True,
        "redistributionAllowed": False,
    }
    languages = {track.language for track in manifest.tracks}
    if len(manifest.tracks) != 30:
        report["gaps"].append(_gap("track_count", f"清单有 {len(manifest.tracks)} 首，P0 基准需要 30 首。"))
    if not {"zh", "en", "ja"} <= languages:
        report["gaps"].append(_gap("language_coverage", "曲库需要同时覆盖中文、英文和日文。"))

    complete_gold = 0
    for track in manifest.tracks:
        track_dir = corpus / "tracks" / track.id
        entry, counted = _evaluate_directory(track, track_dir, report["warnings"])
        report["tracks"].append(entry)
        complete_gold += counted
    reasons = {metric["reason"] for track in report["tracks"] for metric in track["metrics"].values()}
    if "mixdown_rejected" in reasons:
        report["gaps"].append(_gap("mixdown_rejected", "有预测声明把混音当作贝斯。该文件没有计分，贝斯音名也没有改用混音。"))
    if "prediction_invalid" in reasons:
        report["gaps"].append(_gap("prediction_invalid", "有预测文件不符合字段定义，对应曲目没有计分。"))
    if not 5 <= complete_gold <= 10:
        report["gaps"].append(_gap("gold_count", f"完整精标有 {complete_gold} 首，P0 基准需要 5 到 10 首。"))
    if any(track["modelRunRecorded"] is False and (track.get("separation") or {}).get("status") == "completed"
           for track in report["tracks"]):
        report["gaps"].append(_gap("model_run_environment_missing", "有已完成的分离没有记下当时的硬件、操作系统和 Python。"))
    return _finish(report)


def _evaluate_directory(track, track_dir: Path, warnings: list) -> tuple[dict, int]:
    entry = {
        "id": track.id,
        "title": track.title,
        "language": track.language,
        "hasGoldLabels": track.hasGoldLabels,
        "gold": "not_declared",
        "audioPresent": False,
        "audioBytes": None,
        "separation": None,
        "modelRunRecorded": None,
        "models": {},
        "metrics": {key: blank(key, "not_evaluated", "not_started", "这项还没有评估。") for key in METRIC_SPEC},
    }
    gold = None
    if track.hasGoldLabels:
        gold, problem, detail = _load_model(track_dir / JSON_NAMES["gold"], GoldFile)
        if problem == "absent":
            entry["gold"] = "absent"
            _fill(entry, GOLD_METRICS, "missing", "gold_missing", "清单声明有精标，但 gold.json 不存在。")
        elif problem or gold.trackId != track.id:
            entry["gold"] = "invalid"
            _fill(entry, GOLD_METRICS, "not_evaluated", "gold_invalid", detail or "gold.json 与曲目编号不一致。")
            gold = None
        elif gold.syntheticExample:
            entry["gold"] = "synthetic"
            _fill(entry, METRIC_SPEC, "not_evaluated", "synthetic_example", "合成公式样例只用于核对公式，不计成歌曲准确率。")
            warnings.append(_gap("synthetic_example", f"{track.id} 是合成公式样例，没有计分。"))
            return entry, 0
        elif _outside_duration(gold, track.durationSeconds) or _gold_chords_unparsed(gold):
            entry["gold"] = "invalid"
            _fill(entry, GOLD_METRICS, "not_evaluated", "gold_invalid", "精标超出音频时长，或含有无法规范化的和弦。")
            gold = None
        else:
            entry["gold"] = "complete" if _gold_complete(gold) else "partial"
    elif (track_dir / JSON_NAMES["gold"]).is_file():
        warnings.append(_gap("gold_file_ignored", f"{track.id} 未声明精标，旁边的 gold.json 没有参与计分。"))

    audio_ok, audio_bytes, audio_problem = _audio_state(track_dir, track.audioRelativePath)
    entry["audioPresent"] = audio_ok
    entry["audioBytes"] = audio_bytes
    if not audio_ok:
        _fill_unresolved(entry, "missing", audio_problem or "audio_missing", "曲目音频不在本机或路径无效，相关指标没有计算。")
        if entry["gold"] == "not_declared":
            _fill(entry, GOLD_METRICS, "not_applicable", "track_has_no_gold_labels", "这首没有精标，该项只在精标子集上计算。")
        return entry, 1 if entry["gold"] == "complete" else 0

    prediction, pred_problem, pred_detail = _load_model(track_dir / JSON_NAMES["prediction"], PredictionFile)
    if pred_problem == "absent":
        prediction = None
    elif pred_problem or prediction.trackId != track.id or _prediction_outside(prediction, track.durationSeconds):
        code = "mixdown_rejected" if pred_detail and "混音" in pred_detail else "prediction_invalid"
        detail = pred_detail or "prediction.json 与曲目编号不一致，或事件超出音频时长。"
        _fill_unresolved(entry, "not_evaluated", code, detail)
        if not track.hasGoldLabels:
            _fill(entry, GOLD_METRICS, "not_applicable", "track_has_no_gold_labels", "这首没有精标，该项只在精标子集上计算。")
        return entry, 1 if entry["gold"] == "complete" else 0
    if prediction is not None:
        entry["separation"] = _separation_view(prediction)
        entry["modelRunRecorded"] = prediction.modelRun is not None
        entry["models"] = _model_views(prediction)
        if prediction.separation.status == "completed" and prediction.modelRun is None:
            entry["modelRunRecorded"] = False

    _apply_metrics(entry, track, gold, prediction, track_dir)
    return entry, 1 if entry["gold"] == "complete" else 0


def _apply_metrics(entry: dict, track, gold, prediction, track_dir: Path) -> None:
    separated = prediction is not None and prediction.separation.status == "completed"
    if not track.hasGoldLabels:
        _fill(entry, GOLD_METRICS, "not_applicable", "track_has_no_gold_labels", "这首没有精标，该项只在精标子集上计算。")
    elif gold is not None:
        _score_gold(entry, gold, prediction, separated)
    _score_listening(entry, track, prediction, separated, track_dir)
    _score_processing(entry, gold if track.hasGoldLabels else None, prediction, separated)
    if track.hasGoldLabels and gold is not None and entry["metrics"]["humanCorrectionTime"]["reason"] == "not_started":
        _score_human(entry, track, track_dir)
    _replace_not_started(entry)


def _score_gold(entry: dict, gold, prediction, separated: bool) -> None:
    if prediction is None:
        _fill(entry, (
            "bpmAndMeasures", "sectionBoundaries", "chordAccuracy", "lyricTiming",
            "singingRecognition", "noteF1", "bassPitchClass",
        ), "missing", "prediction_absent", "没有 prediction.json，这些模型指标没有计算。")
        return
    _score_bass_and_notes(entry, gold, prediction, separated)
    _score_lyrics(entry, gold, prediction, separated)
    _score_structure_and_chords(entry, gold, prediction)


def _score_structure_and_chords(entry, gold, prediction) -> None:
    if not gold.tempo:
        entry["metrics"]["bpmAndMeasures"] = blank("bpmAndMeasures", "missing", "gold_layer_absent", "精标没有速度和下拍。")
    elif prediction.tempo is None:
        entry["metrics"]["bpmAndMeasures"] = blank("bpmAndMeasures", "missing", "tempo_prediction_absent", "预测没有速度和下拍。")
    elif not provenance_is_model(prediction.structureProvenance):
        entry["metrics"]["bpmAndMeasures"] = blank("bpmAndMeasures", "missing", "structure_provenance_missing", "速度结果没有可接受的模型来源。")
    else:
        entry["metrics"]["bpmAndMeasures"] = bpm_and_measures(gold.tempo, prediction.tempo)

    if not gold.sections:
        entry["metrics"]["sectionBoundaries"] = blank("sectionBoundaries", "missing", "gold_layer_absent", "精标没有段落。")
    elif prediction.sections is None:
        entry["metrics"]["sectionBoundaries"] = blank("sectionBoundaries", "missing", "section_prediction_absent", "预测没有段落。")
    elif not provenance_is_model(prediction.structureProvenance):
        entry["metrics"]["sectionBoundaries"] = blank("sectionBoundaries", "missing", "structure_provenance_missing", "段落结果没有可接受的模型来源。")
    else:
        entry["metrics"]["sectionBoundaries"] = section_boundaries(gold.sections, prediction.sections)

    if not gold.chords:
        entry["metrics"]["chordAccuracy"] = blank("chordAccuracy", "missing", "gold_layer_absent", "精标没有和弦。")
    elif prediction.chords is None:
        entry["metrics"]["chordAccuracy"] = blank("chordAccuracy", "missing", "chord_prediction_absent", "预测没有和弦。")
    elif not provenance_is_model(prediction.harmonyProvenance):
        entry["metrics"]["chordAccuracy"] = blank("chordAccuracy", "missing", "harmony_provenance_missing", "和弦结果没有可接受的模型来源。")
    else:
        entry["metrics"]["chordAccuracy"] = chord_accuracy(gold.chords, prediction.chords)


def _blocked_stem(prediction, separated: bool) -> tuple[str, str] | None:
    if not separated:
        reason = "separation_failed" if prediction.separation.status == "failed" else "separation_not_run"
        detail = "分离没有完成。已忽略预测中的贝斯音名、音符或歌词，没有改用混音。"
        return reason, detail
    return None


def _score_bass_and_notes(entry, gold, prediction, separated: bool) -> None:
    blocked = _blocked_stem(prediction, separated)
    bass_missing = separated and not prediction.separation.stems.bass
    if not gold.bassPitches:
        entry["metrics"]["bassPitchClass"] = blank("bassPitchClass", "missing", "gold_layer_absent", "精标没有贝斯音名。")
    elif blocked or bass_missing:
        reason, detail = ("bass_stem_missing", "没有贝斯分轨。音名没有改用混音计算。") if bass_missing else blocked
        entry["metrics"]["bassPitchClass"] = blank("bassPitchClass", "not_applicable", reason, detail)
    elif prediction.bassPitches is None:
        entry["metrics"]["bassPitchClass"] = blank("bassPitchClass", "missing", "bass_prediction_absent", "预测没有贝斯音名。")
    elif not provenance_is_model(prediction.bassProvenance):
        entry["metrics"]["bassPitchClass"] = blank("bassPitchClass", "missing", "bass_provenance_missing", "贝斯音名没有可接受的模型来源。")
    else:
        entry["metrics"]["bassPitchClass"] = bass_pitch_accuracy(gold.bassPitches, prediction.bassPitches)

    if not gold.notes:
        entry["metrics"]["noteF1"] = blank("noteF1", "missing", "gold_layer_absent", "精标没有音符。")
    elif blocked or bass_missing:
        reason, detail = ("bass_stem_missing", "没有贝斯分轨。音符没有改用混音计算。") if bass_missing else blocked
        entry["metrics"]["noteF1"] = blank("noteF1", "not_applicable", reason, detail)
    elif prediction.notes is None:
        entry["metrics"]["noteF1"] = blank("noteF1", "missing", "note_prediction_absent", "预测没有音符。")
    elif not provenance_is_model(prediction.noteProvenance):
        entry["metrics"]["noteF1"] = blank("noteF1", "missing", "note_provenance_missing", "音符结果没有可接受的模型来源。")
    else:
        entry["metrics"]["noteF1"] = note_f1(gold.notes, prediction.notes)


def _score_lyrics(entry, gold, prediction, separated: bool) -> None:
    if not gold.lyrics:
        _fill(entry, ("lyricTiming", "singingRecognition"), "missing", "gold_layer_absent", "精标没有歌词。")
        return
    blocked = _blocked_stem(prediction, separated)
    if blocked or not prediction.separation.stems.vocals:
        reason, detail = ("vocals_missing", "没有人声分轨，歌唱识别没有计算。") if separated else blocked
        _fill(entry, ("lyricTiming", "singingRecognition"), "not_applicable", reason, detail)
        return
    if prediction.lyrics is None:
        _fill(entry, ("lyricTiming", "singingRecognition"), "missing", "lyric_prediction_absent", "预测没有歌词识别结果。")
        return
    if not provenance_is_model(prediction.lyricProvenance, implementation="faster-whisper", require_model_name=True):
        _fill(entry, ("lyricTiming", "singingRecognition"), "missing", "whisper_provenance_missing",
              "歌唱识别需要 faster-whisper 的模型名和版本。没有这些记录时不计算文本或时间。")
        return
    timing, recognition = lyric_metrics(gold.lyrics, prediction.lyrics)
    entry["metrics"]["lyricTiming"] = timing
    entry["metrics"]["singingRecognition"] = recognition


def _score_listening(entry, track, prediction, separated: bool, track_dir: Path) -> None:
    if prediction is None:
        entry["metrics"]["separationListening"] = blank(
            "separationListening", "missing", "prediction_absent", "没有分离记录，听感没有计算。")
        return
    if not separated:
        reason = "separation_failed" if prediction.separation.status == "failed" else "separation_not_run"
        entry["metrics"]["separationListening"] = blank(
            "separationListening", "not_applicable", reason, "分离没有完成，听感表即使存在也不计分。")
        return
    sheet, problem, detail = _load_model(track_dir / JSON_NAMES["listening"], ListeningSheet)
    if problem or sheet.trackId != track.id:
        entry["metrics"]["separationListening"] = blank(
            "separationListening", "missing", "listening_missing", detail or "分离已完成，但听感表不存在或无效。")
        return
    entry["metrics"]["separationListening"] = listening_score(sheet)


def _score_human(entry, track, track_dir: Path) -> None:
    record, problem, detail = _load_model(track_dir / JSON_NAMES["human"], HumanEditFile)
    if problem == "absent":
        entry["metrics"]["humanCorrectionTime"] = blank(
            "humanCorrectionTime", "missing", "human_edit_missing", "精标曲目没有人工校正时间记录。")
        return
    if problem or record.trackId != track.id:
        code = "human_edit_inconsistent" if detail and "时长" in detail else "human_edit_invalid"
        entry["metrics"]["humanCorrectionTime"] = blank(
            "humanCorrectionTime", "not_evaluated", code, detail or "人工校正记录无效。")
        return
    entry["metrics"]["humanCorrectionTime"] = human_time(record)


def _score_processing(entry, gold, prediction, separated: bool) -> None:
    if prediction is None:
        entry["metrics"]["processingTime"] = blank("processingTime", "missing", "prediction_absent", "没有预测文件，墙钟时间没有记录。")
        return
    required = ["separationSeconds"]
    if gold is not None:
        if gold.tempo is not None or gold.sections:
            required.append("structureSeconds")
        if gold.chords:
            required.append("harmonySeconds")
        if separated and (gold.bassPitches or gold.notes):
            required.append("bassAnalysisSeconds")
        if separated and gold.lyrics:
            required.append("lyricRecognitionSeconds")
    entry["metrics"]["processingTime"] = processing_time(prediction.wallClock, required)


def _replace_not_started(entry: dict) -> None:
    for key, metric in entry["metrics"].items():
        if metric["reason"] == "not_started":
            entry["metrics"][key] = blank(key, "not_evaluated", "not_recorded", "这项没有形成记录。")


def _finish(report: dict) -> dict:
    report["metrics"] = {key: _rollup(report["tracks"], key) for key in METRIC_SPEC}
    report["separationOutcomes"] = _separation_outcomes(report["tracks"])
    report["status"] = _status(report)
    report["summary"] = {
        "not_evaluated": "准确性评估没有执行。各项空值不是得分，也不能解读为准确率通过。",
        "incomplete": "只存在局部测量或曲库尚未满足 P0。这些数值不是准确率通过，也不写入仓库。",
        "evaluated": "P0 协议要求的记录已经齐备。qualityPassed 仍为空：完成测量不是质量达标。",
    }[report["status"]]
    report["benchmarkComplete"] = report["status"] == "evaluated"
    return report


def _status(report: dict) -> str:
    if not report["tracks"]:
        return "not_evaluated"
    measured_any = any(metric["status"] == "measured" for track in report["tracks"] for metric in track["metrics"].values())
    if not measured_any:
        return "not_evaluated"
    open_metric = any(
        metric["status"] in {"missing", "not_evaluated", "undefined", "incomplete"}
        for track in report["tracks"] for metric in track["metrics"].values()
    )
    blockers = [item["code"] for item in report["gaps"]]
    rollups_ready = all(report["metrics"][key]["status"] == "measured" for key in METRIC_SPEC)
    if open_metric or blockers or not rollups_ready:
        return "incomplete"
    return "evaluated"


def _rollup(tracks: list, key: str) -> dict:
    relevant = [track["metrics"][key] for track in tracks if track["metrics"][key]["status"] != "not_applicable"]
    if not relevant:
        reason = "not_applicable" if tracks else "not_evaluated"
        return blank(key, reason, reason, "没有进入这项分母的曲目。" if tracks else "没有曲目，这项没有评估。")
    if any(item["status"] != "measured" for item in relevant):
        return blank(key, "incomplete", "partial_tracks", "还有曲目缺少这项测量，因此不给出曲库平均值。")
    values = [item["value"] for item in relevant]
    if key == "humanCorrectionTime":
        headline = median(values)
        extra = {"medianSeconds": headline, "sumSeconds": sum(values), "tracksMeasured": len(values)}
    else:
        headline = mean(values)
        extra = {"mean": headline, "tracksMeasured": len(values)}
        if key == "processingTime":
            extra["sumSeconds"] = sum(values)
    body = measured(key, headline, extra)
    return body


def _empty_report(corpus: Path | None) -> dict:
    environment = probe_environment()
    installed = environment["demucs"]["installed"] and environment["fasterWhisper"]["installed"]
    warnings = []
    if not environment["demucs"]["installed"]:
        warnings.append(_gap("demucs_not_installed_here", "评分进程没有安装 Demucs。本次不下载权重，也不因此编造分离结果。"))
    if not environment["fasterWhisper"]["installed"]:
        warnings.append(_gap(
            "faster_whisper_not_installed_here",
            "评分进程没有安装 faster-whisper。本次不下载权重；没有模型来源的歌词预测也不会被当成歌唱识别准确率。",
        ))
    return {
        "protocol": "basstrace-p0-eval",
        "protocolVersion": "1",
        "status": "not_evaluated",
        "summary": "",
        "accuracyClaim": False,
        "qualityPassed": None,
        "benchmarkComplete": False,
        "publishedInRepository": False,
        "confidenceUsedAsAccuracy": False,
        "mixdownSubstitutedForBass": False,
        "projectsRewritten": False,
        "outputWritten": False,
        "corpusPath": str(corpus) if corpus is not None else None,
        "authorization": None,
        "thisProcess": {
            "ranDemucs": False,
            "ranWhisper": False,
            "downloadedWeights": False,
            "openedAudio": False,
            "rewroteProjects": False,
            "uploadedAudio": False,
            "packagesInstalled": installed,
        },
        "productDefaults": {
            "separation": {"implementation": "demucs", "modelName": "htdemucs", "device": "cpu"},
            "lyrics": {"implementation": "faster-whisper", "modelName": "tiny", "device": "cpu"},
            "note": "这是产品当前的默认参数，只说明以后对照时要记录的设置，不表示本次已经运行。",
        },
        "scoringEnvironment": environment,
        "gaps": [],
        "warnings": warnings,
        "tracks": [],
        "separationOutcomes": {"completed": 0, "failed": 0, "missing": 0, "unrecorded": 0},
        "metrics": {key: blank(key, "not_evaluated", "corpus_missing", "没有曲库，这项没有评估。") for key in METRIC_SPEC},
    }


def _separation_outcomes(tracks: list) -> dict:
    counts = {"completed": 0, "failed": 0, "missing": 0, "unrecorded": 0}
    for track in tracks:
        separation = track.get("separation")
        if not separation:
            counts["unrecorded"] += 1
        else:
            counts[separation["status"]] += 1
    return counts


def probe_environment() -> dict:
    return {
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "os": {"system": platform.system(), "release": platform.release(), "version": platform.version()},
        "python": platform.python_version(),
        "cpuCount": os.cpu_count(),
        "cpuModel": _cpu_model(),
        "ramBytes": _ram_bytes(),
        "gpu": None,
        "demucs": probe_package("demucs", "demucs"),
        "fasterWhisper": probe_package("faster-whisper", "faster_whisper"),
        "weightsLoaded": False,
    }


def probe_package(distribution: str, import_name: str) -> dict:
    try:
        installed = importlib.util.find_spec(import_name) is not None
    except (ImportError, ValueError, AttributeError):
        installed = False
    version = None
    if installed:
        try:
            version = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            version = None
    return {"installed": bool(installed), "version": version, "weightsLoaded": False}


def _cpu_model() -> str | None:
    try:
        text = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for line in text.splitlines():
        if line.lower().startswith("model name"):
            return line.split(":", 1)[1].strip() or None
    return None


def _ram_bytes() -> int | None:
    try:
        text = Path("/proc/meminfo").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for line in text.splitlines():
        if line.startswith("MemTotal:"):
            return int(line.split()[1]) * 1024
    return None


def _load_model(path: Path, model):
    if not path.is_file():
        return None, "absent", None
    if path.stat().st_size > MAX_JSON_BYTES:
        return None, "too_large", f"{path.name} 超过 {MAX_JSON_BYTES} 字节，没有解析。"
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return None, "unreadable", f"{path.name} 无法读取：{exc.__class__.__name__}"
    try:
        return model.model_validate(payload), None, None
    except ValidationError as exc:
        return None, "invalid", _brief(path.name, exc)


def _brief(name: str, exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = ".".join(str(item) for item in err["loc"])
        parts.append(f"{loc}: {err['msg']}")
    return f"{name} 不符合字段定义（{'；'.join(parts)[:500]}）"


def _audio_state(track_dir: Path, relative: str) -> tuple[bool, int | None, str | None]:
    path = track_dir / relative
    try:
        resolved = path.resolve()
        resolved.relative_to(track_dir.resolve())
    except (OSError, ValueError):
        return False, None, "audio_path_rejected"
    if not path.is_file():
        return False, None, "audio_missing"
    size = path.stat().st_size
    if size <= 0:
        return False, 0, "audio_empty"
    return True, size, None


def _inside_repo(path: Path) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return False
    return True


def _gold_complete(gold: GoldFile) -> bool:
    return bool(gold.tempo and gold.sections and gold.chords and gold.lyrics and gold.notes and gold.bassPitches)


def _gold_chords_unparsed(gold: GoldFile) -> bool:
    return any(parse_chord(item.label) is None for item in gold.chords or [])


def _outside_duration(gold: GoldFile, duration: float) -> bool:
    layers = [*(gold.sections or []), *(gold.chords or []), *(gold.lyrics or []), *(gold.notes or []), *(gold.bassPitches or [])]
    if any(item.end > duration + 0.05 for item in layers):
        return True
    return gold.tempo is not None and gold.tempo.downbeats[-1] > duration + 0.05


def _prediction_outside(prediction: PredictionFile, duration: float) -> bool:
    layers = [
        *(prediction.sections or []), *(prediction.chords or []), *(prediction.lyrics or []),
        *(prediction.notes or []), *(prediction.bassPitches or []),
    ]
    if any(item.end > duration + 0.05 for item in layers):
        return True
    return prediction.tempo is not None and prediction.tempo.downbeats[-1] > duration + 0.05


def _separation_view(prediction: PredictionFile) -> dict:
    stems = prediction.separation.stems
    return {
        "status": prediction.separation.status,
        "error": prediction.separation.error,
        "usedMixdownAsBass": False,
        "stems": {name: getattr(stems, name) for name in STEMS},
    }


def _model_views(prediction: PredictionFile) -> dict:
    fields = {
        "separation": prediction.separation.provenance,
        "structure": prediction.structureProvenance,
        "harmony": prediction.harmonyProvenance,
        "bass": prediction.bassProvenance,
        "notes": prediction.noteProvenance,
        "lyrics": prediction.lyricProvenance,
    }
    view = {}
    for name, provenance in fields.items():
        if provenance is None:
            view[name] = None
            continue
        view[name] = {
            "implementation": provenance.implementation,
            "modelName": provenance.modelName,
            "modelVersion": provenance.modelVersion,
            "parameters": dict(provenance.parameters),
        }
    if prediction.modelRun is not None:
        view["modelRun"] = prediction.modelRun.model_dump()
    return view


def _fill(entry: dict, keys, status: str, reason: str, detail: str) -> None:
    for key in keys:
        entry["metrics"][key] = blank(key, status, reason, detail)


def _fill_unresolved(entry: dict, status: str, reason: str, detail: str) -> None:
    for key, metric in entry["metrics"].items():
        if metric["status"] in {"not_started", "not_evaluated"} and metric["reason"] in {"not_started", "not_recorded"}:
            entry["metrics"][key] = blank(key, status, reason, detail)


def _gap(code: str, detail: str) -> dict:
    return {"code": code, "detail": detail}


def _write_outside_repo(report: dict, output: Path | None) -> tuple[dict, bool]:
    if output is None:
        return report, False
    if _inside_repo(output):
        report["warnings"].append(_gap("output_inside_repository", "拒绝把评估报告写入仓库。结果只打印到标准输出。"))
        return report, False
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(_dumps(report), encoding="utf-8")
    except OSError as exc:
        report["warnings"].append(_gap("output_not_written", f"报告没有写入磁盘：{exc.__class__.__name__}"))
        return report, False
    return report, True


def _deliver(payload: dict, output: Path | None) -> None:
    text = _dumps(payload)
    if output is not None and not _inside_repo(output):
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
    print(text)


def _dumps(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"


if __name__ == "__main__":
    sys.exit(main())
