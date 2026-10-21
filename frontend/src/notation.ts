import { assignTab, beatsPerBar, positionToTime, timeToPosition } from './music';
import type { Note, NoteNotation, Project } from './music';

export type NoteValue = 1 | 2 | 4 | 8 | 16 | 32;
export const NOTE_VALUES: NoteValue[] = [1, 2, 4, 8, 16, 32];
export interface NumberPitch { degree: number; accidental: number; octave: number; text: string }
export interface Rhythm { value: NoteValue; dotted: boolean; lines: number; approximate: boolean }
export interface NumberFragment { note: Note; start: number; end: number; continued: boolean; continues: boolean }
const mod = (value: number, base = 12) => ((value % base) + base) % base;

export function keyScale(key: string): { tonic: number; scale: number[]; flats: boolean } {
  const match = /^\s*([A-Ga-g])([#b♯♭]?)(.*)$/.exec(key || 'C');
  const natural: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const suffix = match?.[3] || '';
  const minor = /minor|小调|^\s*(?:min\b|m(?:$|\s))/i.test(suffix);
  const accidental = /[#♯]/.test(match?.[2] || '') ? 1 : /[b♭]/.test(match?.[2] || '') ? -1 : 0;
  return { tonic: mod((natural[match?.[1].toUpperCase() || 'C'] || 0) + accidental), scale: minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11], flats: /[b♭]/.test(match?.[2] || '') || ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'].includes((match?.[1].toUpperCase() || '') + (match?.[2] || '')) };
}
/** Plain 1 is the tonic in the C3-based octave; dots encode octave, never audio timing. */
export function numberPitch(midi: number, key: string): NumberPitch {
  const { tonic, scale, flats } = keyScale(key);
  const relative = midi - (48 + tonic), pitch = mod(relative);
  let chosen = 0, accidental = 0, distance = Infinity;
  scale.forEach((step, index) => {
    let difference = mod(pitch - step);
    if (difference > 6) difference -= 12;
    const preference = difference === 0 ? 0 : flats ? difference < 0 ? 0.01 : 0.02 : difference > 0 ? 0.01 : 0.02;
    const score = Math.abs(difference) + preference;
    if (score < distance) { distance = score; chosen = index; accidental = difference; }
  });
  const octave = Math.round((relative - scale[chosen] - accidental) / 12);
  return { degree: chosen + 1, accidental, octave, text: `${accidental > 0 ? '♯'.repeat(accidental) : '♭'.repeat(-accidental)}${chosen + 1}` };
}
export function midiForNumber(degree: number, key: string, octave: number, accidental = 0): number {
  const { tonic, scale } = keyScale(key);
  return Math.max(0, Math.min(127, 48 + tonic + octave * 12 + scale[Math.max(0, Math.min(6, degree - 1))] + accidental));
}
export function numberLabel(p: Project, note: Note): string {
  if (note.notation?.rest) return '0';
  if (note.notation?.dead) return 'x';
  const text = numberPitch(note.midi, p.key).text;
  return note.notation?.ghost ? `(${text})` : text;
}
function denominator(p: Project): number { return Number(p.meter.split('/')[1]) || 4; }
function beatIndex(p: Project, time: number): number { const at = timeToPosition(p, time); return (at.bar - 1) * beatsPerBar(p) + at.beat - 1; }
function indexTime(p: Project, index: number): number { const size = beatsPerBar(p), bar = Math.floor(index / size); return positionToTime(p, bar + 1, index - bar * size + 1); }

/** Map actual start/end through the tempo grid before choosing the displayed rhythm. */
export function noteRhythm(p: Project, note: Pick<Note, 'start' | 'duration'>): Rhythm {
  const quarters = (beatIndex(p, note.start + note.duration) - beatIndex(p, note.start)) * 4 / denominator(p);
  let value: NoteValue = 4, dotted = false, difference = Infinity;
  for (const candidate of NOTE_VALUES) for (const dot of [false, true]) {
    const length = 4 / candidate * (dot ? 1.5 : 1), error = Math.abs(Math.log(Math.max(0.000001, quarters) / length));
    if (error < difference) { difference = error; value = candidate; dotted = dot; }
  }
  return { value, dotted, lines: Math.max(0, Math.log2(value / 4)), approximate: difference > 0.08 };
}
export function notationDuration(p: Project, start: number, value: NoteValue, dotted = false): number {
  const beats = denominator(p) / value * (dotted ? 1.5 : 1);
  return Math.max(0.001, Math.min(p.duration - start, indexTime(p, beatIndex(p, start) + beats) - start));
}
export function numberFragments(p: Project, start: number, end: number): NumberFragment[] {
  return p.notes.filter(note => note.duration > 0 && note.start < end - 1e-8 && note.start + note.duration > start + 1e-8)
    .map(note => ({ note, start: Math.max(start, note.start), end: Math.min(end, p.duration, note.start + note.duration), continued: note.start < start - 1e-8, continues: note.start + note.duration > end + 1e-8 }))
    .filter(fragment => fragment.end > fragment.start).sort((a, b) => a.start - b.start || a.note.id.localeCompare(b.note.id));
}
export function noteIsPlaying(note: Note, time: number): boolean {
  return !note.notation?.rest && time >= note.start && time < note.start + note.duration;
}
function modified(note: Note, patch: Partial<Note>): Note { return { ...note, ...patch, source: 'manual', locked: true }; }
function finger(note: Note): Note {
  if (note.notation?.rest) { const copy = { ...note }; delete copy.string; delete copy.fret; return copy; }
  return assignTab([note])[0];
}
export function setNumberDegree(p: Project, ids: string[], degree: number): Project {
  const selected = new Set(ids);
  return { ...p, notes: p.notes.map(note => {
    if (!selected.has(note.id)) return note;
    if (degree === 0) return finger(modified(note, { notation: { ...note.notation, rest: true, ghost: false, dead: false } }));
    const pitch = numberPitch(note.midi, p.key), midi = midiForNumber(degree, p.key, pitch.octave);
    return finger(modified(note, { midi, string: undefined, fret: undefined, notation: { ...note.notation, rest: false, dead: false } }));
  }) };
}
export function setNumberNotation(p: Project, ids: string[], patch: Partial<NoteNotation>): Project {
  const selected = new Set(ids);
  return { ...p, notes: p.notes.map(note => {
    if (!selected.has(note.id)) return note;
    const rhythm = noteRhythm(p, note), notation = { ...note.notation, ...patch };
    if (patch.ghost) { notation.dead = false; notation.rest = false; }
    if (patch.dead) { notation.ghost = false; notation.rest = false; }
    if (patch.rest) { notation.ghost = false; notation.dead = false; }
    const timingChanged = patch.value !== undefined || patch.dotted !== undefined;
    if (timingChanged) { notation.value = patch.value ?? rhythm.value; notation.dotted = patch.dotted ?? rhythm.dotted; }
    const duration = timingChanged ? notationDuration(p, note.start, notation.value!, notation.dotted) : note.duration;
    return finger(modified(note, { notation, duration }));
  }) };
}
export function moveNumberNotes(p: Project, ids: string[], beats: number, octaves = 0): Project {
  const selected = new Set(ids);
  return { ...p, notes: p.notes.map(note => {
    if (!selected.has(note.id)) return note;
    const start = Math.max(0, Math.min(p.duration - note.duration, indexTime(p, beatIndex(p, note.start) + beats)));
    const midi = Math.max(0, Math.min(127, note.midi + octaves * 12));
    return finger(modified(note, { start, midi, ...(midi !== note.midi ? { string: undefined, fret: undefined } : {}) }));
  }) };
}
export function alterNumberNotes(p: Project, ids: string[], semitones: number): Project {
  const selected = new Set(ids);
  return { ...p, notes: p.notes.map(note => selected.has(note.id) && !note.notation?.rest && !note.notation?.dead
    ? finger(modified(note, { midi: Math.max(0, Math.min(127, note.midi + Math.round(semitones))), string: undefined, fret: undefined })) : note) };
}
export function insertNumberNote(p: Project, start: number, id: string, rest = false, value: NoteValue = 4): Project {
  const at = Math.max(0, Math.min(Math.max(0, p.duration - 0.01), start));
  const preceding = [...p.notes].filter(note => !note.notation?.rest && note.start <= at).sort((a, b) => b.start - a.start)[0];
  const midi = preceding?.midi ?? midiForNumber(1, p.key, -1);
  const note = finger({ id, midi, start: at, duration: notationDuration(p, at, value), source: 'manual', confidence: 1, locked: true, notation: { value, rest } });
  return { ...p, notes: [...p.notes, note].sort((a, b) => a.start - b.start) };
}
export function pasteNumberNotes(p: Project, notes: Note[], start: number, ids: string[]): Project {
  if (!notes.length) return p;
  const origin = Math.min(...notes.map(note => note.start));
  const pasted = notes.map((note, index) => ({ ...note, notation: note.notation ? { ...note.notation } : undefined, id: ids[index], start: start + note.start - origin, source: 'manual' as const, locked: true }))
    .filter(note => note.id && note.start >= 0 && note.start < p.duration)
    .map(note => ({ ...note, duration: Math.min(note.duration, p.duration - note.start) }));
  return { ...p, notes: [...p.notes, ...pasted].sort((a, b) => a.start - b.start) };
}
