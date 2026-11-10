"""Song folders are library metadata, independent of project edits and playlists."""
from uuid import uuid4
from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator
from . import storage
from .models import Model

router = APIRouter(prefix='/api/folders')

class FolderName(Model):
    name: str = Field(min_length=1, max_length=100)

    @field_validator('name', mode='before')
    @classmethod
    def trim_name(cls, value):
        if not isinstance(value, str):
            return value
        if not value.strip():
            raise ValueError('文件夹名称不能为空')
        return value.strip()

class Folder(FolderName):
    id: str

class MoveSongs(Model):
    projectIds: list[str] = Field(min_length=1, max_length=10000)
    folderId: str | None = None

def read_folders():
    import json
    path = storage.DATA_ROOT / 'folders.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'folders': [], 'assignments': {}}

def write_folders(data):
    storage.write_json(storage.DATA_ROOT / 'folders.json', data)

def require_unique(data, name, except_id=None):
    if any(f['id'] != except_id and f['name'].casefold() == name.casefold() for f in data['folders']):
        raise HTTPException(409, '已经有同名文件夹')

@router.get('')
def list_folders():
    with storage.LOCK:
        data = read_folders()
        data['assignments'] = {pid: fid for pid, fid in data['assignments'].items() if not storage.is_trashed(pid)}
        return data

@router.post('', status_code=201)
def create_folder(value: FolderName):
    with storage.LOCK:
        data = read_folders()
        require_unique(data, value.name)
        folder = Folder(id=str(uuid4()), name=value.name).model_dump()
        data['folders'].append(folder)
        write_folders(data)
        return folder

@router.post('/move', status_code=204)
def move_songs(value: MoveSongs):
    from .playlists import validate_songs
    with storage.LOCK:
        data = read_folders()
        validate_songs(value.projectIds)
        if value.folderId and not any(f['id'] == value.folderId for f in data['folders']):
            raise HTTPException(404, '文件夹不存在')
        for pid in value.projectIds:
            if value.folderId:
                data['assignments'][pid] = value.folderId
            else:
                data['assignments'].pop(pid, None)
        write_folders(data)

@router.put('/{folder_id}')
def rename_folder(folder_id: str, value: FolderName):
    with storage.LOCK:
        data = read_folders()
        folder = next((f for f in data['folders'] if f['id'] == folder_id), None)
        if folder is None:
            raise HTTPException(404, '文件夹不存在')
        require_unique(data, value.name, folder_id)
        folder['name'] = value.name
        write_folders(data)
        return folder

@router.delete('/{folder_id}', status_code=204)
def delete_folder(folder_id: str):
    with storage.LOCK:
        data = read_folders()
        if not any(f['id'] == folder_id for f in data['folders']):
            raise HTTPException(404, '文件夹不存在')
        data['folders'] = [f for f in data['folders'] if f['id'] != folder_id]
        data['assignments'] = {p: f for p, f in data['assignments'].items() if f != folder_id}
        write_folders(data)
