import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend import storage
from backend.main import app
from backend.models import Project
from backend.pdf_export import PdfUnavailable


class PdfExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = patch.object(storage, 'DATA_ROOT', Path(self.temp.name))
        self.root.start()
        self.client = TestClient(app)
        self.project = Project(id='516978a1-4465-4d0e-8676-5b0b5bc0eb44', title='原工程', duration=10)
        storage.save(self.project)
        self.url = f'/api/projects/{self.project.id}/export/pdf'

    def tearDown(self):
        self.client.close(); self.root.stop(); self.temp.cleanup()

    def test_exports_unsaved_snapshot_without_touching_disk(self):
        before = {str(p): p.read_bytes() for p in Path(self.temp.name).rglob('*') if p.is_file()}
        draft = self.project.model_dump(); draft['title'] = '未保存的大字谱'
        draft['scoreStyle'].update(printPreset='custom', lyricPrintSize=30, topPrintSize=36, printBarsPerRow=2)
        with patch('backend.main.render_pdf', return_value=b'%PDF-test') as render:
            response = self.client.post(self.url,json={'project':draft,'degree':True})
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.headers['content-type'],'application/pdf')
            self.assertEqual(render.call_args.args[0].project.title,draft['title'])
            self.assertTrue(render.call_args.args[0].degree)
        self.assertEqual(before,{str(p): p.read_bytes() for p in Path(self.temp.name).rglob('*') if p.is_file()})

    def test_invalid_id_duration_and_print_size_do_not_render(self):
        draft=self.project.model_dump()
        with patch('backend.main.render_pdf') as render:
            other={**draft,'id':'demo'}
            self.assertEqual(self.client.post(self.url,json={'project':other}).status_code,400)
            draft['duration']=100
            draft['manualFills']=[{'id':'g','notes':[{'id':'n','digit':1,'start':11,'end':12}]}]
            self.assertEqual(self.client.post(self.url,json={'project':draft}).status_code,422)
            draft=self.project.model_dump();draft['scoreStyle']['topPrintSize']=99
            self.assertEqual(self.client.post(self.url,json={'project':draft}).status_code,422)
            render.assert_not_called()

    def test_renderer_failure_can_be_retried(self):
        with patch('backend.main.render_pdf',side_effect=PdfUnavailable('Edge 不可用')):
            response=self.client.post(self.url,json={'project':self.project.model_dump()})
            self.assertEqual(response.status_code,503)
            self.assertIn('Edge',response.json()['detail'])

    def test_legacy_save_preserves_new_print_fields(self):
        self.project.scoreStyle.printPreset='custom';self.project.scoreStyle.topPrintSize=28
        self.project.scoreStyle.printBarsPerRow=2;storage.save(self.project)
        draft=self.project.model_dump()
        for key in ('printPreset','topPrintSize','fillPrintSize','printBarsPerRow'):draft['scoreStyle'].pop(key,None)
        saved=storage.save_user_edit(self.project,Project.model_validate(draft))
        self.assertEqual(saved.scoreStyle.topPrintSize,28)
        self.assertEqual(saved.scoreStyle.printBarsPerRow,2)
        self.assertEqual(saved.scoreStyle.printPreset,'custom')
