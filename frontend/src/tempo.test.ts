import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resampleBeatTimes } from './tempo.ts';
import { barCount, makeGrid, positionToTime, timeToPosition, type Project } from './music.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const project = (): Project => ({
  id: 'tempo-test', title: 'Tempo test', artist: '', duration: 8, originalKey: 'C', key: 'C',
  bpm: 120, meter: '4/4', offset: 0, beatTimes: [], sections: [],
  chords: Array.from({ length: 16 }, (_, i) => ({ id: `chord-${i}`, bar: Math.floor(i / 4) + 1, beat: i % 4 + 1, label: i % 2 ? 'G7' : 'Cmaj7', source: 'analysis' as const, confidence: 0.8, locked: false })),
  lyrics: [{ id: 'lyric', text: '原始歌词时间', start: 1.3, end: 5.2, source: 'manual', locked: true }],
  notes: [{ id: 'note', midi: 40, start: 2.1, duration: 0.7, source: 'manual', confidence: 1, locked: true }],
  markers: [{ id: 'fill', time: 3.7, label: 'FILL', text: '原曲', source: 'manual' }],
  stems: [], analysis: { state: 'idle', stage: '', progress: 0, warnings: [] }, updatedAt: '', revision: 1, isDemo: false,
});

test('uniform half/double BPM grids keep their first beat and cover the previous last beat', () => {
  const times = [0.3, 0.8, 1.3, 1.8, 2.3];
  assert.deepEqual(resampleBeatTimes(times, 0.5), [0.3, 1.3, 2.3]);
  const doubled = resampleBeatTimes(times, 2);
  doubled.forEach((time, index) => close(time, 0.3 + index * 0.25));
  assert.equal(doubled[0], times[0]); assert.equal(doubled.at(-1), times.at(-1));
  assert.deepEqual(resampleBeatTimes(times, 1), times);
  assert.notEqual(resampleBeatTimes(times, 1), times);
});

test('nonuniform half/double BPM follows recorded beat intervals instead of flattening tempo changes', () => {
  const times = [0.2, 0.7, 1.4, 1.9, 2.8];
  assert.deepEqual(resampleBeatTimes(times, 0.5), [0.2, 1.4, 2.8]);
  const doubled = resampleBeatTimes(times, 2);
  assert.equal(doubled[0], 0.2); assert.equal(doubled.at(-1), 2.8);
  times.forEach((time, index) => close(doubled[index * 2], time));
  for (let index = 0; index < times.length - 1; index++) close(doubled[index * 2 + 1], (times[index] + times[index + 1]) / 2);
  assert.deepEqual(resampleBeatTimes(doubled, 0.5), times);
});

test('a clipped BPM ratio and an odd final beat extrapolate the last interval while covering the source', () => {
  const times = [1, 1.4, 2, 2.9];
  const clipped = resampleBeatTimes(times, 0.75);
  assert.equal(clipped[0], 1); close(clipped[1], 1.6); close(clipped[2], 2.6); close(clipped[3], 3.8);
  assert.ok(clipped.at(-1)! >= times.at(-1)!);
  const half = resampleBeatTimes(times, 0.5);
  assert.deepEqual(half, [1, 2, 3.8]);
  assert.equal(resampleBeatTimes([2, 2.5], 0.5).length, 2);
});

test('correcting a uniform BPM reassigns denser/sparser measures while preserving every event audio time', () => {
  const before = project(), snapshot = JSON.stringify(before);
  for (const ratio of [0.5, 2]) {
    const next: Project = { ...before, bpm: before.bpm * ratio, beatTimes: [] };
    next.beatTimes = makeGrid(next);
    const remapped = before.chords.map(chord => ({ ...chord, ...timeToPosition(next, positionToTime(before, chord.bar, chord.beat)) }));
    remapped.forEach((chord, index) => close(positionToTime(next, chord.bar, chord.beat), positionToTime(before, before.chords[index].bar, before.chords[index].beat)));
    assert.equal(barCount(next), barCount(before) * ratio);
    assert.equal(remapped.length, before.chords.length);
    assert.equal(new Set(remapped.map(chord => positionToTime(next, chord.bar, chord.beat))).size, before.chords.length);
    assert.deepEqual(next.lyrics, before.lyrics); assert.deepEqual(next.notes, before.notes); assert.deepEqual(next.markers, before.markers);
  }
  assert.equal(JSON.stringify(before), snapshot);
});

test('resampled nonuniform grids preserve source-time chord lookup, lyrics, notes and fill markers', () => {
  const before = { ...project(), offset: 0.2, beatTimes: [0.2, 0.7, 1.4, 1.9, 2.8, 3.4, 4.2, 4.8, 5.5] };
  const snapshot = JSON.stringify(before);
  for (const ratio of [0.5, 0.75, 2]) {
    const next = { ...before, bpm: before.bpm * ratio, beatTimes: resampleBeatTimes(before.beatTimes, ratio) };
    const remapped = before.chords.map(chord => ({ ...chord, ...timeToPosition(next, positionToTime(before, chord.bar, chord.beat)) }));
    remapped.forEach((chord, index) => close(positionToTime(next, chord.bar, chord.beat), positionToTime(before, before.chords[index].bar, before.chords[index].beat)));
    assert.equal(makeGrid(next)[0], before.offset);
    assert.deepEqual(next.lyrics, before.lyrics); assert.deepEqual(next.notes, before.notes); assert.deepEqual(next.markers, before.markers);
  }
  assert.equal(JSON.stringify(before), snapshot);
});

test('invalid resampling input fails without changing the supplied timestamps', () => {
  const times = [0.2, 0.7, 1.4], snapshot = [...times];
  for (const ratio of [0, -1, NaN, Infinity]) assert.throws(() => resampleBeatTimes(times, ratio), RangeError);
  for (const invalid of [[], [1], [1, 1], [1, 0], [0, NaN]]) assert.throws(() => resampleBeatTimes(invalid, 0.5), RangeError);
  assert.deepEqual(times, snapshot);
});
