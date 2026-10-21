import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Note, Project } from './music.ts';
import { alterNumberNotes, insertNumberNote, keyScale, midiForNumber, moveNumberNotes, noteIsPlaying, noteRhythm, notationDuration, numberFragments, numberLabel, numberPitch, pasteNumberNotes, setNumberDegree, setNumberNotation } from './notation.ts';

const project = (): Project => ({ id: 'numbers', title: 'Number test', artist: '', duration: 8, originalKey: 'C Major', key: 'C Major', bpm: 120, meter: '4/4', offset: 0, beatTimes: [], sections: [], chords: [], lyrics: [], notes: [], markers: [], stems: [], analysis: { state: 'idle', stage: '', progress: 0, warnings: [] }, updatedAt: '', revision: 1, isDemo: false });
const note = (id = 'note', midi = 36, start = 0, duration = 0.5): Note => ({ id, midi, start, duration, source: 'analysis', confidence: 0.8, locked: false });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('number pitch uses key, major/minor scale, accidentals and explicit octave dots', () => {
  assert.deepEqual(numberPitch(36, 'C Major'), { degree: 1, accidental: 0, octave: -1, text: '1' });
  assert.deepEqual(numberPitch(54, 'C Major'), { degree: 4, accidental: 1, octave: 0, text: '♯4' });
  assert.deepEqual(numberPitch(56, 'F Major'), { degree: 3, accidental: -1, octave: 0, text: '♭3' });
  assert.equal(numberPitch(60, 'A Minor').degree, 3);
  assert.equal(numberPitch(58, 'Bb Major').degree, 1);
  assert.equal(midiForNumber(7, 'A Minor', -1), 55);
  assert.equal(keyScale('C# minor').tonic, 1);
  for (const midi of [0, 28, 36, 40, 48, 54, 60, 83, 127]) {
    const pitch = numberPitch(midi, 'C Major');
    assert.equal(midiForNumber(pitch.degree, 'C Major', pitch.octave, pitch.accidental), midi);
  }
});
test('duration underlines and dots come from real time through the tempo grid', () => {
  const p = project();
  assert.deepEqual(noteRhythm(p, note('quarter')), { value: 4, dotted: false, lines: 0, approximate: false });
  assert.deepEqual(noteRhythm(p, note('eighth', 36, 0, 0.25)), { value: 8, dotted: false, lines: 1, approximate: false });
  assert.deepEqual(noteRhythm(p, note('dotted16', 36, 0, 0.1875)), { value: 16, dotted: true, lines: 2, approximate: false });
  assert.equal(noteRhythm(p, note('unquantized', 36, 0, 0.31)).approximate, true);
  p.beatTimes = [0, 0.5, 1.25, 2, 3];
  assert.deepEqual(noteRhythm(p, note('varying', 36, 0.5, 0.75)), { value: 4, dotted: false, lines: 0, approximate: false });
  close(notationDuration(p, 0.5, 8), 0.375);
});
test('eighth-note meter and song-end clipping retain actual interval boundaries', () => {
  const p = { ...project(), meter: '6/8', duration: 1.6 };
  close(notationDuration(p, 0, 4), 0.5);
  close(notationDuration(p, 0, 8, true), 0.375);
  close(notationDuration(p, 1.5, 4), 0.1);
  assert.equal(noteRhythm(p, note('eighth', 36, 0, 0.25)).value, 8);
});
test('cross-bar note fragments cover real sounding intervals, including continuation', () => {
  const p = project(); p.notes = [note('across', 36, 1.5, 1), note('before', 38, 0, 0.5), note('boundary', 40, 3, 0.5)];
  const first = numberFragments(p, 0, 2), next = numberFragments(p, 2, 4);
  assert.deepEqual(first.map(fragment => [fragment.note.id, fragment.start, fragment.end, fragment.continued, fragment.continues]), [['before', 0, 0.5, false, false], ['across', 1.5, 2, false, true]]);
  assert.deepEqual(next.map(fragment => [fragment.note.id, fragment.start, fragment.end, fragment.continued, fragment.continues]), [['across', 2, 2.5, true, false], ['boundary', 3, 3.5, false, false]]);
  assert.equal(noteIsPlaying(p.notes[0], 2.49), true); assert.equal(noteIsPlaying(p.notes[0], 2.5), false);
  assert.equal(noteIsPlaying({ ...p.notes[0], notation: { rest: true } }, 2), false);
});
test('ghost parenthesis, dead x and rest 0 remain distinct independent of pitch', () => {
  const p = project(), original = note();
  assert.equal(numberLabel(p, original), '1');
  assert.equal(numberLabel(p, { ...original, notation: { ghost: true } }), '(1)');
  assert.equal(numberLabel(p, { ...original, notation: { dead: true } }), 'x');
  assert.equal(numberLabel(p, { ...original, notation: { rest: true } }), '0');
  p.notes = [original];
  const ghost = setNumberNotation(p, [original.id], { ghost: true });
  const dead = setNumberNotation(ghost, [original.id], { dead: true });
  const rest = setNumberNotation(dead, [original.id], { rest: true });
  assert.equal(dead.notes[0].notation?.ghost, false); assert.equal(dead.notes[0].notation?.dead, true);
  assert.equal(rest.notes[0].notation?.dead, false); assert.equal(rest.notes[0].notation?.rest, true);
  assert.equal(original.notation, undefined);
});
test('editing note value or dot updates seconds, while tie/slur do not change timing', () => {
  const p = project(); p.notes = [note('a'), note('b', 40, 1)];
  const eighth = setNumberNotation(p, ['a'], { value: 8 }); close(eighth.notes[0].duration, 0.25);
  const dotted = setNumberNotation(eighth, ['a'], { dotted: true }); close(dotted.notes[0].duration, 0.375);
  const tied = setNumberNotation(dotted, ['a'], { tie: true, slur: true }); close(tied.notes[0].duration, 0.375);
  assert.equal(tied.notes[0].locked, true); assert.equal(tied.notes[0].source, 'manual');
  assert.equal(tied.notes[1], p.notes[1]); close(p.notes[0].duration, 0.5);
});
test('0–7 editing preserves octave, clears accidentals, recomputes fingering and supports rest', () => {
  const p = project(); p.notes = [{ ...note('a', 42), string: 4, fret: 14 }];
  const changed = setNumberDegree(p, ['a'], 1);
  assert.equal(changed.notes[0].midi, 36); assert.equal(changed.notes[0].fret! + [43, 38, 33, 28][changed.notes[0].string! - 1], 36);
  const rest = setNumberDegree(changed, ['a'], 0); assert.equal(numberLabel(rest, rest.notes[0]), '0'); assert.equal(rest.notes[0].string, undefined);
  const again = setNumberDegree(rest, ['a'], 5); assert.equal(again.notes[0].midi, 43); assert.equal(again.notes[0].notation?.rest, false);
  assert.equal(p.notes[0].midi, 42);
});
test('arrow movement changes only selected notes and stays within playable song bounds', () => {
  const p = project(); p.notes = [note('a', 36, 0.5), note('b', 40, 1)];
  const moved = moveNumberNotes(p, ['a'], 0.25); close(moved.notes[0].start, 0.625); assert.equal(moved.notes[1], p.notes[1]);
  close(moveNumberNotes(p, ['a'], -20).notes[0].start, 0);
  close(moveNumberNotes(p, ['a'], 100).notes[0].start, 7.5);
  assert.equal(moveNumberNotes(p, ['a'], 0, 1).notes[0].midi, 48);
  assert.equal(p.notes[0].midi, 36);
});
test('sharp/flat edit affects pitched notes without converting rest or dead symbols', () => {
  const p = project(); p.notes = [note('a', 41), { ...note('b'), notation: { rest: true } }, { ...note('c'), notation: { dead: true } }];
  const changed = alterNumberNotes(p, ['a', 'b', 'c'], 1);
  assert.equal(changed.notes[0].midi, 42); assert.equal(numberLabel(changed, changed.notes[0]), '♯4');
  assert.equal(changed.notes[1], p.notes[1]); assert.equal(changed.notes[2], p.notes[2]);
});
test('insertion follows preceding pitch, uses grid duration, and separates rest from TAB', () => {
  const p = project(); p.notes = [note('previous', 40, 0)];
  const inserted = insertNumberNote(p, 2, 'new', false, 16), created = inserted.notes.find(item => item.id === 'new')!;
  assert.equal(created.midi, 40); close(created.duration, 0.125); assert.equal(created.locked, true); assert.equal(created.source, 'manual');
  const rested = insertNumberNote(p, 2, 'rest', true), rest = rested.notes.find(item => item.id === 'rest')!;
  assert.equal(rest.notation?.rest, true); assert.equal(rest.string, undefined);
  assert.equal(p.notes.length, 1);
});
test('paste preserves relative timestamps and notation while assigning new independent IDs', () => {
  const p = project(), originals = [{ ...note('a', 36, 1), notation: { ghost: true } }, { ...note('b', 40, 1.75), notation: { tie: true } }];
  const pasted = pasteNumberNotes(p, originals, 5, ['copy-a', 'copy-b']);
  assert.deepEqual(pasted.notes.map(item => [item.id, item.start]), [['copy-a', 5], ['copy-b', 5.75]]);
  assert.equal(pasted.notes[0].notation?.ghost, true); assert.notEqual(pasted.notes[0].notation, originals[0].notation);
  const tail = pasteNumberNotes(p, originals, 7.75, ['tail-a', 'tail-b']);
  assert.equal(tail.notes.length, 1); close(tail.notes[0].duration, 0.25);
  assert.equal(p.notes.length, 0);
});
