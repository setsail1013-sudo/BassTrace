"""Local playlists reference projects; editing a playlist never edits a song."""
from uuid import uuid4
from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator
from .models import Model
from . import storage


class PlaylistInput(Model):
    name: str = Field(min_length=1, max_length=100)
    projectIds: list[str] = Field(default_factory=list, max_length=10000)

    @field_validator('name')
    @classmethod
    def clean_name(cls, value: str):
        if not value.strip():
            raise ValueError('歌单名称不能为空')
        return value.strip()

    @field_validator('projectIds')
    @classmethod
    def unique_ids(cls, values: list[str]):
        if any(not storage.ID_PATTERN.fullmatch(value) for value in values):
            raise ValueError('歌单中包含无效工程 ID')
        return list(dict.fromkeys(values))


class Playlist(PlaylistInput):
    id: str


router = APIRouter(prefix='/api/playlists')


def read_playlists() -> list[Playlist]:
    import json
    file = storage.DATA_ROOT / 'playlists.json'
    if not file.exists():
        return []
    return [Playlist.model_validate(p) for p in json.loads(file.read_text(encoding='utf-8'))['playlists']]


def write_playlists(items: list[Playlist]):
    storage.write_json(storage.DATA_ROOT / 'playlists.json', {'playlists': [p.model_dump() for p in items]})


def validate_songs(ids: list[str]):
    for project_id in ids:
        if storage.is_trashed(project_id) or not (storage.project_dir(project_id) / 'project.json').is_file():
            raise HTTPException(404, '歌曲不存在，请刷新曲库后重试')


@router.get('', response_model=list[Playlist])
def list_playlists():
    with storage.LOCK:
        return [item.model_copy(update={'projectIds': [pid for pid in item.projectIds if not storage.is_trashed(pid)]})
                for item in read_playlists()]


@router.post('', response_model=Playlist, status_code=201)
def create_playlist(data: PlaylistInput):
    with storage.LOCK:
        validate_songs(data.projectIds)
        items = read_playlists()
        playlist = Playlist(id=str(uuid4()), **data.model_dump())
        write_playlists([*items, playlist])
        return playlist


@router.put('/{playlist_id}', response_model=Playlist)
def update_playlist(playlist_id: str, data: PlaylistInput):
    with storage.LOCK:
        items = read_playlists()
        if not any(p.id == playlist_id for p in items):
            raise HTTPException(404, '歌单不存在')
        validate_songs(data.projectIds)
        playlist = Playlist(id=playlist_id, **data.model_dump())
        old = next(p for p in items if p.id == playlist_id)
        playlist.projectIds += [pid for pid in old.projectIds if storage.is_trashed(pid) and pid not in playlist.projectIds]
        write_playlists([playlist if p.id == playlist_id else p for p in items])
        return playlist


@router.delete('/{playlist_id}', status_code=204)
def delete_playlist(playlist_id: str):
    with storage.LOCK:
        items = read_playlists()
        if not any(p.id == playlist_id for p in items):
            raise HTTPException(404, '歌单不存在')
        write_playlists([p for p in items if p.id != playlist_id])
