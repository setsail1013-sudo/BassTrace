import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionToTime, type Lyric, type Project } from './music.ts';
import { addManualFill, deleteFillNote, mergeLyricPrevious, moveManualFill, orderedLyrics, packTxtLyrics, rowPercentTime, rowTimePercent, scoreRows, setFillLines, setFillOctave, splitLyric } from './tracks.ts';

const base = (): Project => ({ id: 'tracks', title: '三轨测试', artist: '', duration: 16, originalKey: 'C Major', key: 'C Major', bpm: 120, meter: '4/4', offset: 0, beatTimes: [], sections: [], chords: [{ id: 'chord', label: 'Cmaj7', bar: 1, beat: 1, source: 'manual', confidence: 1, locked: true }], lyrics: [], notes: [], markers: [], stems: [], analysis: { state: 'idle', stage: '', progress: 0, warnings: [] }, updatedAt: '', revision: 0, isDemo: false });
const lyric = (id: string, text: string, start: number, end: number, order?: number): Lyric => ({ id, text, start, end, order, source: 'analysis', locked: false });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const times = (p: Project, group = 0) => p.manualFills![group].notes.map(note => [note.start, note.end]);
const digits = ['one', 'two', 'three', 'four'];
const numbered = (p = base(), start = 0) => addManualFill(p, start, '1234', 'fill', digits);
const preserveOtherTracks = (before: Project, after: Project) => {
  assert.equal(after.chords, before.chords); assert.equal(after.notes, before.notes); assert.equal(after.markers, before.markers);
  assert.equal(after.beatTimes, before.beatTimes); assert.equal(after.sections, before.sections);
};

test('TXT retains original line text and packs adjacent widths from zero instead of distributing across song', () => {
  const p = base(), raw = '你好世界\r\n A B \n\n最后一句';
  let id = 0;
  const result = packTxtLyrics(p, raw, { rowWidth: 160, barsPerRow: 4, fontSize: 10, measureText: text => Array.from(text).length * 10 }, () => `line-${id++}`);
  assert.deepEqual(result.map(item => [item.text, item.start, item.end, item.order]), [['你好世界', 0, 2, 0], [' A B ', 2, 4.5, 1], ['最后一句', 4.5, 6.5, 2]]);
  assert.ok(result.every(item => item.source === 'manual' && item.locked));
  assert.equal(p.lyrics.length, 0); assert.equal(raw, '你好世界\r\n A B \n\n最后一句');
  const longer = packTxtLyrics({ ...p, duration: 1000 }, raw, { rowWidth: 160, barsPerRow: 4, fontSize: 10, measureText: text => Array.from(text).length * 10 });
  assert.deepEqual(longer.map(item => [item.start, item.end]), result.map(item => [item.start, item.end]));
});

test('TXT packing follows nonuniform beats and pickups, and fails atomically if text does not fit', () => {
  const p = { ...base(), offset: .2, beatTimes: [0, .4, 1, 1.7, 2.2] }, snapshot = JSON.stringify(p);
  const result = packTxtLyrics(p, '你\n好', { rowWidth: 80, barsPerRow: 2, fontSize: 10, measureText: () => 10 });
  close(result[0].start, 0); close(result[0].end, .425); close(result[1].start, .425); close(result[1].end, .975);
  close(rowTimePercent(p,1,2,result[0].end)/100*80,10);
  close(rowTimePercent(p,1,2,result[1].end)/100*80,20);
  assert.throws(() => packTxtLyrics({ ...p, duration: .3 }, '原文全部保留', { rowWidth: 10, barsPerRow: 4, fontSize: 20 }), RangeError);
  assert.equal(JSON.stringify(p), snapshot);
});

test('legacy lyric array order and explicit text order never become time order', () => {
  const p = base(); p.lyrics = [lyric('a', 'A', 4, 5), lyric('b', 'B', 1, 2)];
  assert.deepEqual(orderedLyrics(p).map(item => item.id), ['a', 'b']);
  p.lyrics = [lyric('b', 'B', 1, 2, 1), lyric('a', 'A', 4, 5, 0)];
  assert.deepEqual(orderedLyrics(p).map(item => item.id), ['a', 'b']);
});

test('split uses Unicode character proportions, stable order and exact original range', () => {
  const p = numbered(); p.lyrics = [lyric('first', 'A😀中文', 2, 6), lyric('last', ' later ', 7, 10)];
  const before = JSON.stringify(p), result = splitLyric(p, 'first', 3, 'second');
  assert.deepEqual(result.lyrics.map(item => [item.text, item.start, item.end, item.order]), [['A😀', 2, 4, 0], ['中文', 4, 6, 1], [' later ', 7, 10, 2]]);
  assert.ok(result.lyrics.slice(0, 2).every(item => item.source === 'manual' && item.locked));
  assert.equal(result.manualFills, p.manualFills); preserveOtherTracks(p, result); assert.equal(JSON.stringify(p), before);
  const insideSurrogate = splitLyric(p, 'first', 2, 'unicode');
  assert.equal(insideSurrogate.lyrics[0].text, 'A'); assert.equal(insideSurrogate.lyrics[1].text, '😀中文');
  assert.equal(splitLyric(p, 'first', 0, 'empty'), p);
  assert.equal(splitLyric(p, 'first', 5, 'empty'), p);
});

test('split and merge use live edited text and preserve all original spaces', () => {
  const p = base(); p.lyrics = [lyric('left', 'Hi ', 1, 3), lyric('right', ' there', 5, 8), lyric('tail', '尾句', 10, 12)];
  const merged = mergeLyricPrevious(p, 'right', ' world');
  assert.deepEqual(merged.lyrics.map(item => [item.text, item.start, item.end, item.order]), [['Hi  world', 1, 8, 0], ['尾句', 10, 12, 1]]);
  preserveOtherTracks(p, merged);
  const split = splitLyric(p, 'left', 3, 'new', 'Hi  world');
  assert.equal(split.lyrics.slice(0, 2).map(item => item.text).join(''), 'Hi  world');
  assert.equal(mergeLyricPrevious(split, 'new').lyrics[0].text, 'Hi  world');
  assert.equal(mergeLyricPrevious(p, 'left'), p);
});

test('continuous 1234 creates manual numbers with quarter durations and does not derive bass pitches', () => {
  const p = base(), snapshot = JSON.stringify(p), result = numbered(p, 1.75);
  assert.deepEqual(times(result), [[1.75, 2.25], [2.25, 2.75], [2.75, 3.25], [3.25, 3.75]]);
  assert.deepEqual(result.manualFills![0].notes.map(item => [item.digit, item.lines, item.octave]), [[1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]);
  assert.equal(result.lyrics, p.lyrics); preserveOtherTracks(p, result); assert.equal(JSON.stringify(p), snapshot);
  const rest = addManualFill(p, 0, '0', 'rest', ['r']); assert.equal(rest.manualFills![0].notes[0].digit, 0);
});

test('line changes reflow only selected group suffix and preserve other tracks and preceding notes', () => {
  const p = addManualFill(numbered(), 4, '56', 'other', ['five', 'six']), before = JSON.stringify(p);
  const shortened = setFillLines(p, 'fill', 'two', 1);
  assert.deepEqual(times(shortened), [[0, .5], [.5, .75], [.75, 1.25], [1.25, 1.75]]);
  assert.equal(shortened.manualFills![0].notes[0], p.manualFills![0].notes[0]);
  assert.equal(shortened.manualFills![1], p.manualFills![1]); assert.equal(shortened.lyrics, p.lyrics); preserveOtherTracks(p, shortened);
  const sixteenth = setFillLines(shortened, 'fill', 'two', 2);
  assert.deepEqual(times(sixteenth), [[0, .5], [.5, .625], [.625, 1.125], [1.125, 1.625]]);
  assert.equal(JSON.stringify(p), before);
});

test('6/8 uses two eighth-beat cells per quarter and subdivisions remain musical', () => {
  const p = numbered({ ...base(), meter: '6/8' });
  assert.deepEqual(times(p), [[0, .5], [.5, 1], [1, 1.5], [1.5, 2]]);
  close(positionToTime(p, 2, 1), 1.5);
  const next = setFillLines(p, 'fill', 'three', 2);
  assert.deepEqual(times(next), [[0, .5], [.5, 1], [1, 1.125], [1.125, 1.625]]);
});

test('fill subdivisions interpolate changing beat intervals instead of using global BPM', () => {
  const p = numbered({ ...base(), beatTimes: [0, .4, 1, 1.7, 2.2, 2.6, 3.3] });
  assert.deepEqual(times(p), [[0, .4], [.4, 1], [1, 1.7], [1.7, 2.2]]);
  const result = setFillLines(p, 'fill', 'two', 1);
  close(result.manualFills![0].notes[1].end, .7);
  close(result.manualFills![0].notes[2].start, .7);
  close(result.manualFills![0].notes[2].end, 1.35);
});

test('octave dots change only selected notation and never act as duration dots', () => {
  const p = numbered(), result = setFillOctave(p, 'fill', 'two', 2);
  assert.equal(result.manualFills![0].notes[1].octave, 2); assert.deepEqual(times(result), times(p));
  assert.equal(result.manualFills![0].notes[0], p.manualFills![0].notes[0]);
  assert.equal(setFillOctave(result, 'fill', 'two', -2).manualFills![0].notes[1].octave, -2);
  assert.throws(() => setFillOctave(p, 'fill', 'one', 3), RangeError);
});

test('deleting an internal number closes only its group suffix and deleting final number removes group', () => {
  const p = addManualFill(numbered(), 4, '5', 'other', ['five']), result = deleteFillNote(p, 'fill', 'two');
  assert.deepEqual(result.manualFills![0].notes.map(item => item.digit), [1, 3, 4]);
  assert.deepEqual(times(result), [[0, .5], [.5, 1], [1, 1.5]]);
  assert.equal(result.manualFills![0].notes[0], p.manualFills![0].notes[0]); assert.equal(result.manualFills![1], p.manualFills![1]);
  assert.equal(deleteFillNote(p, 'other', 'five').manualFills!.length, 1);
  assert.deepEqual(times(deleteFillNote(p, 'fill', 'one')), [[0, .5], [.5, 1], [1, 1.5]]);
});

test('group dragging clamps common delta while preserving exact irregular note durations', () => {
  const p = numbered({ ...base(), beatTimes: [0, .4, 1, 1.7, 2.2] }), result = moveManualFill(p, 'fill', 15);
  close(result.manualFills![0].notes[3].end, 16);
  p.manualFills![0].notes.forEach((note, index) => {
    close(result.manualFills![0].notes[index].end - result.manualFills![0].notes[index].start, note.end - note.start);
    close(result.manualFills![0].notes[index].start - note.start, 13.8);
  });
  times(moveManualFill(result, 'fill', -20)).forEach((pair, index) => pair.forEach((time, edge) => close(time, times(p)[index][edge])));
  preserveOtherTracks(p, result);
});

test('overflow and invalid fill notation are rejected atomically without losing existing content', () => {
  const p = numbered({ ...base(), duration: 2 }), short = setFillLines(p, 'fill', 'one', 2), snapshot = JSON.stringify(short);
  assert.throws(() => addManualFill(p, 1, '1234', 'new', ['a', 'b', 'c', 'd']), RangeError);
  assert.throws(() => addManualFill(p, 0, '189', 'new', ['a', 'b', 'c']), RangeError);
  assert.throws(() => addManualFill(p, 0, '1', 'fill', ['new']), RangeError);
  assert.throws(() => addManualFill(p, 0, '1', 'new', ['one']), RangeError);
  const moved = moveManualFill(short, 'fill', 1);
  assert.throws(() => setFillLines(moved, 'fill', 'one', 0), RangeError);
  assert.equal(JSON.stringify(short), snapshot);
});

test('BPM grid corrections leave every stored lyric and manual note audio second unchanged', () => {
  const p = numbered(); p.lyrics = [lyric('line', '秒数固定', 3, 5)];
  const slower = { ...p, bpm: 60, beatTimes: [] }, snapshot = JSON.stringify({ lyrics: p.lyrics, fills: p.manualFills });
  assert.equal(slower.manualFills, p.manualFills); assert.equal(slower.lyrics, p.lyrics);
  assert.notEqual(rowTimePercent(slower, 1, 4, 2), rowTimePercent(p, 1, 4, 2));
  const dotted = setFillOctave(slower, 'fill', 'two', 1);
  assert.equal(JSON.stringify({ lyrics: dotted.lyrics, fills: dotted.manualFills!.map(group => ({ ...group, notes: group.notes.map(note => ({ ...note, octave: 0 })) })) }), snapshot);
});

test('row percent mapping is invertible over nonuniform grid, pickups and short final bar', () => {
  const p = { ...base(), duration: 4.1, offset: .2, beatTimes: [0, .4, 1, 1.7, 2.2, 2.6, 3.3, 3.9, 4.4] };
  close(rowTimePercent(p, 1, 2, 0), 0); close(rowTimePercent(p, 1, 2, p.duration), 100);
  for (const time of [0, .2, .4, .7, 1.4, 2.4, 3.7, 4.1]) close(rowPercentTime(p, 1, 2, rowTimePercent(p, 1, 2, time)), time);
  const secondRowStart = positionToTime(p, 2, 1);
  close(rowTimePercent(p, 2, 2, secondRowStart), 0);
});

test('score rows cover gaps, partial sections and remaining bars exactly once', () => {
  const p = base(); p.sections = [{ id: 'section', name: 'Verse', startBar: 3, endBar: 7, color: '' }];
  const rows = scoreRows(p, 4);
  assert.deepEqual(rows, [{ sectionId: 'gap:1:2', startBar: 1, endBar: 2 }, { sectionId: 'section', startBar: 3, endBar: 6 }, { sectionId: 'section', startBar: 7, endBar: 7 }, { sectionId: 'gap:8:8', startBar: 8, endBar: 8 }]);
  assert.deepEqual(rows.flatMap(row => Array.from({ length: row.endBar - row.startBar + 1 }, (_, i) => row.startBar + i)), [1, 2, 3, 4, 5, 6, 7, 8]);
});
