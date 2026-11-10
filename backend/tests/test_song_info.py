import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend import storage
from backend.main import app
from backend.models import Project


class SongInfoTests(unittest.TestCase):
    def test_metadata_roundtrip_index_analysis_and_explicit_clear(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, 'DATA_ROOT', Path(directory)), TestClient(app) as client:
            project = Project(id='516978a1-4465-4d0e-8676-5b0b5bc0eb44', title='文件歌名', duration=10)
            storage.save(project)
            url = f'/api/projects/{project.id}'
            draft = project.model_dump()
            draft['artist'] = 'Adele / 王菲'
            response = client.put(url, json=draft)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(client.get(url).json()['artist'], draft['artist'])
            self.assertEqual(storage.list_projects()[0].artist, draft['artist'])
            merged = storage.merge_candidates(storage.load(project.id), {'bpm': 96, 'artist': '候选歌手', 'title': '候选曲名'})
            storage.save(merged)
            saved = client.get(url).json()
            self.assertEqual(saved['artist'], draft['artist'])
            self.assertEqual(saved['title'], project.title)
            saved['artist'] = ''
            cleared = client.put(url, json=saved)
            self.assertEqual(cleared.status_code, 200)
            self.assertEqual(client.get(url).json()['artist'], '')
