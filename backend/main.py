from __future__ import annotations

import logging
import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from . import adapters, audio, lyrics, storage
from .demo import ensure_demo
from .models import Analysis, AnalyzeRequest, LyricAlignment, LyricsAlignRequest, Project, Stem
from .timeline import beat_to_time, time_to_beat

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Persisted jobs cannot continue across a server restart. Make this visible
    # instead of leaving the player polling a permanently running analysis.
    with storage.LOCK:
        for existing in storage.list_projects():
            changed = False
            if existing.analysis.state == "running":
                existing.analysis.state = "error"
                existing.analysis.stage = "上次分析已中断，可重新分析"
                existing.analysis.warnings.append("本次服务进程没有上次分析任务，请重新分析；已保存的人工编辑仍保留。")
                changed = True
            if existing.lyricAlignment.state == "running":
                existing.lyricAlignment.state = "error"
                existing.lyricAlignment.stage = "上次歌词任务已中断"
                existing.lyricAlignment.error = "服务已重启，请重新识别和对齐；原始歌词与人工时间仍保留。"
                existing.lyricAlignment.jobId = None
                changed = True
            if changed:
                storage.save(existing)
    yield


app = FastAPI(title="BassChart Studio", version="2.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
                   allow_methods=["GET", "POST", "PUT"], allow_headers=["*"])
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="basschart-analysis")
DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
MAX_UPLOAD = 300 * 1024 * 1024


def get_project(project_id: str) -> Project:
    try:
        return storage.load(project_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "找不到工程") from exc


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.1.0", "capabilities": audio.capabilities()}


@app.get("/api/projects", response_model=list[Project])
def projects():
    return storage.list_projects()


@app.get("/api/projects/demo", response_model=Project)
def demo():
    return ensure_demo()


@app.post("/api/projects/upload", response_model=Project)
async def upload(file: UploadFile = File(...)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".wav", ".mp3", ".flac", ".m4a"}:
        raise HTTPException(415, "支持 MP3、WAV、FLAC、M4A 音频")
    project_id = str(uuid.uuid4())
    directory = storage.project_dir(project_id)
    directory.mkdir(parents=True, exist_ok=True)
    source = directory / ("upload" + suffix)
    total = 0
    try:
        with source.open("wb") as target:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD:
                    raise HTTPException(413, "音频大小不能超过 300 MB")
                target.write(chunk)
        if not total:
            raise HTTPException(400, "音频文件为空")
        duration = await run_in_threadpool(adapters.DEFAULT.decoder.decode, source, directory / "original.wav")
        waveform = await run_in_threadpool(audio.peaks, directory / "original.wav")
        source.unlink(missing_ok=True)
        project = Project(id=project_id, title=Path(file.filename or "未命名歌曲").stem[:300] or "未命名歌曲",
                          duration=duration,
                          stems=[Stem(id="original", name="原曲", available=True,
                                      url=f"/media/{project_id}/original.wav", peaks=waveform)] +
                                [Stem(id=name, name=label) for name, label in
                                 (("bass", "贝斯"), ("drums", "鼓"), ("vocals", "人声"), ("other", "伴奏"))],
                          analysis=Analysis(stage="音频已导入，等待分析", warnings=["初始 96 BPM / C / 4/4 仅为默认值，尚未分析。"] ))
        storage.save(project)
        return project
    except HTTPException:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    except (ValueError, OSError) as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        logging.exception("Audio import failed")
        shutil.rmtree(directory, ignore_errors=True)
        raise HTTPException(422, "音频导入失败，请确认音频可播放及 FFmpeg 可用。") from exc
    finally:
        await file.close()


@app.get("/api/projects/{project_id}", response_model=Project)
def project(project_id: str):
    return get_project(project_id)


@app.put("/api/projects/{project_id}", response_model=Project)
def update_project(project_id: str, incoming: Project):
    with storage.LOCK:
        current = get_project(project_id)
        if incoming.id != project_id:
            raise HTTPException(400, "工程 ID 不匹配")
        # A stale tab must not silently replace a more recent user save. Analysis
        # progress updates do not increment this revision.
        if incoming.revision != current.revision:
            raise HTTPException(409, "工程已被更新，请重新加载后保存。")
        try:
            return storage.save_user_edit(current, incoming)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc


def set_status(project_id: str, stage: str, progress: float, warnings: list[str] | None = None):
    with storage.LOCK:
        project = storage.load(project_id)
        project.analysis = Analysis(state="running", stage=stage, progress=progress,
                                    warnings=warnings if warnings is not None else project.analysis.warnings)
        storage.save(project)


def run_analysis(project_id: str, options: AnalyzeRequest):
    warnings = []
    try:
        current = storage.load(project_id)
        directory = storage.project_dir(project_id)
        new_stems = {}
        bass = None
        if options.source == "uploaded_bass":
            bass = checked_audio_path(directory / "original.wav", directory, "导入的独立贝斯")
            new_stems["bass"] = bass
        else:
            if not options.separate:
                try:
                    bass = bass_path(current)
                    # An explicitly uploaded single track must not become an
                    # implicit full-mix fallback in a later full-song request.
                    if bass == (directory / "original.wav").resolve() or not audio.valid_stem_audio(bass, current.duration):
                        bass = None
                except ValueError:
                    pass
            if bass is None:
                set_status(project_id, "分离贝斯音轨（首次运行可能下载模型）", 10, warnings)
                new_stems = adapters.DEFAULT.separator.separate(directory / "original.wav", directory)
                if "bass" not in new_stems:
                    raise ValueError("分离任务没有生成贝斯音轨，请重新分离")
                bass = checked_audio_path(new_stems["bass"], directory, "贝斯")
                if not audio.valid_stem_audio(bass, current.duration):
                    raise ValueError("分离后的贝斯音轨不可读或与歌曲长度不一致，请重新分离")
        stem_objects = []
        for name, path in new_stems.items():
            path = checked_audio_path(path, directory, name)
            relative = path.relative_to(directory.resolve()).as_posix()
            stem_objects.append(Stem(id=name, name={"bass": "贝斯", "drums": "鼓", "vocals": "人声", "other": "伴奏"}[name],
                                     url=f"/media/{project_id}/{relative}", available=True, peaks=audio.peaks(path)))
        # Publish genuine separation independently. A later analysis failure
        # must not force a second expensive separation or discard other edits.
        if stem_objects:
            with storage.LOCK:
                latest = storage.load(project_id)
                for stem in stem_objects:
                    latest.stems = [item for item in latest.stems if item.id != stem.id] + [stem]
                latest.revision += 1
                storage.save(latest)
        set_status(project_id, "增强贝斯试听音量", 45, warnings)
        enhanced = directory / "bass-enhanced.wav"
        gain = audio.enhance_bass(bass, enhanced)
        with storage.LOCK:
            latest = storage.load(project_id)
            stem = next(item for item in latest.stems if item.id == "bass")
            stem.enhancedUrl = f"/media/{project_id}/{enhanced.name}"
            stem.gainDb = gain
            latest.revision += 1
            storage.save(latest)
            current = latest.model_copy(deep=True)
            preserve_grid = any(storage.edit_flags(project_id).get(field) for field in storage.GRID_FIELDS)
        set_status(project_id, "仅从贝斯轨分析主要音名与节拍", 60, warnings)
        result = adapters.DEFAULT.bass_analyzer.analyze(current, enhanced.resolve(), preserve_grid=preserve_grid)
        # Adapter output cannot replace harmony, lyrics, notes or manual marks.
        result = {key: value for key, value in result.items()
                  if key in {"bpm", "offset", "beatTimes", "sections", "bassEvents", "warnings"}}
        warnings.extend(result.pop("warnings", []))
        if options.transcribe:
            warnings.append("已跳过音符转写，只显示贝斯主要音名；手写加花继续保留。")
        if current.isDemo:
            warnings.append("重新分析演示音频会产生候选估计，可能与已知合成参数不同。")
        with storage.LOCK:
            latest = storage.load(project_id)
            previous_grid = {field: getattr(latest, field) for field in storage.GRID_FIELDS}
            previous_sections = latest.sections
            chord_times = {chord.id: beat_to_time(latest, chord.bar, chord.beat) for chord in latest.chords}
            flags = storage.edit_flags(project_id)
            if any(flags.get(field) for field in storage.GRID_FIELDS):
                warnings.append("已保留人工节拍网格；新的贝斯音名按实际音频时间显示，不会替换已有和弦。")
            if any(chord.locked or chord.source == "manual" for chord in latest.chords):
                warnings.append("已保留人工确认的和弦，可随时切回和弦视图。")
            latest = storage.merge_candidates(latest, result)
            if any(getattr(latest, field) != value for field, value in previous_grid.items()):
                positions = {chord.id: time_to_beat(latest, chord_times[chord.id])
                             for chord in latest.chords}
                if any(bar < 1 for bar, _ in positions.values()):
                    # This project format cannot store chords before bar one.
                    # Retain the grid rather than silently moving those events.
                    for field, value in previous_grid.items():
                        setattr(latest, field, value)
                    latest.sections = previous_sections
                    warnings.append("候选首拍晚于已保存的和弦，本次保留原节拍网格与段落，避免和弦对齐偏移；请试听后手工校正首拍。")
                else:
                    for chord in latest.chords:
                        chord.bar, chord.beat = positions[chord.id]
            # Respect a view selection saved while this job was running.
            if latest.topTrack == current.topTrack:
                latest.topTrack = "bass"
            latest.validate_bass_events()
            latest.analysis = Analysis(state="complete", stage="候选分析完成，请试听校正", progress=100, warnings=warnings)
            latest.revision += 1
            storage.save(latest)
    except Exception as exc:
        logging.exception("Project analysis failed")
        with storage.LOCK:
            latest = storage.load(project_id)
            latest.analysis = Analysis(state="error", stage="分析失败", progress=100,
                                       warnings=warnings + [f"分析失败：{str(exc)[-600:]}"])
            storage.save(latest)


@app.post("/api/projects/{project_id}/analyze", response_model=Project)
def analyze(project_id: str, options: AnalyzeRequest):
    with storage.LOCK:
        project = get_project(project_id)
        if project.lyricAlignment.state == "running":
            raise HTTPException(409, "该工程正在识别歌词，请等待任务完成。")
        if project.analysis.state == "running":
            return project
        if options.source == "uploaded_bass":
            try:
                checked_audio_path(storage.project_dir(project_id) / "original.wav", storage.project_dir(project_id), "导入的独立贝斯")
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
        project.analysis = Analysis(state="running", stage="分析任务已排队", progress=0,
                                    warnings=["分析期间可编辑并保存；人工校正会优先保留。"])
        storage.save(project)
        EXECUTOR.submit(run_analysis, project_id, options)
        return project


def checked_audio_path(path: Path, directory: Path, label: str) -> Path:
    path = Path(path).resolve()
    if not path.is_relative_to(directory.resolve()) or path.suffix.lower() not in {".wav", ".flac", ".mp3", ".m4a"} or not path.is_file():
        raise ValueError(f"{label}音轨文件不可用，请检查导入文件或重新分离音轨")
    return path


def isolated_stem_path(project: Project, stem_id: str, label: str) -> Path:
    stem = next((item for item in project.stems if item.id == stem_id and item.available), None)
    prefix = f"/media/{project.id}/"
    if stem is None or not stem.url.startswith(prefix):
        detail = ("请先执行四轨分离，或导入独立贝斯并选择该来源。" if stem_id == "bass" else
                  "请先执行四轨分离；不会使用原曲伪造人声识别结果。")
        raise ValueError(f"没有可用的独立{label}音轨。{detail}")
    directory = storage.project_dir(project.id)
    return checked_audio_path(directory / unquote(stem.url[len(prefix):]), directory, label)


def bass_path(project: Project) -> Path:
    return isolated_stem_path(project, "bass", "贝斯")


def vocal_path(project: Project) -> Path:
    return isolated_stem_path(project, "vocals", "人声")


def run_lyric_alignment(project_id: str, options: LyricsAlignRequest, job_id: str,
                        original: str, target_text: str, vocals: Path, start: float, end: float):
    try:
        detected = adapters.DEFAULT.lyrics.transcribe(vocals, model=options.model,
                                                     language=options.language, start=start, end=end)
        with storage.LOCK:
            latest = storage.load(project_id)
            if latest.lyricAlignment.jobId != job_id:
                return  # New original text or another user decision superseded this task.
            if latest.lyricsOriginal != original:
                raise ValueError("原歌词在识别期间已修改，请使用新原文重新对齐")
            if options.lyricId:
                target = next((item for item in latest.lyrics if item.id == options.lyricId), None)
                if target is None or target.text != target_text:
                    raise ValueError("该歌词片段在识别期间已修改或删除，请重新识别此句")
            lines = (lyrics.align_text(target_text, detected, latest.lyrics, target_id=options.lyricId)
                     if options.mode == "align" else [])
            # A sentence rerun must not reapply stale candidates from other lines.
            lyrics.apply_alignment(latest, lines)
            if options.lyricId:
                previous = latest.lyricAlignment
                # A sentence rerun updates that sentence only, retaining the other
                # transcription candidates for review and later correction.
                detected = [item for item in previous.detectedSegments if item.end <= start or item.start >= end] + detected
                detected.sort(key=lambda item: item.start)
                lines = [item for item in previous.lines if item.lyricId != options.lyricId] + lines
            for index, segment in enumerate(detected):
                segment.id = f"detected-{index}"
            warnings = ["歌唱识别和字词时间仍需试听确认；此对齐使用识别字词匹配，不是音素级强制对齐。",
                        "原始歌词与识别初稿分别保存；已锁定片段的时间不会被自动修改。"]
            if not detected:
                warnings.append("没有识别出可靠人声歌词；原文保留，待对齐片段没有填入虚构时间。")
            if any(not segment.words for segment in detected):
                warnings.append("部分识别没有字词时间，仅使用片段内近似时间作为候选。")
            latest.lyricAlignment = LyricAlignment(state="complete", stage="歌词候选已生成，请试听核对", progress=100,
                                                  detectedSegments=detected, lines=lines, warnings=warnings)
            latest.revision += 1
            storage.save(latest)
    except Exception as exc:
        logging.exception("Lyric recognition/alignment failed")
        with storage.LOCK:
            latest = storage.load(project_id)
            if latest.lyricAlignment.jobId == job_id:
                latest.lyricAlignment.state = "error"
                latest.lyricAlignment.stage = "歌词识别或对齐失败"
                latest.lyricAlignment.error = str(exc)[-1200:]
                latest.lyricAlignment.progress = 100
                latest.lyricAlignment.jobId = None
                latest.revision += 1
                storage.save(latest)


@app.post("/api/projects/{project_id}/lyrics/align", response_model=Project)
def align_lyrics(project_id: str, options: LyricsAlignRequest):
    with storage.LOCK:
        project = get_project(project_id)
        if options.revision is not None and options.revision != project.revision:
            raise HTTPException(409, "工程已更新，请重新加载后识别歌词。")
        if project.analysis.state == "running" or project.lyricAlignment.state == "running":
            raise HTTPException(409, "该工程已有分析任务，请等待任务完成。")
        try:
            vocals = vocal_path(project)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        try:
            lyrics.require_whisper()
        except lyrics.LyricsDependencyError as exc:
            raise HTTPException(503, str(exc)) from exc
        target = next((item for item in project.lyrics if item.id == options.lyricId), None)
        if options.lyricId and target is None:
            raise HTTPException(404, "找不到需要重新识别的歌词片段")
        start = options.start if options.start is not None else target.start if target else 0
        end = options.end if options.end is not None else target.end if target else project.duration
        if start >= end or end > project.duration or start >= project.duration:
            raise HTTPException(422, "识别时间区间必须位于音频内，且结束时间晚于开始时间")
        original = options.originalText if options.originalText is not None else project.lyricsOriginal or "\n".join(item.text for item in project.lyrics)
        target_text = target.text if target else original
        if options.mode == "align" and not target_text.strip():
            raise HTTPException(422, "请先导入或填写原歌词，再执行对齐；可使用 recognize 模式仅生成识别初稿。")
        if any(len(line) > 2000 for line in target_text.splitlines()):
            raise HTTPException(422, "请将原歌词按句换行，每句最多 2000 个字符")
        project.lyricsOriginal = original
        job_id = str(uuid.uuid4())
        previous = project.lyricAlignment
        project.lyricAlignment = LyricAlignment(state="running", stage="人声歌词识别已排队", progress=5,
                                               detectedSegments=previous.detectedSegments if options.lyricId else [],
                                               lines=previous.lines if options.lyricId else [], jobId=job_id,
                                               warnings=["首次运行会下载所选模型；任务不会替换原文或已锁定时间。"])
        project.revision += 1
        storage.save(project)
        EXECUTOR.submit(run_lyric_alignment, project_id, options, job_id, original, target_text, vocals, start, end)
        return project


@app.get("/media/{project_id}/{filename:path}")
def media(project_id: str, filename: str):
    try:
        directory = storage.project_dir(project_id).resolve()
    except ValueError as exc:
        raise HTTPException(400, "无效工程 ID") from exc
    path = (directory / filename).resolve()
    if not path.is_relative_to(directory) or path.suffix.lower() not in {".wav", ".mp3", ".flac", ".m4a"}:
        raise HTTPException(404, "找不到音频")
    if not path.is_file():
        raise HTTPException(404, "找不到音频")
    return FileResponse(path)


@app.get("/{filename:path}")
def frontend(filename: str):
    if filename == "api" or filename.startswith("api/") or filename == "media" or filename.startswith("media/"):
        raise HTTPException(404, "找不到接口")
    root = DIST.resolve()
    path = (root / filename).resolve()
    if not path.is_relative_to(root):
        raise HTTPException(404, "找不到页面")
    if path.is_file():
        return FileResponse(path)
    if Path(filename).suffix:
        raise HTTPException(404, "找不到文件")
    index = root / "index.html"
    if not index.is_file():
        raise HTTPException(503, "前端尚未构建，请运行项目启动脚本。")
    return FileResponse(index)
