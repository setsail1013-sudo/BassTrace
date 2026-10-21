import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { CSSProperties } from 'react';
import type { Chord } from './music';
import { layoutChordLabels, romanChord } from './music';

type Props = { chords: Chord[]; beats: number; degree: boolean; songKey: string; fontSize: number; onEdit: (id: string) => void; anchorPercent?: (chord: Chord) => number; labelFormatter?: (chord: Chord) => string };
type Layout = ReturnType<typeof layoutChordLabels> & { tops: number[]; height: number; baseWidth: number };

/** Move overlapping labels to separate rows without moving their beat anchors. */
export function ChordLane({ chords, beats, degree, songKey, fontSize, onEdit, anchorPercent, labelFormatter }: Props) {
  const lane = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const text = (chord: Chord) => labelFormatter ? labelFormatter(chord) : degree ? romanChord(chord.label, songKey) : chord.label;
  const labels = chords.map(chord => ({ id: chord.id, beat: anchorPercent ? 1 + anchorPercent(chord) / 100 * beats : chord.beat, label: text(chord) }));
  const signature = JSON.stringify(labels);

  useLayoutEffect(() => {
    const container = lane.current;
    if (!container) return;
    const context = document.createElement('canvas').getContext('2d');
    let active = true;
    const measure = () => {
      if (!active) return;
      const width = container.getBoundingClientRect().width;
      const button = container.querySelector<HTMLButtonElement>('.chord');
      const style = getComputedStyle(button || container);
      const size = parseFloat(style.fontSize) || fontSize;
      if (context) context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const next = layoutChordLabels(JSON.parse(signature), beats, width, text => (context?.measureText(text).width ?? text.length * size * .75) + 6);
      const buttons = new Map([...container.querySelectorAll<HTMLButtonElement>('.chord')].map(element => [element.dataset.chordId, element]));
      const heights: number[] = [];
      next.items.forEach(item => {
        const element = buttons.get(item.id), previous = element?.style.width;
        if (element) element.style.width = `${item.width}px`;
        heights[item.row] = Math.max(heights[item.row] || size * 1.4, element?.getBoundingClientRect().height || 0);
        if (element) element.style.width = previous || '';
      });
      const tops: number[] = []; let total = 8;
      heights.forEach((height, row) => { tops[row] = total; total += height + 9; });
      setLayout({ ...next, tops, height: Math.max(30, total), baseWidth: Math.max(1, width) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    const print = window.matchMedia('print');
    const beforePrint = () => flushSync(measure);
    print.addEventListener('change', measure);
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', measure);
    document.fonts.ready.then(measure);
    return () => { active = false; observer.disconnect(); print.removeEventListener('change', measure); window.removeEventListener('beforeprint', beforePrint); window.removeEventListener('afterprint', measure); };
  }, [signature, beats, fontSize]);

  const positions = new Map(layout?.items.map(item => [item.id, item]));
  return <div ref={lane} className="chord-lane" style={{ height: layout?.height ?? 30 }}>
    {chords.map(chord => {
      const item = positions.get(chord.id);
      const style = item ? { left: `${item.left / layout!.baseWidth * 100}%`, top: layout?.tops[item.row] ?? 8, width: `${item.width / layout!.baseWidth * 100}%`, '--chord-anchor': `${(item.anchor - item.left) / Math.max(1, item.width) * 100}%` } : { left: `${(chord.beat - 1) / beats * 100}%`, '--chord-anchor': '0px' };
      return <button key={chord.id} className={chord.locked ? 'chord locked' : 'chord'} style={style as CSSProperties} data-beat={anchorPercent ? 1 + anchorPercent(chord) / 100 * beats : chord.beat} data-chord-id={chord.id} draggable onDragStart={event => event.dataTransfer.setData('text/plain', `chord:${chord.id}`)} onClick={() => onEdit(chord.id)} title={`第 ${chord.beat} 拍 · ${chord.source === 'analysis' ? `候选 ${Math.round(chord.confidence * 100)}%` : '点击编辑 / 拖动拍点'}`}>
        {text(chord)}{chord.locked && <i/>}
      </button>;
    })}
  </div>;
}
