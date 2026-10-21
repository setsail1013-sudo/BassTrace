import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { Note, NoteNotation, Project } from './music';
import { beatsPerBar, layoutChordLabels, positionToTime, timeToPosition } from './music';
import { alterNumberNotes, insertNumberNote, moveNumberNotes, noteIsPlaying, noteRhythm, numberFragments, numberLabel, numberPitch, pasteNumberNotes, setNumberDegree, setNumberNotation } from './notation';
import type { NoteValue } from './notation';
import './number-score.css';

type Edit = (change: (p: Project) => Project) => void;
interface ScoreContextValue {
  p: Project; time: number; selected: string[]; cursor: number; status: string; printing: boolean;
  select: (id: string, event: MouseEvent) => void; setCursor: (time: number, clear?: boolean) => void;
  apply: (patch: Partial<NoteNotation>) => void; degree: (degree: number) => void;
  insert: (rest?: boolean) => void; remove: () => void; copy: () => void; paste: () => void;
  move: (beats: number, octaves?: number) => void; audition?: () => void; edit: Edit; seek: (time: number) => void;
}
const ScoreContext = createContext<ScoreContextValue | null>(null);
function useScore() { const context = useContext(ScoreContext); if (!context) throw new Error('NumberBar 必须放在 NumberScoreProvider 中'); return context; }
const newId = () => `number-${crypto.randomUUID()}`;
export interface NumberScoreProviderProps { enabled?: boolean; p: Project; time: number; onEdit: Edit; onSeek: (time: number) => void; onAudition?: (start: number, end: number) => void; children: ReactNode }

/** Selection lives across bars; mutations use the app's shared undo/save path. */
export function NumberScoreProvider({ enabled = true, p, time, onEdit, onSeek, onAudition, children }: NumberScoreProviderProps) {
  const [selected, setSelected] = useState<string[]>([]), [cursor, updateCursor] = useState(0), [status, setStatus] = useState('');
  const [printing, setPrinting] = useState(() => typeof window !== 'undefined' && window.matchMedia('print').matches);
  const anchor = useRef<string | null>(null), clipboard = useRef<Note[]>([]);
  useEffect(() => { const media = window.matchMedia('print'), change = () => setPrinting(media.matches), before = () => flushSync(() => setPrinting(true)), after = () => setPrinting(false); media.addEventListener('change', change); window.addEventListener('beforeprint', before); window.addEventListener('afterprint', after); return () => { media.removeEventListener('change', change); window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); }; }, []);
  useEffect(() => { setSelected([]); updateCursor(0); anchor.current = null; clipboard.current = []; setStatus(''); }, [p.id]);
  useEffect(() => { const ids = new Set(p.notes.map(note => note.id)); setSelected(previous => previous.every(id => ids.has(id)) ? previous : previous.filter(id => ids.has(id))); }, [p.notes]);
  const setCursor = useCallback((at: number, clear = false) => { updateCursor(Math.max(0, Math.min(p.duration, at))); if (clear) { setSelected([]); anchor.current = null; } }, [p.duration]);
  const select = useCallback((id: string, event: MouseEvent) => {
    const note = p.notes.find(note => note.id === id); if (!note) return;
    updateCursor(note.start); setStatus('');
    if (event.shiftKey && anchor.current) {
      const order = [...p.notes].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
      const from = order.findIndex(item => item.id === anchor.current), to = order.findIndex(item => item.id === id);
      setSelected(order.slice(Math.min(from < 0 ? to : from, to), Math.max(from < 0 ? to : from, to) + 1).map(item => item.id));
    } else if (event.ctrlKey || event.metaKey) { setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]); anchor.current = id; }
    else { setSelected([id]); anchor.current = id; }
  }, [p.notes]);
  const apply = useCallback((patch: Partial<NoteNotation>) => { if (selected.length) onEdit(current => setNumberNotation(current, selected, patch)); }, [onEdit, selected]);
  const degree = useCallback((value: number) => { if (selected.length) onEdit(current => setNumberDegree(current, selected, value)); }, [onEdit, selected]);
  const move = useCallback((beats: number, octaves = 0) => { if (selected.length) onEdit(current => moveNumberNotes(current, selected, beats, octaves)); }, [onEdit, selected]);
  const insert = useCallback((rest = false) => { const id = newId(); onEdit(current => insertNumberNote(current, cursor, id, rest)); setSelected([id]); anchor.current = id; setStatus(rest ? '已插入休止符' : '已插入音符'); }, [cursor, onEdit]);
  const remove = useCallback(() => { if (!selected.length) return; const ids = new Set(selected); onEdit(current => ({ ...current, notes: current.notes.filter(note => !ids.has(note.id)) })); setSelected([]); anchor.current = null; setStatus('已删除选中音符'); }, [onEdit, selected]);
  const copy = useCallback(() => { clipboard.current = p.notes.filter(note => selected.includes(note.id)).map(note => ({ ...note, notation: note.notation ? { ...note.notation } : undefined })); setStatus(clipboard.current.length ? `已复制 ${clipboard.current.length} 个音符；点击目标拍位后粘贴` : '请先选中音符'); }, [p.notes, selected]);
  const paste = useCallback(() => { if (!clipboard.current.length) { setStatus('请先复制音符'); return; } const ids = clipboard.current.map(newId); onEdit(current => pasteNumberNotes(current, clipboard.current, cursor, ids)); setSelected(ids); anchor.current = ids[0]; setStatus('已粘贴到编辑光标'); }, [cursor, onEdit]);
  const audition = useCallback(() => { const notes = p.notes.filter(note => selected.includes(note.id)); if (notes.length && onAudition) onAudition(Math.max(0, Math.min(...notes.map(note => note.start))), Math.min(p.duration, Math.max(...notes.map(note => note.start + note.duration)))); }, [p.notes, p.duration, selected, onAudition]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable="true"]')) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'c') { event.preventDefault(); event.stopPropagation(); copy(); return; }
    if (command && event.key.toLowerCase() === 'v') { event.preventDefault(); event.stopPropagation(); paste(); return; }
    if (command && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); setSelected(p.notes.map(note => note.id)); return; }
    if (event.key === 'Escape') { setSelected([]); anchor.current = null; return; }
    if (event.key === 'Insert') { event.preventDefault(); event.stopPropagation(); insert(); return; }
    if (!selected.length || command || event.altKey) return;
    if (/^[0-7]$/.test(event.key)) { event.preventDefault(); event.stopPropagation(); degree(Number(event.key)); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); remove(); }
    else if (event.key.startsWith('Arrow')) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        if (event.shiftKey) { move(direction * 0.25); return; }
        const ordered = [...p.notes].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        const indices = ordered.map((note, index) => selected.includes(note.id) ? index : -1).filter(index => index >= 0);
        const current = direction > 0 ? Math.max(...indices) : Math.min(...indices);
        const target = ordered[Math.max(0, Math.min(ordered.length - 1, current + direction))];
        if (target) { setSelected([target.id]); anchor.current = target.id; updateCursor(target.start); onSeek(target.start); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.number-note[data-note-id="${CSS.escape(target.id)}"]`)?.focus()); }
      } else if (event.key === 'ArrowUp') move(0, 1); else if (event.key === 'ArrowDown') move(0, -1);
    }
  };
  const context = useMemo<ScoreContextValue>(() => ({ p, time, selected, cursor, status, printing, select, setCursor, apply, degree, insert, remove, copy, paste, move, audition: onAudition ? audition : undefined, edit: onEdit, seek: onSeek }), [p, time, selected, cursor, status, printing, select, setCursor, apply, degree, insert, remove, copy, paste, move, audition, onAudition, onEdit, onSeek]);
  return <ScoreContext.Provider value={context}><div className="number-score-editor" onKeyDown={enabled ? keyDown : undefined}>{children}</div></ScoreContext.Provider>;
}

/** Compact contextual controls, with secondary performance marks behind one toggle. */
export function NumberToolbar() {
  const score = useScore(), [expanded, setExpanded] = useState(false);
  const first = score.p.notes.find(note => score.selected.includes(note.id)), rhythm = first ? noteRhythm(score.p, first) : null;
  const toggle = (field: 'dotted' | 'ghost' | 'dead' | 'rest' | 'tie' | 'slur') => score.apply({ [field]: field === 'dotted' ? !rhythm?.dotted : !first?.notation?.[field] });
  return <div className="number-toolbar" role="toolbar" aria-label="数字谱编辑工具">
    <span className="number-toolbar-title">数字谱 <small>{score.selected.length ? `已选 ${score.selected.length} 个` : `光标 ${score.cursor.toFixed(2)} 秒`}</small></span>
    <button type="button" onClick={() => score.insert()} title="在光标处插入音符 · Insert">+ 音符</button><button type="button" onClick={() => score.insert(true)}>+ 休止</button>
    {score.selected.length > 0 && <>
      <span className="number-separator"/>
      <label>时值 <select aria-label="数字谱音符时值" value={rhythm?.value ?? 4} onChange={event => score.apply({ value: Number(event.target.value) as NoteValue })}>{[1, 2, 4, 8, 16, 32].map(value => <option value={value} key={value}>{value === 1 ? '全音符' : `1/${value}`}</option>)}</select></label>
      <button type="button" className={rhythm?.dotted ? 'enabled' : ''} aria-pressed={rhythm?.dotted ?? false} onClick={() => toggle('dotted')}>附点 ·</button>
      <button type="button" disabled={!score.audition} onClick={score.audition} title="试听选中音符的原曲时间区间">试听</button>
      <button type="button" onClick={score.remove} title="Delete">删除</button><button type="button" onClick={score.copy} title="Ctrl+C">复制</button>
    </>}
    <button type="button" onClick={score.paste} title="Ctrl+V">粘贴</button>
    <button type="button" className="number-more" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? '收起' : '演奏标记'}</button>
    {expanded && <div className="number-extra">
      <span>音级</span>{[0, 1, 2, 3, 4, 5, 6, 7].map(value => <button type="button" key={value} disabled={!first} onClick={() => score.degree(value)}>{value}</button>)}
      <button type="button" disabled={!first} onClick={() => score.edit(current => alterNumberNotes(current, score.selected, 1))} title="升高半音">♯</button><button type="button" disabled={!first} onClick={() => score.edit(current => alterNumberNotes(current, score.selected, -1))} title="降低半音">♭</button>
      <span className="number-separator"/>{([['ghost', '鬼音 ( )'], ['dead', '闷音 x'], ['rest', '休止 0'], ['tie', '延音'], ['slur', '连奏']] as const).map(([field, label]) => <button type="button" key={field} disabled={!first} aria-pressed={!!first?.notation?.[field]} className={first?.notation?.[field] ? 'enabled' : ''} onClick={() => toggle(field)}>{label}</button>)}
      <span className="number-key-hint">0–7 改音级 · ←→ 选择相邻音符 · Shift+←→ 移动 ¼ 拍 · ↑↓ 八度 · Shift / Ctrl 多选</span>
    </div>}
    {score.status && <span className="number-status" role="status">{score.status}</span>}
  </div>;
}

export interface NumberBarProps { bar: number; start: number; end: number; showRegions?: boolean }
export const NumberBar = memo(function NumberBar({ bar, start, end, showRegions = true }: NumberBarProps) {
  const score = useScore(), container = useRef<HTMLDivElement>(null), [width, setWidth] = useState(240), [numberFont, setNumberFont] = useState(19.2);
  const fragments = useMemo(() => numberFragments(score.p, start, end), [score.p.notes, start, end]);
  useEffect(() => { const element = container.current; if (!element) return; const measure = () => { setWidth(element.clientWidth); setNumberFont((Number.parseFloat(getComputedStyle(element).getPropertyValue('--sheet-font')) || 16) * 1.2); }; const observer = new ResizeObserver(measure); observer.observe(element); const glyph = element.querySelector('.number-glyph'); if (glyph) observer.observe(glyph); measure(); return () => observer.disconnect(); }, [fragments[0]?.note.id]);
  const size = beatsPerBar(score.p);
  const display = useMemo(() => fragments.map(fragment => {
    const { note } = fragment, pitch = numberPitch(note.midi, score.p.key);
    const text = numberLabel(score.p, note);
    const position = timeToPosition(score.p, fragment.start), rhythm = noteRhythm(score.p, { start: fragment.start, duration: fragment.end - fragment.start });
    return { ...fragment, pitch, text, beat: position.bar < bar ? 1 : position.beat, rhythm };
  }), [fragments, score.p.key, score.p.bpm, score.p.meter, score.p.offset, score.p.beatTimes, bar]);
  const layoutWidth = score.printing ? Math.min(120, width) : width, displayFont = score.printing ? 12 : numberFont;
  const percent = (value: number) => `${layoutWidth > 0 ? value / layoutWidth * 100 : 0}%`;
  const layout = useMemo(() => layoutChordLabels(display.map(item => ({ id: item.note.id, label: item.text, beat: item.beat })), size, layoutWidth, text => Math.max(displayFont + 6, text.length * displayFont * .63 + 9 + displayFont * .32)), [display, size, layoutWidth, displayFont]);
  const rowHeight = Math.max(47, displayFont * 1.1 + 20);
  const placements = new Map(layout.items.map(item => [item.id, item])), selected = new Set(score.selected), height = Math.max(64, layout.rows * rowHeight + 12);
  const atPointer = (clientX: number) => {
    const rect = container.current!.getBoundingClientRect(), fraction = Math.max(0, Math.min(0.9999, (clientX - rect.left) / rect.width));
    const beat = Math.round(fraction * size * 4) / 4 + 1;
    return positionToTime(score.p, bar, Math.min(size + 0.75, beat));
  };
  return <div className="number-bar" ref={container} style={{ height }} tabIndex={0} role="group" aria-label={`第 ${bar} 小节数字谱`}
    onClick={event => { if ((event.target as HTMLElement).closest('.number-note')) return; const at = atPointer(event.clientX); score.setCursor(at, !(event.shiftKey || event.ctrlKey || event.metaKey)); score.seek(at); event.currentTarget.focus(); }}
    onDragOver={event => { if (event.dataTransfer.types.includes('application/x-bass-number-note')) event.preventDefault(); }}
    onDrop={event => { const id = event.dataTransfer.getData('application/x-bass-number-note'); if (!id) return; event.preventDefault(); event.stopPropagation(); const note = score.p.notes.find(note => note.id === id); if (!note) return; const target = atPointer(event.clientX), before = timeToPosition(score.p, note.start), after = timeToPosition(score.p, target); const delta = (after.bar - before.bar) * size + after.beat - before.beat; score.edit(current => moveNumberNotes(current, selected.has(id) ? score.selected : [id], delta)); score.setCursor(target); }}>
    <span className="number-bar-label">贝斯</span>
    {Array.from({ length: size }, (_, index) => <i key={index} className="number-beat" style={{ left: `${index / size * 100}%` }} aria-hidden="true"/>)}
    {display.map(item => {
      const placement = placements.get(item.note.id)!, isSelected = selected.has(item.note.id), active = noteIsPlaying(item.note, score.time) && score.time >= item.start && score.time < item.end;
      const endPosition = timeToPosition(score.p, item.end), endBeat = endPosition.bar > bar ? size + 1 : endPosition.beat;
      const regionWidth = Math.max(0, (endBeat - item.beat) / size * layoutWidth);
      const top = 13 + placement.row * rowHeight, octave = Math.min(6, Math.abs(item.pitch.octave));
      const style = { left: percent(placement.left), top, width: percent(placement.width), '--number-anchor': `${placement.width > 0 ? (placement.anchor - placement.left) / placement.width * 100 : 0}%` } as CSSProperties;
      const descriptive = `${item.note.notation?.rest ? '休止' : item.text} · 第 ${bar} 小节第 ${item.beat.toFixed(2)} 拍 · ${item.note.start.toFixed(3)} 秒 · 实际时值 ${item.note.duration.toFixed(3)} 秒${item.rhythm.approximate ? '（显示近似节奏）' : ''}`;
      return <span key={item.note.id} className="number-event-group">
        {showRegions && <span className={`number-region ${active ? 'sounding' : ''} ${item.note.notation?.rest ? 'rest-region' : ''}`} style={{ left: percent(placement.anchor), width: percent(regionWidth), top: top - 9, height: rowHeight - 5 }} aria-hidden="true"/>}
        {(item.continued || item.continues || item.note.notation?.tie || item.note.notation?.slur) && <span className={`number-arc ${item.note.notation?.slur ? 'slur-arc' : ''}`} style={{ left: percent(placement.anchor), top: top - 9, width: percent(Math.min(layoutWidth - placement.anchor, Math.max(12, regionWidth))) }} aria-label={item.note.notation?.slur ? '连奏线' : '延音线'}/>}
        <button type="button" className={`number-note ${isSelected ? 'selected' : ''} ${active ? 'sounding' : ''} ${item.note.notation?.ghost ? 'ghost-note' : ''} ${item.note.notation?.dead ? 'dead-note' : ''} ${item.note.notation?.rest ? 'rest-note' : ''} ${item.continued ? 'continued-note' : ''}`} style={style} title={descriptive} aria-label={descriptive} aria-pressed={isSelected} data-note-id={item.note.id} data-start={item.note.start} data-end={item.note.start + item.note.duration} draggable
          onClick={event => { event.stopPropagation(); score.select(item.note.id, event); score.seek(item.start); }}
          onDragStart={event => { if (!selected.has(item.note.id)) score.select(item.note.id, event); event.dataTransfer.setData('application/x-bass-number-note', item.note.id); event.dataTransfer.effectAllowed = 'move'; }}>
          {!item.note.notation?.rest && !item.note.notation?.dead && item.pitch.octave > 0 && <span className="number-octave above" style={{ fontSize: Math.min(numberFont * .8, 16, placement.width / Math.max(1, octave) / 0.4) }} aria-label={`高 ${octave} 个八度`}>{'·'.repeat(octave)}</span>}
          <span className="number-glyph">{item.text}{item.rhythm.dotted && <span className="number-dot">·</span>}</span>
          <span className="number-underlines" aria-label={`${item.rhythm.value} 分音符`}>{Array.from({ length: item.rhythm.lines }, (_, index) => <i key={index}/>)}</span>
          {!item.note.notation?.rest && !item.note.notation?.dead && item.pitch.octave < 0 && <span className="number-octave below" style={{ fontSize: Math.min(numberFont * .8, 16, placement.width / Math.max(1, octave) / 0.4) }} aria-label={`低 ${octave} 个八度`}>{'·'.repeat(octave)}</span>}
        </button>
        {item.rhythm.value <= 2 && <span className="number-sustain" style={{ left: percent(Math.min(layoutWidth, placement.anchor + placement.width + 3)), top, width: percent(Math.max(0, Math.min(layoutWidth - placement.anchor, regionWidth) - placement.width - 3)) }} aria-hidden="true">{item.rhythm.value === 1 ? '− − −' : '−'}</span>}
      </span>;
    })}
    {display.length === 0 && <span className="number-empty">点击拍位插入音符或休止</span>}
  </div>;
});
