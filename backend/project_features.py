"""Independent score analysis and reversible library lifecycle operations."""
import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException

from . import adapters, audio, storage
from .models import Analysis, KeyAnalysis, Stem, utc_now
from .playlists import read_playlists, write_playlists

router = APIRouter(prefix='/api')
TASK_FIELDS = {'key': 'keyAnalysis', 'chords': 'harmonyAnalysis', 'backing': 'backingAnalysis'}


def progress(project_id, field, stage, value):
    with storage.LOCK:
        latest = storage.load(project_id)
        task = getattr(latest, field)
        task.stage, task.progress = stage, value
        storage.save(latest)


def assert_idle(project):
    if project.id in storage.EXPORTING:
        raise HTTPException(409, '正在备份这首歌曲，完成后可重试')
    if storage.task_running(project):
        raise HTTPException(409, '歌曲正在分析或对齐，请任务完成后重试')


def apply_key(latest, result):
    flags = storage.edit_flags(latest.id)
    result.confirmed = bool((latest.keyAnalysis and latest.keyAnalysis.confirmed) or flags.get('key') or flags.get('originalKey'))
    if result.detectedKey and not result.confirmed and not flags.get('originalKey') and not flags.get('key'):
        latest.originalKey = result.detectedKey
        latest.key = result.detectedKey
    latest.keyAnalysis = result


@router.get('/trash')
def list_trash():
    with storage.LOCK:
        return sorted(storage.trash_records().values(), key=lambda r: r['deletedAt'], reverse=True)


@router.delete('/projects/{project_id}', status_code=204)
def trash_project(project_id: str):
    from .main import get_project
    with storage.LOCK:
        p = get_project(project_id)
        assert_idle(p)
        playlists = read_playlists()
        record = {'id': p.id, 'title': p.title, 'artist': p.artist, 'deletedAt': utc_now(),
                  'playlistIds': [item.id for item in playlists if p.id in item.projectIds]}
        records = storage.trash_records()
        records[p.id] = record
        # The tombstone is authoritative. Reads, saves and media stop working
        # immediately, even if the index is rebuilt or an old tab retries.
        storage.write_json(storage.DATA_ROOT / 'trash.json', records)
        with storage.connect_index() as connection:
            connection.execute('DELETE FROM projects WHERE id=?', (p.id,))


@router.post('/trash/{project_id}/restore')
def restore_project(project_id: str):
    with storage.LOCK:
        records = storage.trash_records()
        if project_id not in records:
            raise HTTPException(404, '回收站中没有这首歌曲')
        p = storage.load(project_id, include_trash=True)
        playlists = read_playlists()
        for item in playlists:
            if item.id in records[project_id]['playlistIds'] and project_id not in item.projectIds:
                item.projectIds.append(project_id)
        write_playlists(playlists)
        del records[project_id]
        storage.write_json(storage.DATA_ROOT / 'trash.json', records)

        p.revision += 1
        storage.save(p)
        return p


@router.delete('/trash/{project_id}', status_code=204)
def purge_project(project_id: str):
    with storage.LOCK:
        records = storage.trash_records()
        if project_id not in records:
            raise HTTPException(404, '回收站中没有这首歌曲')
        directory = storage.project_dir(project_id)
        # Resolve and verify the exact managed target before recursive removal.
        if directory.is_symlink() or (directory.exists() and getattr(directory, 'is_junction', lambda: False)()):
            raise HTTPException(400, '不能删除链接目录')
        resolved = directory.resolve()
        if resolved.parent != storage.DATA_ROOT.resolve() or resolved.name != project_id:
            raise HTTPException(400, '删除路径超出项目范围')
        try:
            if directory.exists():
                shutil.rmtree(directory)
        except OSError as exc:
            raise HTTPException(409, '文件仍被占用，回收站记录已保留，请稍后重试') from exc
        playlists = read_playlists()
        for item in playlists:
            item.projectIds = [pid for pid in item.projectIds if pid != project_id]
        write_playlists(playlists)
        from .folders import read_folders, write_folders
        folders = read_folders()
        folders['assignments'].pop(project_id, None)
        write_folders(folders)
        del records[project_id]
        storage.write_json(storage.DATA_ROOT / 'trash.json', records)


def run_feature(project_id: str, kind: str):
    from .main import checked_audio_path, isolated_stem_path
    field = TASK_FIELDS[kind]
    try:
        current = storage.load(project_id)
        directory = storage.project_dir(project_id)
        original = checked_audio_path(directory / 'original.wav', directory, '原曲')
        if current.audioSource == 'uploaded_bass':
            raise ValueError('导入的是独立贝斯，缺少完整歌曲；请导入原曲后再使用此功能')
        if kind == 'key':
            if current.keyAnalysis is None:
                current.keyAnalysis = KeyAnalysis(state='running')
                storage.save(current)
            progress(project_id, field, '正在分析原曲调性', 30)
            result = audio.analyze_key(original)
            with storage.LOCK:
                latest = storage.load(project_id)
                apply_key(latest, result)
                latest.revision += 1
                storage.save(latest)
        elif kind == 'chords':
            progress(project_id, field, '正在按当前节拍网格识别和弦', 30)
            try:
                other = isolated_stem_path(current, 'other', '其他伴奏')
                if not audio.valid_stem_audio(other, current.duration):
                    other = None
            except ValueError:
                other = None
            result = audio.analyze_harmony(current, original, other)
            with storage.LOCK:
                latest = storage.load(project_id)
                if any(getattr(latest, f) != getattr(current, f) for f in storage.GRID_FIELDS + ('meter',)):
                    raise ValueError('分析期间节拍网格已修改，请按新网格重新识别')
                latest = storage.merge_candidates(latest, {'chords': result, '_harmonyOnCurrentGrid': True})
                latest.harmonyAnalysis = Analysis(state='complete', progress=100, stage='和弦候选已完成，可切换查看',
                                                  warnings=['使用原曲及可用伴奏估计和弦；转位和复杂和弦请试听校正。'])
                latest.revision += 1
                storage.save(latest)
        else:
            paths = {}
            try:
                for name in ('drums', 'vocals', 'other'):
                    path = isolated_stem_path(current, name, name)
                    if not audio.valid_stem_audio(path, current.duration):
                        raise ValueError('分轨无效')
                    paths[name] = path
            except ValueError:
                progress(project_id, field, '正在分离鼓、人声和其他伴奏', 10)
                separated = adapters.DEFAULT.separator.separate(original, directory)
                with storage.LOCK:
                    latest = storage.load(project_id)
                    latest.stems = [s for s in latest.stems if s.id not in set(separated) | {'backing'}]
                    for name, path in separated.items():
                        path = checked_audio_path(path, directory, name)
                        if not audio.valid_stem_audio(path, current.duration):
                            raise ValueError('分离音轨无效，请重新分离')
                        relative = path.relative_to(directory.resolve()).as_posix()
                        latest.stems.append(Stem(id=name, name={'bass':'贝斯','drums':'鼓','vocals':'人声','other':'伴奏'}[name],
                                                 available=True, url=f'/media/{project_id}/{relative}'))
                    latest.revision += 1
                    storage.save(latest)
                paths = {name: Path(separated[name]) for name in ('drums', 'vocals', 'other')}
            target = directory / 'backing.wav'
            progress(project_id, field, '正在合成无贝斯伴奏', 75)
            audio.mix_backing(list(paths.values()), original, target)
            with storage.LOCK:
                latest = storage.load(project_id)
                latest.stems = [s for s in latest.stems if s.id != 'backing'] + [Stem(
                    id='backing', name='无贝斯伴奏', available=True, url=f'/media/{project_id}/backing.wav?v={latest.revision + 1}')]
                latest.backingAnalysis = Analysis(state='complete', progress=100, stage='无贝斯伴奏已生成',
                                                   warnings=['分离可能残留少量贝斯串音。'])
                latest.revision += 1
                storage.save(latest)
    except FileNotFoundError:
        return  # A deleted project must never be resurrected by a late task.
    except Exception as exc:
        logging.exception('Independent analysis failed')
        with storage.LOCK:
            if storage.is_trashed(project_id):
                return
            latest = storage.load(project_id)
            task = getattr(latest, field)
            task.state, task.stage, task.progress = 'error', str(exc)[-600:], 100
            latest.revision += 1
            storage.save(latest)


@router.post('/projects/{project_id}/features/{kind}')
def start_feature(project_id: str, kind: str):
    from .main import EXECUTOR, get_project, isolated_stem_path
    if kind not in TASK_FIELDS:
        raise HTTPException(404, '未知的分析功能')
    with storage.LOCK:
        p = get_project(project_id)
        assert_idle(p)
        if p.audioSource == 'uploaded_bass':
            raise HTTPException(422, '这是独立贝斯文件，请先导入完整原曲')
        if kind == 'backing' and any(s.id == 'backing' and s.available for s in p.stems):
            try:
                if audio.valid_stem_audio(isolated_stem_path(p, 'backing', '无贝斯伴奏'), p.duration):
                    return p
            except ValueError:
                pass
        field = TASK_FIELDS[kind]
        if kind == 'key':
            task = p.keyAnalysis.model_copy(deep=True) if p.keyAnalysis else KeyAnalysis()
            task.state, task.stage, task.progress = 'running', '原曲调性识别已排队', 5
        else:
            task = Analysis(state='running', stage='和弦识别已排队' if kind == 'chords' else '无贝斯伴奏生成已排队', progress=5)
        setattr(p, field, task)
        p.revision += 1
        storage.save(p)
        EXECUTOR.submit(run_feature, project_id, kind)
        return p
