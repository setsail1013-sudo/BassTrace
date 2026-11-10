import hashlib
import io
import json
import tempfile
import subprocess
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from backend import storage
from backend.main import app
from backend.models import Project, Stem, Lyric
from backend.folders import read_folders
from backend import library_transfer as transfer
from backend import audio

class LibraryTransferTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patch = patch.object(storage, 'DATA_ROOT', self.root)
        self.patch.start()
        self.queue = patch.object(transfer.IO_QUEUE, 'submit')
        self.submit = self.queue.start()
        self.client = TestClient(app)
        transfer.JOBS.clear(); storage.EXPORTING.clear()
        self.p = Project(id=str(uuid4()), title='测试歌曲', artist='歌手', duration=2,
                         lyrics=[Lyric(id='line', text='保留我的歌词', start=.3, end=1.8)])
        root = storage.project_dir(self.p.id); root.mkdir()
        sf.write(root/'original.wav', np.zeros((44100*2,2)), 44100)
        sf.write(root/'bass.wav', np.ones((44100*2,2))*.01, 44100)
        self.p.stems = [Stem(id='original', name='原曲', available=True, url=f'/media/{self.p.id}/original.wav'),
                        Stem(id='bass', name='贝斯', available=True, url=f'/media/{self.p.id}/bass.wav')]
        storage.save(self.p)
        storage.write_json(root/'edits.json', {'bpm':True,'deletedChords':['old'],'key':True})

    def tearDown(self):
        self.client.close(); self.queue.stop(); self.patch.stop()
        transfer.JOBS.clear(); storage.EXPORTING.clear(); self.tmp.cleanup()

    def folder(self, name='演出'):
        result = self.client.post('/api/folders',json={'name':name})
        self.assertEqual(result.status_code,201,result.text)
        return result.json()

    def export(self, body=None):
        result=self.client.post('/api/library/exports',json=body or {})
        self.assertEqual(result.status_code,202,result.text)
        args=self.submit.call_args.args
        args[0](*args[1:])
        job=transfer.JOBS[result.json()['id']]
        self.assertEqual(job['state'],'complete',job)
        return job, (transfer.job_dir(job['id'])/'library.basstrace.zip').read_bytes()

    def validate(self, contents):
        response=self.client.post('/api/library/imports',files={'file':('backup.zip',contents,'application/zip')})
        self.assertEqual(response.status_code,202,response.text)
        job=response.json(); transfer.validate_worker(job['id'])
        return transfer.JOBS[job['id']]

    def test_folders_moves_duplicates_delete_and_trash_restore(self):
        folder=self.folder(' 排练 ')
        self.assertEqual(folder['name'],'排练')
        self.assertEqual(self.client.post('/api/folders',json={'name':'排练'}).status_code,409)
        self.assertEqual(self.client.post('/api/folders',json={'name':'  '}).status_code,422)
        self.assertEqual(self.client.post('/api/folders/move',json={'folderId':folder['id'],'projectIds':[self.p.id]}).status_code,204)
        self.client.delete('/api/projects/'+self.p.id)
        self.assertEqual(self.client.get('/api/folders').json()['assignments'],{})
        self.assertEqual(read_folders()['assignments'][self.p.id],folder['id'])
        self.client.post('/api/trash/'+self.p.id+'/restore')
        self.assertEqual(self.client.get('/api/folders').json()['assignments'][self.p.id],folder['id'])
        self.client.delete('/api/folders/'+folder['id'])
        self.assertEqual(read_folders()['assignments'],{})
        self.assertEqual(self.client.get('/api/projects/'+self.p.id).status_code,200)

    def test_roundtrip_preserves_audio_edits_lyrics_and_classification_as_copies(self):
        folder=self.folder()
        self.client.post('/api/folders/move',json={'folderId':folder['id'],'projectIds':[self.p.id]})
        self.client.post('/api/playlists',json={'name':'演出歌单','projectIds':[self.p.id]})
        _,contents=self.export()
        with zipfile.ZipFile(io.BytesIO(contents)) as z:
            manifest=json.loads(z.read('manifest.json'))
            self.assertEqual(manifest['version'],1)
            self.assertNotIn('index.sqlite3',z.namelist())
        original=(storage.project_dir(self.p.id)/'project.json').read_bytes()
        for iteration in range(2):
            job=self.validate(contents)
            self.assertEqual(job['state'],'ready',job)
            self.assertEqual(job['preview']['songs'],1)
            r=self.client.post('/api/library/imports/'+job['id']+'/confirm')
            self.assertEqual(r.status_code,202,r.text)
            transfer.import_worker(job['id'])
            job=transfer.JOBS[job['id']]
            self.assertEqual(job['state'],'complete',job)
            pid=job['projectIds'][0]
            self.assertNotEqual(pid,self.p.id)
            imported=storage.load(pid)
            self.assertEqual(imported.lyrics,self.p.lyrics)
            self.assertEqual(imported.artist,self.p.artist)
            self.assertEqual(storage.edit_flags(pid),storage.edit_flags(self.p.id))
            self.assertIn(pid,imported.stems[0].url)
            self.assertEqual((storage.project_dir(pid)/'original.wav').read_bytes(),(storage.project_dir(self.p.id)/'original.wav').read_bytes())
            self.assertIn(pid,read_folders()['assignments'])
        self.assertEqual((storage.project_dir(self.p.id)/'project.json').read_bytes(),original)
        self.assertEqual(len(storage.list_projects()),3)
        self.assertEqual(len({f['name'] for f in read_folders()['folders']}),3)
        _,again=self.export()
        self.assertEqual(self.validate(again)['preview']['songs'],3)

    def test_export_reserves_files_and_releases_on_failure(self):
        response=self.client.post('/api/library/exports',json={})
        self.assertIn(self.p.id,storage.EXPORTING)
        self.assertEqual(self.client.delete('/api/projects/'+self.p.id).status_code,409)
        self.assertEqual(self.client.post('/api/projects/'+self.p.id+'/features/key').status_code,409)
        args=self.submit.call_args.args
        with patch.object(zipfile,'ZipFile',side_effect=OSError('disk failure')):
            args[0](*args[1:])
        self.assertNotIn(self.p.id,storage.EXPORTING)
        self.assertEqual(transfer.JOBS[response.json()['id']]['state'],'error')

    def test_corrupt_checksum_and_path_traversal_rejected(self):
        _,contents=self.export()
        for path in ('../escape','projects/../escape','C:/outside','a\\b','CON.txt'):
            data=io.BytesIO()
            with zipfile.ZipFile(data,'w') as z:z.writestr(path,b'evil')
            self.assertEqual(self.validate(data.getvalue())['state'],'error')
        data=io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(contents)) as src,zipfile.ZipFile(data,'w') as dst:
            for info in src.infolist():dst.writestr(info.filename,b'bad' if info.filename.endswith('bass.wav') else src.read(info.filename))
        self.assertEqual(self.validate(data.getvalue())['state'],'error')
        self.assertEqual(len(storage.list_projects()),1)

    def test_symlink_and_case_collisions_rejected(self):
        for case in ('symlink','duplicate'):
            data=io.BytesIO()
            with zipfile.ZipFile(data,'w') as z:
                if case=='symlink':
                    info=zipfile.ZipInfo('link');info.create_system=3;info.external_attr=0o120777<<16;z.writestr(info,'../outside')
                else:z.writestr('A',b'a');z.writestr('a',b'a')
            self.assertEqual(self.validate(data.getvalue())['state'],'error')

    def test_low_disk_and_running_project_rejected(self):
        with patch.object(transfer.shutil,'disk_usage') as disk:
            disk.return_value.free=0
            self.assertEqual(self.client.post('/api/library/exports',json={}).status_code,422)
        p=storage.load(self.p.id);p.analysis.state='running';storage.save(p)
        self.assertEqual(self.client.post('/api/library/exports',json={}).status_code,409)

    def test_restore_failure_rolls_back_new_projects_and_metadata(self):
        self.folder();_,contents=self.export();job=self.validate(contents)
        before=read_folders()
        with patch.object(transfer,'write_playlists',side_effect=OSError('injected commit failure')):
            transfer.import_worker(job['id'])
        self.assertEqual(transfer.JOBS[job['id']]['state'],'error')
        self.assertEqual(len(storage.list_projects()),1)
        self.assertEqual(read_folders(),before)

    def test_restart_recovers_interrupted_restore(self):
        pid=str(uuid4());root=storage.project_dir(pid);root.mkdir();(root/'partial').write_text('partial')
        job=transfer.new_job('import');directory=transfer.job_dir(job['id'])
        storage.write_json(directory/'transaction.json',{'state':'committing','newIds':[pid],'foldersBefore':read_folders(),'playlistsBefore':[]})
        transfer.update(job['id'],state='running')
        transfer.recover_transfers()
        self.assertFalse(root.exists())
        self.assertEqual(transfer.JOBS[job['id']]['state'],'error')

    def test_trashed_song_excluded_and_empty_folder_preserved(self):
        f=self.folder();self.client.delete('/api/projects/'+self.p.id)
        _,contents=self.export()
        job=self.validate(contents)
        self.assertEqual(job['state'],'ready',job)
        self.assertEqual(job['preview']['songs'],0)
        self.assertEqual(job['preview']['folders'],[f['name']])

    def test_independent_bass_upload_keeps_provenance_without_analysis(self):
        wav=(storage.project_dir(self.p.id)/'original.wav').read_bytes()
        response=self.client.post('/api/projects/upload',files={'file':('test.wav',wav,'audio/wav')},data={'source':'uploaded_bass'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['audioSource'],'uploaded_bass')

    @unittest.skipUnless(audio.ffmpeg_path(), 'FFmpeg is needed for the format integration check')
    def test_four_supported_music_formats_decode_into_managed_audio(self):
        source=storage.project_dir(self.p.id)/'original.wav'
        for suffix in ('wav','mp3','flac','m4a'):
            with self.subTest(suffix=suffix):
                target=self.root/f'format-check.{suffix}'
                subprocess.run([audio.ffmpeg_path(),'-v','error','-i',str(source),'-y',str(target)],check=True,capture_output=True)
                response=self.client.post('/api/projects/upload',files={'file':(target.name,target.read_bytes())})
                self.assertEqual(response.status_code,200,response.text)
                imported=response.json()
                self.assertAlmostEqual(imported['duration'],2,delta=.1)
                self.assertTrue((storage.project_dir(imported['id'])/'original.wav').is_file())

    def test_empty_library_restore_retains_all_project_data_and_audio_hashes(self):
        values = self.p.model_dump()
        values.update(manualFills=[{'id':'fill','notes':[{'id':'one','digit':4,'start':.5,'end':.75,'lines':1,'octave':1,'notation':{'accent':True}}]}],
                      performanceNotes={'effectsPreset':'03 号','technique':'轻指弹','reminders':'尾奏看鼓手'},
                      scoreStyle={'lyricFontSize':28,'lyricPrintSize':22},
                      bassEvents=[{'id':'bass-a','start':0,'end':1,'pitchClass':9,'locked':True,'source':'manual','confidence':1}],topTrack='bass')
        original = Project.model_validate(values);storage.save(original)
        folder=self.folder();self.client.post('/api/folders/move',json={'projectIds':[original.id],'folderId':folder['id']})
        _,contents=self.export()
        with tempfile.TemporaryDirectory() as empty,patch.object(storage,'DATA_ROOT',Path(empty)):
            job=self.validate(contents);self.assertEqual(job['state'],'ready',job)
            transfer.import_worker(job['id']);job=transfer.JOBS[job['id']]
            self.assertEqual(job['state'],'complete',job)
            new=storage.load(job['projectIds'][0])
            for field in ('lyrics','manualFills','performanceNotes','scoreStyle','bassEvents','bpm','beatTimes'):
                self.assertEqual(getattr(new,field),getattr(original,field))
            _,second=self.export()
            with zipfile.ZipFile(io.BytesIO(contents)) as a,zipfile.ZipFile(io.BytesIO(second)) as b:
                self.assertEqual(a.read(f'projects/{original.id}/original.wav'),b.read(f'projects/{new.id}/original.wav'))
                self.assertEqual(a.read(f'projects/{original.id}/edits.json'),b.read(f'projects/{new.id}/edits.json'))

    def test_archive_limits_and_terminal_cleanup(self):
        _,contents=self.export()
        with patch.object(transfer,'MAX_ARCHIVE',10):
            self.assertEqual(self.client.post('/api/library/imports',files={'file':('large.zip',contents)}).status_code,422)
        with patch.object(transfer,'MAX_EXPANDED',10):
            self.assertEqual(self.validate(contents)['state'],'error')
        with patch.object(transfer,'MAX_FILES',1):
            self.assertEqual(self.validate(contents)['state'],'error')
        job=self.validate(contents);directory=transfer.job_dir(job['id'])
        self.assertEqual(self.client.delete('/api/library/jobs/'+job['id']).status_code,204)
        self.assertFalse(directory.exists());self.assertEqual(len(storage.list_projects()),1)

    def test_oversized_stream_is_rejected_before_creating_a_job(self):
        count=len(transfer.JOBS)
        response=self.client.post('/api/library/imports',content=b'',headers={'content-length':str(transfer.MAX_ARCHIVE+transfer.CHUNK+1),'content-type':'multipart/form-data; boundary=x'})
        self.assertEqual(response.status_code,413)
        self.assertEqual(len(transfer.JOBS),count)

    def test_deleted_folder_not_recreated_by_restoring_trashed_song(self):
        folder=self.folder();self.client.post('/api/folders/move',json={'folderId':folder['id'],'projectIds':[self.p.id]})
        self.client.delete('/api/projects/'+self.p.id);self.client.delete('/api/folders/'+folder['id'])
        self.client.post('/api/trash/'+self.p.id+'/restore')
        self.assertEqual(read_folders(),{'folders':[],'assignments':{}})

if __name__=='__main__':unittest.main()
