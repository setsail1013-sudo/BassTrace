import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project } from './music.ts';
import { exportThreeTrackHtml } from './three-track-export.ts';
import { mergeLyricPrevious, splitLyric } from './tracks.ts';
import { transposeProject } from './music.ts';
import { GuitarChordMarkButton } from './GuitarChordMark.tsx';
import {
  GuitarChordImportError,
  confirmGuitarChord,
  deleteGuitarChord,
  guitarChordFailureMessage,
  guitarChordMarkStyle,
  guitarChordStatusLabel,
  guitarChordsOnLyric,
  importGuitarChordPdf,
  mergeGuitarChordImport,
  normalizeGuitarChordSymbol,
  projectFromServer,
  readGuitarChords,
  updateGuitarChord,
  type GuitarChordStore,
} from './guitar-chords.ts';

/** Synthetic chart text. Not taken from a published chord chart. */
const LYRIC = '合成灯火靠近窗';

function memoryStore(): GuitarChordStore & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return { dump, getItem: key => dump.get(key) ?? null, setItem: (key, value) => { dump.set(key, value); } };
}

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
      { id: 'keep', symbol: 'Bm', proof: 'confirmed', source: 'manual', alignment: { lyricId: 'line', charOffset: 2, token: '灯' }, importId: 'old', section: '合成段' },
      { id: 'drop', symbol: 'G', proof: 'pending', source: 'import', alignment: { lyricId: 'line', charOffset: 0, token: '合' }, importId: 'old' },
    ],
  };
}

test('a project saved before the guitar-chord field still opens', () => {
  const legacy = project();
  delete legacy.guitarChords;
  delete legacy.guitarChordImport;
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'guitarChords'), false);
  assert.deepEqual(readGuitarChords(legacy), []);
  assert.deepEqual(guitarChordsOnLyric(legacy, legacy.lyrics[0]), []);
  const opened = projectFromServer(null, legacy, memoryStore());
  assert.deepEqual(opened.guitarChords, []);
  assert.equal(opened.lyrics, legacy.lyrics);
  assert.equal(opened.bassEvents, legacy.bassEvents);
  assert.equal(opened.manualFills, legacy.manualFills);
  assert.equal(opened.chords, legacy.chords);
  const messy = project();
  messy.guitarChords = [{ id: 'ok', symbol: 'E7', proof: 'pending', source: 'import', alignment: { lyricId: 'line', charOffset: 3, token: '火' } }, { id: '', symbol: 'G', proof: 'pending', source: 'import' } as never, { id: 'bad', symbol: '!!', proof: 'pending', source: 'import' } as never];
  assert.deepEqual(readGuitarChords(messy).map(chord => chord.symbol), ['E7']);
});

test('a guitar chord renders over its lyric character, not the start of the bar', () => {
  const current = project();
  current.guitarChords = [
    { id: 'g', symbol: 'G', proof: 'pending', source: 'import', time: 0, alignment: { lyricId: 'line', charOffset: 0, token: '合' } },
    { id: 'a', symbol: 'A', proof: 'pending', source: 'import', time: 0, alignment: { lyricId: 'line', charOffset: 2, token: '灯' } },
    { id: 'e', symbol: 'E7', proof: 'confirmed', source: 'manual', alignment: { lyricId: 'line', charOffset: 3, token: '火' } },
    { id: 'stale', symbol: 'D', proof: 'pending', source: 'import', alignment: { lyricId: 'line', charOffset: 2, token: '火' } },
  ];
  const marks = guitarChordsOnLyric(current, current.lyrics[0]);
  const lamp = marks.find(mark => mark.symbol === 'A');
  assert.ok(lamp);
  assert.equal(lamp.token, '灯');
  assert.equal(lamp.charOffset, 2);
  assert.equal(lamp.lyricId, 'line');
  assert.equal(lamp.leftRatio, 2 / LYRIC.length);
  assert.ok(lamp.leftRatio > 0);
  assert.equal(lamp.label, '待校对');
  assert.equal(guitarChordStatusLabel(lamp.proof), '待校对');
  assert.equal(marks.some(mark => mark.id === 'stale'), false);
  const style = guitarChordMarkStyle(0, 100, 40, lamp);
  assert.equal(style.left, `calc(0% + ${2 / LYRIC.length} * 100%)`);
  assert.equal(style.left.includes(`${2 / LYRIC.length}`), true);
  const html = renderToStaticMarkup(createElement(GuitarChordMarkButton, { mark: lamp, left: style.left, top: style.top, onEdit: () => undefined }));
  assert.match(html, /data-lyric-token="灯"/);
  assert.match(html, /data-char-offset="2"/);
  assert.match(html, /data-lyric-id="line"/);
  assert.match(html, /data-proof="pending"/);
  assert.match(html, /data-accepted="false"/);
  assert.match(html, />待校对</);
  assert.equal(html.includes('已校对'), false);
  assert.equal(html.includes('准确'), false);
  assert.match(html, /class="guitar-chord-symbol">A</);
  const confirmed = marks.find(mark => mark.symbol === 'E7');
  assert.equal(confirmed?.label, '已校对');
  assert.equal(confirmed?.token, '火');
});

test('re-import replaces pending candidates and leaves confirmed chords and other tracks alone', () => {
  const before = project();
  const snapshot = JSON.stringify(before);
  const next = mergeGuitarChordImport(before, {
    importId: 'new-batch',
    filename: 'synthetic-chart.pdf',
    importedAt: '2026-11-16T00:00:00Z',
    status: 'pending',
    chords: [
      { symbol: 'E7', lyricId: 'line', charOffset: 2, token: '灯' },
      { symbol: 'A', lyricId: 'line', charOffset: 6, token: '窗' },
      { symbol: 'D', lyricId: 'line', charOffset: 0, token: '合' },
      { symbol: 'F#m', lyricId: 'missing', charOffset: 0 },
    ],
  }, () => 'candidate');
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(next.lyrics, before.lyrics);
  assert.equal(next.bassEvents, before.bassEvents);
  assert.equal(next.manualFills, before.manualFills);
  assert.equal(next.chords, before.chords);
  assert.equal(next.notes, before.notes);
  const kept = next.guitarChords?.find(chord => chord.id === 'keep');
  assert.equal(kept?.symbol, 'Bm');
  assert.equal(kept?.proof, 'confirmed');
  assert.equal(kept?.alignment?.token, '灯');
  assert.equal(next.guitarChords?.some(chord => chord.id === 'drop'), false);
  assert.equal(next.guitarChords?.some(chord => chord.symbol === 'E7'), false);
  const added = next.guitarChords?.find(chord => chord.symbol === 'A');
  assert.equal(added?.proof, 'pending');
  assert.equal(added?.source, 'import');
  assert.equal(added?.alignment?.charOffset, 6);
  assert.equal(guitarChordStatusLabel(added!.proof), '待校对');
  assert.equal(next.guitarChords?.find(chord => chord.symbol === 'D')?.alignment?.token, '合');
  assert.equal(next.guitarChords?.find(chord => chord.symbol === 'F#m')?.alignment, undefined);
  assert.equal(next.guitarChordImport?.status, 'pending');
  const cleared = mergeGuitarChordImport(next, { importId: 'empty', importedAt: '', status: 'pending', chords: [] }, () => 'none');
  assert.equal(cleared.guitarChords?.some(chord => chord.id === 'keep'), true);
  assert.equal(cleared.guitarChords?.some(chord => chord.proof === 'pending'), false);
  assert.equal(cleared.lyrics, before.lyrics);
});

test('confirming or editing a guitar chord does not rewrite proofed notes, fills, or lyrics', () => {
  const before = project();
  const confirmed = confirmGuitarChord(before, 'drop');
  assert.equal(confirmed.guitarChords?.find(chord => chord.id === 'drop')?.proof, 'confirmed');
  assert.equal(confirmed.guitarChords?.find(chord => chord.id === 'drop')?.source, 'manual');
  assert.equal(confirmed.lyrics, before.lyrics);
  assert.equal(confirmed.bassEvents, before.bassEvents);
  assert.equal(confirmed.manualFills, before.manualFills);
  assert.equal(confirmed.chords, before.chords);
  const edited = updateGuitarChord(before, 'drop', { symbol: 'e7', charOffset: 4 });
  assert.equal(edited.guitarChords?.find(chord => chord.id === 'drop')?.symbol, 'E7');
  assert.equal(edited.guitarChords?.find(chord => chord.id === 'drop')?.proof, 'confirmed');
  assert.equal(edited.guitarChords?.find(chord => chord.id === 'drop')?.alignment?.token, '靠');
  assert.equal(edited.bassEvents, before.bassEvents);
  assert.equal(edited.manualFills, before.manualFills);
  assert.equal(edited.lyrics, before.lyrics);
  assert.equal(edited.guitarChords?.find(chord => chord.id === 'keep')?.symbol, 'Bm');
  const removed = deleteGuitarChord(edited, 'drop');
  assert.equal(removed.guitarChords?.some(chord => chord.id === 'drop'), false);
  assert.equal(removed.manualFills, before.manualFills);
  assert.throws(() => updateGuitarChord(before, 'drop', { symbol: '不是和弦' }), RangeError);
  assert.equal(JSON.stringify(before.guitarChords), JSON.stringify(project().guitarChords));
});

test('failure messages stay in Chinese and do not produce an alignment', async () => {
  for (const [code, detail] of Object.entries({
    unreadable_pdf: '没有可提取的文字',
    lyrics_mismatch: '对不上',
    wrong_song: '不像当前这首歌',
    parse_error: '解析失败',
  })) {
    const message = guitarChordFailureMessage(422, { code });
    assert.match(message.detail, new RegExp(detail));
    assert.equal(message.detail.includes('准确'), false);
  }
  assert.equal(guitarChordFailureMessage(404, { detail: 'Not Found' }).detail.includes('尚未就绪'), true);
  assert.equal(guitarChordFailureMessage(422, { detail: '谱面歌词和当前工程的歌词对不上，已停止导入。', code: 'lyrics_mismatch' }).detail, '谱面歌词和当前工程的歌词对不上，已停止导入。');
  const file = new File([Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])], 'synthetic-chart.pdf', { type: 'application/pdf' });
  let calls = 0;
  await assert.rejects(
    importGuitarChordPdf('synthetic', file, 3, async () => { calls += 1; return new Response(JSON.stringify({ detail: '这份 PDF 是打印件，没有可提取的文字，无法读取和弦。', code: 'unreadable_pdf' }), { status: 422 }); }),
    (error: unknown) => error instanceof GuitarChordImportError && error.detail.includes('没有可提取的文字') && error.code === 'unreadable_pdf',
  );
  assert.equal(calls, 1);
  await assert.rejects(importGuitarChordPdf('synthetic', new File(['hello'], 'notes.txt', { type: 'text/plain' }), 3, async () => { throw new Error('should not upload'); }), GuitarChordImportError);
  await assert.rejects(importGuitarChordPdf('synthetic', file, 3, async () => { throw new TypeError('offline'); }), (error: unknown) => error instanceof GuitarChordImportError && error.detail.includes('暂时无法连接本地服务'));
});

test('import responses are candidates even when a payload claims they are confirmed', async () => {
  const file = new File([Uint8Array.from([0x25, 0x50, 0x44, 0x46])], 'synthetic-chart.pdf', { type: 'application/pdf' });
  const result = await importGuitarChordPdf('song id', file, 3, async (url, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'include');
    assert.equal(String(url), '/api/projects/song%20id/guitar-chords/import');
    const form = init?.body as FormData;
    assert.equal(form.get('revision'), '3');
    assert.equal((form.get('file') as File).name, 'synthetic-chart.pdf');
    return Response.json({ importId: 'batch', importedAt: '2026-11-16T00:00:00Z', status: 'confirmed', warning: '自动对齐不代表已经准确。', chords: [{ symbol: 'bm', lyricId: 'line', charOffset: 4, token: '靠' }] });
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.chords[0].symbol, 'Bm');
  const merged = mergeGuitarChordImport(project(), result, () => 'from-pdf');
  const candidate = merged.guitarChords?.find(chord => chord.id === 'from-pdf');
  assert.equal(candidate?.proof, 'pending');
  assert.equal(candidate?.symbol, 'Bm');
  assert.equal(candidate?.alignment?.token, '靠');
  assert.equal(guitarChordStatusLabel('pending'), '待校对');
  assert.equal(merged.guitarChords?.find(chord => chord.id === 'keep')?.symbol, 'Bm');
  assert.equal(merged.guitarChords?.find(chord => chord.id === 'keep')?.proof, 'confirmed');
});

test('server responses that omit the field keep confirmed chords, and an explicit list replaces the cache', () => {
  const store = memoryStore();
  const local = project();
  const server = project();
  delete server.guitarChords;
  delete server.guitarChordImport;
  const kept = projectFromServer(local, server, store);
  assert.equal(kept.guitarChords?.find(chord => chord.id === 'keep')?.symbol, 'Bm');
  assert.equal(kept.bassEvents, server.bassEvents);
  const reloaded = projectFromServer(null, server, store);
  assert.equal(reloaded.guitarChords?.find(chord => chord.id === 'keep')?.proof, 'confirmed');
  const cleared = projectFromServer(local, { ...server, guitarChords: [] }, store);
  assert.deepEqual(cleared.guitarChords, []);
  assert.deepEqual(projectFromServer(null, server, store).guitarChords, []);
});

test('lyric splits and merges keep a chord on the same character', () => {
  const before = project();
  before.guitarChords = [
    { id: 'lamp', symbol: 'A', proof: 'confirmed', source: 'manual', alignment: { lyricId: 'line', charOffset: 2, token: '灯' } },
    { id: 'window', symbol: 'E7', proof: 'pending', source: 'import', alignment: { lyricId: 'line', charOffset: 6, token: '窗' } },
  ];
  const split = splitLyric(before, 'line', 3, 'right');
  assert.equal(split.lyrics[0].text, '合成灯');
  assert.equal(split.lyrics[1].text, '火靠近窗');
  assert.equal(split.guitarChords?.find(chord => chord.id === 'lamp')?.alignment?.lyricId, 'line');
  assert.equal(split.guitarChords?.find(chord => chord.id === 'window')?.alignment?.lyricId, 'right');
  assert.equal(split.guitarChords?.find(chord => chord.id === 'window')?.alignment?.charOffset, 3);
  assert.equal(guitarChordsOnLyric(split, split.lyrics[1])[0]?.token, '窗');
  const merged = mergeLyricPrevious(split, 'right');
  assert.equal(merged.lyrics[0].text, LYRIC);
  assert.equal(guitarChordsOnLyric(merged, merged.lyrics[0]).find(mark => mark.symbol === 'E7')?.token, '窗');
  assert.equal(split.bassEvents, before.bassEvents);
});

test('transpose moves guitar symbols with the song and export does not paint them into the rehearsal score', () => {
  const before = project();
  const shifted = transposeProject(before, 2);
  assert.equal(shifted.guitarChords?.find(chord => chord.id === 'keep')?.symbol, 'C#m');
  assert.equal(shifted.guitarChords?.find(chord => chord.id === 'keep')?.proof, 'confirmed');
  assert.equal(shifted.bassEvents?.[0].pitchClass, 9);
  assert.equal(before.guitarChords?.[0].symbol, 'Bm');
  before.guitarChords?.push({ id: 'rare', symbol: 'E7', proof: 'pending', source: 'import', alignment: { lyricId: 'line', charOffset: 5, token: '近' } });
  const html = exportThreeTrackHtml(before);
  assert.equal(html.includes('guitar-chord'), false);
  assert.equal(html.includes('E7'), false);
  assert.equal(html.includes('待校对'), false);
  assert.equal(normalizeGuitarChordSymbol('bm7'), 'Bm7');
  assert.equal(normalizeGuitarChordSymbol('f#m'), 'F#m');
  assert.equal(normalizeGuitarChordSymbol('G/B'), 'G/B');
  assert.equal(normalizeGuitarChordSymbol('不是和弦'), null);
});
