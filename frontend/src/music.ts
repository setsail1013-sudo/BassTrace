/** Shared musical timeline and portable project utilities. */
export type Source = 'demo' | 'manual' | 'analysis';
export interface Section { id: string; name: string; startBar: number; endBar: number; color: string }
export interface Chord { id: string; bar: number; beat: number; label: string; source: Source; confidence: number; locked: boolean; start?: number; end?: number }
export interface BassEvent { id: string; start: number; end: number; pitchClass: number; source: Source; confidence: number; locked: boolean }
export type FillConnectionKind = 'slideUp' | 'slideDown' | 'hammer' | 'pull' | 'tie';
export interface FillNotation { cut?: boolean; dead?: boolean; accent?: boolean; connection?: { kind: FillConnectionKind; targetNoteId: string } | null }
export interface ScoreStyle { lyricFontSize: number; lyricPrintSize: number; colors: { lyrics: string; top: string; fill: string; mark: string }; printColor: boolean; printOrientation?: 'portrait' | 'landscape' }
export interface Lyric { id: string; text: string; start: number; end: number; source: Source; locked: boolean; order?: number | null }
export interface ManualFillNote { id: string; digit: number; start: number; end: number; lines: 0 | 1 | 2; octave: number; notation?: FillNotation | null }
export interface ManualFill { id: string; notes: ManualFillNote[] }
export interface NoteNotation { value?: 1 | 2 | 4 | 8 | 16 | 32; dotted?: boolean; ghost?: boolean; dead?: boolean; rest?: boolean; tie?: boolean; slur?: boolean }
export interface Note { id: string; midi: number; start: number; duration: number; string?: number; fret?: number; source: Source; confidence: number; locked: boolean; notation?: NoteNotation }
export interface Marker { id: string; time: number; label: string; text: string; source: Source }
export interface Stem { id: string; name: string; url: string; available: boolean; peaks: number[]; enhancedUrl?: string | null; gainDb?: number | null }
export interface AlignmentLine { id: string; lyricId?: string; text: string; detectedText: string; start: number | null; end: number | null; status: 'matched' | 'pending' | 'manual'; confidence: number; diff: Array<{kind:'equal'|'replace'|'insert'|'delete';original:string;detected:string}> }
export interface LyricAlignment { state:'idle'|'running'|'complete'|'error'; stage:string; progress:number; detectedSegments:Array<{id:string;text:string;start:number;end:number;confidence:number;words:Array<{text:string;start:number;end:number;confidence:number}>}>; lines:AlignmentLine[]; warnings:string[]; error:string|null; jobId?:string|null }
export interface Project {
  id: string; title: string; artist: string; duration: number; originalKey: string; key: string;
  bpm: number; meter: string; offset: number; beatTimes: number[]; sections: Section[];
  chords: Chord[]; lyrics: Lyric[]; notes: Note[]; markers: Marker[]; stems: Stem[];
  analysis: { state: 'idle' | 'running' | 'complete' | 'error'; stage: string; progress: number; warnings: string[] };
  updatedAt: string; revision: number; isDemo: boolean;
  lyricsOriginal?: string; lyricAlignment?: LyricAlignment;
  manualFills?: ManualFill[];
  bassEvents?: BassEvent[]; topTrack?: 'bass' | 'chords'; scoreStyle?: ScoreStyle;
}
export interface Position { bar: number; beat: number }

const mod = (value: number, base = 12) => ((value % base) + base) % base;
function meterParts(p: Pick<Project, 'meter'>): [number, number] {
  const match = /^(\d+)\/(\d+)$/.exec(p.meter || '4/4');
  const numerator = match ? Number(match[1]) : 4;
  const denominator = match ? Number(match[2]) : 4;
  return [numerator > 0 ? numerator : 4, denominator > 0 ? denominator : 4];
}
export function beatsPerBar(p: Pick<Project, 'meter'>): number { return meterParts(p)[0]; }
/** BPM is measured in quarter notes; a 6/8 bar therefore contains six eighth-note beats. */
export function beatSeconds(p: Pick<Project, 'meter' | 'bpm'>): number {
  return 60 / (Number.isFinite(p.bpm) && p.bpm > 0 ? p.bpm : 120) * 4 / meterParts(p)[1];
}

/** Absolute audio seconds. Offset anchors beat one; irregular beat intervals are preserved. */
export function makeGrid(p: Pick<Project, 'beatTimes' | 'offset' | 'duration' | 'bpm' | 'meter'>): number[] {
  const offset = Number.isFinite(p.offset) ? p.offset : 0;
  const supplied = p.beatTimes || [];
  const valid = supplied.length > 1 && supplied.every((time, i) => Number.isFinite(time) && (i === 0 || time > supplied[i - 1]));
  const grid = valid ? supplied.map(time => time - supplied[0] + offset) : [offset];
  const step = valid ? grid[grid.length - 1] - grid[grid.length - 2] : beatSeconds(p);
  const duration = Number.isFinite(p.duration) ? Math.max(0, p.duration) : 0;
  const extra = Math.max(1, Math.ceil((duration - grid[grid.length - 1]) / step));
  // Keep one boundary beyond the last playable beat for interpolation and the last bar.
  for (let i = 0; i < extra; i++) grid.push(grid[grid.length - 1] + step);
  return grid;
}
function gridTime(grid: number[], index: number): number {
  if (index < 0) return grid[0] + index * (grid[1] - grid[0]);
  if (index >= grid.length - 1) return grid[grid.length - 1] + (index - grid.length + 1) * (grid[grid.length - 1] - grid[grid.length - 2]);
  const lower = Math.floor(index);
  return grid[lower] + (index - lower) * (grid[lower + 1] - grid[lower]);
}
export function positionToTime(p: Project, bar: number, beat: number): number {
  return gridTime(makeGrid(p), (bar - 1) * beatsPerBar(p) + beat - 1);
}
function timeToIndex(p: Project, time: number): number {
  const grid = makeGrid(p);
  if (time <= grid[0]) return (time - grid[0]) / (grid[1] - grid[0]);
  const last = grid.length - 1;
  if (time >= grid[last]) return last + (time - grid[last]) / (grid[last] - grid[last - 1]);
  let left = 0, right = last;
  while (left + 1 < right) { const middle = (left + right) >>> 1; if (grid[middle] <= time) left = middle; else right = middle; }
  return left + (time - grid[left]) / (grid[right] - grid[left]);
}
export function timeToPosition(p: Project, time: number): Position {
  const index = timeToIndex(p, time);
  const size = beatsPerBar(p);
  const barIndex = Math.floor((index + 1e-9) / size);
  return { bar: barIndex + 1, beat: Math.max(1, index - barIndex * size + 1) };
}
export function barCount(p: Project): number {
  return Math.max(1, Math.ceil((timeToIndex(p, Math.max(0, p.duration)) - 1e-9) / beatsPerBar(p)));
}
/** Read-only display ranges cover every audio bar once, including unassigned gaps. */
export function displaySections(p: Project): Section[] {
  const count = barCount(p), result: Section[] = [];
  let cursor = 1;
  const gap = (startBar: number, endBar: number): Section => ({ id: `gap:${startBar}:${endBar}`, name: '未分段', startBar, endBar, color: '#8d9b7c' });
  // Earlier sections retain their range; overlapping later sections display only their uncovered tail.
  for (const section of [...p.sections].sort((a, b) => a.startBar - b.startBar)) {
    if (cursor > count) break;
    if (!Number.isFinite(section.startBar) || !Number.isFinite(section.endBar)) continue;
    const start = Math.max(cursor, 1, Math.ceil(section.startBar));
    const end = Math.min(count, Math.floor(section.endBar));
    if (end < start) continue;
    if (start > cursor) result.push(gap(cursor, start - 1));
    result.push({ ...section, startBar: start, endBar: end });
    cursor = end + 1;
  }
  if (cursor <= count) result.push(gap(cursor, count));
  return result;
}
/** A detected bass pitch is not a harmonic chord, including legacy saved candidates. */
export function isBassRootCandidate(chord: Chord): boolean {
  return /^[A-G][#b♯♭]?\?$/.test(chord.label.trim())
    || (chord.source === 'analysis' && chord.id.startsWith('analysis-bass-root-'));
}
/** Display harmonic changes without rewriting analysis or user-confirmed event data. */
export function displayChords(input: Pick<Project, 'chords'> | readonly Chord[]): Chord[] {
  const chords = 'chords' in input ? input.chords : input;
  const ordered = chords.map((chord, order) => ({ chord, order })).sort((a, b) => a.chord.bar - b.chord.bar || a.chord.beat - b.chord.beat || a.order - b.order);
  const result: Chord[] = [];
  let previous: string | undefined;
  for (const { chord } of ordered) {
    if (isBassRootCandidate(chord)) continue;
    const label = chord.label.trim();
    const automatic = (chord.source === 'analysis' || chord.source === 'demo') && !chord.locked;
    if (!automatic || label !== previous) result.push(chord);
    previous = label;
  }
  return result;
}
export function chordAt(p: Project, time: number): Chord | undefined {
  let selected: Chord | undefined, selectedTime = -Infinity;
  for (const chord of p.chords) {
    if (isBassRootCandidate(chord)) continue;
    const at = positionToTime(p, chord.bar, chord.beat);
    if (at <= time + 1e-9 && at >= selectedTime) { selected = chord; selectedTime = at; }
  }
  return selected;
}

/** Keep pickup lyrics before the first downbeat visible without changing their audio times. */
export function lyricsForBar(p: Project, bar: number): Lyric[] {
  const start = bar === 1 ? 0 : positionToTime(p, bar, 1);
  const end = Math.min(p.duration, positionToTime(p, bar + 1, 1));
  return p.lyrics.filter(lyric => lyric.start >= start - 1e-8 && lyric.start < end - 1e-8);
}

const NATURAL: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
interface ParsedChord { root: string; quality: string; bass?: string }
function parseChord(label: string): ParsedChord | undefined {
  const match = /^([A-Ga-g][#b♯♭]?)(.*?)(?:\/([A-Ga-g][#b♯♭]?))?$/.exec(label.trim());
  return match ? { root: normalizePitch(match[1]), quality: match[2], bass: match[3] ? normalizePitch(match[3]) : undefined } : undefined;
}
function normalizePitch(pitch: string): string { return pitch[0].toUpperCase() + pitch.slice(1).replace('♯', '#').replace('♭', 'b'); }
function pitchClass(pitch: string): number { return mod(NATURAL[pitch[0]] + (pitch.endsWith('#') ? 1 : pitch.endsWith('b') ? -1 : 0)); }
function transposePitch(pitch: string, steps: number, flats = pitch.includes('b')): string { return (flats ? FLATS : SHARPS)[mod(pitchClass(pitch) + Math.round(steps))]; }
function shiftedChord(label: string, steps: number, flats?: boolean): string {
  const parsed = parseChord(label);
  if (!parsed || mod(steps) === 0) return label;
  return transposePitch(parsed.root, steps, flats) + parsed.quality + (parsed.bass ? '/' + transposePitch(parsed.bass, steps, flats) : '');
}
export function transposeChord(label: string, steps: number): string { return shiftedChord(label, Number.isFinite(steps) ? Math.round(steps) : 0); }
function parseKey(key: string): { root: string; minor: boolean; suffix: string } | undefined {
  const match = /^\s*([A-Ga-g][#b♯♭]?)(.*)$/.exec(key);
  if (!match) return undefined;
  return { root: normalizePitch(match[1]), minor: /minor|小调|^\s*(?:min\b|m(?:$|\s))/i.test(match[2]), suffix: match[2] };
}
function romanRoot(root: string, key: string): string {
  const parsed = parseKey(key);
  if (!parsed) return root;
  const degree = mod(LETTERS.indexOf(root[0]) - LETTERS.indexOf(parsed.root[0]), 7);
  const scale = parsed.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  let accidental = mod(pitchClass(root) - pitchClass(parsed.root) - scale[degree]);
  if (accidental > 6) accidental -= 12;
  return (accidental > 0 ? '#'.repeat(accidental) : 'b'.repeat(-accidental)) + ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][degree];
}
export function romanChord(label: string, key: string): string {
  const chord = parseChord(label);
  if (!chord || !parseKey(key)) return label;
  let degree = romanRoot(chord.root, key), quality = chord.quality;
  const diminished = /^(?:dim|°|o)/i.test(quality);
  const minor = /^(?:m(?!aj)|min|-)/i.test(quality);
  if (minor || diminished) degree = degree.toLowerCase();
  if (diminished) quality = quality.replace(/^(?:dim|°|o)/i, '°');
  else if (minor) quality = quality.replace(/^(?:min|m|-)/i, '');
  return degree + quality + (chord.bass ? '/' + romanRoot(chord.bass, key) : '');
}

interface Fingering { string: number; fret: number }
const OPEN_STRINGS = [43, 38, 33, 28]; // 1=G2, 2=D2, 3=A1, 4=E1.
function candidates(note: Note): Fingering[] {
  const choices: Fingering[] = [];
  if (!Number.isInteger(note.midi)) return choices;
  OPEN_STRINGS.forEach((open, i) => { const fret = note.midi - open; if (fret >= 0 && fret <= 20) choices.push({ string: i + 1, fret }); });
  if (note.locked && note.string !== undefined && note.fret !== undefined) {
    const manual = choices.find(choice => choice.string === note.string && choice.fret === note.fret);
    if (manual) return [manual];
  }
  return choices;
}
/** Dynamic programming chooses a playable path instead of assigning each pitch independently. */
export function assignTab(notes: Note[]): Note[] {
  const result = notes.map(note => { const copy = { ...note }; delete copy.string; delete copy.fret; return copy; });
  const order = notes.map((note, index) => ({ note, index })).sort((a, b) => a.note.start - b.note.start);
  let group: typeof order = [];
  function solve() {
    if (!group.length) return;
    const options = group.map(item => candidates(item.note));
    const costs: number[][] = [], paths: number[][] = [];
    options.forEach((choices, index) => {
      costs[index] = []; paths[index] = [];
      choices.forEach((choice, j) => {
        const positionCost = choice.fret * 0.055 + (choice.fret > 12 ? 0.2 : 0);
        if (!index) { costs[index][j] = positionCost; paths[index][j] = -1; return; }
        let best = Infinity, previous = 0;
        options[index - 1].forEach((prior, k) => {
          const move = Math.abs(choice.fret - prior.fret) * 0.75 + Math.abs(choice.string - prior.string) * 0.8;
          const cost = costs[index - 1][k] + move + positionCost;
          if (cost < best) { best = cost; previous = k; }
        });
        costs[index][j] = best; paths[index][j] = previous;
      });
    });
    let chosen = costs[costs.length - 1].indexOf(Math.min(...costs[costs.length - 1]));
    for (let i = group.length - 1; i >= 0; i--) { Object.assign(result[group[i].index], options[i][chosen]); chosen = paths[i][chosen]; }
    group = [];
  }
  for (const item of order) {
    if (!candidates(item.note).length) { solve(); continue; }
    if (group.length && item.note.start - (group[group.length - 1].note.start + group[group.length - 1].note.duration) > 2) solve();
    group.push(item);
  }
  solve();
  return result;
}
export function transposeProject(p: Project, steps: number): Project {
  const amount = Number.isFinite(steps) ? Math.round(steps) : 0;
  if (p.notes.some(note => !Number.isInteger(note.midi + amount) || note.midi + amount < 0 || note.midi + amount > 127)) {
    throw new RangeError('无法移调：音符将超出 MIDI 0–127 范围，请调整音符或移调方向。');
  }
  const parsed = parseKey(p.key);
  const key = parsed ? transposePitch(parsed.root, amount) + parsed.suffix : p.key;
  const target = parseKey(key);
  const flats = target ? target.root.includes('b') || ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'].includes(target.root) : undefined;
  const notes = p.notes.map(note => {
    const copy = { ...note, midi: note.midi + amount };
    const shiftedFret = (note.fret ?? -100) + amount;
    // A user's chosen string remains useful after transposition when that position is playable.
    if (note.locked && note.string !== undefined && note.fret !== undefined && OPEN_STRINGS[note.string - 1] + note.fret === note.midi && shiftedFret >= 0 && shiftedFret <= 20) {
      copy.fret = shiftedFret;
    } else { delete copy.string; delete copy.fret; }
    return copy;
  });
  // Revision is the server's persisted version, not a client edit counter.
  return { ...p, key, chords: p.chords.map(chord => ({ ...chord, label: shiftedChord(chord.label, amount, flats) })), bassEvents: p.bassEvents?.map(event => ({ ...event, pitchClass: mod(event.pitchClass + amount) })), notes: assignTab(notes), updatedAt: new Date().toISOString() };
}

export function parseLrc(text: string, duration: number): Lyric[] {
  const offsetMatch = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(text);
  const offset = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0;
  const entries: Array<{ text: string; start: number; order: number }> = [];
  const timestamp = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const tags = [...line.matchAll(timestamp)];
    if (!tags.length) continue;
    const content = line.replace(timestamp, '').replace(/\[(?:offset|ti|ar|al|by):[^\]]*\]/gi, '').trim();
    for (const tag of tags) {
      if (Number(tag[2]) >= 60) continue;
      const fraction = tag[3] ? Number('0.' + tag[3]) : 0;
      const start = Math.max(0, Number(tag[1]) * 60 + Number(tag[2]) + fraction + offset);
      if (Number.isFinite(duration) && duration > 0 && start >= duration) continue;
      entries.push({ text: content, start, order: entries.length });
    }
  }
  entries.sort((a, b) => a.start - b.start || a.order - b.order);
  const fallbackEnd = duration > 0 ? duration : (entries.at(-1)?.start ?? 0) + 5;
  return entries.map((entry, i) => {
    let next = i + 1;
    while (next < entries.length && Math.abs(entries[next].start - entry.start) < 1e-9) next++;
    return { id: `lyric-lrc-${i + 1}`, text: entry.text, start: entry.start, end: Math.max(entry.start, Math.min(fallbackEnd, entries[next]?.start ?? fallbackEnd)), source: 'manual' as const, locked: true };
  }).filter(lyric => lyric.text.length > 0);
}
function lrcStamp(time: number): string {
  const milliseconds = Math.round(Math.max(0, Number.isFinite(time) ? time : 0) * 1000);
  const minutes = Math.floor(milliseconds / 60000), seconds = Math.floor(milliseconds / 1000) % 60, fraction = milliseconds % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`;
}
export function toLrc(p: Project): string {
  const plain = (value: string) => value.replace(/[\r\n\[\]]/g, ' ');
  return [`[ti:${plain(p.title)}]`, `[ar:${plain(p.artist)}]`, ...[...p.lyrics].sort((a, b) => a.start - b.start).map(lyric => `[${lrcStamp(lyric.start)}]${lyric.text.replace(/[\r\n]/g, ' ')}`)].join('\n') + '\n';
}
export function formatTime(seconds: number): string {
  const value = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export interface ChordLabelLayout {
  items: Array<{ id: string; label: string; beat: number; left: number; width: number; anchor: number; row: number }>;
  rows: number;
}
/** Keep true beat anchors while packing readable labels into non-overlapping rows.
 * This function is deliberately self-contained so the portable HTML uses the same layout rule.
 */
export function layoutChordLabels(chords: Array<{ id: string; label: string; beat: number }>, beats: number, width: number, measure: (label: string) => number): ChordLabelLayout {
  const containerWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const beatCount = Number.isFinite(beats) && beats > 0 ? beats : 1;
  const lanes: Array<Array<{ left: number; right: number }>> = [];
  const items = chords.map((chord, order) => ({ ...chord, order })).sort((a, b) => a.beat - b.beat || a.order - b.order).map(chord => {
    const measured = measure(chord.label);
    const labelWidth = Math.min(containerWidth, Math.max(0, Number.isFinite(measured) ? measured : 0));
    const anchor = Math.min(containerWidth, Math.max(0, (chord.beat - 1) / beatCount * containerWidth));
    const left = Math.max(0, Math.min(anchor, containerWidth - labelWidth));
    const right = left + labelWidth;
    let row = lanes.findIndex(lane => lane.every(prior => right + 8 <= prior.left || left >= prior.right + 8));
    if (row < 0) { row = lanes.length; lanes.push([]); }
    lanes[row].push({ left, right });
    return { id: chord.id, label: chord.label, beat: chord.beat, left, width: labelWidth, anchor, row };
  });
  return { items, rows: lanes.length };
}

const escapeHtml = (text: unknown) => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
/** The document is self-contained; the reader may attach a local audio file for playback. */
export function copySectionChords(p: Project, source: Section, targetBar: number): Project {
  const length = source.endBar - source.startBar + 1;
  if (!Number.isInteger(targetBar) || targetBar < 1 || targetBar + length - 1 > barCount(p)) throw new Error('目标段落超出歌曲小节范围');
  const selected = p.chords.filter(chord => chord.bar >= source.startBar && chord.bar <= source.endBar);
  const end = targetBar + length - 1;
  const copied = selected.map(chord => ({ ...chord, id: crypto.randomUUID(), bar: targetBar + chord.bar - source.startBar, source: 'manual' as const, locked: true }));
  return { ...p, chords: [...p.chords.filter(chord => chord.bar < targetBar || chord.bar > end), ...copied].sort((a, b) => a.bar - b.bar || a.beat - b.beat) };
}

export function exportHtml(p: Project, mode: 'chart' | 'tab' | 'structure' = 'chart'): string {
  const size = beatsPerBar(p), count = barCount(p);
  const sections = displaySections(p);
  const visibleChords = displayChords(p);
  const sectionAt = (bar: number) => sections.find(section => bar >= section.startBar && bar <= section.endBar);
  let body = '';
  if (mode === 'structure') {
    body = `<div class="structure">${sections.map(section => `<button data-time="${positionToTime(p, section.startBar, 1)}"><strong>${escapeHtml(section.name)}</strong><span>${section.startBar}–${section.endBar} 小节 · ${section.endBar - section.startBar + 1} 小节</span></button>`).join('')}</div>`;
  } else {
    const notes = mode === 'tab' ? assignTab(p.notes.filter(note => !note.notation?.rest)) : [];
    for (let bar = 1; bar <= count; bar++) {
      const section = sectionAt(bar);
      if (section?.startBar === bar) body += `<h2>${escapeHtml(section.name)}</h2>`;
      const start = positionToTime(p, bar, 1), end = positionToTime(p, bar + 1, 1);
      const chordMarkup = visibleChords.filter(chord => chord.bar === bar).map(chord => `<button class="chord" style="left:${(chord.beat - 1) / size * 100}%" data-id="${escapeHtml(chord.id)}" data-label="${escapeHtml(chord.label)}" data-beat="${chord.beat}" data-time="${positionToTime(p, bar, chord.beat)}" title="第 ${chord.beat} 拍">${escapeHtml(chord.label)}<small>${escapeHtml(romanChord(chord.label, p.key))}</small></button>`).join('');
      const lines = Array.from({ length: size }, (_, i) => `<i style="left:${i / size * 100}%"><span>${i + 1}</span></i>`).join('');
      const laneEnds: number[] = [];
      const lyrics = lyricsForBar(p, bar).sort((a, b) => a.start - b.start).map(lyric => {
        const at = timeToPosition(p, Math.max(start, lyric.start));
        const left = Math.max(0, (at.beat - 1) / size * 100);
        const finish = timeToIndex(p, Math.min(end, Math.max(lyric.start, lyric.end))) - (bar - 1) * size;
        const width = Math.max(0.5, Math.min(100 - left, finish / size * 100 - left));
        let lane = laneEnds.findIndex(laneEnd => laneEnd <= lyric.start + 1e-8);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = Math.max(lyric.start, lyric.end);
        // Sequential fragments share a baseline; simultaneous/overlapping fragments use separate lanes.
        // Keep source times intact even when a fragment continues past the visible bar boundary.
        return `<button class="lyric" style="left:${left}%;width:${width}%;top:${lane * 32}px" data-lane="${lane}" data-time="${lyric.start}" data-start="${lyric.start}" data-end="${lyric.end}">${escapeHtml(lyric.text)}</button>`;
      }).join('');
      const tab = mode === 'tab' ? `<div class="tab">${['G', 'D', 'A', 'E'].map((name, i) => `<div class="string"><b>${name}</b>${notes.filter(note => note.start >= start && note.start < end && note.string === i + 1).map(note => `<button class="fret" style="left:${(timeToPosition(p, note.start).beat - 1) / size * 100}%" data-time="${note.start}">${note.fret}</button>`).join('')}</div>`).join('')}</div>${notes.filter(note => note.start >= start && note.start < end && note.string === undefined).map(note => `<span class="unplayable">音高 ${note.midi}：超出四弦 20 品范围</span>`).join('')}` : '';
      const markers = mode === 'chart' ? '' : p.markers.filter(marker => marker.time >= start && marker.time < end).map(marker => `<button class="marker" data-time="${marker.time}">${escapeHtml(marker.label)} ${escapeHtml(marker.text)}</button>`).join('');
      body += `<article class="bar" data-start="${start}" data-end="${end}"><header>第 ${bar} 小节</header><div class="beats" data-beats="${size}">${lines}${chordMarkup}</div>${tab}<div class="lyrics">${lyrics}</div>${markers}</article>`;
    }
  }
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(p.title)} · BassChart Studio</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f7f7f5;color:#171b22;font:16px system-ui,sans-serif}.page{max-width:1100px;margin:auto;padding:32px}h1{margin:0 0 8px}h2{font-size:20px;break-after:avoid}p{line-height:1.6}.controls{position:sticky;top:0;background:#f7f7f5;z-index:2;padding:12px 0;border-bottom:1px solid #ddd}audio{width:100%;margin-top:8px}.bar{display:inline-block;vertical-align:top;width:calc(50% - 12px);margin:6px;padding:12px;border:1px solid #c8cbd0;background:white;border-radius:8px;break-inside:avoid}.bar.active{outline:3px solid #d79b19}.bar header{font-size:12px;color:#667085;margin-bottom:8px}.beats{height:70px;position:relative;border-bottom:1px solid #ccd0d6}.beats i{position:absolute;height:100%;border-left:1px dashed #ddd;font-style:normal}.beats i span{position:absolute;bottom:3px;padding-left:4px;font-size:10px;color:#9298a3}button{font:inherit;cursor:pointer;border:0;background:none;text-align:left;color:inherit}.chord{position:absolute;top:8px;font-weight:700;padding:0 2px;white-space:normal;overflow-wrap:anywhere;max-width:100%;line-height:1.2}.chord:before{content:"";position:absolute;left:var(--chord-anchor,0px);top:-5px;width:2px;height:4px;background:#899a81}.chord small{display:block;color:#737c8a;font-weight:400;font-size:12px;margin-top:5px}.lyrics{position:relative;min-height:38px;margin-top:8px}.lyric{position:absolute;padding:3px 0;line-height:1.6;overflow-wrap:anywhere}.marker{color:#8f5d06;font-size:12px;margin:4px 0}.tab{padding:10px 0}.string{height:27px;border-bottom:1px solid #6c7480;position:relative;margin-left:16px}.string>b{position:absolute;left:-16px;font-size:12px;top:17px}.fret{position:absolute;top:16px;background:white;padding:0 4px;font:13px monospace;line-height:18px}.unplayable{font-size:12px;color:#aa3030}.structure{display:grid;gap:12px}.structure button{padding:18px;background:white;border:1px solid #ccd0d6;border-radius:6px}.structure span{display:block;color:#667085;margin-top:5px}@media(max-width:650px){.page{padding:16px}.bar{width:100%;margin:6px 0}}@media print{@page{margin:12mm}body{background:white;font-size:12px}.controls{display:none}.page{padding:0;orphans:1;widows:1}.page>h2{break-after:auto}.bar{border-color:#555}.bar.active{outline:none}.chord small{font-size:10px}}
  </style><main class="page"><h1>${escapeHtml(p.title)}</h1><p>${escapeHtml(p.artist)} · 原调 ${escapeHtml(p.originalKey)} · 演奏调 ${escapeHtml(p.key)} · ${p.bpm} BPM · ${escapeHtml(p.meter)} · ${count} 小节${mode === 'tab' ? ' · E–A–D–G' : ''}${p.isDemo ? ' · 示例工程' : ''}</p><div class="controls"><label>选择本机音频，点击小节、和弦或歌词定位播放： <input id="audioFile" type="file" accept="audio/*"></label><audio id="player" controls></audio><small>此曲谱文件不包含音频；选择与工程对应的原曲或贝斯音轨。</small></div>${body}</main><script>
  const layoutChordLabels=${layoutChordLabels.toString()};
  function measureChords(){document.querySelectorAll('.beats').forEach(container=>{const elements=[...container.querySelectorAll('.chord')];const byId=new Map(elements.map(item=>[item.dataset.id,item]));const widths=new Map();elements.forEach(item=>{item.style.width='max-content';item.style.maxWidth='none';widths.set(item.dataset.label,Math.max(widths.get(item.dataset.label)||0,item.getBoundingClientRect().width));});const base=Math.max(1,window.matchMedia('print').matches?Math.min(240,container.clientWidth):container.clientWidth);const layout=layoutChordLabels(elements.map(item=>({id:item.dataset.id,label:item.dataset.label,beat:Number(item.dataset.beat)})),Number(container.dataset.beats),base,label=>widths.get(label)||0);const heights=[];layout.items.forEach(placement=>{const item=byId.get(placement.id);item.style.left=placement.left/base*100+'%';item.style.width=placement.width/base*100+'%';item.style.maxWidth='100%';item.style.setProperty('--chord-anchor',(placement.anchor-placement.left)/Math.max(1,placement.width)*100+'%');item.dataset.row=placement.row;heights[placement.row]=Math.max(heights[placement.row]||0,item.getBoundingClientRect().height);});const tops=[];let total=8;heights.forEach((height,row)=>{tops[row]=total;total+=height+10;});layout.items.forEach(placement=>{byId.get(placement.id).style.top=tops[placement.row]+'px';});container.style.height=Math.max(70,total+18)+'px';});}
  function measureLyrics(){document.querySelectorAll('.lyrics').forEach(container=>{const items=[...container.querySelectorAll('.lyric')];const heights=[];items.forEach(item=>{const lane=Number(item.dataset.lane);heights[lane]=Math.max(heights[lane]||0,item.offsetHeight);});const tops=[];let total=0;heights.forEach((height,lane)=>{tops[lane]=total;total+=height+4;});items.forEach(item=>item.style.top=tops[Number(item.dataset.lane)]+'px');container.style.height=Math.max(38,total)+'px';});}function measureChart(){measureChords();measureLyrics();}measureChart();window.addEventListener('resize',measureChart);window.addEventListener('beforeprint',measureChart);window.addEventListener('afterprint',measureChart);window.matchMedia('print').addEventListener('change',measureChart);if(document.fonts)document.fonts.ready.then(measureChart);
  const player=document.getElementById('player');let objectUrl;document.getElementById('audioFile').addEventListener('change',event=>{const file=event.target.files[0];if(!file)return;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(file);player.src=objectUrl;});document.addEventListener('click',event=>{const item=event.target.closest('[data-time]');if(!item||!player.src)return;player.currentTime=Number(item.dataset.time);player.play().catch(()=>{});});player.addEventListener('timeupdate',()=>{document.querySelectorAll('.bar').forEach(bar=>bar.classList.toggle('active',player.currentTime>=Number(bar.dataset.start)&&player.currentTime<Number(bar.dataset.end)));});
  </script></html>`;
}
