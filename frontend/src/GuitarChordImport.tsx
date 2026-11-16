import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, Upload } from 'lucide-react';
import type { Project } from './music';
import {
  deleteGuitarChord,
  guitarChordStatusLabel,
  importGuitarChordPdf,
  lyricCharacterAt,
  patchGuitarChord,
  projectFromGuitarChordImport,
  readGuitarChords,
  stepGuitarChordOffset,
  GuitarChordRequestError,
} from './guitar-chords';

type Phase = 'idle' | 'loading' | 'done';

export function GuitarChordImportForm({ project, persist, onProject, onClose }: { project: Project; persist: () => Promise<Project | null>; onProject: (next: Project, summary: string) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function submit(selected = file) {
    if (!selected || busy.current) return;
    setError('');
    setSummary('');
    setWarnings([]);
    setPhase('loading');
    busy.current = true;
    try {
      const current = await persist();
      if (!alive.current) return;
      if (!current) {
        setPhase('idle');
        setError('请先保存当前修改后再导入和弦谱。');
        return;
      }
      if (!current.lyrics.length) {
        setPhase('idle');
        setError('当前工程没有歌词，无法把吉他和弦对齐到歌词。请先导入并保存歌词。');
        return;
      }
      const result = await importGuitarChordPdf(current.id, selected);
      if (!alive.current) return;
      const next = projectFromGuitarChordImport(result);
      const added = result.added.length;
      const text = [result.note, added ? `本次写入 ${added} 个待校对候选。` : '没有新的待校对候选。已确认和手改的和弦仍保留。', ...result.warnings].join(' ');
      setPhase('done');
      setSummary(text);
      setWarnings(result.warnings);
      onProject(next, text);
    } catch (reason) {
      if (!alive.current) return;
      setPhase('idle');
      setError(reason instanceof GuitarChordRequestError ? reason.detail : reason instanceof Error && reason.message ? reason.message : '和弦谱请求失败，没有改动现有内容。');
    } finally {
      busy.current = false;
    }
  }

  return <form onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className="modal-description">从和弦谱 PDF 读取吉他和弦，由本机写入工程的吉他和弦列表，标在已有歌词对应的字上方。新写入的是待校对候选，不会改写贝斯音名、手写加花、歌词，也不会覆盖已确认或手改的吉他和弦。</p>
    <label className="file-label"><Upload size={14}/>选择和弦谱 PDF<input type="file" accept="application/pdf,.pdf" onChange={event => { const next = event.target.files?.[0] ?? null; setFile(next); setError(''); setPhase('idle'); setSummary(''); if (next) void submit(next); }} /></label>
    {file && <p className="quiet-hint">{file.name}</p>}
    {phase === 'loading' && <p className="guitar-chord-status" role="status"><LoaderCircle size={15} className="spin" />正在读取和弦谱…已确认的内容不会被改写。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {summary && <p className="guitar-chord-status" role="status">{summary}</p>}
    {warnings.map(warning => <p className="quiet-hint" key={warning}>{warning}</p>)}
    <p className="quiet-hint">打印件、歌词对不上或不像当前这首歌时，服务会说明原因并停止，不会把和弦标到错误的字上。</p>
    <div className="form-actions">
      <button className="secondary" type="button" onClick={onClose}>关闭</button>
      <button className="primary" type="submit" disabled={!file || phase === 'loading'}>{phase === 'loading' ? '正在读取…' : '导入和弦谱'}</button>
    </div>
  </form>;
}

export function GuitarChordForm({ project, chordId, persist, onProject, onDelete, onClose }: { project: Project; chordId: string; persist: () => Promise<Project | null>; onProject: (next: Project) => void; onDelete: (next: Project) => void; onClose: () => void }) {
  const existing = readGuitarChords(project).find(chord => chord.id === chordId);
  const [symbol, setSymbol] = useState(existing?.symbol ?? '');
  const [lyricId, setLyricId] = useState(existing?.lyricId ?? project.lyrics[0]?.id ?? '');
  const [charOffset, setCharOffset] = useState(existing?.charOffset ?? 0);
  const [section, setSection] = useState(existing?.section ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lyric = project.lyrics.find(item => item.id === lyricId);
  const at = lyric ? lyricCharacterAt(lyric.text, charOffset) : null;
  if (!existing) return <p className="modal-description">这个吉他和弦已经不在工程里。</p>;
  const chord = existing;
  const candidate = chord.status === 'candidate';

  function fail(reason: unknown) {
    setError(reason instanceof GuitarChordRequestError ? reason.detail : reason instanceof Error && reason.message ? reason.message : '没有改动这个和弦。');
  }
  async function confirm() {
    if (busy) return;
    const nextSection = section.trim() ? section.trim() : null;
    const changed = symbol !== chord.symbol || nextSection !== chord.section || (lyricId || null) !== chord.lyricId || (lyricId ? charOffset : null) !== chord.charOffset;
    if (changed) {
      setError('请先保存修改。确认校对只接受已经保存的和弦，不会带上未保存的改动。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const current = await persist();
      if (!current) { setError('请先保存当前修改后再确认这个和弦。'); return; }
      const result = await patchGuitarChord(current.id, chord.id, { status: 'confirmed', revision: current.revision });
      onProject(result.project);
      onClose();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }
  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const current = await persist();
      if (!current) { setError('请先保存当前修改后再保存这个和弦。'); return; }
      const result = await patchGuitarChord(current.id, chord.id, {
        symbol,
        section: section.trim() ? section.trim() : null,
        lyricId: lyricId || null,
        charOffset: lyricId ? charOffset : null,
        revision: current.revision,
      });
      onProject(result.project);
      onClose();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }
  function move(direction: -1 | 1) {
    if (!lyric) return;
    const next = stepGuitarChordOffset(lyric.text, at ? charOffset : 0, direction);
    if (next === null) return;
    setCharOffset(next);
    setError('');
  }

  return <form onSubmit={event => void save(event)}>
    <p className="modal-description">这是歌词上方的吉他和弦，和贝斯音名分开保存。确认或手改之后，再次导入不会覆盖它。当前状态：{guitarChordStatusLabel(chord.status)}{candidate ? '，还不是已核对的结果。' : '。'}</p>
    <label>和弦符号<input autoFocus required value={symbol} maxLength={40} placeholder="G / Bm / E7" onChange={event => setSymbol(event.target.value)} /></label>
    <label>对齐到歌词<select aria-label="对齐到哪一句歌词" value={lyricId} onChange={event => { setLyricId(event.target.value); setCharOffset(0); }}>
      {project.lyrics.map(item => <option key={item.id} value={item.id}>{item.text}</option>)}
    </select></label>
    <div className="guitar-chord-token" aria-live="polite">{lyric && at ? <>{codePointPreview(lyric.text, charOffset, at.token)}</> : '这一句里还没有可对齐的字。'}</div>
    <div className="form-actions">
      <button type="button" className="secondary" onClick={() => move(-1)} disabled={!lyric}>上一个字</button>
      <button type="button" className="secondary" onClick={() => move(1)} disabled={!lyric}>下一个字</button>
    </div>
    <label>段落标签（可空）<input value={section} maxLength={40} placeholder="主歌 / 副歌" onChange={event => setSection(event.target.value)} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions">
      <button className="danger" type="button" onClick={() => onDelete(deleteGuitarChord(project, chord.id))}>删除此和弦</button>
      {candidate && <button className="secondary" type="button" disabled={busy} onClick={() => void confirm()}><Check size={15} />确认校对</button>}
      <button className="primary" type="submit" disabled={busy}><Check size={15} />保存修改</button>
    </div>
  </form>;
}

function codePointPreview(text: string, charOffset: number, token: string) {
  const chars = Array.from(text);
  return <>{chars.slice(0, charOffset).join('')}<mark>{token}</mark>{chars.slice(charOffset + 1).join('')}</>;
}
