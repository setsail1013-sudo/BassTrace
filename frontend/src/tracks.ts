/** Independent, immutable editing operations for the three score tracks. */
import { beatsPerBar, displaySections, positionToTime, timeToPosition, type Lyric, type ManualFill, type ManualFillNote, type Project } from './music.ts';
import { cleanFillNotation } from './fill-techniques';

const EPSILON = 1e-8;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Order is the original text order, deliberately independent of audio timestamps. */
export function orderedLyrics(p: Pick<Project, 'lyrics'>): Lyric[] {
  return p.lyrics.map((lyric, index) => ({ lyric, index }))
    .sort((a, b) => (Number.isFinite(a.lyric.order) ? a.lyric.order! : a.index) - (Number.isFinite(b.lyric.order) ? b.lyric.order! : b.index) || a.index - b.index)
    .map(item => item.lyric);
}

export function beatIndex(p: Project, time: number): number {
  const position = timeToPosition(p, time);
  return (position.bar - 1) * beatsPerBar(p) + position.beat - 1;
}
export function timeAtBeat(p: Project, index: number): number {
  const size = beatsPerBar(p), barIndex = Math.floor(index / size);
  return positionToTime(p, barIndex + 1, index - barIndex * size + 1);
}
function advanceBeats(p: Project, start: number, count: number): number {
  return timeAtBeat(p, beatIndex(p, start) + count);
}

export type LyricFootprints = Record<string, number>;
/** Text occupies beat-space, independently of LRC end times (which often include silence). */
export function moveLyricWithPush(p: Project, id: string, target: number, widths: LyricFootprints): Project {
  const list = orderedLyrics(p), index = list.findIndex(l => l.id === id);
  if (index < 0 || !Number.isFinite(target)) return p;
  const original = list[index], current = beatIndex(p, original.start);
  const width = (i: number) => Math.max(0, widths[list[i].id] ?? 0);
  const songStart = beatIndex(p, 0), songEnd = beatIndex(p, p.duration);
  const previousEnd = index ? beatIndex(p, list[index - 1].start) + width(index - 1) : songStart;
  // Existing overlapping text is not silently rearranged merely by clicking it.
  const minimum = Math.max(songStart, Math.min(current, previousEnd));
  let desired = Math.max(minimum, Math.min(songEnd, beatIndex(p, target)));
  if (Math.abs(desired - current) < EPSILON) return p;
  function trial(at: number): Map<string, number> | null {
    const shifts = new Map<string, number>();
    let left = at;
    for (let i = index; i < list.length; i++) {
      const lyric = list[i], oldLeft = beatIndex(p, lyric.start);
      if (i > index && left <= oldLeft + EPSILON) break;
      const start = timeAtBeat(p, left), delta = start - lyric.start;
      if (start < -EPSILON || lyric.end + delta > Math.max(p.duration, lyric.end) + EPSILON ||
          left + width(i) > Math.max(songEnd, oldLeft + width(i)) + EPSILON) return null;
      if (Math.abs(delta) > EPSILON) shifts.set(lyric.id, delta);
      // Moving earlier opens space; it never pulls later phrases into that space.
      if (at < current) break;
      left += width(i);
    }
    return shifts;
  }
  let shifts = trial(desired);
  if (!shifts && desired > current) {
    let low = current, high = desired;
    for (let n = 0; n < 48; n++) { const mid = (low + high) / 2; if (trial(mid)) low = mid; else high = mid; }
    desired = low; shifts = trial(desired);
  }
  if (!shifts?.size) return p;
  return { ...p, lyrics: p.lyrics.map(l => {
    const delta = shifts!.get(l.id);
    return delta === undefined ? l : { ...l, start: l.start + delta, end: l.end + delta, source: 'manual', locked: true };
  }) };
}

export function nudgeLyric(p: Project, id: string, beats: number, widths: LyricFootprints): Project {
  const lyric = p.lyrics.find(l => l.id === id);
  return lyric ? moveLyricWithPush(p, id, timeAtBeat(p, beatIndex(p, lyric.start) + beats), widths) : p;
}

export function setFillDigit(p: Project, groupId: string, noteId: string, digit: number): Project {
  if (!Number.isInteger(digit) || digit < 0 || digit > 7) return p;
  const group = p.manualFills?.find(g => g.id === groupId), note = group?.notes.find(n => n.id === noteId);
  if (!group || !note || note.digit === digit) return p;
  return replaceFill(p, { ...group, notes: group.notes.map(n => n.id === noteId ? { ...n, digit, octave: digit === 0 ? 0 : n.octave } : n) }, groupId);
}

export interface PackLyricsOptions {
  rowWidth: number; barsPerRow: number; fontSize: number;
  measureText?: (text: string) => number;
}
/** TXT is packed once in measured display space, then persisted as audio seconds. */
export function packTxtLyrics(p: Project, raw: string, opts: PackLyricsOptions, idFactory: () => string = () => crypto.randomUUID()): Lyric[] {
  if (!Number.isFinite(opts.rowWidth) || opts.rowWidth <= 0 || !Number.isFinite(opts.fontSize) || opts.fontSize <= 0 || !Number.isInteger(opts.barsPerRow) || opts.barsPerRow <= 0)
    throw new RangeError('歌词初排需要有效的谱面宽度、字号和每行小节数。');
  const lines = raw.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).filter(line => line.trim().length > 0);
  const rowEnd = Math.min(p.duration, positionToTime(p, opts.barsPerRow + 1, 1));
  const span = beatIndex(p, rowEnd) - beatIndex(p, 0);
  const pixelsPerBeat = opts.rowWidth / Math.max(EPSILON, span);
  const measured = opts.measureText ?? ((text: string) => Array.from(text).reduce((width, character) => width + opts.fontSize * (/\s/u.test(character) ? .33 : /[\u0000-\u007f]/u.test(character) ? .55 : 1), 0));
  let cursor = 0;
  const result = lines.map((text, order): Lyric => {
    const width = measured(text);
    if (!Number.isFinite(width) || width < 0) throw new RangeError('无法计算歌词宽度，请检查导入内容。');
    const start = cursor;
    cursor = advanceBeats(p, cursor, Math.max(width, opts.fontSize * .33) / pixelsPerBeat);
    return { id: idFactory(), text, start, end: cursor, order, source: 'manual', locked: true };
  });
  if (cursor > p.duration + EPSILON) throw new RangeError('歌词紧排超出了歌曲时长。请减少字号或增加谱面宽度后重新导入；原歌词未被替换。');
  return result;
}

/** DOM carets are UTF-16 offsets; do not split inside a surrogate pair. */
function safeCaret(text: string, caret: number): number {
  let offset = clamp(Math.trunc(caret), 0, text.length);
  if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset])) offset--;
  return offset;
}

export function splitLyric(p: Project, id: string, caret: number, newId: string, editedText?: string): Project {
  const lyrics = orderedLyrics(p), index = lyrics.findIndex(lyric => lyric.id === id);
  if (index < 0) return p;
  if (p.lyrics.some(lyric => lyric.id === newId)) throw new RangeError('歌词片段标识重复。');
  const lyric = lyrics[index], text = editedText ?? lyric.text, offset = safeCaret(text, caret);
  if (offset <= 0 || offset >= text.length || lyric.end <= lyric.start) return p;
  const left = text.slice(0, offset), right = text.slice(offset);
  const boundary = lyric.start + (lyric.end - lyric.start) * Array.from(left).length / Array.from(text).length;
  lyrics.splice(index, 1, { ...lyric, text: left, end: boundary, source: 'manual', locked: true },
    { ...lyric, id: newId, text: right, start: boundary, source: 'manual', locked: true });
  const lyricAnchors=(p.lyricAnchors??[]).flatMap(a=>{
    if(a.lyricId!==id)return [a];
    if(text.slice(a.startOffset,a.endOffset)!==a.text)return [];
    if(a.endOffset<=offset)return [a];
    if(a.startOffset>=offset)return [{...a,lyricId:newId,startOffset:a.startOffset-offset,endOffset:a.endOffset-offset}];
    return [{...a,endOffset:offset,text:text.slice(a.startOffset,offset)},
      {...a,id:`${a.id.slice(0,90)}-split`,lyricId:newId,startOffset:0,endOffset:a.endOffset-offset,text:text.slice(offset,a.endOffset)}];
  });
  return { ...p, lyricAnchors, lyrics: lyrics.map((item, order) => ({ ...item, order })) };
}

export function mergeLyricPrevious(p: Project, id: string, editedText?: string): Project {
  const lyrics = orderedLyrics(p), index = lyrics.findIndex(lyric => lyric.id === id);
  if (index < 1) return p;
  const current = lyrics[index], previous = lyrics[index - 1];
  lyrics.splice(index - 1, 2, { ...previous, text: previous.text + (editedText ?? current.text),
    start: Math.min(previous.start, current.start), end: Math.max(previous.end, current.end), source: 'manual', locked: true });
  const lyricAnchors=(p.lyricAnchors??[]).flatMap(a=>a.lyricId!==id?[a]:
    (editedText??current.text).slice(a.startOffset,a.endOffset)===a.text?[{...a,lyricId:previous.id,startOffset:a.startOffset+previous.text.length,endOffset:a.endOffset+previous.text.length}]:[]);
  return { ...p, lyricAnchors, lyrics: lyrics.map((item, order) => ({ ...item, order })) };
}

function checkLines(lines: number): asserts lines is 0 | 1 | 2 {
  if (![0, 1, 2].includes(lines)) throw new RangeError('下划线数量必须为 0、1 或 2。');
}
/** Grid beats use the meter denominator; each undivided note is one quarter note. */
function noteEnd(p: Project, start: number, lines: 0 | 1 | 2): number {
  const denominator = Number(/^\d+\/(\d+)$/.exec(p.meter)?.[1] || 4);
  return advanceBeats(p, start, denominator / 4 / 2 ** lines);
}
function ensureFillFits(p: Project, notes: ManualFillNote[]): void {
  if (notes.some(note => !Number.isFinite(note.start) || !Number.isFinite(note.end) || note.start < -EPSILON || note.end <= note.start || note.end > p.duration + EPSILON))
    throw new RangeError('这一组加花超出了歌曲时长。请向前移动或缩短时值；已有加花未被修改。');
}
function replaceFill(p: Project, updated: ManualFill | undefined, id: string): Project {
  return { ...p, manualFills: (p.manualFills ?? []).flatMap(group => group.id === id ? (updated ? [cleanFillNotation(updated)] : []) : [group]) };
}
/** Reflow only the selected suffix in one group, keeping earlier notes and other groups. */
function reflowFill(p: Project, group: ManualFill, from: number, start: number, firstLines?: 0 | 1 | 2): ManualFill {
  let cursor = start;
  const notes = group.notes.map((note, index) => {
    if (index < from) return note;
    const lines = index === from && firstLines !== undefined ? firstLines : note.lines;
    const end = noteEnd(p, cursor, lines), next = { ...note, start: cursor, end, lines };
    cursor = end;
    return next;
  });
  ensureFillFits(p, notes);
  return { ...group, notes };
}

export function addManualFill(p: Project, time: number, digits: string, groupId: string, noteIds: string[]): Project {
  if (!/^[0-7]+$/.test(digits) || noteIds.length !== digits.length || new Set(noteIds).size !== noteIds.length)
    throw new RangeError('请输入 0–7 的数字，并为每个数字提供独立标识。');
  if ((p.manualFills ?? []).some(group => group.id === groupId || group.notes.some(note => noteIds.includes(note.id))))
    throw new RangeError('加花标识重复。');
  const group: ManualFill = { id: groupId, notes: Array.from(digits, (digit, index) => ({ id: noteIds[index], digit: Number(digit), start: time, end: time, lines: 0, octave: 0 })) };
  const filled = reflowFill(p, group, 0, time);
  return { ...p, manualFills: [...(p.manualFills ?? []), filled] };
}

export function setFillLines(p: Project, groupId: string, noteId: string, lines: 0 | 1 | 2): Project {
  return setFillLinesBatch(p, [{ group: groupId, note: noteId }], lines);
}

export type FillTarget = { group: string; note: string };
/** Calculate every group before returning, so a failed group cannot partially apply an edit. */
export function setFillLinesBatch(p: Project, selection: FillTarget[], lines: 0 | 1 | 2 | { delta: -1 | 1 }): Project {
  if (typeof lines === 'number') checkLines(lines);
  const ids = new Set(selection.map(item => `${item.group}\u0000${item.note}`));
  let changed = false;
  const manualFills = (p.manualFills ?? []).map(group => {
    const notes = group.notes.map(note => {
      if (!ids.has(`${group.id}\u0000${note.id}`)) return note;
      const next = typeof lines === 'number' ? lines : Math.max(0, Math.min(2, note.lines + lines.delta)) as 0 | 1 | 2;
      return next === note.lines ? note : { ...note, lines: next };
    });
    const from = notes.findIndex((note, index) => note !== group.notes[index]);
    if (from < 0) return group;
    changed = true;
    return cleanFillNotation(reflowFill(p, { ...group, notes }, from, notes[from].start));
  });
  return changed ? { ...p, manualFills } : p;
}

export function deleteFillNotes(p: Project, selection: FillTarget[]): Project {
  const ids = new Set(selection.map(item => `${item.group}\u0000${item.note}`));
  let changed = false;
  const manualFills = (p.manualFills ?? []).flatMap(group => {
    const notes = group.notes.filter(note => !ids.has(`${group.id}\u0000${note.id}`));
    if (notes.length === group.notes.length) return [group];
    changed = true;
    return notes.length ? [cleanFillNotation({ ...group, notes })] : [];
  });
  return changed ? { ...p, manualFills } : p;
}

export function setFillOctave(p: Project, groupId: string, noteId: string, octave: number): Project {
  if (!Number.isInteger(octave) || octave < -2 || octave > 2) throw new RangeError('八度点数量应为 -2 到 2。');
  const group = p.manualFills?.find(item => item.id === groupId), index = group?.notes.findIndex(note => note.id === noteId) ?? -1;
  if (!group || index < 0 || group.notes[index].octave === octave) return p;
  return replaceFill(p, { ...group, notes: group.notes.map((note, i) => i === index ? { ...note, octave } : note) }, groupId);
}

export function deleteFillNote(p: Project, groupId: string, noteId: string): Project {
  return deleteFillNotes(p, [{ group: groupId, note: noteId }]);
}

export function moveManualFill(p: Project, groupId: string, target: number): Project {
  const group = p.manualFills?.find(item => item.id === groupId);
  if (!group?.notes.length || !Number.isFinite(target)) return p;
  const start = Math.min(...group.notes.map(note => note.start)), end = Math.max(...group.notes.map(note => note.end));
  if (end - start > p.duration + EPSILON) return p;
  const delta = clamp(target - start, -start, p.duration - end);
  if (Math.abs(delta) < EPSILON) return p;
  return replaceFill(p, { ...group, notes: group.notes.map(note => ({ ...note, start: note.start + delta, end: note.end + delta })) }, groupId);
}

export interface ScoreRow { sectionId: string; startBar: number; endBar: number }
export function scoreRows(p: Project, barsPerRow: number): ScoreRow[] {
  const width = Math.max(1, Math.floor(barsPerRow) || 4), rows: ScoreRow[] = [];
  for (const section of displaySections(p)) {
    for (let start = section.startBar; start <= section.endBar; start += width)
      rows.push({ sectionId: section.id, startBar: start, endBar: Math.min(section.endBar, start + width - 1) });
  }
  return rows;
}
function rowBeatBounds(p: Project, startBar: number, endBar: number): [number, number] {
  const start = startBar === 1 ? 0 : positionToTime(p, startBar, 1);
  const end = Math.min(p.duration, positionToTime(p, endBar + 1, 1));
  return [beatIndex(p, start), beatIndex(p, end)];
}
/** Percent coordinates follow the beat grid, including tempo changes and pickups. */
export function rowTimePercent(p: Project, startBar: number, endBar: number, time: number): number {
  const [start, end] = rowBeatBounds(p, startBar, endBar);
  return end > start ? (beatIndex(p, time) - start) / (end - start) * 100 : 0;
}
export function rowPercentTime(p: Project, startBar: number, endBar: number, percent: number): number {
  const [start, end] = rowBeatBounds(p, startBar, endBar);
  return timeAtBeat(p, start + (end - start) * percent / 100);
}
