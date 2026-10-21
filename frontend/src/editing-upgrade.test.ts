import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project, Lyric } from './music';
import { addManualFill, moveLyricWithPush, nudgeLyric, beatIndex, setFillDigit } from './tracks';
import { fillLayoutGroups, fillLayoutRows, layoutCompactFills } from './fill-layout';
import { scoreRows } from './tracks';

const song = (): Project => ({ id: 'edits', title: '原创验证', artist: '', duration: 32, bpm: 120, meter: '4/4', originalKey: 'C', key: 'C', offset: 0, beatTimes: [], sections: [], chords: [], lyrics: [], manualFills: [], notes: [], markers: [], stems: [], analysis: { state: 'idle', stage: '', progress: 0, warnings: [] }, revision: 1, updatedAt: '', isDemo: false });
const lyric = (id: string, start: number, end = start + 1): Lyric => ({ id, text: id, start, end, locked: false, source: 'analysis' });
const positions = (p: Project) => p.lyrics.map(l => l.start);
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('an isolated drag consumes only silence even when LRC end extends to the next start', () => {
  const p = song(); p.lyrics = [lyric('a', 0, 6), lyric('b', 6, 15), lyric('c', 15, 32)];
  const next = moveLyricWithPush(p, 'a', 3, { a: 2, b: 2, c: 2 });
  assert.deepEqual(positions(next), [3, 6, 15]); assert.equal(next.lyrics[0].end, 9);
  assert.equal(next.lyrics[1], p.lyrics[1]); assert.equal(next.chords, p.chords); assert.equal(next.manualFills, p.manualFills);
});
test('collision pushes only as far as needed, then a gap stops propagation', () => {
  const p = song(); p.lyrics = [lyric('a', 0), lyric('b', 3), lyric('c', 4), lyric('d', 12)];
  const next = moveLyricWithPush(p, 'a', 3.5, { a: 2, b: 2, c: 2, d: 2 });
  assert.deepEqual(positions(next), [3.5, 4.5, 5.5, 12]);
  next.lyrics.forEach((l, i) => near(l.end - l.start, p.lyrics[i].end - p.lyrics[i].start));
  assert.deepEqual(positions(p), [0, 3, 4, 12]);
});
test('moving left stops at the preceding text, without pulling any follower', () => {
  const p = song(); p.lyrics = [lyric('a', 0, 8), lyric('b', 5), lyric('c', 7)];
  assert.deepEqual(positions(moveLyricWithPush(p, 'b', -10, { a: 3, b: 2, c: 1 })), [0, 1.5, 7]);
});
test('a right boundary limits the whole push transaction without shortening text or audio durations', () => {
  const p = song(); p.duration = 10; p.lyrics = [lyric('a', 1), lyric('b', 5), lyric('c', 8, 10)];
  const next = moveLyricWithPush(p, 'a', 100, { a: 2, b: 2, c: 2 });
  near(next.lyrics[0].start, 6); near(next.lyrics[1].start, 7); near(next.lyrics[2].start, 8);
  assert.equal(next.lyrics.map(l => l.text).join(''), 'abc');
  next.lyrics.forEach(l => assert.ok(l.end <= 10 + 1e-8));
});
test('quarter-beat spacing uses nonuniform beat grid, preserves duration and handles 6/8', () => {
  const p = song(); p.beatTimes = [0,.4,1,1.7,2.1,2.8]; p.meter = '6/8'; p.lyrics = [lyric('a', 1), lyric('b', 8)];
  const shifted = nudgeLyric(p, 'a', .25, { a: .5, b: .5 });
  near(shifted.lyrics[0].start, 1.175); near(shifted.lyrics[0].end, 2.175);
  near(beatIndex(p, shifted.lyrics[0].start) - beatIndex(p, 1), .25);
  assert.equal(shifted.lyrics[1], p.lyrics[1]);
});
test('a final partial gap is consumed once and then head backspace has no movement to perform', () => {
  const p = song(); p.lyrics = [lyric('a', 0), lyric('b', 1.03)];
  const close = nudgeLyric(p, 'b', -.25, { a: 2, b: 2 }); near(close.lyrics[1].start, 1);
  assert.equal(nudgeLyric(close, 'b', -.25, { a: 2, b: 2 }), close);
});
test('long manual groups wrap inside one chord while all stored times and notation stay unchanged', () => {
  let p = song(); p.chords = [{ id: 'c', bar: 1, beat: 1, label: 'C', source: 'manual', locked: true, confidence: 1 }, { id: 'd', bar: 1, beat: 2, label: 'D', source: 'manual', locked: true, confidence: 1 }];
  p = addManualFill(p, 0, '1234567012345670', 'g', Array.from({ length: 16 }, (_, i) => `n${i}`));
  const snapshot = JSON.stringify(p), rows = fillLayoutRows(p, scoreRows(p, 4), 640), result = layoutCompactFills(rows, fillLayoutGroups(p), 19);
  assert.equal(result.items.length, 16); assert.equal(new Set(result.items.map(n => n.id)).size, 16);
  assert.ok(result.items.every(n => n.left >= 0 && n.left + n.width <= 40.001 && n.fontSize >= 12 && n.compact));
  assert.ok(new Set(result.items.map(n => n.top)).size > 1); assert.equal(JSON.stringify(p), snapshot);
});
test('a chord spanning score rows continues in order and multiple groups never overlap', () => {
  let p = song(); p.chords = [{ id: 'c', bar: 1, beat: 1, label: 'C', source: 'manual', locked: true, confidence: 1 }];
  p = addManualFill(p, 0, '1234567'.repeat(6), 'g', Array.from({ length: 42 }, (_, i) => `n${i}`));
  p = addManualFill(p, 0, '1234', 'h', ['h1','h2','h3','h4']);
  const result = layoutCompactFills(fillLayoutRows(p, scoreRows(p, 2), 250), fillLayoutGroups(p), 19);
  assert.equal(result.items.length, 46); assert.ok(new Set(result.items.map(n => n.row)).size > 1);
  for (let i = 0; i < result.items.length; i++) for (const b of result.items.slice(i + 1)) {
    const a = result.items[i]; if (a.row !== b.row) continue;
    const overlapX = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    if (overlapX > 0) assert.ok(Math.abs(a.top - b.top) >= Math.min(a.fontSize, b.fontSize) * 1.2 + 26);
  }
});
test('no-chord fills use the containing bar, print and mobile keep every digit, and rest replacement clears octave', () => {
  const p = addManualFill(song(), 2, '12345670', 'g', Array.from({ length: 8 }, (_, i) => `n${i}`));
  p.manualFills![0].notes[0].octave = 2;
  const groups = fillLayoutGroups(p); assert.equal(groups[0].start, 4); assert.equal(groups[0].end, 8);
  for (const width of [230, 650, 1000]) {
    const result = layoutCompactFills(fillLayoutRows(p, scoreRows(p, 4), width), groups, 14, 12);
    assert.equal(result.items.length, 8); assert.ok(result.items.every(n => n.fontSize >= 12 && n.left + n.width <= n.rangeRight + .01));
  }
  const next = setFillDigit(p, 'g', 'n0', 0); assert.equal(next.manualFills![0].notes[0].octave, 0); assert.equal(next.manualFills![0].notes[0].start, 2);
});

test('compact continuation remains in reading order even when both score rows overflow', () => {
  const notes = Array.from({ length: 32 }, (_, i) => ({ id: `note${i}`, beat: i / 10 }));
  const rows = [{ id: 1, start: 0, end: 1, width: 45 }, { id: 2, start: 1, end: 2, width: 45 }];
  const result = layoutCompactFills(rows, [{ id: 'g', start: 0, end: 2, notes }], 19);
  const reading = [...result.items].sort((a, b) => a.row - b.row || a.top - b.top || a.left - b.left);
  assert.deepEqual(reading.map(n => n.id), notes.map(n => n.id));
});

test('a pickup before the first downbeat has a valid fill display range starting at audio zero', () => {
  const p = addManualFill({ ...song(), offset: 1 }, .1, '12', 'pickup', ['p1','p2']);
  const groups = fillLayoutGroups(p); near(groups[0].start, beatIndex(p, 0));
  const layout = layoutCompactFills(fillLayoutRows(p, scoreRows(p, 4), 650), groups, 19);
  assert.equal(layout.items.length, 2); assert.ok(layout.items.every(n => n.left >= 0));
});
