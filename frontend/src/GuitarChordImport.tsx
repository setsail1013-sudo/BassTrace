import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, Upload } from 'lucide-react';
import type { Project } from './music';
import {
  confirmGuitarChord,
  deleteGuitarChord,
  guitarChordStatusLabel,
  importGuitarChordPdf,
  isGuitarChordPlaced,
  lyricCharacterAt,
  mergeGuitarChordImport,
  readGuitarChords,
  stepGuitarChordOffset,
  updateGuitarChord,
  type GuitarChordImportResult,
} from './guitar-chords';

type Phase = 'idle' | 'loading' | 'empty' | 'done';

export function GuitarChordImportForm({ project, onApply, onClose }: { project: Project; onApply: (next: Project, summary: string) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState('');
  const [warning, setWarning] = useState('');
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function submit(selected = file) {
    if (!selected || busy.current) return;
    if (!project.lyrics.length) {
      setError('请先导入歌词。吉他和弦要对齐到已有歌词的字上，这次没有上传。');
      setPhase('idle');
      return;
    }
    setError('');
    setSummary('');
    setWarning('');
    setPhase('loading');
    busy.current = true;
    let result: GuitarChordImportResult;
    try {
      result = await importGuitarChordPdf(project.id, selected, project.revision);
    } catch (reason) {
      if (!alive.current) return;
      setPhase('idle');
      setError(reason instanceof Error ? reason.message : '和弦谱导入失败，没有改动现有内容。');
      return;
    } finally {
      busy.current = false;
    }
    if (!alive.current) return;
    const next = mergeGuitarChordImport(project, result);
    const pending = readGuitarChords(next).filter(chord => chord.proof === 'pending');
    const unplaced = pending.filter(chord => !isGuitarChordPlaced(next, chord)).length;
    if (!result.chords.length || !pending.length) {
      setPhase('empty');
      const text = '没有读到可显示的和弦候选。已校对的吉他和弦、歌词、贝斯音名和加花都没有改动。';
      setSummary(text);
      onApply(next, text);
      return;
    }
    const text = `已放入 ${pending.length} 个待校对候选${unplaced ? `，其中 ${unplaced} 个没能对齐到歌词，未画在谱面上` : ''}。确认或修改之前，不代表对齐已经准确。`;
    setPhase('done');
    setSummary(text);
    setWarning(result.warning ?? '');
    onApply(next, text);
  }

  return <form onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className="modal-description">从和弦谱 PDF 读取吉他和弦，标在已有歌词对应的字上方。结果先作为待校对候选，不会改写顶部贝斯音名、手写加花、歌词，也不会覆盖已经校对的吉他和弦。</p>
    <label className="file-label"><Upload size={14}/>选择和弦谱 PDF<input type="file" accept="application/pdf,.pdf" onChange={event => { const next = event.target.files?.[0] ?? null; setFile(next); setError(''); setPhase('idle'); setSummary(''); if (next) void submit(next); }} /></label>
    {file && <p className="quiet-hint">{file.name}</p>}
    {phase === 'loading' && <p className="guitar-chord-status" role="status"><LoaderCircle size={15} className="spin" />正在读取和弦谱…已有校对内容不会被改写。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {summary && <p className="guitar-chord-status" role="status">{summary}</p>}
    {warning && phase === 'done' && <p className="quiet-hint">{warning}</p>}
    <p className="quiet-hint">打印件或没有文字的 PDF、歌词对不上、不像当前这首歌时，会说明原因并停止，不会把和弦标到错误的字上。</p>
    <div className="form-actions">
      <button className="secondary" type="button" onClick={onClose}>关闭</button>
      <button className="primary" type="submit" disabled={!file || phase === 'loading'}>{phase === 'loading' ? '正在读取…' : '导入和弦谱'}</button>
    </div>
  </form>;
}

export function GuitarChordForm({ project, chordId, onApply, onClose }: { project: Project; chordId: string; onApply: (next: Project) => void; onClose: () => void }) {
  const existing = readGuitarChords(project).find(chord => chord.id === chordId);
  const [symbol, setSymbol] = useState(existing?.symbol ?? '');
  const [lyricId, setLyricId] = useState(existing?.alignment?.lyricId ?? project.lyrics[0]?.id ?? '');
  const [charOffset, setCharOffset] = useState(existing?.alignment?.charOffset ?? 0);
  const [section, setSection] = useState(existing?.section ?? '');
  const [error, setError] = useState('');
  const lyric = project.lyrics.find(item => item.id === lyricId);
  const at = lyric ? lyricCharacterAt(lyric.text, charOffset) : null;
  if (!existing) return <p className="modal-description">这个吉他和弦已经不在工程里。</p>;
  const chord = existing;

  function apply(next: Project) {
    onApply(next);
    onClose();
  }
  function save(event?: FormEvent) {
    event?.preventDefault();
    try {
      apply(updateGuitarChord(project, chord.id, { symbol, lyricId, charOffset, section }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '没有改动这个和弦。');
    }
  }
  function confirm() {
    try {
      const edited = updateGuitarChord(project, chord.id, { symbol, lyricId, charOffset, section });
      apply(edited === project ? confirmGuitarChord(project, chord.id) : edited);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '还不能确认这个和弦。');
    }
  }
  function move(direction: -1 | 1) {
    if (!lyric) return;
    const next = stepGuitarChordOffset(lyric.text, at ? charOffset : 0, direction);
    if (next === null) return;
    setCharOffset(next);
    setError('');
  }

  return <form onSubmit={save}>
    <p className="modal-description">这是歌词上方的吉他和弦，和顶部贝斯音名分开保存。修改或确认后，再次导入不会覆盖它。当前状态：{guitarChordStatusLabel(existing.proof)}{existing.proof === 'pending' ? '，还不是已确认的结果。' : '。'}</p>
    <label>和弦符号<input autoFocus required value={symbol} maxLength={40} placeholder="G / Bm / E7" onChange={event => setSymbol(event.target.value)} /></label>
    <label>对齐到歌词<select aria-label="对齐到哪一句歌词" value={lyricId} onChange={event => { setLyricId(event.target.value); setCharOffset(0); }}>
      {project.lyrics.map(item => <option key={item.id} value={item.id}>{item.text}</option>)}
    </select></label>
    <div className="guitar-chord-token" aria-live="polite">{lyric && at ? <>{lyric.text.slice(0, charOffset)}<mark>{at.token}</mark>{lyric.text.slice(charOffset + at.token.length)}</> : '这一句里还没有可对齐的字。'}</div>
    <div className="form-actions">
      <button type="button" className="secondary" onClick={() => move(-1)} disabled={!lyric}>上一个字</button>
      <button type="button" className="secondary" onClick={() => move(1)} disabled={!lyric}>下一个字</button>
    </div>
    <label>段落标签（可空）<input value={section} maxLength={40} placeholder="主歌 / 副歌" onChange={event => setSection(event.target.value)} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions">
      <button className="danger" type="button" onClick={() => apply(deleteGuitarChord(project, chord.id))}>删除此和弦</button>
      {existing.proof === 'pending' && <button className="secondary" type="button" onClick={confirm}><Check size={15} />确认校对</button>}
      <button className="primary" type="submit"><Check size={15} />保存修改</button>
    </div>
    </form>;
}
