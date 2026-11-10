import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend import storage
from backend.main import app
from backend.models import Project


class PerformanceNotesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = patch.object(storage, 'DATA_ROOT', Path(self.temp.name))
        self.root.start()
        self.client = TestClient(app)
        self.project = Project(id='516978a1-4465-4d0e-8676-5b0b5bc0eb44', title='备注测试', duration=10)
        storage.save(self.project)
        self.url = f'/api/projects/{self.project.id}'

    def tearDown(self):
        self.client.close()
        self.root.stop()
        self.temp.cleanup()

    def test_notes_roundtrip_partial_legacy_save_and_explicit_clear(self):
        draft = self.project.model_dump()
        draft['performanceNotes'] = dict(effectsPreset='03', technique='指弹\n副歌加强', reminders='停两拍', includeInExport=True)
        saved = self.client.put(self.url, json=draft)
        self.assertEqual(saved.status_code, 200)
        expected = saved.json()['performanceNotes']
        self.assertEqual(self.client.get(self.url).json()['performanceNotes'], expected)
        legacy = saved.json(); del legacy['performanceNotes']
        saved = self.client.put(self.url, json=legacy).json()
        self.assertEqual(saved['performanceNotes'], expected)
        saved['performanceNotes'] = {'includeInExport': False}
        saved = self.client.put(self.url, json=saved).json()
        self.assertEqual(saved['performanceNotes']['reminders'], '停两拍')
        self.assertFalse(saved['performanceNotes']['includeInExport'])
        saved['performanceNotes'] = {'effectsPreset':'', 'technique':'', 'reminders':'', 'includeInExport':True}
        saved = self.client.put(self.url, json=saved).json()
        self.assertEqual(saved['performanceNotes']['reminders'], '')

    def test_pdf_receives_unsaved_notes_and_does_not_save_them(self):
        draft = self.project.model_dump()
        draft['performanceNotes']['reminders'] = '未保存的演出提醒'
        with patch('backend.main.render_pdf', return_value=b'%PDF-test') as render:
            response = self.client.post(self.url+'/export/pdf', json={'project':draft})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(render.call_args.args[0].project.performanceNotes.reminders, '未保存的演出提醒')
        self.assertEqual(self.client.get(self.url).json()['performanceNotes']['reminders'], '')
