"""Versioned portable library archives, isolated from the audio analysis queue."""
import hashlib
import asyncio
import json
import logging
import shutil
import stat
import time
import tempfile
import zipfile
import soundfile as sf
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import Field
from . import storage
from .folders import Folder, read_folders, write_folders
from .models import Model, Project
from .playlists import Playlist, read_playlists, write_playlists

router = APIRouter(prefix='/api/library')
IO_QUEUE = ThreadPoolExecutor(max_workers=1, thread_name_prefix='basstrace-library')
JOBS = {}
MAX_ARCHIVE = 10 * 1024**3
MAX_EXPANDED = 50 * 1024**3
MAX_FILES = 10000
CHUNK = 1024 * 1024

class ArchiveUploadLimit:
    """Bound the multipart stream before Starlette spools a large upload."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] != 'POST' or scope['path'] != '/api/library/imports':
            return await self.app(scope, receive, send)
        limit = MAX_ARCHIVE + CHUNK  # allow multipart headers; file itself has the exact cap below
        length = dict(scope['headers']).get(b'content-length', b'')
        if length.isdigit() and int(length) > limit:
            return await JSONResponse({'detail':'备份包不能超过 10GiB'}, status_code=413)(scope, receive, send)
        total = 0
        async def bounded_receive():
            nonlocal total
            message = await receive()
            if message['type'] == 'http.request':
                total += len(message.get('body', b''))
                if total > limit:
                    raise HTTPException(413, '备份包不能超过 10GiB')
                # Multipart may spool on C: even if the library itself lives on D:.
                for target in (tempfile.gettempdir(), storage.DATA_ROOT):
                    if shutil.disk_usage(target).free < len(message.get('body', b'')) + 64 * 1024**2:
                        raise HTTPException(507, '上传暂存盘空间不足，请释放磁盘空间后重试')
            return message
        return await self.app(scope, bounded_receive, send)

class ExportRequest(Model):
    projectIds: list[str] | None = Field(default=None, max_length=10000)
    folderId: str | None = None
    playlistId: str | None = None

def transfer_root():
    root = storage.DATA_ROOT / '.transfers'
    root.mkdir(parents=True, exist_ok=True)
    return root

def job_dir(job_id):
    if not storage.ID_PATTERN.fullmatch(job_id) or job_id == 'demo':
        raise HTTPException(404, '任务不存在')
    return transfer_root() / job_id

def new_job(kind):
    job = {'id': str(uuid4()), 'kind': kind, 'state': 'queued', 'progress': 0, 'message': '已排队', 'createdAt': time.time()}
    job_dir(job['id']).mkdir()
    JOBS[job['id']] = job
    storage.write_json(job_dir(job['id']) / 'status.json', job)
    return job

def update(job_id, **changes):
    with storage.LOCK:
        JOBS[job_id].update(changes)
        storage.write_json(job_dir(job_id) / 'status.json', JOBS[job_id])

def safe_relative(name):
    if not isinstance(name, str) or not name or '\\' in name or ':' in name or '\x00' in name:
        raise ValueError('备份文件路径无效')
    parts = name.split('/')
    if any(p in ('', '.', '..') or p.endswith((' ', '.')) for p in parts):
        raise ValueError('备份文件路径越界或不兼容')
    if any(p.split('.')[0].upper() in {'CON','PRN','AUX','NUL',*[f'COM{i}' for i in range(10)],*[f'LPT{i}' for i in range(10)]} for p in parts):
        raise ValueError('备份包含不兼容文件名')
    return PurePosixPath(name)

def media_relative(project_id, url):
    path = unquote(urlsplit(url).path)
    prefix = f'/media/{project_id}/'
    if not path.startswith(prefix):
        raise ValueError('音频地址不属于工程')
    return str(safe_relative(path[len(prefix):]))

def managed_audio(project_id, relative):
    root = storage.project_dir(project_id).resolve()
    path = root / relative
    if not path.resolve().is_relative_to(root) or any(p.is_symlink() or getattr(p, 'is_junction', lambda: False)() for p in [path, *path.parents] if p != root.parent):
        raise ValueError('音频路径超出工程范围')
    if not path.is_file():
        raise ValueError('缺少音频文件：' + relative)
    return path

def check_space(required):
    if shutil.disk_usage(storage.DATA_ROOT).free < required + 64 * 1024**2:
        raise ValueError('磁盘可用空间不足，请先释放空间再重试')

def json_bytes(value):
    return json.dumps(value, ensure_ascii=False).encode('utf-8')

def select_projects(request):
    projects = storage.list_projects()
    ids = set(request.projectIds) if request.projectIds is not None else {p.id for p in projects}
    folders = read_folders()
    if request.folderId:
        if not any(f['id'] == request.folderId for f in folders['folders']):
            raise HTTPException(404, '文件夹不存在')
        ids &= {pid for pid, fid in folders['assignments'].items() if fid == request.folderId}
    if request.playlistId:
        playlist = next((p for p in read_playlists() if p.id == request.playlistId), None)
        if playlist is None:
            raise HTTPException(404, '歌单不存在')
        ids &= set(playlist.projectIds)
    selected = [p for p in projects if p.id in ids]
    if request.projectIds is not None and set(request.projectIds) - {p.id for p in projects}:
        raise HTTPException(404, '部分歌曲已删除，请刷新曲库')
    if not selected and request.folderId is None and request.projectIds is not None:
        raise HTTPException(400, '请先选择歌曲')
    return selected

@router.post('/exports', status_code=202)
def start_export(request: ExportRequest):
    from .project_features import assert_idle
    with storage.LOCK:
        projects = select_projects(request)
        for project in projects:
            assert_idle(project)
        ids = {p.id for p in projects}
        folders = read_folders()
        whole = request.projectIds is None and not request.folderId and not request.playlistId
        used_folders = {fid for pid, fid in folders['assignments'].items() if pid in ids}
        if request.folderId:
            used_folders.add(request.folderId)
        manifest = {'format': 'basstrace-library', 'version': 1, 'projects': [p.id for p in projects],
                    'folders': [f for f in folders['folders'] if whole or f['id'] in used_folders],
                    'assignments': {pid: fid for pid, fid in folders['assignments'].items() if pid in ids},
                    'playlists': [{**p.model_dump(), 'projectIds': [pid for pid in p.projectIds if pid in ids]}
                                  for p in read_playlists() if whole or p.id == request.playlistId or ids.intersection(p.projectIds)], 'files': {}}
        entries = {}
        try:
            for project in projects:
                entries[f'projects/{project.id}/project.json'] = json_bytes(project.model_dump())
                entries[f'projects/{project.id}/edits.json'] = json_bytes(storage.edit_flags(project.id))
                if any(len(entries[f'projects/{project.id}/{name}']) > 32 * 1024**2 for name in ('project.json', 'edits.json')):
                    raise ValueError('工程元数据超过 32MiB，请整理后再备份')
                paths = {'original.wav'}
                for stem in project.stems:
                    if stem.available:
                        paths.add(media_relative(project.id, stem.url))
                        if stem.enhancedUrl:
                            paths.add(media_relative(project.id, stem.enhancedUrl))
                for path in paths:
                    entries[f'projects/{project.id}/{path}'] = managed_audio(project.id, path)
            size = sum(len(v) if isinstance(v, bytes) else v.stat().st_size for v in entries.values())
            if size > MAX_ARCHIVE - 16 * 1024**2 or len(entries) + 1 > MAX_FILES:
                raise ValueError('备份超过 10GiB 或 10,000 个文件，请分批导出')
            check_space(size)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        job = new_job('export')
        storage.EXPORTING.update(ids)
        IO_QUEUE.submit(export_worker, job['id'], entries, manifest, ids)
        return job.copy()

def export_worker(job_id, entries, manifest, ids):
    path = job_dir(job_id) / 'library.basstrace.zip'
    try:
        update(job_id, state='running', message='正在打包音频与曲谱')
        with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            for index, (name, source) in enumerate(entries.items()):
                digest, size = hashlib.sha256(), 0
                with archive.open(name, 'w', force_zip64=True) as out:
                    if isinstance(source, bytes):
                        out.write(source); digest.update(source); size = len(source)
                    else:
                        with source.open('rb') as inp:
                            while chunk := inp.read(CHUNK):
                                out.write(chunk); digest.update(chunk); size += len(chunk)
                manifest['files'][name] = {'size': size, 'sha256': digest.hexdigest()}
                update(job_id, progress=round((index + 1) / max(1, len(entries)) * 95))
            archive.writestr('manifest.json', json_bytes(manifest))
        update(job_id, state='complete', progress=100, message='备份已完成', downloadUrl=f'/api/library/jobs/{job_id}/download')
    except Exception as exc:
        path.unlink(missing_ok=True)
        update(job_id, state='error', message=str(exc))
    finally:
        with storage.LOCK:
            storage.EXPORTING.difference_update(ids)

@router.post('/imports', status_code=202)
async def upload_archive(file: UploadFile = File(...)):
    job = new_job('import')
    path = job_dir(job['id']) / 'upload.zip'
    try:
        total = 0
        with path.open('wb') as out:
            while chunk := await file.read(CHUNK):
                total += len(chunk)
                if total > MAX_ARCHIVE:
                    raise ValueError('备份包不能超过 10GiB')
                check_space(len(chunk))
                out.write(chunk)
        IO_QUEUE.submit(validate_worker, job['id'])
        return job.copy()
    except Exception as exc:
        path.unlink(missing_ok=True)
        update(job['id'], state='error', message=str(exc))
        raise HTTPException(422, str(exc)) from exc
    except asyncio.CancelledError:
        path.unlink(missing_ok=True)
        update(job['id'], state='error', message='上传已中断，请重新上传')
        raise
    finally:
        await file.close()

def read_small(archive, name, limit=32 * 1024**2):
    if archive.getinfo(name).file_size > limit:
        raise ValueError('备份元数据过大')
    return json.loads(archive.read(name))

def validate_worker(job_id):
    directory = job_dir(job_id)
    staged = directory / 'staged'
    try:
        update(job_id, state='running', message='正在检查备份文件')
        with zipfile.ZipFile(directory / 'upload.zip') as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FILES:
                raise ValueError('备份文件数量超过限制')
            names, expanded = set(), 0
            for info in infos:
                safe_relative(info.filename)
                if info.filename.casefold() in names or info.is_dir() or info.flag_bits & 1 or stat.S_ISLNK(info.external_attr >> 16):
                    raise ValueError('备份包含重复路径、加密或链接文件')
                mode = stat.S_IFMT(info.external_attr >> 16)
                if mode not in (0, stat.S_IFREG):
                    raise ValueError('备份包含不支持的特殊文件')
                names.add(info.filename.casefold()); expanded += info.file_size
            if expanded > MAX_EXPANDED:
                raise ValueError('展开后的备份超过 50GiB')
            check_space(expanded)
            manifest = read_small(archive, 'manifest.json', 16 * 1024**2)
            if manifest.get('format') != 'basstrace-library' or manifest.get('version') != 1:
                raise ValueError('不支持的曲库备份格式或版本')
            files = manifest['files']
            if set(files) | {'manifest.json'} != {i.filename for i in infos}:
                raise ValueError('备份清单与文件不一致')
            pids = manifest['projects']
            if len(set(pids)) != len(pids) or any(not storage.ID_PATTERN.fullmatch(pid) for pid in pids):
                raise ValueError('备份工程编号无效')
            folders = [Folder.model_validate(f) for f in manifest['folders']]
            playlists = [Playlist.model_validate(p) for p in manifest['playlists']]
            fids = {f.id for f in folders}
            if len(fids) != len(folders) or len({p.id for p in playlists}) != len(playlists):
                raise ValueError('分类编号重复')
            if any(pid not in pids or fid not in fids for pid, fid in manifest['assignments'].items()) or any(set(p.projectIds) - set(pids) for p in playlists):
                raise ValueError('分类引用了不存在的歌曲')
            for index, (name, expected) in enumerate(files.items()):
                parts = safe_relative(name).parts
                if len(parts) < 3 or parts[0] != 'projects' or parts[1] not in pids:
                    raise ValueError('备份包含未声明的工程文件')
                if parts[-1] in ('project.json', 'edits.json') and archive.getinfo(name).file_size > 32 * 1024**2:
                    raise ValueError('备份工程元数据过大，请分批整理内容')
                target = staged.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                digest, size = hashlib.sha256(), 0
                with archive.open(name) as inp, target.open('wb') as out:
                    while chunk := inp.read(CHUNK):
                        size += len(chunk)
                        if size > expected['size'] or size > MAX_EXPANDED:
                            raise ValueError('文件大小与清单不一致')
                        digest.update(chunk); out.write(chunk)
                if size != expected['size'] or digest.hexdigest() != expected['sha256']:
                    raise ValueError('备份文件校验失败：' + name)
                update(job_id, progress=round((index + 1) / max(1, len(files)) * 95))
            for pid in pids:
                root = staged / 'projects' / pid
                project = Project.model_validate_json((root / 'project.json').read_text('utf-8'))
                if project.id != pid or not (root / 'original.wav').is_file():
                    raise ValueError('工程编号或原曲缺失')
                flags = json.loads((root / 'edits.json').read_text('utf-8'))
                if not isinstance(flags, dict):
                    raise ValueError('人工编辑记录无效')
                expected_paths = {'project.json', 'edits.json', 'original.wav'}
                for stem in project.stems:
                    for url in ([stem.url, stem.enhancedUrl] if stem.available else []):
                        if url:
                            relative = media_relative(pid, url)
                            expected_paths.add(relative)
                            if not (root / relative).is_file():
                                raise ValueError('备份缺少分轨音频')
                actual_paths = {name[len(f'projects/{pid}/'):] for name in files if name.startswith(f'projects/{pid}/')}
                if actual_paths != expected_paths:
                    raise ValueError('备份包含非工程文件')
                for relative in expected_paths - {'project.json', 'edits.json'}:
                    info = sf.info(root / relative)
                    if not info.frames or not info.samplerate or abs(info.duration-project.duration) > .25:
                        raise ValueError('备份音频无效或与曲谱时长不符')
            storage.write_json(directory / 'manifest.json', manifest)
        update(job_id, state='ready', progress=100, message='校验通过，可恢复为新副本', preview={
            'songs': len(pids), 'folders': [f.name for f in folders], 'playlists': [p.name for p in playlists], 'bytes': expanded})
    except Exception as exc:
        if staged.exists():
            shutil.rmtree(staged)
        update(job_id, state='error', message='备份校验失败：' + str(exc))

def imported_name(name, existing):
    candidate, number = name, 1
    while candidate.casefold() in existing:
        suffix = '（导入）' if number == 1 else f'（导入 {number}）'
        candidate = name[:100-len(suffix)] + suffix; number += 1
    existing.add(candidate.casefold())
    return candidate

def rollback(directory, journal):
    # IDs are freshly generated by this server; only managed immediate children are removed.
    for pid in journal['newIds']:
        path = storage.project_dir(pid)
        if path.resolve().parent != storage.DATA_ROOT.resolve() or path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
            raise ValueError('恢复回滚路径无效')
        if path.exists():
            shutil.rmtree(path)
    write_folders(journal['foldersBefore'])
    storage.write_json(storage.DATA_ROOT / 'playlists.json', {'playlists': journal['playlistsBefore']})
    storage.ensure_index()
    journal['state'] = 'rolled_back'
    storage.write_json(directory / 'transaction.json', journal)

def recover_transfers():
    with storage.LOCK:
        for file in transfer_root().glob('*/transaction.json'):
            journal = json.loads(file.read_text('utf-8'))
            if journal['state'] == 'committing':
                rollback(file.parent, journal)
        for file in transfer_root().glob('*/status.json'):
            job = json.loads(file.read_text('utf-8'))
            if job['state'] in ('queued', 'running'):
                job.update(state='error', message='上次曲库任务已中断，请重新操作')
            JOBS[job['id']] = job
        storage.EXPORTING.clear()

@router.post('/imports/{job_id}/confirm', status_code=202)
def confirm_import(job_id: str):
    with storage.LOCK:
        job = get_job(job_id)
        if job['kind'] != 'import' or job['state'] != 'ready':
            raise HTTPException(409, '备份尚未校验完成或已经恢复')
        update(job_id, state='queued', progress=0, message='恢复已排队')
        IO_QUEUE.submit(import_worker, job_id)
        return JOBS[job_id].copy()

def import_worker(job_id):
    directory = job_dir(job_id)
    journal = None
    try:
        update(job_id, state='running', message='正在恢复曲库')
        manifest = json.loads((directory / 'manifest.json').read_text('utf-8'))
        with storage.LOCK:
            folders, playlists = read_folders(), read_playlists()
            mapping = {pid: str(uuid4()) for pid in manifest['projects']}
            journal = {'state': 'committing', 'newIds': list(mapping.values()), 'foldersBefore': folders,
                       'playlistsBefore': [p.model_dump() for p in playlists]}
            storage.write_json(directory / 'transaction.json', journal)
            next_folders = json.loads(json.dumps(folders))
            names = {f['name'].casefold() for f in folders['folders']}
            folder_map = {}
            for folder in manifest['folders']:
                fid = folder_map[folder['id']] = str(uuid4())
                next_folders['folders'].append({'id': fid, 'name': imported_name(folder['name'], names)})
            for old, new in mapping.items():
                root = directory / 'staged' / 'projects' / old
                project = Project.model_validate_json((root / 'project.json').read_text('utf-8'))
                project.id, project.revision, project.isDemo = new, 1, False
                for stem in project.stems:
                    if stem.url:
                        stem.url = f'/media/{new}/' + media_relative(old, stem.url)
                    if stem.enhancedUrl:
                        stem.enhancedUrl = f'/media/{new}/' + media_relative(old, stem.enhancedUrl)
                for field in ('analysis','lyricAlignment','keyAnalysis','harmonyAnalysis','backingAnalysis'):
                    task = getattr(project, field)
                    if task and task.state == 'running':
                        task.state, task.stage = 'error', '备份中的任务已中断，可手动重试'
                root.replace(storage.project_dir(new))
                storage.save(project)
                if old in manifest['assignments']:
                    next_folders['assignments'][new] = folder_map[manifest['assignments'][old]]
            names = {p.name.casefold() for p in playlists}
            for playlist in manifest['playlists']:
                playlists.append(Playlist(id=str(uuid4()), name=imported_name(playlist['name'], names), projectIds=[mapping[p] for p in playlist['projectIds']]))
            write_folders(next_folders)
            write_playlists(playlists)
            storage.write_json(directory / 'transaction.json', {**journal, 'state': 'complete'})
            journal['state'] = 'complete'
            update(job_id, state='complete', progress=100, message=f'已恢复 {len(mapping)} 首歌曲', projectIds=list(mapping.values()))
    except Exception as exc:
        logging.exception('Library restore failed')
        with storage.LOCK:
            if journal is not None and journal['state'] == 'committing':
                rollback(directory, journal)
            update(job_id, state='error', message='恢复失败：' + str(exc))

@router.get('/jobs/{job_id}')
def get_job(job_id: str):
    job_dir(job_id)
    with storage.LOCK:
        if job_id not in JOBS:
            raise HTTPException(404, '任务不存在，请重新操作')
        return JOBS[job_id].copy()

@router.get('/jobs/{job_id}/download')
def download_job(job_id: str):
    job = get_job(job_id)
    if job['kind'] != 'export' or job['state'] != 'complete':
        raise HTTPException(409, '备份尚未完成')
    return FileResponse(job_dir(job_id) / 'library.basstrace.zip', media_type='application/zip', filename='BassTrace.basstrace.zip')

@router.delete('/jobs/{job_id}', status_code=204)
def discard_job(job_id: str):
    with storage.LOCK:
        job = get_job(job_id)
        if job['state'] in ('queued', 'running'):
            raise HTTPException(409, '任务进行中，完成后可清理')
        path = job_dir(job_id)
        if path.resolve().parent != transfer_root().resolve() or path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
            raise HTTPException(400, '临时文件路径无效')
        try:
            shutil.rmtree(path)
        except OSError as exc:
            raise HTTPException(409, '文件正在下载或被占用，请稍后清理') from exc
        del JOBS[job_id]
