/** Lyric-aligned guitar chords from `POST /api/projects/{id}/chords/import-pdf`.

The saved project is the source of truth. Import writes `guitarChords` on the
server and returns that project. `candidate` chords are 待校对 and are not
accepted accuracy. `confirmed` and `manual` chords survive re-import.
`charOffset` is a Unicode code point index, the same count as Python `len`.
 */
import type { GuitarChord, GuitarChordSource, GuitarChordStatus, Lyric, Project } from './music.ts';

export const GUITAR_CHORD_IMPORT_PATH = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/chords/import-pdf`;
export const GUITAR_CHORD_PATCH_PATH = (projectId: string, chordId: string) => `/api/projects/${encodeURIComponent(projectId)}/guitar-chords/${encodeURIComponent(chordId)}`;

/** Shown with every successful import. The server returns this exact sentence. */
export const GUITAR_CHORD_IMPORT_NOTE = '这些和弦来自本地版面提取，尚未经过人工核对，不能视为已验收的识别准确率。';

export interface GuitarChordImportResult {
  note: string;
  warnings: string[];
  added: GuitarChord[];
  preservedIds: string[];
  untimedIds: string[];
  project: Project;
}

export interface GuitarChordPatchBody {
  symbol?: string;
  section?: string | null;
  lyricId?: string | null;
  charOffset?: number | null;
  start?: number | null;
  end?: number | null;
  bar?: number | null;
  beat?: number | null;
  status?: GuitarChordStatus;
  revision: number;
}

export interface PlacedGuitarChord {
  id: string;
  symbol: string;
  lyricId: string;
  charOffset: number;
  token: string;
  status: GuitarChordStatus;
  leftRatio: number;
  widthRatio: number;
  section: string | null;
  /** Visible status. A candidate is never labeled as accepted. */
  label: '待校对' | '已确认' | '已手改';
}

export class GuitarChordRequestError extends Error {
  readonly detail: string;
  readonly status: number;
  constructor(detail: string, status = 0) {
    super(detail);
    this.name = 'GuitarChordRequestError';
    this.detail = detail;
    this.status = status;
  }
}

const NETWORK_DETAIL = '暂时无法连接本地服务，没有改动现有内容。';
const EMPTY_FILE_DETAIL = '和弦谱文件为空。';

export function guitarChordStatusLabel(status: GuitarChordStatus): PlacedGuitarChord['label'] {
  if (status === 'confirmed') return '已确认';
  if (status === 'manual') return '已手改';
  return '待校对';
}

export function isProtectedGuitarChord(chord: Pick<GuitarChord, 'status'>): boolean {
  return chord.status === 'confirmed' || chord.status === 'manual';
}

export function codePoints(text: string): string[] {
  return Array.from(text);
}

function unitWidth(character: string): number {
  if (/\s/u.test(character)) return 0.33;
  if (/^[\u0000-\u007f]$/u.test(character)) return 0.55;
  return 1;
}

/** `charOffset` selects one code point. Ordinary CJK indexes match a JavaScript index. */
export function lyricCharacterAt(text: string, charOffset: number): { token: string; leftRatio: number; widthRatio: number } | null {
  const chars = codePoints(text);
  if (!Number.isInteger(charOffset) || charOffset < 0 || charOffset >= chars.length) return null;
  const widths = chars.map(unitWidth);
  const total = widths.reduce((sum, width) => sum + width, 0) || 1;
  const start = widths.slice(0, charOffset).reduce((sum, width) => sum + width, 0);
  return { token: chars[charOffset], leftRatio: start / total, widthRatio: widths[charOffset] / total };
}

export function stepGuitarChordOffset(text: string, charOffset: number, direction: -1 | 1): number | null {
  const chars = codePoints(text);
  if (!chars.length) return null;
  const next = charOffset + direction;
  return next >= 0 && next < chars.length ? next : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseStoredGuitarChord(entry: unknown): GuitarChord | null {
  if (!entry || typeof entry !== 'object') return null;
  const row = entry as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id.trim()) return null;
  if (typeof row.symbol !== 'string' || !row.symbol.trim() || row.symbol.length > 40) return null;
  if (row.status !== 'candidate' && row.status !== 'confirmed' && row.status !== 'manual') return null;
  if (row.source !== 'pdf' && row.source !== 'manual') return null;
  const section = typeof row.section === 'string' && row.section.trim() ? row.section : null;
  const lyricId = typeof row.lyricId === 'string' && row.lyricId ? row.lyricId : null;
  const charOffset = Number.isInteger(row.charOffset) && (row.charOffset as number) >= 0 ? row.charOffset as number : null;
  return {
    id: row.id,
    symbol: row.symbol,
    section,
    lyricId,
    charOffset,
    start: finiteOrNull(row.start),
    end: finiteOrNull(row.end),
    bar: Number.isInteger(row.bar) && (row.bar as number) >= 1 ? row.bar as number : null,
    beat: finiteOrNull(row.beat),
    status: row.status,
    source: row.source as GuitarChordSource,
  };
}

/** A project saved before guitar chords existed opens with an empty list. */
export function readGuitarChords(project: { guitarChords?: unknown }): GuitarChord[] {
  if (!Array.isArray(project.guitarChords)) return [];
  const seen = new Set<string>();
  const chords: GuitarChord[] = [];
  for (const entry of project.guitarChords) {
    const chord = parseStoredGuitarChord(entry);
    if (!chord || seen.has(chord.id)) continue;
    seen.add(chord.id);
    chords.push(chord);
  }
  return chords;
}

export function normalizeGuitarChords<T extends Project>(project: T): T {
  return { ...project, guitarChords: readGuitarChords(project) };
}

export function placeGuitarChord(lyric: Pick<Lyric, 'id' | 'text'>, chord: GuitarChord): PlacedGuitarChord | null {
  if (!chord.lyricId || chord.lyricId !== lyric.id || chord.charOffset === null) return null;
  const at = lyricCharacterAt(lyric.text, chord.charOffset);
  if (!at) return null;
  return {
    id: chord.id,
    symbol: chord.symbol,
    lyricId: lyric.id,
    charOffset: chord.charOffset,
    token: at.token,
    status: chord.status,
    leftRatio: at.leftRatio,
    widthRatio: at.widthRatio,
    section: chord.section,
    label: guitarChordStatusLabel(chord.status),
  };
}

export function guitarChordsOnLyric(project: Pick<Project, 'guitarChords'>, lyric: Pick<Lyric, 'id' | 'text'>): PlacedGuitarChord[] {
  return readGuitarChords(project).flatMap(chord => {
    const placed = placeGuitarChord(lyric, chord);
    return placed ? [placed] : [];
  });
}

export function isGuitarChordPlaced(project: Project, chord: GuitarChord): boolean {
  const lyric = project.lyrics.find(item => item.id === chord.lyricId);
  return !!lyric && !!placeGuitarChord(lyric, chord);
}

export function guitarChordMarkStyle(lyricLeftPercent: number, lyricWidthPercent: number, lyricTop: number, mark: PlacedGuitarChord): { left: string; top: number } {
  return {
    left: `calc(${lyricLeftPercent}% + ${mark.leftRatio} * ${lyricWidthPercent}%)`,
    top: Math.max(0, lyricTop - 34),
  };
}

/** Use the saved project from import. Do not merge again or invent times. */
export function projectFromGuitarChordImport(result: GuitarChordImportResult): Project {
  return normalizeGuitarChords(result.project);
}

export function deleteGuitarChord(project: Project, id: string): Project {
  const chords = readGuitarChords(project);
  if (!chords.some(chord => chord.id === id)) return project;
  return { ...project, guitarChords: chords.filter(chord => chord.id !== id) };
}

/**
 * A split changes the original lyric text, so the server drops links that stay
 * on that id. A chord whose character moves into the new lyric keeps that character.
 * `utf16Split` is the lyric editor caret; guitar offsets count code points.
 */
export function retargetGuitarChordsAfterSplit(chords: GuitarChord[] | undefined, lyricId: string, utf16Split: number, originalText: string, newLyricId: string): GuitarChord[] | undefined {
  if (!chords?.length) return chords;
  const splitAt = codePoints(originalText.slice(0, utf16Split)).length;
  return chords.map(chord => {
    if (chord.lyricId !== lyricId || chord.charOffset === null) return chord;
    if (chord.charOffset >= splitAt) return { ...chord, lyricId: newLyricId, charOffset: chord.charOffset - splitAt };
    return { ...chord, lyricId: null, charOffset: null };
  });
}

/** Merging changes both lyric texts, so both links are released instead of slid onto a different character. */
export function retargetGuitarChordsAfterMerge(chords: GuitarChord[] | undefined, previousId: string, mergedId: string): GuitarChord[] | undefined {
  if (!chords?.length) return chords;
  return chords.map(chord => chord.lyricId === previousId || chord.lyricId === mergedId ? { ...chord, lyricId: null, charOffset: null } : chord);
}

export function guitarChordFailureDetail(body: unknown, fallback = '和弦谱请求失败，没有改动现有内容。'): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
    if (detail !== undefined && detail !== null) return JSON.stringify(detail);
  }
  return fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function parseGuitarChordImportResult(body: unknown): GuitarChordImportResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GuitarChordRequestError('和弦谱导入没有返回结果，没有改动现有内容。', 200);
  const record = body as Record<string, unknown>;
  if (!record.project || typeof record.project !== 'object' || Array.isArray(record.project)) {
    throw new GuitarChordRequestError('和弦谱导入没有返回工程，没有改动现有内容。', 200);
  }
  const project = normalizeGuitarChords(record.project as Project);
  return {
    note: typeof record.note === 'string' && record.note.trim() ? record.note : GUITAR_CHORD_IMPORT_NOTE,
    warnings: stringList(record.warnings),
    added: readGuitarChords({ guitarChords: record.added }),
    preservedIds: stringList(record.preservedIds),
    untimedIds: stringList(record.untimedIds),
    project,
  };
}

export function parseGuitarChordPatchResult(body: unknown): { chord: GuitarChord; project: Project } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GuitarChordRequestError('保存吉他和弦没有返回结果，没有改动现有内容。', 200);
  const record = body as Record<string, unknown>;
  const project = record.project && typeof record.project === 'object' && !Array.isArray(record.project) ? normalizeGuitarChords(record.project as Project) : null;
  const chord = parseStoredGuitarChord(record.chord);
  if (!project || !chord) throw new GuitarChordRequestError('保存吉他和弦没有返回工程，没有改动现有内容。', 200);
  return { chord, project };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function requestJson(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, credentials: 'include' });
  } catch {
    throw new GuitarChordRequestError(NETWORK_DETAIL, 0);
  }
  const body = await readBody(response);
  if (!response.ok) throw new GuitarChordRequestError(guitarChordFailureDetail(body), response.status);
  return body;
}

export async function importGuitarChordPdf(projectId: string, file: File, fetchImpl: typeof fetch = globalThis.fetch): Promise<GuitarChordImportResult> {
  if (!file.size) throw new GuitarChordRequestError(EMPTY_FILE_DETAIL, 400);
  const body = new FormData();
  body.append('file', file, file.name);
  const payload = await requestJson(GUITAR_CHORD_IMPORT_PATH(projectId), { method: 'POST', body }, fetchImpl);
  return parseGuitarChordImportResult(payload);
}

export async function patchGuitarChord(projectId: string, chordId: string, patch: GuitarChordPatchBody, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ chord: GuitarChord; project: Project }> {
  const payload = await requestJson(GUITAR_CHORD_PATCH_PATH(projectId, chordId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }, fetchImpl);
  return parseGuitarChordPatchResult(payload);
}
