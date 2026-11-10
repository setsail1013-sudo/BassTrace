import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from backend import adapters, audio, storage
from backend.main import app, run_analysis
from backend.models import AnalyzeRequest, Chord, KeyAnalysis, Lyric, LyricAnchor, Project, Stem
from backend.project_features import run_feature


class LibraryAnalysisUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patch = patch.object(storage, 'DATA_ROOT', self.root)
        self.patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.patch.stop()
        self.tmp.cleanup()

    def fixture(self):
        pid = 'e041bf4f-b41f-4862-8406-fb444130a741'
        directory = storage.project_dir(pid)
        directory.mkdir()
        rate = 11025
        t = np.arange(rate * 2) / rate
        signal = np.concatenate([sum(.06 * np.sin(2 * np.pi * 440 * 2 ** ((m - 69) / 12) * t)
                                    for m in chord)
                                 for chord in ([50, 54, 57], [55, 59, 62], [57, 61, 64], [50, 54, 57])])
        sf.write(directory / 'original.wav', signal, rate)
        sf.write(directory / 'bass.wav', .1 * np.sin(2 * np.pi * 73.416 * np.arange(len(signal)) / rate), rate)
        p = Project(id=pid, title='D major test', duration=8, stems=[
            Stem(id=name, name=name, available=True, url=f'/media/{pid}/{name}.wav')
            for name in ('original', 'bass')])
        storage.save(p)
        return p, directory

    def test_complete_full_song_analysis_does_not_retain_default_c(self):
        p, _ = self.fixture()
        with patch.object(adapters.DEFAULT.bass_analyzer, 'analyze', return_value={'bassEvents': [], 'warnings': []}):
            run_analysis(p.id, AnalyzeRequest(source='original'))
        result = storage.load(p.id)
        self.assertEqual(result.analysis.state, 'complete')
        self.assertEqual(result.originalKey, 'D')
        self.assertEqual(result.key, 'D')

    def test_trash_blocks_stale_save_media_and_analysis_then_restores_membership(self):
        p, _ = self.fixture()
        playlist = self.client.post('/api/playlists', json={'name': 'Live', 'projectIds': [p.id]}).json()
        self.assertEqual(self.client.delete(f'/api/projects/{p.id}').status_code, 204)
        self.assertEqual(self.client.get('/api/projects').json(), [])
        self.assertEqual(self.client.put(f'/api/projects/{p.id}', json=p.model_dump()).status_code, 404)
        self.assertEqual(self.client.get(f'/media/{p.id}/original.wav').status_code, 404)
        self.assertEqual(self.client.post(f'/api/projects/{p.id}/analyze', json={}).status_code, 404)
        self.assertEqual(self.client.get('/api/playlists').json()[0]['projectIds'], [])
        self.assertEqual(len(self.client.get('/api/trash').json()), 1)
        self.assertEqual(self.client.post(f'/api/trash/{p.id}/restore').status_code, 200)
        self.assertEqual(self.client.get('/api/playlists').json()[0]['projectIds'], [p.id])
        self.assertEqual(self.client.get(f'/api/projects/{p.id}').status_code, 200)
        self.assertEqual(self.client.get('/api/playlists').json()[0]['id'], playlist['id'])

    def test_purge_only_removes_managed_project(self):
        p, directory = self.fixture()
        outside = self.root / 'my-original.mp3'
        outside.write_bytes(b'keep')
        self.client.delete(f'/api/projects/{p.id}')
        self.assertEqual(self.client.delete(f'/api/trash/{p.id}').status_code, 204)
        self.assertFalse(directory.exists())
        self.assertEqual(outside.read_bytes(), b'keep')

    def test_active_task_cannot_be_deleted(self):
        p, _ = self.fixture()
        p.analysis.state = 'running'
        storage.save(p)
        self.assertEqual(self.client.delete(f'/api/projects/{p.id}').status_code, 409)

    def test_backing_has_all_nonbass_tracks_and_preserves_frames(self):
        _, directory = self.fixture()
        rate = 22050
        count = rate * 8
        stems = []
        for name, value in [('drums', .6), ('vocals', .4), ('other', .3)]:
            path = directory / (name + '.wav')
            sf.write(path, np.full((count, 2), value, dtype=np.float32), rate, subtype='FLOAT')
            stems.append(path)
        target = directory / 'backing.wav'
        audio.mix_backing(stems, directory / 'original.wav', target)
        samples, output_rate = sf.read(target, always_2d=True)
        original = sf.info(directory / 'original.wav')
        self.assertEqual(output_rate, original.samplerate)
        self.assertEqual(samples.shape, (original.frames, original.channels))
        self.assertGreater(float(samples.mean()), .8)
        self.assertLessEqual(float(np.max(np.abs(samples))), .9)

    def test_key_silence_has_no_candidate(self):
        _, directory = self.fixture()
        sf.write(directory / 'silent.wav', np.zeros(11025 * 8), 11025)
        result = audio.analyze_key(directory / 'silent.wav')
        self.assertIsNone(result.detectedKey)

    def test_optional_harmony_uses_corrected_grid_and_preserves_manual_events(self):
        p, _ = self.fixture()
        p.bpm = 90
        p.meter = '6/8'
        p.beatTimes = [i * .3 + (i % 2) * .02 for i in range(28)]
        p.chords = [Chord(id='manual', bar=1, beat=1, label='D/F#', source='manual', locked=True)]
        storage.save(p)
        grid = (p.bpm, p.meter, p.beatTimes.copy())
        storage.write_json(storage.project_dir(p.id) / 'edits.json', {'bpm': True})
        run_feature(p.id, 'chords')
        result = storage.load(p.id)
        self.assertEqual(result.harmonyAnalysis.state, 'complete')
        self.assertEqual((result.bpm, result.meter, result.beatTimes), grid)
        self.assertTrue(any(c.id == 'manual' and c.label == 'D/F#' for c in result.chords))
        self.assertTrue(any(c.source == 'analysis' for c in result.chords))
        self.assertEqual(result.topTrack, p.topTrack)

    def test_key_candidates_protect_manual_key_and_old_client_preserves_new_fields(self):
        p, _ = self.fixture()
        p.key = p.originalKey = 'Am'
        p.keyAnalysis = KeyAnalysis(confirmed=True)
        p.lyrics = [Lyric(id='l', text='中文歌词', start=0, end=4)]
        p.chords = [Chord(id='c', bar=1, beat=1, label='Am')]
        p.lyricAnchors = [LyricAnchor(id='a', lyricId='l', startOffset=0, endOffset=2, text='中文', eventId='c', track='chords')]
        storage.save(p)
        run_feature(p.id, 'key')
        result = storage.load(p.id)
        self.assertEqual(result.key, 'Am')
        self.assertEqual(result.keyAnalysis.detectedKey, 'D')
        data = result.model_dump()
        for field in ('keyAnalysis', 'harmonyAnalysis', 'backingAnalysis', 'lyricAnchors', 'audioSource'):
            data.pop(field)
        response = self.client.put(f'/api/projects/{p.id}', json=data)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['lyricAnchors'][0]['text'], '中文')
        self.assertEqual(response.json()['keyAnalysis']['detectedKey'], 'D')

    def test_each_independent_task_blocks_deletion_and_other_tasks(self):
        p, _ = self.fixture()
        for field in ('harmonyAnalysis', 'backingAnalysis'):
            task = getattr(p, field)
            task.state = 'running'
            storage.save(p)
            self.assertEqual(self.client.delete(f'/api/projects/{p.id}').status_code, 409)
            self.assertEqual(self.client.post(f'/api/projects/{p.id}/features/key').status_code, 409)
            task.state = 'idle'
        p.audioSource = 'uploaded_bass'
        storage.save(p)
        self.assertEqual(self.client.post(f'/api/projects/{p.id}/features/backing').status_code, 422)

    def test_known_major_and_minor_transpositions(self):
        _, directory = self.fixture()
        rate = 11025
        t = np.arange(rate) / rate
        for root, suffix, third in [(0, '', 4), (2, '', 4), (5, '', 4), (9, 'm', 3), (2, 'm', 3)]:
            samples = np.concatenate([sum(.04 * np.sin(2 * np.pi * 440 * 2 ** ((48 + root + step - 69) / 12) * t)
                                          for step in chord) for chord in
                                      ([0, third, 7], [5, 9 if not suffix else 8, 12], [7, 11 if not suffix else 10, 14], [0, third, 7])])
            path = directory / 'known.wav'
            sf.write(path, samples, rate)
            result = audio.analyze_key(path)
            self.assertEqual(result.candidates[0].key, audio.PITCH_CLASSES[root] + suffix)

    def test_backing_reuses_valid_stems_and_cached_file(self):
        p, directory = self.fixture()
        for name in ('drums', 'vocals', 'other'):
            sf.write(directory / (name + '.wav'), np.full((11025 * 8, 2), .04), 11025)
            p.stems.append(Stem(id=name, name=name, available=True, url=f'/media/{p.id}/{name}.wav'))
        storage.save(p)
        with patch.object(adapters.DEFAULT.separator, 'separate', side_effect=AssertionError('must reuse stems')):
            run_feature(p.id, 'backing')
        ready = storage.load(p.id)
        self.assertEqual(ready.backingAnalysis.state, 'complete')
        self.assertTrue(any(s.id == 'backing' and s.available for s in ready.stems))
        with patch('backend.main.EXECUTOR.submit') as submit:
            response = self.client.post(f'/api/projects/{p.id}/features/backing')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['revision'], ready.revision)
        submit.assert_not_called()

    def test_manual_word_link_protects_its_event_across_reanalysis(self):
        p, _ = self.fixture()
        p.lyrics = [Lyric(id='l', text='中文歌词', start=0, end=4)]
        p.chords = [Chord(id='linked-chord', bar=1, beat=1, label='D', source='analysis')]
        p.lyricAnchors = [LyricAnchor(id='a', lyricId='l', startOffset=0, endOffset=2, text='中文', eventId='linked-chord', track='chords')]
        storage.save(p)
        run_feature(p.id, 'chords')
        ready = storage.load(p.id)
        self.assertTrue(any(c.id == 'linked-chord' for c in ready.chords))
        self.assertEqual(ready.lyricAnchors[0].eventId, 'linked-chord')


if __name__ == '__main__':
    unittest.main()
