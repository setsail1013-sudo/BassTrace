import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GuitarChord, Project } from './music.ts';
import { exportThreeTrackHtml } from './three-track-export.ts';
import { mergeLyricPrevious, splitLyric } from './tracks.ts';
import { transposeProject } from './music.ts';
import { GuitarChordMarkButton } from './GuitarChordMark.tsx';
import {
  GUITAR_CHORD_IMPORT_NOTE,
  GuitarChordRequestError,
  guitarChordFailureDetail,
  guitarChordMarkStyle,
  guitarChordStatusLabel,
  guitarChordsOnLyric,
  importGuitarChordPdf,
  isProtectedGuitarChord,
  lyricCharacterAt,
  normalizeGuitarChords,
  patchGuitarChord,
  projectFromGuitarChordImport,
  readGuitarChords,
  type GuitarChordImportResult,
} from './guitar-chords.ts';

/** Synthetic lyric. Not taken from a published chord chart. */
const LYRIC = '合成灯火靠近窗';

const chord = (partial: Partial<GuitarChord> & Pick<GuitarChord, 'id' | 'symbol' | 'status'>): GuitarChord => ({
  section: null,
  lyricId: null,
  charOffset: null,
  start: null,
  end: null,
  bar: null,
  beat: null,
  source: partial.status === 'manual' ? 'manual' : 'pdf',
  ...partial,
});

function project(): Project {
  return {
    id: 'synthetic',
    title: '合成曲',
    artist: '测试',
    duration: 16,
    originalKey: 'C Major',
    key: 'C Major',
    bpm: 120,
    meter: '4/4',
    offset: 0,
    beatTimes: [],
    sections: [],
    chords: [{ id: 'harmony', label: 'Cmaj7', bar: 1, beat: 1, source: 'manual', confidence: 1, locked: true }],
    bassEvents: [{ id: 'bass', start: 1, end: 2, pitchClass: 7, source: 'manual', confidence: 1, locked: true }],
    manualFills: [{ id: 'fill', notes: [{ id: 'note', digit: 1, start: 1, end: 1.5, lines: 0, octave: 0 }] }],
    lyrics: [{ id: 'line', text: LYRIC, start: 1, end: 4, source: 'manual', locked: true, order: 0 }],
    notes: [],
    markers: [],
    stems: [],
    analysis: { state: 'idle', stage: '', progress: 0, warnings: [] },
    updatedAt: '',
    revision: 3,
    isDemo: false,
    guitarChords: [
      chord({ id: 'keep', symbol: 'Bm', status: 'confirmed', source: 'pdf', lyricId: 'line', charOffset: 2, start: 1.4, end: 2, section: '合成段' }),
      chord({ id: 'hand', symbol: 'E7', status: 'manual', source: 'manual', lyricId: 'line', charOffset: 3, start: 1.8, end: 2.4 }),
      chord({ id: 'drop', symbol: 'G', status: 'candidate', source: 'pdf', lyricId: 'line', charOffset: 0, start: 1, end: 1.4 }),
    ],
  };
}

test('a project saved before the guitar-chord field still opens', () => {
  const legacy = project();
  delete legacy.guitarChords;
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'guitarChords'), false);
  assert.deepEqual(readGuitarChords(legacy), []);
  assert.deepEqual(guitarChordsOnLyric(legacy, legacy.lyrics[0]), []);
  const opened = normalizeGuitarChords(legacy);
  assert.deepEqual(opened.guitarChords, []);
  assert.equal(opened.lyrics, legacy.lyrics);
  assert.equal(opened.bassEvents, legacy.bassEvents);
  assert.equal(opened.manualFills, legacy.manualFills);
  assert.equal(opened.chords, legacy.chords);
  const messy = project();
  messy.guitarChords = [
    chord({ id: 'ok', symbol: 'E7', status: 'candidate', lyricId: 'line', charOffset: 3 }),
    { id: 'bad', symbol: '', status: 'candidate', source: 'pdf' } as GuitarChord,
  ];
  assert.deepEqual(readGuitarChords(messy).map(item => item.symbol), ['E7']);
  assert.equal(readGuitarChords(messy)[0].symbol, 'E7');
  assert.equal(readGuitarChords({ guitarChords: [chord({ id: 'minor', symbol: 'Bm', status: 'candidate' })] })[0].symbol, 'Bm');
});

test('a guitar chord renders over its lyric character, not the start of the bar', () => {
  const current = project();
  current.guitarChords = [
    chord({ id: 'g', symbol: 'G', status: 'candidate', start: 0, lyricId: 'line', charOffset: 0 }),
    chord({ id: 'a', symbol: 'A', status: 'candidate', start: 0, lyricId: 'line', charOffset: 2 }),
    chord({ id: 'e', symbol: 'E7', status: 'confirmed', source: 'pdf', lyricId: 'line', charOffset: 3 }),
    chord({ id: 'loose', symbol: 'D', status: 'candidate', lyricId: null, charOffset: null, start: null }),
  ];
  const marks = guitarChordsOnLyric(current, current.lyrics[0]);
  const lamp = marks.find(mark => mark.symbol === 'A');
  assert.ok(lamp);
  assert.equal(lamp.token, '灯');
  assert.equal(lamp.charOffset, 2);
  assert.equal(lamp.leftRatio, 2 / LYRIC.length);
  assert.ok(lamp.leftRatio > 0);
  assert.equal(lamp.label, '待校对');
  assert.equal(guitarChordStatusLabel('candidate'), '待校对');
  assert.equal(marks.some(mark => mark.id === 'loose'), false);
  const style = guitarChordMarkStyle(0, 100, 40, lamp);
  assert.equal(style.left, `calc(0% + ${2 / LYRIC.length} * 100%)`);
  const html = renderToStaticMarkup(createElement(GuitarChordMarkButton, { mark: lamp, left: style.left, top: style.top, onEdit: () => undefined }));
  assert.match(html, /data-lyric-token="灯"/);
  assert.match(html, /data-char-offset="2"/);
  assert.match(html, /data-status="candidate"/);
  assert.match(html, /data-accepted="false"/);
  assert.match(html, /aria-label="A 待校对，尚未人工核对"/);
  assert.match(html, /title="A · 待校对，尚未人工核对"/);
  assert.equal(html.includes('<small'), false);
  assert.equal(html.includes('>待校对<'), false);
  assert.equal(html.includes('已确认'), false);
  assert.equal(html.includes('已手改'), false);
  assert.match(html, /class="guitar-chord-symbol">A</);
  const accepted = marks.find(mark => mark.symbol === 'E7');
  assert.ok(accepted);
  const acceptedHtml = renderToStaticMarkup(createElement(GuitarChordMarkButton, { mark: accepted, left: '0%', top: 0, onEdit: () => undefined }));
  assert.match(acceptedHtml, /aria-label="E7 已确认"/);
  assert.equal(acceptedHtml.includes('待校对'), false);
  assert.equal(acceptedHtml.includes('<small'), false);
  const emoji = '合😀灯';
  assert.equal(lyricCharacterAt(emoji, 2)?.token, '灯');
  assert.equal(lyricCharacterAt(emoji, 3), null);
  assert.equal(isProtectedGuitarChord(current.guitarChords[2]), true);
  assert.equal(isProtectedGuitarChord(lamp), false);
});

test('import uses the chord PDF route and keeps the saved project, including protected chords', async () => {
  const saved = project();
  saved.revision = 4;
  saved.guitarChords = [
    chord({ id: 'keep', symbol: 'Bm', status: 'confirmed', source: 'pdf', lyricId: 'line', charOffset: 2, start: 1.4, end: 2 }),
    chord({ id: 'hand', symbol: 'E7', status: 'manual', source: 'manual', lyricId: 'line', charOffset: 3, start: 1.8, end: 2.4 }),
    chord({ id: 'fresh', symbol: 'A', status: 'candidate', source: 'pdf', lyricId: 'line', charOffset: 6, start: 3, end: 4 }),
  ];
  const file = new File([Uint8Array.from([0x25, 0x50, 0x44, 0x46])], 'synthetic-chart.pdf', { type: 'application/pdf' });
  const result = await importGuitarChordPdf('song id', file, async (url, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'include');
    assert.equal(String(url), '/api/projects/song%20id/chords/import-pdf');
    const form = init?.body as FormData;
    assert.equal((form.get('file') as File).name, 'synthetic-chart.pdf');
    assert.equal(form.get('revision'), null);
    const body: GuitarChordImportResult = {
      note: GUITAR_CHORD_IMPORT_NOTE,
      warnings: ['已保留人工确认或手改的和弦，相同位置的新候选没有覆盖它们。'],
      added: [saved.guitarChords![2]],
      preservedIds: ['keep', 'hand'],
      untimedIds: [],
      project: saved,
    };
    return Response.json(body);
  });
  assert.equal(result.note, GUITAR_CHORD_IMPORT_NOTE);
  const next = projectFromGuitarChordImport(result);
  assert.deepEqual(next.lyrics, saved.lyrics);
  assert.deepEqual(next.bassEvents, saved.bassEvents);
  assert.deepEqual(next.manualFills, saved.manualFills);
  assert.deepEqual(next.chords, saved.chords);
  assert.equal(next.guitarChords?.find(item => item.id === 'keep')?.symbol, 'Bm');
  assert.equal(next.guitarChords?.find(item => item.id === 'keep')?.status, 'confirmed');
  assert.equal(next.guitarChords?.find(item => item.id === 'hand')?.symbol, 'E7');
  assert.equal(next.guitarChords?.find(item => item.id === 'hand')?.status, 'manual');
  assert.equal(next.guitarChords?.find(item => item.id === 'fresh')?.status, 'candidate');
  assert.equal(guitarChordStatusLabel('candidate'), '待校对');
  assert.equal(isProtectedGuitarChord(next.guitarChords![0]), true);
  assert.equal(isProtectedGuitarChord(next.guitarChords![1]), true);
  assert.equal(isProtectedGuitarChord(next.guitarChords![2]), false);
});

test('FastAPI detail is the failure reason, and a message field is not used instead', async () => {
  const detail = '这份和弦谱与当前工程不是同一首歌，未写入和弦。';
  assert.equal(guitarChordFailureDetail({ detail, message: 'English failure' }), detail);
  assert.equal(guitarChordFailureDetail({ message: 'English failure' }, '没有改动现有内容。'), '没有改动现有内容。');
  assert.match(guitarChordFailureDetail({ detail: '这份和弦谱的歌词无法与当前工程歌词对齐，未写入和弦。' }), /无法与当前工程歌词对齐/);
  const file = new File([Uint8Array.from([0x25, 0x50, 0x44, 0x46])], 'synthetic-chart.pdf', { type: 'application/pdf' });
  await assert.rejects(
    importGuitarChordPdf('synthetic', file, async () => new Response(JSON.stringify({ detail }), { status: 422 })),
    (error: unknown) => error instanceof GuitarChordRequestError && error.detail === detail && error.status === 422,
  );
  await assert.rejects(
    importGuitarChordPdf('synthetic', new File([], 'empty.pdf', { type: 'application/pdf' }), async () => { throw new Error('should not upload'); }),
    (error: unknown) => error instanceof GuitarChordRequestError && error.detail === '和弦谱文件为空。',
  );
  await assert.rejects(
    importGuitarChordPdf('synthetic', file, async () => { throw new TypeError('offline'); }),
    (error: unknown) => error instanceof GuitarChordRequestError && error.detail.includes('暂时无法连接本地服务'),
  );
});

test('confirm and edit call PATCH with the project revision', async () => {
  const saved = project();
  saved.revision = 8;
  const confirmed = chord({ id: 'drop', symbol: 'G', status: 'confirmed', source: 'pdf', lyricId: 'line', charOffset: 0, start: 1, end: 1.4 });
  saved.guitarChords = saved.guitarChords?.map(item => item.id === 'drop' ? confirmed : item);
  const confirm = await patchGuitarChord('synthetic', 'drop', { status: 'confirmed', revision: 3 }, async (url, init) => {
    assert.equal(String(url), '/api/projects/synthetic/guitar-chords/drop');
    assert.equal(init?.method, 'PATCH');
    assert.equal(init?.credentials, 'include');
    assert.deepEqual(JSON.parse(String(init?.body)), { status: 'confirmed', revision: 3 });
    return Response.json({ chord: confirmed, project: saved });
  });
  assert.equal(confirm.chord.status, 'confirmed');
  assert.equal(confirm.chord.source, 'pdf');
  assert.equal(confirm.project.revision, 8);
  assert.deepEqual(confirm.project.bassEvents, saved.bassEvents);
  assert.deepEqual(confirm.project.lyrics, saved.lyrics);
  assert.deepEqual(confirm.project.manualFills, saved.manualFills);
  const edited = chord({ id: 'drop', symbol: 'F#m', status: 'manual', source: 'manual', lyricId: 'line', charOffset: 4, start: 2, end: 2.6 });
  const changed = { ...saved, revision: 9, guitarChords: saved.guitarChords?.map(item => item.id === 'drop' ? edited : item) };
  const update = await patchGuitarChord('synthetic', 'drop', { symbol: 'F#m', lyricId: 'line', charOffset: 4, section: null, revision: 8 }, async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { symbol: 'F#m', lyricId: 'line', charOffset: 4, section: null, revision: 8 });
    return Response.json({ chord: edited, project: changed });
  });
  assert.equal(update.chord.symbol, 'F#m');
  assert.equal(update.chord.status, 'manual');
  assert.deepEqual(update.project.lyrics, changed.lyrics);
  assert.deepEqual(update.project.bassEvents, changed.bassEvents);
  await assert.rejects(
    patchGuitarChord('synthetic', 'missing', { status: 'confirmed', revision: 1 }, async () => new Response(JSON.stringify({ detail: '找不到要修改的吉他和弦。' }), { status: 404 })),
    (error: unknown) => error instanceof GuitarChordRequestError && error.detail === '找不到要修改的吉他和弦。',
  );
  await assert.rejects(
    patchGuitarChord('synthetic', 'drop', { status: 'confirmed', revision: 1 }, async () => new Response(JSON.stringify({ detail: '工程已被更新，请重新加载后保存。' }), { status: 409 })),
    (error: unknown) => error instanceof GuitarChordRequestError && error.detail === '工程已被更新，请重新加载后保存。',
  );
});

test('lyric text changes release links the way the saved project does, without moving a chord onto another character', () => {
  const before = project();
  const split = splitLyric(before, 'line', 3, 'right');
  assert.equal(split.lyrics[0].text, '合成灯');
  assert.equal(split.lyrics[1].text, '火靠近窗');
  assert.equal(split.guitarChords?.find(item => item.id === 'keep')?.lyricId, null);
  assert.equal(split.guitarChords?.find(item => item.id === 'keep')?.symbol, 'Bm');
  const moved = split.guitarChords?.find(item => item.id === 'hand');
  assert.equal(moved?.lyricId, 'right');
  assert.equal(moved?.charOffset, 0);
  assert.equal(guitarChordsOnLyric(split, split.lyrics[1]).find(mark => mark.symbol === 'E7')?.token, '火');
  const merged = mergeLyricPrevious(split, 'right');
  assert.equal(merged.guitarChords?.every(item => item.lyricId === null), true);
  assert.deepEqual(merged.guitarChords?.map(item => item.symbol), ['Bm', 'E7', 'G']);
  assert.equal(split.bassEvents, before.bassEvents);
  assert.equal(split.manualFills, before.manualFills);
});

test('transpose keeps chord quality and export does not paint guitar chords into the rehearsal score', () => {
  const before = project();
  const shifted = transposeProject(before, 2);
  assert.equal(shifted.guitarChords?.find(item => item.id === 'keep')?.symbol, 'C#m');
  assert.equal(shifted.guitarChords?.find(item => item.id === 'hand')?.symbol, 'F#7');
  assert.equal(shifted.guitarChords?.find(item => item.id === 'keep')?.status, 'confirmed');
  assert.equal(shifted.bassEvents?.[0].pitchClass, 9);
  assert.equal(before.guitarChords?.[0].symbol, 'Bm');
  const html = exportThreeTrackHtml(before);
  assert.equal(html.includes('guitar-chord'), false);
  assert.equal(html.includes('待校对'), false);
  assert.equal(html.includes('>E7<'), false);
});
