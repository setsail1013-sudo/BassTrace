import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend import storage
from backend.main import app
from backend.models import Project


class PlaylistTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=patch.object(storage,'DATA_ROOT',Path(self.temp.name));self.root.start()
        self.client=TestClient(app)
        self.song=Project(id='516978a1-4465-4d0e-8676-5b0b5bc0eb44',title='歌曲',duration=10)
        storage.save(self.song)

    def tearDown(self):
        self.client.close();self.root.stop();self.temp.cleanup()

    def test_create_rename_membership_and_delete_leave_songs_untouched(self):
        filename=storage.project_dir(self.song.id)/'project.json';before=filename.read_bytes()
        self.assertEqual(self.client.get('/api/playlists').json(),[])
        response=self.client.post('/api/playlists',json={'name':' 周末演出 ','projectIds':[self.song.id,self.song.id]})
        self.assertEqual(response.status_code,201);playlist=response.json()
        self.assertEqual(playlist['name'],'周末演出');self.assertEqual(playlist['projectIds'],[self.song.id])
        self.assertEqual(self.client.get('/api/playlists').json(),[playlist])
        url='/api/playlists/'+playlist['id']
        updated=self.client.put(url,json={'name':'排练','projectIds':[]}).json()
        self.assertEqual(updated['projectIds'],[])
        self.assertEqual(self.client.delete(url).status_code,204)
        self.assertEqual(self.client.get('/api/playlists').json(),[])
        self.assertEqual(filename.read_bytes(),before)

    def test_invalid_name_or_missing_song_does_not_write(self):
        self.assertEqual(self.client.post('/api/playlists',json={'name':'  '}).status_code,422)
        self.assertEqual(self.client.post('/api/playlists',json={'name':'演出','projectIds':['../../escape']}).status_code,422)
        self.assertEqual(self.client.post('/api/playlists',json={'name':'演出','projectIds':['11111111-1111-1111-1111-111111111111']}).status_code,404)
        self.assertEqual(self.client.put('/api/playlists/missing',json={'name':'x'}).status_code,404)
        self.assertEqual(self.client.delete('/api/playlists/missing').status_code,404)
        self.assertEqual(self.client.get('/api/playlists').json(),[])
