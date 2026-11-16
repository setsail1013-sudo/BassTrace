/** Lyric-aligned guitar chords.

These are not the top-track bass names (`bassEvents`) and not the legacy
harmony list (`chords`). A chord is drawn above the lyric character named by
`alignment`. Import results stay `pending` until the user confirms or edits them.

Backend contract this client consumes (the route may not exist yet):

`POST /api/projects/{projectId}/guitar-chords/import`

- `credentials: "include"` so a local 127.0.0.1 service on another port still
  receives the session cookie. The app calls the same-origin `/api` path, which
  the dev server proxies to `127.0.0.1:8000`.
- `multipart/form-data` with `file` (PDF) and `revision` (current project revision).
- Do not set Content-Type; the browser supplies the multipart boundary.
- Success `200` is candidates only. This client forces `proof: "pending"` even
  if a payload says otherwise. It does not treat the response as a full Project.
- Error JSON uses FastAPI's `detail` string (Chinese) plus optional `code`:
  `unreadable_pdf`, `lyrics_mismatch`, `wrong_song`, `parse_error`.
- The merge keeps confirmed guitar chords and does not rewrite lyrics, bass
  notes, fills, or the top-track chord list. Pending guitar chords may be replaced.
- Persistence: `PUT /api/projects/{id}` should store and return optional
  `guitarChords` and `guitarChordImport`. Until that field exists, the client
  keeps the in-memory track and a local cache when the response omits it.
 */
import type { GuitarChord, GuitarChordAlignment, GuitarChordImportMeta, GuitarChordProof, Lyric, Project } from './music.ts';

export interface GuitarChordCandidate {
  id?: string;
  symbol: string;
  lyricId?: string;
  charOffset?: number;
  token?: string;
  time?: number;
  section?: string;
}

export interface GuitarChordImportResult {
  importId: string;
  filename?: string;
  importedAt: string;
  status: 'pending';
  warning?: string;
  chords: GuitarChordCandidate[];
}

export interface PlacedGuitarChord {
  id: string;
  symbol: string;
  lyricId: string;
  charOffset: number;
  token: string;
  proof: GuitarChordProof;
  leftRatio: number;
  widthRatio: number;
  section?: string;
  /** Visible proof label. Pending is never an acceptance claim. */
  label: '待校对' | '已校对';
}

export class GuitarChordImportError extends Error {
  readonly detail: string;
  readonly code: string;
  constructor(detail: string, code = 'parse_error') {
    super(detail);
    this.name = 'GuitarChordImportError';
    this.detail = detail;
    this.code = code;
  }
}

export const GUITAR_CHORD_IMPORT_PATH = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/guitar-chords/import`;

export const GUITAR_CHORD_FAILURES = {
  unreadable_pdf: '这份 PDF 是打印件，没有可提取的文字，无法读取和弦。',
  lyrics_mismatch: '谱面歌词和当前工程的歌词对不上，已停止导入，没有改动现有内容。',
  wrong_song: '这份和弦谱不像当前这首歌，已停止导入，没有改动现有内容。',
  parse_error: '和弦谱解析失败，没有改动现有歌词、贝斯音名或已校对和弦。',
  not_ready: '和弦谱导入接口尚未就绪。没有改动现有歌词、贝斯音名或和弦。',
  network: '暂时无法连接本地服务，没有改动现有歌词、贝斯音名或和弦。',
  empty_file: '这个 PDF 是空文件，没有改动现有内容。',
  not_pdf: '请选择 PDF 和弦谱。这次没有上传，也没有改动现有内容。',
} as const;

const CACHE_PREFIX = 'basstrace.guitar-chords.v1.';

export interface GuitarChordStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function guitarChordStatusLabel(proof: GuitarChordProof): '待校对' | '已校对' {
  return proof === 'confirmed' ? '已校对' : '待校对';
}

/** Root letter plus a quality such as m, 7, maj7, sus4, or a slash bass. */
export function normalizeGuitarChordSymbol(symbol: string): string | null {
  const trimmed = symbol.trim();
  if (!trimmed || trimmed.length > 40 || /\s/u.test(trimmed)) return null;
  const match = /^([A-Ga-g])([#b♯♭]?)(.*)$/u.exec(trimmed);
  if (!match) return null;
  const rest = match[3];
  if (rest && !/^[A-Za-z0-9#b♯♭()+\-/]+$/u.test(rest)) return null;
  return match[1].toUpperCase() + match[2].replace('♯', '#').replace('♭', 'b') + rest;
}

export function rejectChordChartFile(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  const name = file.name.toLowerCase();
  if (!name.endsWith('.pdf') && file.type !== 'application/pdf') return GUITAR_CHORD_FAILURES.not_pdf;
  if (!file.size) return GUITAR_CHORD_FAILURES.empty_file;
  return null;
}

function isHighSurrogate(char: string | undefined): boolean {
  return !!char && char.charCodeAt(0) >= 0xD800 && char.charCodeAt(0) <= 0xDBFF;
}
function isLowSurrogate(char: string | undefined): boolean {
  return !!char && char.charCodeAt(0) >= 0xDC00 && char.charCodeAt(0) <= 0xDFFF;
}
function unitWidth(character: string): number {
  if (/\s/u.test(character)) return 0.33;
  if (/^[\u0000-\u007f]$/u.test(character)) return 0.55;
  return 1;
}

/** Cumulative display width at each UTF-16 index, using the lyric packer's character weights. */
function widthPrefix(text: string): number[] {
  const prefix = [0];
  let index = 0;
  let total = 0;
  while (index < text.length) {
    const size = isHighSurrogate(text[index]) && isLowSurrogate(text[index + 1]) ? 2 : 1;
    total += unitWidth(text.slice(index, index + size));
    for (let step = 0; step < size; step++) prefix.push(total);
    index += size;
  }
  return prefix;
}

export function lyricCharacterAt(text: string, charOffset: number): { token: string; leftRatio: number; widthRatio: number } | null {
  if (!Number.isInteger(charOffset) || charOffset < 0 || charOffset >= text.length) return null;
  if (isLowSurrogate(text[charOffset]) && isHighSurrogate(text[charOffset - 1])) return null;
  const size = isHighSurrogate(text[charOffset]) && isLowSurrogate(text[charOffset + 1]) ? 2 : 1;
  const prefix = widthPrefix(text);
  const total = prefix[text.length] || 1;
  const start = prefix[charOffset] ?? 0;
  const end = prefix[charOffset + size] ?? start;
  return { token: text.slice(charOffset, charOffset + size), leftRatio: start / total, widthRatio: Math.max(0, end - start) / total };
}

export function stepGuitarChordOffset(text: string, charOffset: number, direction: -1 | 1): number | null {
  if (!text.length) return null;
  if (direction > 0) {
    const current = lyricCharacterAt(text, charOffset);
    const next = charOffset + (current?.token.length ?? 1);
    return lyricCharacterAt(text, next) ? next : null;
  }
  if (charOffset <= 0) return null;
  let previous = charOffset - 1;
  if (isLowSurrogate(text[previous]) && isHighSurrogate(text[previous - 1])) previous -= 1;
  return lyricCharacterAt(text, previous) ? previous : null;
}

function parseAlignment(value: unknown): GuitarChordAlignment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.lyricId !== 'string' || !row.lyricId || !Number.isInteger(row.charOffset) || (row.charOffset as number) < 0) return undefined;
  if (typeof row.token !== 'string' || !row.token) return undefined;
  return { lyricId: row.lyricId, charOffset: row.charOffset as number, token: row.token };
}

function parseStoredGuitarChord(entry: unknown): GuitarChord | null {
  if (!entry || typeof entry !== 'object') return null;
  const row = entry as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id.trim()) return null;
  const symbol = typeof row.symbol === 'string' ? normalizeGuitarChordSymbol(row.symbol) : null;
  if (!symbol) return null;
  if (row.proof !== 'pending' && row.proof !== 'confirmed') return null;
  if (row.source !== 'import' && row.source !== 'manual') return null;
  return {
    id: row.id,
    symbol,
    proof: row.proof,
    source: row.source,
    alignment: parseAlignment(row.alignment),
    time: typeof row.time === 'number' && Number.isFinite(row.time) ? row.time : undefined,
    section: typeof row.section === 'string' && row.section.trim() ? row.section.trim().slice(0, 40) : undefined,
    importId: typeof row.importId === 'string' && row.importId ? row.importId : undefined,
  };
}

/** Missing or malformed chord data opens as an empty track instead of failing the project. */
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

export function readGuitarChordImport(project: { guitarChordImport?: unknown }): GuitarChordImportMeta | null {
  const value = project.guitarChordImport;
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.importId !== 'string' || !row.importId.trim()) return null;
  return {
    importId: row.importId.trim(),
    filename: typeof row.filename === 'string' ? row.filename : undefined,
    importedAt: typeof row.importedAt === 'string' ? row.importedAt : '',
    status: 'pending',
    warning: typeof row.warning === 'string' ? row.warning : undefined,
  };
}

function browserStore(): GuitarChordStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__basstrace_guitar_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

function readCache(store: GuitarChordStore | null, projectId: string): { guitarChords: GuitarChord[]; guitarChordImport: GuitarChordImportMeta | null } | null {
  if (!store) return null;
  try {
    const raw = store.getItem(CACHE_PREFIX + projectId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { guitarChords?: unknown; guitarChordImport?: unknown };
    return { guitarChords: readGuitarChords(parsed), guitarChordImport: readGuitarChordImport(parsed) };
  } catch {
    return null;
  }
}

export function cacheGuitarChords(project: Pick<Project, 'id' | 'guitarChords' | 'guitarChordImport'>, store: GuitarChordStore | null = browserStore()): void {
  if (!store || !project.id) return;
  try {
    store.setItem(CACHE_PREFIX + project.id, JSON.stringify({
      guitarChords: readGuitarChords(project),
      guitarChordImport: readGuitarChordImport(project),
    }));
  } catch {
    /* a full cache must not block editing */
  }
}

/** Keep guitar chords when a server payload was saved by a backend that does not know this field yet. */
export function projectFromServer(previous: Project | null, incoming: Project, store: GuitarChordStore | null = browserStore()): Project {
  if (Object.prototype.hasOwnProperty.call(incoming, 'guitarChords')) {
    const next = { ...incoming, guitarChords: readGuitarChords(incoming), guitarChordImport: readGuitarChordImport(incoming) };
    cacheGuitarChords(next, store);
    return next;
  }
  if (previous && previous.id === incoming.id && Object.prototype.hasOwnProperty.call(previous, 'guitarChords')) {
    const next = { ...incoming, guitarChords: readGuitarChords(previous), guitarChordImport: readGuitarChordImport(previous) };
    cacheGuitarChords(next, store);
    return next;
  }
  const cached = readCache(store, incoming.id);
  if (cached) return { ...incoming, guitarChords: cached.guitarChords, guitarChordImport: cached.guitarChordImport };
  return { ...incoming, guitarChords: [] };
}

function resolveAlignment(project: Project, candidate: GuitarChordCandidate): GuitarChordAlignment | undefined {
  if (!candidate.lyricId || !Number.isInteger(candidate.charOffset)) return undefined;
  const lyric = project.lyrics.find(item => item.id === candidate.lyricId);
  const at = lyric ? lyricCharacterAt(lyric.text, candidate.charOffset as number) : null;
  if (!lyric || !at) return undefined;
  if (candidate.token && candidate.token !== at.token) return undefined;
  return { lyricId: lyric.id, charOffset: candidate.charOffset as number, token: at.token };
}

function anchorKey(alignment: GuitarChordAlignment | undefined): string | null {
  return alignment ? `${alignment.lyricId}:${alignment.charOffset}:${alignment.token}` : null;
}

/** Replace pending candidates. Confirmed guitar chords and every other track stay. */
export function mergeGuitarChordImport(project: Project, result: GuitarChordImportResult, idFactory: () => string = () => crypto.randomUUID()): Project {
  const existing = readGuitarChords(project);
  const confirmed = existing.filter(chord => chord.proof === 'confirmed');
  const usedIds = new Set(confirmed.map(chord => chord.id));
  const protectedAnchors = new Set(confirmed.map(chord => anchorKey(chord.alignment)).filter((key): key is string => !!key));
  const candidates: GuitarChord[] = [];
  for (const candidate of result.chords) {
    const symbol = normalizeGuitarChordSymbol(candidate.symbol);
    if (!symbol) continue;
    let id = candidate.id?.trim() || idFactory();
    if (usedIds.has(id)) id = `${idFactory()}-${candidates.length + confirmed.length + 1}`;
    const alignment = resolveAlignment(project, { ...candidate, symbol });
    const anchor = anchorKey(alignment);
    if (anchor && protectedAnchors.has(anchor)) continue;
    usedIds.add(id);
    if (anchor) protectedAnchors.add(anchor);
    candidates.push({
      id,
      symbol,
      proof: 'pending',
      source: 'import',
      importId: result.importId,
      alignment,
      time: candidate.time,
      section: candidate.section?.trim().slice(0, 40) || undefined,
    });
  }
  return {
    ...project,
    lyrics: project.lyrics,
    chords: project.chords,
    bassEvents: project.bassEvents,
    manualFills: project.manualFills,
    notes: project.notes,
    guitarChords: [...confirmed, ...candidates],
    guitarChordImport: {
      importId: result.importId,
      filename: result.filename,
      importedAt: result.importedAt,
      status: 'pending',
      warning: result.warning?.trim() || '导入结果是待校对候选，自动对齐不代表已经准确。',
    },
  };
}

export function placeGuitarChord(lyric: Pick<Lyric, 'id' | 'text'>, chord: GuitarChord): PlacedGuitarChord | null {
  const alignment = chord.alignment;
  if (!alignment || alignment.lyricId !== lyric.id) return null;
  const at = lyricCharacterAt(lyric.text, alignment.charOffset);
  if (!at || at.token !== alignment.token) return null;
  return {
    id: chord.id,
    symbol: chord.symbol,
    lyricId: lyric.id,
    charOffset: alignment.charOffset,
    token: at.token,
    proof: chord.proof,
    leftRatio: at.leftRatio,
    widthRatio: at.widthRatio,
    section: chord.section,
    label: guitarChordStatusLabel(chord.proof),
  };
}

export function guitarChordsOnLyric(project: Pick<Project, 'guitarChords'>, lyric: Pick<Lyric, 'id' | 'text'>): PlacedGuitarChord[] {
  return readGuitarChords(project).flatMap(chord => {
    const placed = placeGuitarChord(lyric, chord);
    return placed ? [placed] : [];
  });
}

export function isGuitarChordPlaced(project: Project, chord: GuitarChord): boolean {
  const lyric = project.lyrics.find(item => item.id === chord.alignment?.lyricId);
  return !!lyric && !!placeGuitarChord(lyric, chord);
}

export function guitarChordMarkStyle(lyricLeftPercent: number, lyricWidthPercent: number, lyricTop: number, mark: PlacedGuitarChord): { left: string; top: number } {
  return {
    left: `calc(${lyricLeftPercent}% + ${mark.leftRatio} * ${lyricWidthPercent}%)`,
    top: Math.max(0, lyricTop - 34),
  };
}

export interface GuitarChordPatch {
  symbol?: string;
  lyricId?: string;
  charOffset?: number;
  section?: string | null;
  time?: number | null;
}

function sameAlignment(a: GuitarChordAlignment | undefined, b: GuitarChordAlignment | undefined): boolean {
  return a?.lyricId === b?.lyricId && a?.charOffset === b?.charOffset && a?.token === b?.token;
}

/** Editing a chord confirms it and leaves every other track on the same arrays. */
export function updateGuitarChord(project: Project, id: string, patch: GuitarChordPatch): Project {
  const chords = readGuitarChords(project);
  const current = chords.find(chord => chord.id === id);
  if (!current) return project;
  const symbol = patch.symbol === undefined ? current.symbol : normalizeGuitarChordSymbol(patch.symbol);
  if (!symbol) throw new RangeError('请填写和弦符号，例如 G、Bm、E7。');
  let alignment = current.alignment;
  if (patch.lyricId !== undefined || patch.charOffset !== undefined) {
    const lyricId = patch.lyricId ?? current.alignment?.lyricId;
    const charOffset = patch.charOffset ?? current.alignment?.charOffset;
    const lyric = project.lyrics.find(item => item.id === lyricId);
    if (!lyric || charOffset === undefined) throw new RangeError('请把和弦对齐到一句已有歌词的某个字上。');
    const at = lyricCharacterAt(lyric.text, charOffset);
    if (!at) throw new RangeError('这个位置没有歌词字，和弦没有改动。');
    alignment = { lyricId: lyric.id, charOffset, token: at.token };
  }
  const next: GuitarChord = {
    ...current,
    symbol,
    alignment,
    proof: 'confirmed',
    source: 'manual',
    section: patch.section === undefined ? current.section : (patch.section?.trim().slice(0, 40) || undefined),
    time: patch.time === undefined ? current.time : (patch.time ?? undefined),
  };
  if (next.symbol === current.symbol && next.proof === 'confirmed' && next.source === 'manual' && next.section === current.section && next.time === current.time && sameAlignment(next.alignment, current.alignment)) return project;
  return { ...project, guitarChords: chords.map(chord => chord.id === id ? next : chord) };
}

export function confirmGuitarChord(project: Project, id: string): Project {
  const chords = readGuitarChords(project);
  const current = chords.find(chord => chord.id === id);
  if (!current) return project;
  if (!current.alignment) throw new RangeError('请先把和弦对齐到歌词的某个字上，再确认。');
  const lyric = project.lyrics.find(item => item.id === current.alignment?.lyricId);
  const placed = lyric ? placeGuitarChord(lyric, current) : null;
  if (!placed) throw new RangeError('歌词已经变了，请重新选择对齐的字，再确认。');
  if (current.proof === 'confirmed' && current.source === 'manual') return project;
  return { ...project, guitarChords: chords.map(chord => chord.id === id ? { ...chord, proof: 'confirmed' as const, source: 'manual' as const } : chord) };
}

export function deleteGuitarChord(project: Project, id: string): Project {
  const chords = readGuitarChords(project);
  if (!chords.some(chord => chord.id === id)) return project;
  return { ...project, guitarChords: chords.filter(chord => chord.id !== id) };
}

export function retargetGuitarChordsAfterSplit(chords: GuitarChord[] | undefined, lyricId: string, splitAt: number, newLyricId: string): GuitarChord[] | undefined {
  if (!chords?.length) return chords;
  return chords.map(chord => {
    if (chord.alignment?.lyricId !== lyricId || chord.alignment.charOffset < splitAt) return chord;
    return { ...chord, alignment: { ...chord.alignment, lyricId: newLyricId, charOffset: chord.alignment.charOffset - splitAt } };
  });
}

export function retargetGuitarChordsAfterMerge(chords: GuitarChord[] | undefined, previousId: string, previousLength: number, mergedId: string): GuitarChord[] | undefined {
  if (!chords?.length) return chords;
  return chords.map(chord => {
    if (chord.alignment?.lyricId !== mergedId) return chord;
    return { ...chord, alignment: { ...chord.alignment, lyricId: previousId, charOffset: chord.alignment.charOffset + previousLength } };
  });
}

export function guitarChordFailureMessage(status: number, body: unknown, rawText = ''): { detail: string; code: string } {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const detail = typeof record.detail === 'string' ? record.detail.trim() : '';
  if (status === 404 || status === 405) return { detail: GUITAR_CHORD_FAILURES.not_ready, code: 'not_ready' };
  if (detail) return { detail, code: code || 'parse_error' };
  if (code in GUITAR_CHORD_FAILURES) return { detail: GUITAR_CHORD_FAILURES[code as keyof typeof GUITAR_CHORD_FAILURES], code };
  const text = rawText.trim();
  if (text && !text.startsWith('<') && !text.startsWith('{') && text.length <= 180) return { detail: text, code: 'parse_error' };
  return { detail: GUITAR_CHORD_FAILURES.parse_error, code: 'parse_error' };
}

export function parseGuitarChordImportResult(body: unknown): GuitarChordImportResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GuitarChordImportError(GUITAR_CHORD_FAILURES.parse_error, 'parse_error');
  const record = body as Record<string, unknown>;
  if (typeof record.importId !== 'string' || !record.importId.trim() || !Array.isArray(record.chords)) {
    throw new GuitarChordImportError(GUITAR_CHORD_FAILURES.parse_error, 'parse_error');
  }
  const chords: GuitarChordCandidate[] = [];
  for (const item of record.chords) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const symbol = typeof row.symbol === 'string' ? normalizeGuitarChordSymbol(row.symbol) : null;
    if (!symbol) continue;
    chords.push({
      id: typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined,
      symbol,
      lyricId: typeof row.lyricId === 'string' && row.lyricId ? row.lyricId : undefined,
      charOffset: Number.isInteger(row.charOffset) ? row.charOffset as number : undefined,
      token: typeof row.token === 'string' && row.token ? row.token : undefined,
      time: typeof row.time === 'number' && Number.isFinite(row.time) ? row.time : undefined,
      section: typeof row.section === 'string' && row.section.trim() ? row.section.trim().slice(0, 40) : undefined,
    });
  }
  return {
    importId: record.importId.trim(),
    filename: typeof record.filename === 'string' ? record.filename : undefined,
    importedAt: typeof record.importedAt === 'string' ? record.importedAt : '',
    status: 'pending',
    warning: typeof record.warning === 'string' ? record.warning : undefined,
    chords,
  };
}

export async function importGuitarChordPdf(projectId: string, file: File, revision: number, fetchImpl: typeof fetch = globalThis.fetch): Promise<GuitarChordImportResult> {
  const blocked = rejectChordChartFile(file);
  if (blocked) throw new GuitarChordImportError(blocked, file.size ? 'not_pdf' : 'empty_file');
  const body = new FormData();
  body.append('file', file, file.name);
  body.append('revision', String(revision));
  let response: Response;
  try {
    response = await fetchImpl(GUITAR_CHORD_IMPORT_PATH(projectId), { method: 'POST', credentials: 'include', body });
  } catch {
    throw new GuitarChordImportError(GUITAR_CHORD_FAILURES.network, 'network');
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  if (!response.ok) {
    const failure = guitarChordFailureMessage(response.status, parsed, text);
    throw new GuitarChordImportError(failure.detail, failure.code);
  }
  return parseGuitarChordImportResult(parsed);
}
