import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { Plus, Repeat2, Pencil, Trash2, X, Check } from 'lucide-react';
import { ChordLane } from './ChordLane';
import type { Project, Chord, Lyric, ManualFillNote, Section } from './music';
import { beatsPerBar, displaySections, positionToTime, timeToPosition, formatTime } from './music';
import { orderedLyrics, moveLyricWithPush, nudgeLyric, beatIndex, timeAtBeat, type LyricFootprints, splitLyric, mergeLyricPrevious, addManualFill, setFillLines, setFillOctave, setFillDigit, deleteFillNote, moveManualFill, scoreRows, rowTimePercent, rowPercentTime } from './tracks';
import { fillLayoutGroups, fillLayoutRows, layoutCompactFills, type FillPlacement } from './fill-layout';
import { connectionError, fillTechniqueLabels, layoutFillConnections, setFillTechnique, type FillConnectionKind, type FillTechnique, type FillConnectionPath } from './fill-techniques';
import { topEventLabel, topEventTime } from './top-track';
import { readScoreStyle } from './score-style';
import { useCommands, type Command } from './commands';
import './three-tracks.css';

type Edit = (fn: (current: Project) => Project) => void;
type Props = { p: Project; chords: Chord[]; barsPerRow: number; fontSize: number; degree: boolean; time: number; playing: boolean; onEdit: Edit; onChordEdit: (id: string) => void; onNewChord: (bar: number, beat?: number) => void; onNewSection: (bar: number) => void; onSeek: (time: number) => void; onStatus: (text: string) => void; onSectionEdit: (id: string) => void; onLoop: (section: Section) => void };
type Drag = { kind: 'lyric' | 'fill'; id: string; initialX: number; initialY: number; grab: number; target: number; moved: boolean; original: Project; widths: LyricFootprints };
type FillSelection = { group: string; note: string };
const uid = () => crypto.randomUUID();
const label = (section: Section, index: number) => /^候选段落/.test(section.name) ? `段落 ${String(index + 1).padStart(2, '0')}` : section.name;

/** Three independent lanes share the same ruler; only the active lane changes during a drag. */
export function ThreeTrackScore(props: Props) {
  const { p, onEdit, onStatus } = props;
  const [mobile, setMobile] = useState(window.innerWidth <= 650);
  const [printing, setPrinting] = useState(false);
  const [preview, setPreview] = useState<Project | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [editingLyric, setEditingLyric] = useState<string | null>(null);
  const [fillCursor, setFillCursor] = useState<{ time: number; row: number } | null>(null);
  const [fillDigits, setFillDigits] = useState('');
  const [selection, setSelection] = useState<FillSelection | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const lastDrag = useRef(0);
  const [object, setObject] = useState<{ kind: 'lyric' | 'chord' | 'fill' | 'section'; id: string; group?: string } | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [fillLayout, setFillLayout] = useState<ReturnType<typeof layoutCompactFills>>({ items: [], heights: {} });
  const view = preview ?? p;
  const perRow = printing ? 4 : mobile ? 2 : props.barsPerRow;
  const rows = scoreRows(view, perRow);
  const sections = displaySections(view);
  const selectedNote = view.manualFills?.find(g => g.id === selection?.group)?.notes.find(n => n.id === selection?.note);
  const selectedGroup = view.manualFills?.find(g => g.id === selection?.group);
  const scoreStyle = readScoreStyle(view);
  const lyricSize = printing ? scoreStyle.lyricPrintSize * 4 / 3 : scoreStyle.lyricFontSize;
  const connections = layoutFillConnections(fillLayout.items, view.manualFills ?? []);

  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    const measure = () => {
      const lanes = [...element.querySelectorAll<HTMLElement>('.manual-fill-track')];
      const model = fillLayoutRows(view, rows, 1).map(r => ({ ...r, width: Math.max(1, lanes.find(l => Number(l.dataset.startBar) === r.id)?.clientWidth || 650) }));
      setFillLayout(layoutCompactFills(model, fillLayoutGroups(view), printing ? 14 : mobile ? props.fontSize : props.fontSize + 3, 12));
    };
    measure(); const observer = new ResizeObserver(measure); element.querySelectorAll('.manual-fill-track').forEach(l => observer.observe(l));
    window.addEventListener('beforeprint', measure); document.fonts.ready.then(measure);
    return () => { observer.disconnect(); window.removeEventListener('beforeprint', measure); };
  }, [JSON.stringify([view.manualFills, view.chords, view.bassEvents, view.topTrack, view.beatTimes, view.bpm, view.offset, view.duration, rows]), props.fontSize, mobile, printing]);

  function footprints(current = p): LyricFootprints {
    const canvas = document.createElement('canvas').getContext('2d'), result: LyricFootprints = {};
    const lanes = [...(root.current?.querySelectorAll<HTMLElement>('[data-track="lyric"]') ?? [])];
    for (const lyric of current.lyrics) {
      const bar = Math.max(1, timeToPosition(current, lyric.start).bar);
      const lane = lanes.find(l => bar >= Number(l.dataset.startBar) && bar <= Number(l.dataset.endBar)) ?? lanes[0];
      if (!lane) continue;
      const style = getComputedStyle(lane); if (canvas) canvas.font = `${style.fontSize} ${style.fontFamily}`;
      const width = Math.max(8, ...lyric.text.split('\n').map(line => canvas?.measureText(line).width ?? line.length * lyricSize));
      const left = rowPercentTime(current, Number(lane.dataset.startBar), Number(lane.dataset.endBar), 0), right = rowPercentTime(current, Number(lane.dataset.startBar), Number(lane.dataset.endBar), 100);
      result[lyric.id] = width / Math.max(1, lane.clientWidth) * (beatIndex(current, right) - beatIndex(current, left));
    }
    return result;
  }
  function nudge(id: string, beats: number, text?: string) {
    const source = text === undefined ? p : { ...p, lyrics: p.lyrics.map(l => l.id === id ? { ...l, text, locked: true, source: 'manual' as const } : l) };
    const next = nudgeLyric(source, id, beats, footprints(source));
    const moved = next.lyrics.find(l => l.id === id)?.start !== p.lyrics.find(l => l.id === id)?.start;
    if (moved) onEdit(() => next);
    return moved;
  }
  function openFill(at: number) {
    const row = rows.find(r => at >= (r.startBar === 1 ? 0 : positionToTime(p, r.startBar, 1)) && at < positionToTime(p, r.endBar + 1, 1)) ?? rows.at(-1);
    if (!row) return;
    setEditingLyric(null); setSelection(null); setFillDigits(''); setFillCursor({ time: Math.max(0, Math.min(p.duration - .01, at)), row: row.startBar });
    root.current?.querySelector(`[data-start-bar="${row.startBar}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function editObject() {
    if (!object) return;
    if (object.kind === 'lyric') setEditingLyric(object.id);
    if (object.kind === 'chord') props.onChordEdit(object.id);
    if (object.kind === 'section') props.onSectionEdit(object.id);
    if (object.kind === 'fill') { setSelection({ group: object.group!, note: object.id }); requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('.fill-tools select')?.focus()); }
  }
  function deleteObject() {
    if (!object) return;
    if (object.kind === 'fill') changeFill(current => deleteFillNote(current, object.group!, object.id));
    else if (object.kind === 'chord' && p.topTrack === 'bass') onEdit(current => ({ ...current, bassEvents: (current.bassEvents ?? []).filter(item => item.id !== object.id) }));
    else onEdit(current => ({ ...current, [object.kind === 'lyric' ? 'lyrics' : object.kind === 'chord' ? 'chords' : 'sections']: current[object.kind === 'lyric' ? 'lyrics' : object.kind === 'chord' ? 'chords' : 'sections'].filter(item => item.id !== object.id) }));
    setObject(null); setSelection(null);
  }
  function moveObject(beats: number) {
    if (!object) return;
    if (object.kind === 'lyric') { nudge(object.id, beats); return; }
    if (object.kind === 'fill') { const group = p.manualFills?.find(g => g.id === object.group); if (group?.notes[0]) changeFill(current => moveManualFill(current, group.id, timeAtBeat(current, beatIndex(current, group.notes[0].start) + beats))); }
    if (object.kind === 'chord' && p.topTrack === 'bass') { const note = p.bassEvents?.find(n => n.id === object.id); if (note) moveBass(object.id, timeAtBeat(p, beatIndex(p, note.start) + beats)); return; }
    if (object.kind === 'chord') onEdit(current => ({ ...current, chords: current.chords.map(c => {
      if (c.id !== object.id) return c;
      const at = timeToPosition(current, Math.max(0, Math.min(current.duration - .001, timeAtBeat(current, beatIndex(current, positionToTime(current, c.bar, c.beat)) + beats))));
      return { ...c, ...at, locked: true, source: 'manual' };
    }) }));
  }
  function moveBass(id: string, target: number) {
    onEdit(current => ({ ...current, bassEvents: (current.bassEvents ?? []).map(note => {
      if (note.id !== id) return note;
      const delta = Math.max(-note.start, Math.min(current.duration - note.end, target - note.start));
      return { ...note, start: note.start + delta, end: note.end + delta, locked: true, source: 'manual' as const };
    }) }));
  }
  function techniqueEnabled(technique: FillTechnique): boolean {
    if (!selectedNote?.digit || !selectedGroup) return false;
    if (['cut', 'dead', 'accent'].includes(technique)) return true;
    return selectedNote.notation?.connection?.kind === technique || !connectionError(selectedGroup.notes, selectedGroup.notes.findIndex(n => n.id === selectedNote.id), technique as FillConnectionKind);
  }
  function techniqueHint(technique: FillTechnique, shortcut: string): string {
    const hint = `${fillTechniqueLabels[technique]} · ${shortcut.replace('ArrowUp', '↑').replace('ArrowDown', '↓')}`;
    if (!selectedNote?.digit) return `${hint} · 休止符不添加演奏技法。`;
    if (['cut', 'dead', 'accent'].includes(technique)) return hint;
    const reason = selectedGroup && connectionError(selectedGroup.notes, selectedGroup.notes.findIndex(n => n.id === selectedNote.id), technique as FillConnectionKind);
    return `${hint} · ${reason ?? '连接同组下一个音'}`;
  }
  const techniques: { key: FillTechnique; shortcut: string }[] = [{ key: 'slideUp', shortcut: 'Shift+ArrowUp' }, { key: 'slideDown', shortcut: 'Shift+ArrowDown' }, { key: 'cut', shortcut: 'S' }, { key: 'dead', shortcut: 'X' }, { key: 'hammer', shortcut: 'H' }, { key: 'pull', shortcut: 'P' }, { key: 'tie', shortcut: 'T' }, { key: 'accent', shortcut: 'Shift+A' }];
  const objectCommands: Command[] = [
    { id: 'object.edit', label: '编辑选中的对象', keys: ['F2'], enabled: !!object, run: editObject },
    { id: 'object.delete', label: '删除选中的对象', keys: ['Delete'], enabled: !!object, run: deleteObject },
    ...([-1, 1] as const).flatMap(direction => [.25, 1].map(step => ({ id: `object.move.${direction}.${step}`, label: `${direction < 0 ? '向前' : '向后'}移动 ${step === 1 ? '1' : '¼'} 拍`, keys: [`${step === 1 ? 'Shift+' : ''}Arrow${direction < 0 ? 'Left' : 'Right'}`], enabled: !!object && object.kind !== 'section', run: () => moveObject(direction * step) }))),
    { id: 'fill.fewerLines', label: '加花减少一条下划线', keys: ['['], enabled: !!selectedNote && selectedNote.lines > 0, run: () => changeFill(current => setFillLines(current, selection!.group, selection!.note, (selectedNote!.lines - 1) as 0 | 1 | 2)) },
    { id: 'fill.moreLines', label: '加花增加一条下划线', keys: [']'], enabled: !!selectedNote && selectedNote.lines < 2, run: () => changeFill(current => setFillLines(current, selection!.group, selection!.note, (selectedNote!.lines + 1) as 0 | 1 | 2)) },
    ...[-1, 1].map(delta => ({ id: `fill.octave.${delta}`, label: `加花${delta > 0 ? '升高' : '降低'}一个八度`, keys: [`Arrow${delta > 0 ? 'Up' : 'Down'}`], enabled: !!selectedNote && selectedNote.digit !== 0 && Math.abs(selectedNote.octave + delta) <= 2, run: () => changeFill(current => setFillOctave(current, selection!.group, selection!.note, selectedNote!.octave + delta)) })),
    ...Array.from({ length: 8 }, (_, digit) => ({ id: `fill.digit.${digit}`, label: `加花改为 ${digit}${digit === 0 ? '（休止）' : ''}`, keys: [String(digit)], enabled: !!selectedNote, run: () => changeFill(current => setFillDigit(current, selection!.group, selection!.note, digit)) })),
    ...techniques.map(({ key, shortcut }) => ({ id: `fill.technique.${key}`, label: `切换加花${fillTechniqueLabels[key]}`, keys: [shortcut], enabled: techniqueEnabled(key), run: () => changeFill(current => setFillTechnique(current, selection!.group, selection!.note, key)) })),
    { id: 'object.cancel', label: '取消选择或加花输入', keys: ['Escape'], enabled: !!object || !!fillCursor, run: () => { setObject(null); setSelection(null); setFillCursor(null); } },
  ];
  useCommands([
    ...objectCommands.map(c => ({ ...c, scope: 'score' as const, group: '谱面对象', priority: 10 })),
    { id: 'score.addChord', label: p.topTrack === 'bass' ? '添加贝斯音名' : '添加和弦', priority: 20, group: '谱面', keys: ['Shift+C'], run: () => { const at = timeToPosition(p, Math.max(0, Math.min(p.duration - .001, cursor ?? props.time))); props.onNewChord(Math.max(1, at.bar), at.beat); } },
    { id: 'score.addFill', label: '添加手写加花', priority: 20, group: '谱面', keys: ['Shift+F'], run: () => openFill(cursor ?? props.time) },
    { id: 'score.addSection', label: '添加段落', priority: 20, group: '谱面', keys: ['Shift+S'], run: () => props.onNewSection(Math.max(1, timeToPosition(p, cursor ?? props.time).bar)) },
  ]);

  useEffect(() => {
    const resize = () => setMobile(window.innerWidth <= 650);
    const media = window.matchMedia('print');
    const print = () => flushSync(() => setPrinting(media.matches));
    const beforePrint = () => flushSync(() => setPrinting(true));
    const afterPrint = () => setPrinting(media.matches);
    window.addEventListener('resize', resize); media.addEventListener('change', print);
    window.addEventListener('beforeprint', beforePrint); window.addEventListener('afterprint', afterPrint);
    return () => { window.removeEventListener('resize', resize); media.removeEventListener('change', print); window.removeEventListener('beforeprint', beforePrint); window.removeEventListener('afterprint', afterPrint); };
  }, []);
  useEffect(() => { setEditingLyric(null); setFillCursor(null); setFillDigits(''); setSelection(null); setPreview(null); setObject(null); setCursor(null); }, [p.id]);
  useEffect(() => { if (fillCursor) input.current?.focus(); }, [fillCursor]);

  function startDrag(event: PointerEvent<HTMLElement>, kind: Drag['kind'], id: string, anchor: number) {
    if (event.button !== 0 || editingLyric || event.target instanceof HTMLInputElement) return;
    event.stopPropagation();
    const lane = event.currentTarget.closest<HTMLElement>('[data-track]');
    if (!lane) return;
    const bounds = lane.getBoundingClientRect(), startBar = Number(lane.dataset.startBar), endBar = Number(lane.dataset.endBar);
    const at = rowPercentTime(p, startBar, endBar, Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100)));
    const next: Drag = { kind, id, initialX: event.clientX, initialY: event.clientY, grab: at - anchor, target: anchor, moved: false, original: p, widths: kind === 'lyric' ? footprints() : {} };
    dragRef.current = next; setDrag(next);
  }
  useEffect(() => {
    if (!drag) return;
    const move = (event: globalThis.PointerEvent) => {
      const active = dragRef.current;
      if (!active) return;
      if (!active.moved && Math.hypot(event.clientX - active.initialX,event.clientY - active.initialY) < 5) return;
      active.moved = true; event.preventDefault();
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(`[data-track="${active.kind}"]`);
      if (!hit) return;
      const bounds = hit.getBoundingClientRect();
      active.target = rowPercentTime(active.original, Number(hit.dataset.startBar), Number(hit.dataset.endBar), Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100))) - active.grab;
      try { setPreview(active.kind === 'lyric' ? moveLyricWithPush(active.original, active.id, active.target, active.widths) : moveManualFill(active.original, active.id, active.target)); }
      catch (e) { onStatus(String(e)); }
      if (event.clientY > window.innerHeight - 110) window.scrollBy(0, 10);
      else if (event.clientY < 90) window.scrollBy(0, -10);
    };
    const end = () => {
      const active = dragRef.current;
      dragRef.current = null; setDrag(null); setPreview(null);
      if (active?.moved) {
        lastDrag.current = performance.now();
        setTimeout(()=>{lastDrag.current=0;},0);
        try { onEdit(current => active.kind === 'lyric' ? moveLyricWithPush(current, active.id, active.target, active.widths) : moveManualFill(current, active.id, active.target)); }
        catch (e) { onStatus(String(e)); }
      }
    };
    const cancel = () => { dragRef.current = null; setDrag(null); setPreview(null); };
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', cancel);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', cancel); };
  }, [!!drag, onEdit, onStatus]);

  function changeFill(fn: (current: Project) => Project) { try { onEdit(fn); } catch (e) { onStatus(String(e)); } }
  function insertFill() {
    if (!fillCursor || !/^[0-7]+$/.test(fillDigits)) return;
    const digits = fillDigits, at = fillCursor.time;
    try { const next = addManualFill(p, at, digits, uid(), [...digits].map(uid)); onEdit(() => next); setFillDigits(''); setFillCursor(null); }
    catch (e) { onStatus(String(e)); }
  }
  function split(id: string, caret: number, text: string) {
    const newId = uid();
    try { if (splitLyric(p,id,caret,newId,text)===p) return false; onEdit(current => splitLyric(current, id, caret, newId, text)); setEditingLyric(newId); return true; }
    catch (e) { onStatus(String(e)); return false; }
  }
  function merge(id: string, text: string) {
    const list = orderedLyrics(p), index = list.findIndex(l => l.id === id), previous = list[index - 1];
    if (!previous) return false;
    try { onEdit(current => mergeLyricPrevious(current, id, text)); setEditingLyric(previous.id); return true; }
    catch (e) { onStatus(String(e)); return false; }
  }

  return <div ref={root} data-object-kind={object?.kind} data-object-id={object?.id} className={'three-track-score' + (drag?.moved ? ' is-dragging' : '')} style={{ '--lyric-font': `${scoreStyle.lyricFontSize}px`, '--lyric-print-font': `${scoreStyle.lyricPrintSize}pt` } as CSSProperties} onFocusCapture={event => {
    const target = event.target as HTMLElement, lyric = target.closest<HTMLElement>('[data-lyric-id]'), chord = target.closest<HTMLElement>('[data-chord-id]'), fill = target.closest<HTMLElement>('[data-note-id]'), section = target.closest<HTMLElement>('[data-section-id]');
    if (lyric) { setObject({ kind: 'lyric', id: lyric.dataset.lyricId! }); setSelection(null); }
    else if (chord) { setObject({ kind: 'chord', id: chord.dataset.chordId! }); setSelection(null); }
    else if (fill) { setObject({ kind: 'fill', id: fill.dataset.noteId!, group: fill.dataset.fillId! }); setSelection({ group: fill.dataset.fillId!, note: fill.dataset.noteId! }); }
    else if (section) { setObject({ kind: 'section', id: section.dataset.sectionId! }); setSelection(null); }
  }} onClickCapture={event => {
    if (lastDrag.current>0&&performance.now() - lastDrag.current < 200) { event.preventDefault(); event.stopPropagation();lastDrag.current=0; return; }
    const lane = (event.target as HTMLElement).closest<HTMLElement>('[data-track]');
    if (lane && event.detail) { const rect = lane.getBoundingClientRect(); setCursor(Math.max(0, Math.min(p.duration, rowPercentTime(p, Number(lane.dataset.startBar), Number(lane.dataset.endBar), (event.clientX - rect.left) / rect.width * 100)))); }
  }}>
    <div className="track-intro no-print"><span>{p.topTrack === 'bass' ? '贝斯音名' : '和弦'} · 手写加花 · 歌词</span><small>歌词碰到才推 · 句首空格／退格调 ¼ 拍 · 双空格拆分 · F1 快捷键</small></div>
    {sections.map((section, index) => <section className="sheet-section" key={section.id}>
      <div className="sheet-section-heading" data-section-id={section.id}><div><span>{String(index + 1).padStart(2, '0')}</span><h3>{label(section, index)}</h3><small>{section.endBar - section.startBar + 1} 小节</small></div><div className="no-print"><button title="循环此段落" onClick={() => props.onLoop(section)}><Repeat2 size={15}/></button><button title="编辑段落 · F2" onClick={() => props.onSectionEdit(section.id)}><Pencil size={14}/></button></div></div>
      {rows.filter(row => row.sectionId === section.id).map(row => {
        const count = row.endBar - row.startBar + 1, beats = count * beatsPerBar(view);
        const chords = props.chords.filter(c => c.bar >= row.startBar && c.bar <= row.endBar);
        const start = row.startBar === 1 ? 0 : positionToTime(view, row.startBar, 1), end = Math.min(view.duration, positionToTime(view, row.endBar + 1, 1));
        const position = timeToPosition(view, props.time), current = props.playing && position.bar >= row.startBar && position.bar <= row.endBar;
        return <div className={'score-row' + (current ? ' playing' : '')} data-start-bar={row.startBar} key={row.startBar} style={{ '--row-bars': count, '--row-beats': beats } as CSSProperties}>
          <div className="row-ruler">{Array.from({ length: count }, (_, i) => {
            const bar = row.startBar + i, left = i === 0 ? 0 : rowTimePercent(view, row.startBar, row.endBar, positionToTime(view, bar, 1)), right = i === count - 1 ? 100 : rowTimePercent(view, row.startBar, row.endBar, positionToTime(view, bar + 1, 1));
            return <div key={i} className="bar-ruler" data-bar={bar} style={{ left: `${left}%`, width: `${right - left}%` }}><button className="bar-number" title="播放此小节" onClick={() => props.onSeek(positionToTime(view, bar, 1))}>{String(bar).padStart(2, '0')}</button><span>{Array.from({ length: beatsPerBar(view) }, (_, b) => <i key={b} style={{ left: `${(rowTimePercent(view, row.startBar, row.endBar, positionToTime(view, bar, b + 1)) - left) / (right - left) * 100}%` }}>{b + 1}</i>)}</span><button className="add-chord no-print" title={p.topTrack === 'bass' ? '添加贝斯音名 · Shift+C' : '添加和弦 · Shift+C'} onClick={() => props.onNewChord(bar)}><Plus size={13}/></button></div>;
          })}</div>
          <div className="track-grid">
            <div className="row-bar-lines" aria-hidden="true">{Array.from({ length: count - 1 }, (_, i) => <i key={i} style={{ left: `${rowTimePercent(view, row.startBar, row.endBar, positionToTime(view, row.startBar + i + 1, 1))}%` }}/>)}</div>
            {current && <i className="score-playhead no-print" aria-label="当前节拍" style={{ left: `${rowTimePercent(view, row.startBar, row.endBar, props.time)}%` }}/>} 
            {!props.playing && cursor !== null && cursor >= start && cursor < end && <i className="edit-cursor no-print" aria-label="谱面光标" style={{ left: `${rowTimePercent(view, row.startBar, row.endBar, cursor)}%` }}/>} 
            <div className="chord-track" data-track="chord" data-start-bar={row.startBar} data-end-bar={row.endBar} onDragOver={event => event.preventDefault()} onDrop={event => {
              event.preventDefault(); const [kind, id] = event.dataTransfer.getData('text/plain').split(':'); if (kind !== 'chord') return;
              const bounds = event.currentTarget.getBoundingClientRect(), t = rowPercentTime(p, row.startBar, row.endBar, (event.clientX - bounds.left) / bounds.width * 100), at = timeToPosition(p, t);
              if (p.topTrack === 'bass') { moveBass(id, t); return; }
              const beat = Math.max(1, Math.min(beatsPerBar(p) + .75, Math.round(at.beat * 4) / 4));
              onEdit(current => ({ ...current, chords: current.chords.map(c => c.id === id ? { ...c, bar: Math.max(1, at.bar), beat, locked: true, source: 'manual' } : c) }));
            }}><ChordLane chords={chords} beats={beats} degree={props.degree} songKey={view.key} fontSize={props.fontSize} onEdit={props.onChordEdit} labelFormatter={chord => topEventLabel(view, chord, props.degree)} anchorPercent={chord => rowTimePercent(view, row.startBar, row.endBar, topEventTime(view, chord))}/></div>
            <FillLane p={view} startBar={row.startBar} endBar={row.endBar} placements={fillLayout.items.filter(n => n.row === row.startBar)} connections={connections.filter(n => n.row === row.startBar)} height={fillLayout.heights[row.startBar] ?? 60} selection={selection} onSeek={props.onSeek} onSelect={setSelection} onPointerDown={startDrag} onEmpty={event => {
              if (drag?.moved || (event.target as HTMLElement).closest('button,input,.fill-input-box')) return;
              const bounds = event.currentTarget.getBoundingClientRect(); const at = rowPercentTime(p, row.startBar, row.endBar, (event.clientX - bounds.left) / bounds.width * 100);
              setEditingLyric(null); setSelection(null); setFillDigits(''); setFillCursor({ time: Math.max(0, Math.min(p.duration - .01, at)), row: row.startBar });
            }}>
              {fillCursor?.row === row.startBar && <div className="fill-input-box no-print" style={{ left: `${Math.min(70, rowTimePercent(view, row.startBar, row.endBar, fillCursor.time))}%` }}><input ref={input} aria-label="手写加花数字" value={fillDigits} placeholder="输入 1234" inputMode="numeric" onChange={event => setFillDigits(event.target.value.replace(/[^0-7]/g, '').slice(0, 64))} onKeyDown={event => { if (event.ctrlKey || event.metaKey || event.altKey) return; event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); insertFill(); } if (event.key === 'Escape') setFillCursor(null); }}/><button title="写入加花" onClick={insertFill}><Check size={14}/></button><button title="取消加花输入" onClick={() => setFillCursor(null)}><X size={14}/></button></div>}
            </FillLane>
            {selection && selectedNote && fillLayout.items.some(n => n.id === selectedNote.id && n.row === row.startBar) && <div className="fill-editor-panel no-print" role="group" aria-label="手写加花编辑">
              <div className="fill-tools" role="toolbar" aria-label="手写加花工具"><span>加花 {selectedNote.digit}</span>{fillLayout.items.find(n => n.id === selectedNote.id)?.compact && <small className="compact-hint">紧凑显示 · 演奏时间保留</small>}<label>下划线<select aria-label="加花下划线" title="[ 减少 / ] 增加" value={selectedNote.lines} onChange={event => changeFill(current => setFillLines(current, selection.group, selection.note, Number(event.target.value) as 0 | 1 | 2))}><option value="0">无 · 四分</option><option value="1">一条 · 八分</option><option value="2">两条 · 十六分</option></select></label><label>八度点<select aria-label="加花八度点" title="↑ 升八度 / ↓ 降八度" value={selectedNote.octave} disabled={selectedNote.digit === 0} onChange={event => changeFill(current => setFillOctave(current, selection.group, selection.note, Number(event.target.value)))}>{[-2, -1, 0, 1, 2].map(n => <option key={n} value={n}>{n < 0 ? `下方 ${-n} 点` : n > 0 ? `上方 ${n} 点` : '无'}</option>)}</select></label><button title="删除加花数字 · Delete" onClick={() => { changeFill(current => deleteFillNote(current, selection.group, selection.note)); setSelection(null); }}><Trash2 size={14}/></button><button title="收起加花工具 · Esc" onClick={() => setSelection(null)}><X size={14}/></button></div>
              <div className="fill-technique-tools" role="toolbar" aria-label="加花演奏技法">{techniques.map(({ key, shortcut }) => <span key={key} title={techniqueHint(key, shortcut)}><button type="button" aria-pressed={key === 'cut' || key === 'dead' || key === 'accent' ? !!selectedNote.notation?.[key] : selectedNote.notation?.connection?.kind === key} disabled={!techniqueEnabled(key)} aria-description={techniqueEnabled(key) ? undefined : techniqueHint(key, shortcut)} onClick={() => changeFill(current => setFillTechnique(current, selection.group, selection.note, key))}>{fillTechniqueLabels[key]}<kbd>{shortcut.replace('ArrowUp', '↑').replace('ArrowDown', '↓')}</kbd></button></span>)}</div>
            </div>}
            <LyricLane p={view} startBar={row.startBar} endBar={row.endBar} start={start} end={end} fontSize={lyricSize} editing={editingLyric} onEditing={setEditingLyric} onPointerDown={startDrag} onSeek={props.onSeek} onCommit={(id, text) => onEdit(current => current.lyrics.find(l => l.id === id)?.text === text ? current : ({ ...current, lyrics: current.lyrics.map(l => l.id === id ? { ...l, text, locked: true, source: 'manual' } : l) }))} onSplit={split} onMerge={merge} onNudge={nudge}/>
          </div>
        </div>;
      })}
    </section>)}
  </div>;
}

type Placed = { id: string; left: number; top: number; width: number };
/** Only this lane's height changes when labels overlap. Anchors remain at their real times. */
function useLaneLayout(signature: string, fontSize: number, items: { id: string; percent: number; text: string; minWidth?: number }[], lineHeight: number, gap = 4) {
  const ref = useRef<HTMLDivElement>(null), [layout, setLayout] = useState<{ placed: Placed[]; height: number }>({ placed: [], height: lineHeight });
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const width = Math.max(1, element.getBoundingClientRect().width);
      // Use the rendered lyric style, including font weight, padding, CJK shaping and
      // explicit newlines. Canvas estimates can put the last character on an
      // unaccounted line when the browser lays out fractional print-font sizes.
      const probe = document.createElement('button');
      probe.type = 'button'; probe.tabIndex = -1; probe.className = 'lyric track-lyric';
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { visibility: 'hidden', pointerEvents: 'none', maxWidth: 'none', minWidth: '0', top: '0' });
      probe.style.setProperty('--track-left', '0%');
      element.appendChild(probe);
      const actual = getComputedStyle(probe), size = parseFloat(actual.fontSize) || fontSize;
      const heightPerLine = parseFloat(actual.lineHeight) || lineHeight * size / fontSize;
      const ends: number[] = [], heights: number[] = [], provisional: (Placed & { row: number })[] = [];
      for (const item of items) {
        const left = Math.max(0, Math.min(width - 12, item.percent / 100 * width));
        probe.textContent = item.text; probe.style.width = 'max-content';
        const labelWidth = Math.max(item.minWidth ?? 8, Math.ceil(probe.getBoundingClientRect().width) + 2);
        const available = Math.max(12, width - left), boxWidth = Math.min(available, labelWidth);
        probe.style.width = `${boxWidth}px`;
        const wrappedHeight = Math.ceil(probe.getBoundingClientRect().height) + 2;
        let row = ends.findIndex(end => end <= left + .1); if (row < 0) row = ends.length;
        ends[row] = left + boxWidth + gap;
        heights[row] = Math.max(heights[row] ?? heightPerLine, wrappedHeight);
        provisional.push({ id: item.id, left: left / width * 100, top: 0, width: boxWidth / width * 100, row });
      }
      probe.remove();
      const tops: number[] = []; let height = 0; heights.forEach((h, index) => { tops[index] = height; height += h + 5; });
      setLayout({ placed: provisional.map(item => ({ ...item, top: tops[item.row] })), height: Math.max(heightPerLine, height) });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element); const media = window.matchMedia('print'); media.addEventListener('change', measure); document.fonts.ready.then(measure);
    const beforePrint = () => flushSync(measure);
    window.addEventListener('beforeprint', beforePrint); window.addEventListener('afterprint', measure);
    return () => { active = false; observer.disconnect(); media.removeEventListener('change', measure); window.removeEventListener('beforeprint', beforePrint); window.removeEventListener('afterprint', measure); };
  }, [signature, fontSize, lineHeight, gap]);
  return { ref, ...layout };
}

function FillLane({ p, startBar, endBar, placements, connections, height, selection, onSelect, onSeek, onPointerDown, onEmpty, children }: { p: Project; startBar: number; endBar: number; placements: FillPlacement[]; connections: FillConnectionPath[]; height: number; selection: FillSelection | null; onSelect: (selection: FillSelection) => void; onSeek: (time: number) => void; onPointerDown: (event: PointerEvent<HTMLElement>, kind: Drag['kind'], id: string, time: number) => void; onEmpty: (event: React.MouseEvent<HTMLDivElement>) => void; children: React.ReactNode }) {
  return <div className="manual-fill-track" data-track="fill" data-start-bar={startBar} data-end-bar={endBar} style={{ minHeight: height }} onClick={onEmpty}>
    {!placements.length && <span className="fill-empty no-print">点击拍位写加花 · Shift+F</span>}
    <svg className="fill-connections" aria-hidden="true" width="100%" height={height}>{connections.map(link => <g key={link.id}><path d={link.path}/>{link.label && <text x={link.labelX} y={link.labelY}>{link.label}</text>}</g>)}</svg>
    {placements.map(at => {
      const group = p.manualFills?.find(g => g.id === at.group), n = group?.notes.find(note => note.id === at.id); if (!n || !group) return null;
      return <button key={n.id} className={'manual-fill-note' + (selection?.note === n.id ? ' selected' : '')} data-fill-id={group.id} data-note-id={n.id} data-start={n.start} data-end={n.end} data-compact={at.compact} data-range-left={at.rangeLeft} data-range-right={at.rangeRight} style={{ left: at.left, top: at.top, width: at.width, fontSize: at.fontSize }} onPointerDown={event => onPointerDown(event, 'fill', group.id, group.notes[0].start)} onClick={event => { event.stopPropagation(); onSelect({ group: group.id, note: n.id }); onSeek(n.start); }} title={`手写加花 ${n.digit} · ${formatTime(n.start)} · ${at.compact ? '紧凑显示 · ' : ''}拖动整组 · [ ] 下划线 · ↑ ↓ 八度`}>
        <FillDigit note={n}/>
      </button>;
    })}{children}
  </div>;
}

export function FillDigit({ note }: { note: ManualFillNote }) {
  const dead = !!note.notation?.dead && note.digit !== 0;
  return <span className="fill-symbol"><span className="fill-connection-space"/><span className="fill-technique-marks"><span aria-label={note.notation?.accent ? '重音' : undefined}>{note.notation?.accent ? '>' : ''}</span><span aria-label={note.notation?.cut ? '切音' : undefined}>{note.notation?.cut ? '切' : ''}</span></span><span className="fill-octave above" aria-label={note.octave > 0 ? `高 ${note.octave} 个八度` : undefined}>{note.digit !== 0 && !dead && note.octave > 0 ? '·'.repeat(note.octave) : '\u00a0'}</span><span className={'fill-number' + (dead ? ' fill-dead' : '')} aria-label={dead ? '闷音 / 死音' : undefined}>{dead ? '×' : note.digit}</span><span className="fill-underlines" data-lines={note.lines}>{Array.from({ length: note.lines }, (_, i) => <i key={i}/>)}</span><span className="fill-octave below" aria-label={note.octave < 0 ? `低 ${-note.octave} 个八度` : undefined}>{note.digit !== 0 && !dead && note.octave < 0 ? '·'.repeat(-note.octave) : '\u00a0'}</span></span>;
}

function LyricLane({ p, startBar, endBar, start, end, fontSize, editing, onEditing, onPointerDown, onSeek, onCommit, onSplit, onMerge, onNudge }: { p: Project; startBar: number; endBar: number; start: number; end: number; fontSize: number; editing: string | null; onEditing: (id: string | null) => void; onPointerDown: (event: PointerEvent<HTMLElement>, kind: Drag['kind'], id: string, time: number) => void; onSeek: (time: number) => void; onCommit: (id: string, text: string) => void; onSplit: (id: string, caret: number, text: string) => boolean; onMerge: (id: string, text: string) => boolean; onNudge: (id: string, beats: number, text: string) => boolean }) {
  const lyrics = orderedLyrics(p).filter(l => l.start >= start - 1e-8 && l.start < end - 1e-8);
  const items = lyrics.map(l => ({ id: l.id, text: l.text, percent: rowTimePercent(p, startBar, endBar, Math.max(start, l.start)) }));
  const layout = useLaneLayout(JSON.stringify(items), fontSize, items, fontSize * 1.55, 0);
  return <div className="editable-lyric-track" data-track="lyric" data-start-bar={startBar} data-end-bar={endBar} ref={layout.ref} style={{ minHeight: layout.height + 10 }}>
    {lyrics.map(l => {
      const at = layout.placed.find(item => item.id === l.id), style = { left: `${at?.left ?? rowTimePercent(p, startBar, endBar, l.start)}%`, top: at?.top ?? 0, width: `${at?.width ?? 100}%` };
      return editing === l.id ? <InlineLyric key={l.id} lyric={l} style={style} onCommit={text => onCommit(l.id, text)} onClose={() => onEditing(null)} onSplit={(caret, text) => onSplit(l.id, caret, text)} onMerge={text => onMerge(l.id, text)} onNudge={(beats, text) => onNudge(l.id, beats, text)}/> : <button key={l.id} className="lyric track-lyric" data-lyric-id={l.id} data-start={l.start} data-end={l.end} style={{...style,'--track-left':style.left} as CSSProperties} onPointerDown={event => onPointerDown(event, 'lyric', l.id, l.start)} onClick={() => onSeek(l.start)} onDoubleClick={() => onEditing(l.id)} title={`${l.text} · ${formatTime(l.start)} · 双击 / F2 编辑 · 拖动碰到才推`}>{l.text}</button>;
    })}
  </div>;
}

/** Local text edits are committed as one transaction; double-key commands consume no lyric text. */
function InlineLyric({ lyric, style, onCommit, onClose, onSplit, onMerge, onNudge }: { lyric: Lyric; style: CSSProperties; onCommit: (text: string) => void; onClose: () => void; onSplit: (caret: number, text: string) => boolean; onMerge: (text: string) => boolean; onNudge: (beats: number, text: string) => boolean }) {
  const [text, setText] = useState(lyric.text), field = useRef<HTMLTextAreaElement>(null), composing = useRef(false), committed = useRef(false);
  const [compositionVersion,setCompositionVersion]=useState(0);
  const double = useRef<{ key: string; time: number; caret: number; original: string } | null>(null);
  useEffect(() => { field.current?.focus(); field.current?.setSelectionRange(0, 0); }, []);
  useEffect(() => { if(text===lyric.text||committed.current)return;const timer=setTimeout(()=>{if(!composing.current&&!committed.current)onCommit(text);},600);return()=>clearTimeout(timer); },[text,lyric.text,compositionVersion]);
  useEffect(()=>{const beforePrint=()=>flushSync(commit);window.addEventListener('beforeprint',beforePrint);window.addEventListener('basschart:commit-lyric',commit);return()=>{window.removeEventListener('beforeprint',beforePrint);window.removeEventListener('basschart:commit-lyric',commit);};},[text,lyric.text]);
  useCommands([
    { id: 'lyric.split', label: '在光标处拆分歌词', keys: ['Ctrl+Enter'], group: '歌词', inInput: true, keepEditor: true, priority: 30, run: () => { committed.current = onSplit(field.current?.selectionStart ?? 0, text); } },
    { id: 'lyric.merge', label: '歌词与前一句合并', keys: ['Ctrl+Shift+Enter'], group: '歌词', inInput: true, keepEditor: true, priority: 30, run: () => { committed.current = onMerge(text); } },
  ]);
  function commit() { if (committed.current) return; committed.current = true; if (text !== lyric.text) onCommit(text); onClose(); }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { double.current = null; event.stopPropagation(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) { double.current = null; return; }
    event.stopPropagation();
    const element = event.currentTarget, caret = element.selectionStart, collapsed = caret === element.selectionEnd, now = performance.now();
    if (event.repeat) { double.current = null; if (collapsed && caret === 0 && (event.key === ' ' || event.key === 'Backspace')) event.preventDefault(); return; }
    if (event.key === 'Escape') { event.preventDefault(); committed.current = true; onClose(); return; }
    if (event.key === 'Enter') { event.preventDefault(); commit(); return; }
    const previous = double.current;
    if (event.key === ' ' && collapsed && caret === 0) { event.preventDefault(); double.current = null; onNudge(.25, text); return; }
    if (event.key === ' ' && collapsed) {
      if (previous?.key === ' ' && now - previous.time <= 500 && caret === previous.caret + 1 && text === previous.original.slice(0, previous.caret) + ' ' + previous.original.slice(previous.caret)) {
        event.preventDefault(); double.current = null;
        if (previous.caret > 0 && previous.caret < previous.original.length) { committed.current = onSplit(previous.caret, previous.original); }
        else setText(previous.original);
      } else double.current = { key: ' ', time: now, caret, original: text };
      return;
    }
    if (event.key === 'Backspace' && collapsed && caret === 0) {
      event.preventDefault();
      if (onNudge(-.25, text)) { double.current = null; return; }
      if (previous?.key === 'Backspace' && now - previous.time <= 500) { double.current = null; committed.current = onMerge(text); }
      else double.current = { key: 'Backspace', time: now, caret: 0, original: text };
      return;
    }
    double.current = null;
  }
  return <><textarea ref={field} className="inline-lyric-editor no-print" data-lyric-id={lyric.id} aria-label="直接编辑歌词" style={{ ...style, minWidth: 90 }} value={text} rows={2} onChange={event => setText(event.target.value)} onBlur={() => { if (!document.querySelector('.command-panel')) commit(); }} onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; double.current = null; }} onCompositionEnd={() => { composing.current = false; double.current = null;setCompositionVersion(v=>v+1); }}/><span className="lyric-print-only" style={style}>{text}</span></>
}
