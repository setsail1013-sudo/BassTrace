"""Import a guitar chord chart into the project's own guitarChords list."""
from __future__ import annotations

import logging

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from . import storage
from .chord_chart import (
    COLLISION_WARNING,
    IMPORT_NOTE,
    NO_LYRICS,
    ChartError,
    glyphs_to_candidates,
    measure_grid_available,
    merge_guitar_chords,
    normalize_with_map,
)
from .chord_pdf import ChartReadError, ChartToolError, extract_glyphs
from .models import GuitarChord, Model, Project, normalize_chord_symbol, valid_chord_symbol
from .project_features import assert_idle
from .timeline import beat_to_time

router = APIRouter()
MAX_PDF_BYTES = 20 * 1024 * 1024
_PATCH_FIELDS = {"symbol", "section", "lyricId", "charOffset", "start", "end", "bar", "beat", "status", "revision"}
_CONTENT_FIELDS = {"symbol", "section", "lyricId", "charOffset", "start", "end", "bar", "beat"}


class GuitarChordImportResponse(Model):
    note: str
    warnings: list[str]
    added: list[GuitarChord]
    preservedIds: list[str]
    untimedIds: list[str]
    project: Project


class GuitarChordPatchResponse(Model):
    chord: GuitarChord
    project: Project


def _project(project_id: str) -> Project:
    try:
        return storage.load(project_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "找不到工程") from exc


def _lyric_snapshot(project: Project) -> list[tuple]:
    return [(lyric.id, lyric.text, lyric.start, lyric.end, lyric.order) for lyric in project.lyrics]


def _prepare(pdf: bytes, project: Project, grid: bool):
    glyphs = extract_glyphs(pdf)
    return glyphs_to_candidates(glyphs, project, grid=grid)


@router.post("/api/projects/{project_id}/chords/import-pdf", response_model=GuitarChordImportResponse)
async def import_chord_pdf(project_id: str, file: UploadFile = File(...)):
    with storage.LOCK:
        project = _project(project_id)
        assert_idle(project)
        revision = project.revision
        lyrics = _lyric_snapshot(project)
        grid = measure_grid_available(project, storage.edit_flags(project.id))
        snapshot = project.model_copy(deep=True)
    payload = await _read_pdf(file)
    if not any(normalize_with_map(lyric.text)[0] for lyric in snapshot.lyrics):
        raise HTTPException(422, NO_LYRICS)
    try:
        draft = await run_in_threadpool(_prepare, payload, snapshot, grid)
    except ChartToolError as exc:
        raise HTTPException(503, exc.detail) from exc
    except (ChartReadError, ChartError) as exc:
        raise HTTPException(422, exc.detail) from exc
    except ValidationError as exc:
        logging.exception("Guitar chord import produced an invalid event")
        raise HTTPException(422, "没有从和弦谱版面中提取到可写入的和弦，未写入。") from exc
    with storage.LOCK:
        latest = _project(project_id)
        if latest.revision != revision or _lyric_snapshot(latest) != lyrics:
            raise HTTPException(409, "工程已被更新，请重新加载后导入。")
        assert_idle(latest)
        merged = merge_guitar_chords(latest.guitarChords, draft.chords, latest)
        warnings = list(draft.warnings)
        if merged.collided:
            warnings.append(COLLISION_WARNING)
        latest.guitarChords = merged.chords
        latest.revision += 1
        storage.save(latest)
        saved = storage.load(project_id)
    return GuitarChordImportResponse(
        note=IMPORT_NOTE,
        warnings=warnings,
        added=merged.added,
        preservedIds=merged.preserved_ids,
        untimedIds=[chord.id for chord in saved.guitarChords if chord.start is None],
        project=saved,
    )


@router.patch("/api/projects/{project_id}/guitar-chords/{chord_id}", response_model=GuitarChordPatchResponse)
async def update_guitar_chord(project_id: str, chord_id: str, request: Request):
    payload = await _object(request)
    unknown = set(payload) - _PATCH_FIELDS
    if unknown:
        raise HTTPException(422, "只能修改和弦标记、段落、歌词位置、时间或状态。")
    if "revision" not in payload or isinstance(payload["revision"], bool) or not isinstance(payload["revision"], int):
        raise HTTPException(422, "请提供工程 revision。")
    with storage.LOCK:
        project = _project(project_id)
        assert_idle(project)
        if payload["revision"] != project.revision:
            raise HTTPException(409, "工程已被更新，请重新加载后保存。")
        chord = next((item for item in project.guitarChords if item.id == chord_id), None)
        if chord is None:
            raise HTTPException(404, "找不到要修改的吉他和弦。")
        try:
            _apply_patch(chord, payload, project)
            project.validate_guitar_chords()
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        project.revision += 1
        storage.save(project)
        saved = storage.load(project_id)
        updated = next(item for item in saved.guitarChords if item.id == chord_id)
    return GuitarChordPatchResponse(chord=updated, project=saved)


async def _read_pdf(file: UploadFile) -> bytes:
    chunks = []
    total = 0
    try:
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_PDF_BYTES:
                raise HTTPException(413, "和弦谱 PDF 不能超过 20 MB。")
            chunks.append(chunk)
    finally:
        await file.close()
    payload = b"".join(chunks).lstrip(b"\xef\xbb\xbf")
    if not payload:
        raise HTTPException(400, "和弦谱文件为空。")
    if not payload.startswith(b"%PDF-"):
        raise HTTPException(422, "上传的文件不是有效的 PDF。")
    return payload


async def _object(request: Request) -> dict:
    try:
        payload = await request.json()
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(422, "请求体不是有效的 JSON") from None
    if not isinstance(payload, dict):
        raise HTTPException(422, "请求体必须是 JSON 对象")
    return payload


def _apply_patch(chord: GuitarChord, payload: dict, project: Project) -> None:
    content = _CONTENT_FIELDS & set(payload)
    if "symbol" in payload:
        if not isinstance(payload["symbol"], str):
            raise HTTPException(422, "和弦标记格式无法识别。")
        symbol = normalize_chord_symbol(payload["symbol"])
        if not valid_chord_symbol(symbol):
            raise HTTPException(422, "和弦标记格式无法识别。")
        chord.symbol = symbol
    if "section" in payload:
        section = payload["section"]
        if section is not None and not isinstance(section, str):
            raise HTTPException(422, "段落名称无效。")
        cleaned = section.strip() if isinstance(section, str) else ""
        if len(cleaned) > 40:
            raise HTTPException(422, "段落名称不能超过 40 个字符。")
        chord.section = cleaned or None
    if "lyricId" in payload or "charOffset" in payload:
        _apply_lyric(chord, payload, project)
    if "bar" in payload or "beat" in payload:
        _apply_bar(chord, payload, project)
    if "start" in payload or "end" in payload:
        _apply_time(chord, payload, project)
    elif "lyricId" in payload or "charOffset" in payload:
        _snap_lyric_time(chord, project)
    elif ("bar" in payload or "beat" in payload) and chord.bar is not None and chord.beat is not None:
        start = beat_to_time(project, chord.bar, chord.beat)
        if 0 <= start <= project.duration:
            chord.start = start
            if chord.end is not None and chord.end < chord.start:
                chord.end = chord.start
    if "status" in payload:
        if payload["status"] not in {"candidate", "confirmed", "manual"}:
            raise HTTPException(422, "和弦状态只能是 candidate、confirmed 或 manual。")
        chord.status = payload["status"]
    elif content:
        chord.status = "manual"
    if content or payload.get("status") == "manual":
        chord.source = "manual"


def _apply_lyric(chord: GuitarChord, payload: dict, project: Project) -> None:
    lyric_id = payload["lyricId"] if "lyricId" in payload else chord.lyricId
    offset = payload["charOffset"] if "charOffset" in payload else chord.charOffset
    if lyric_id is None:
        chord.lyricId = None
        chord.charOffset = None
        return
    if not isinstance(lyric_id, str):
        raise HTTPException(422, "找不到要对齐的歌词。")
    lyric = next((item for item in project.lyrics if item.id == lyric_id), None)
    if lyric is None:
        raise HTTPException(422, "找不到要对齐的歌词。")
    if isinstance(offset, bool) or not isinstance(offset, (int, float)) or (isinstance(offset, float) and not offset.is_integer()):
        raise HTTPException(422, "请同时指定歌词中的字词位置。")
    offset = int(offset)
    if offset < 0 or offset >= len(lyric.text):
        raise HTTPException(422, "和弦的字词位置超出歌词长度。")
    chord.lyricId = lyric_id
    chord.charOffset = offset


def _apply_bar(chord: GuitarChord, payload: dict, project: Project) -> None:
    bar = payload["bar"] if "bar" in payload else chord.bar
    beat = payload["beat"] if "beat" in payload else chord.beat
    if bar is None and beat is None:
        chord.bar = None
        chord.beat = None
        return
    if isinstance(bar, bool) or not isinstance(bar, int) or bar < 1:
        raise HTTPException(422, "请同时指定小节和拍点。")
    if isinstance(beat, bool) or not isinstance(beat, (int, float)):
        raise HTTPException(422, "请同时指定小节和拍点。")
    beats = int(project.meter.split("/")[0])
    if float(beat) < 1 or float(beat) >= beats + 1:
        raise HTTPException(422, "吉他和弦拍点超出当前拍号。")
    chord.bar = bar
    chord.beat = float(beat)


def _apply_time(chord: GuitarChord, payload: dict, project: Project) -> None:
    if "start" in payload:
        chord.start = _time_value(payload["start"], project, "开始时间")
    if "end" in payload:
        chord.end = _time_value(payload["end"], project, "结束时间")
    if chord.start is not None and chord.end is not None and chord.end < chord.start:
        raise HTTPException(422, "吉他和弦结束时间不能早于开始时间。")


def _snap_lyric_time(chord: GuitarChord, project: Project) -> None:
    if chord.lyricId is None or chord.charOffset is None:
        return
    lyric = next(item for item in project.lyrics if item.id == chord.lyricId)
    length = max(len(lyric.text), 1)
    span = max(0.0, lyric.end - lyric.start)
    start = lyric.start + span * (chord.charOffset / length)
    chord.start = min(max(start, 0.0), project.duration)
    if chord.end is None or chord.end < chord.start:
        chord.end = min(max(lyric.end, chord.start), project.duration)


def _time_value(value, project: Project, label: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HTTPException(422, f"和弦{label}无效。")
    if value < 0 or value > project.duration:
        raise HTTPException(422, "吉他和弦时间超出音频长度。")
    return float(value)
