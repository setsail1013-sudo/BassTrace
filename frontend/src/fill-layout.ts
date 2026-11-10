import { positionToTime, timeToPosition, type Project } from './music';
import { beatIndex, type ScoreRow } from './tracks';
import { topEvents, topEventTime } from './top-track';

export interface FillLayoutRow { id: number; start: number; end: number; width: number }
export interface FillLayoutGroup { id: string; start: number; end: number; notes: { id: string; beat: number }[]; bands?: number[] }
export interface FillPlacement { id: string; group: string; row: number; left: number; top: number; width: number; fontSize: number; compact: boolean; rangeLeft: number; rangeRight: number; symbolRows?: string; height?: number }

export function fillLayoutRows(p: Project, rows: ScoreRow[], width: number): FillLayoutRow[] {
  return rows.map(row => ({ id: row.startBar, start: beatIndex(p, row.startBar === 1 ? 0 : positionToTime(p, row.startBar, 1)),
    end: beatIndex(p, Math.min(p.duration, positionToTime(p, row.endBar + 1, 1))), width }));
}
export function fillLayoutGroups(p: Project): FillLayoutGroup[] {
  const events = topEvents(p).map(c => ({ start: topEventTime(p, c), end: c.end ?? p.duration }));
  const boundaries = [...new Set(events.map(c => c.start).filter(t => t >= 0 && t < p.duration))].sort((a, b) => a - b);
  return (p.manualFills ?? []).filter(g => g.notes.length).map(g => {
    const first = g.notes[0].start;
    let at = -1; boundaries.forEach((t, i) => { if (t <= first + 1e-8) at = i; });
    const bar = Math.max(1, timeToPosition(p, first).bar);
    // A bass silence is not an endlessly held harmony; keep fills in its current bar.
    const active = at >= 0 && (p.topTrack !== 'bass' || events.some(c => Math.abs(c.start - boundaries[at]) < 1e-8 && c.end > first));
    const start = active ? boundaries[at] : bar === 1 ? 0 : Math.max(0, positionToTime(p, bar, 1));
    const end = active ? Math.min(boundaries[at + 1] ?? p.duration, p.topTrack === 'bass' ? Math.max(...events.filter(c => Math.abs(c.start - boundaries[at]) < 1e-8).map(c => c.end)) : p.duration) : Math.min(p.duration, boundaries.find(t => t > first) ?? p.duration, positionToTime(p, bar + 1, 1));
    const bands = [g.notes.some(n=>n.notation?.connection)?14:0, Math.max(...g.notes.map(n=>Number(!!n.notation?.accent)+Number(!!n.notation?.cut)))*11, g.notes.some(n=>n.digit&&n.octave>0&&!n.notation?.dead)?9:0, 0, g.notes.some(n=>n.lines)?7:0, g.notes.some(n=>n.digit&&n.octave<0&&!n.notation?.dead)?9:0];
    return { id: g.id, start: beatIndex(p, start), end: beatIndex(p, end), notes: g.notes.map(n => ({ id: n.id, beat: beatIndex(p, n.start) })), bands };
  });
}

/** Self-contained so the offline HTML embeds the exact same engraving algorithm. */
export function layoutCompactFills(rows: FillLayoutRow[], groups: FillLayoutGroup[], fontSize: number, minimum = 12): { items: FillPlacement[]; heights: Record<number, number> } {
  const items: FillPlacement[] = [], heights: Record<number, number> = {}, occupied: Record<number, { left: number; right: number; top: number; bottom: number }[]> = {};
  const size = Math.max(minimum, fontSize), symbolWidth = (font: number) => Math.max(12, font * .78);
  for (const row of rows) { heights[row.id] = 0; occupied[row.id] = []; }
  for (const group of groups) {
    if (!group.notes.length) continue;
    const bands = group.bands ?? [0,0,0,0,7,0];
    const lineHeight = (font:number) => font * 1.2 + bands.reduce((sum,n)=>sum+n,0) + 8;
    const segments = rows.filter(r => r.width > 0 && r.end > group.start && r.start < group.end).map(r => ({
      row: r, left: Math.max(0, (group.start - r.start) / (r.end - r.start) * r.width),
      right: Math.min(r.width, (group.end - r.start) / (r.end - r.start) * r.width),
    })).filter(s => s.right > s.left);
    if (!segments.length) continue;
    let placements: { note: { id: string; beat: number }; segment: typeof segments[number]; x: number; line: number }[] = [];
    let compact = false, chosenSize = size;
    for (const note of group.notes) {
      const segment = segments.find(s => note.beat >= s.row.start && note.beat < s.row.end);
      if (!segment) { compact = true; break; }
      const x = (note.beat - segment.row.start) / (segment.row.end - segment.row.start) * segment.row.width;
      const last = placements.at(-1);
      if (x < segment.left - .01 || x + symbolWidth(size) > segment.right + .01 ||
          (last?.segment === segment && x < last.x + symbolWidth(size) + 1)) { compact = true; break; }
      placements.push({ note, segment, x, line: 0 });
    }
    if (compact) {
      // First keep the written start, then reclaim space back to this chord's left edge.
      const first = group.notes[0].beat;
      let usable = segments.filter(s => s.row.end > first).map(s => ({ ...s, left: Math.max(s.left, (first - s.row.start) / (s.row.end - s.row.start) * s.row.width) }));
      const capacity = (list: typeof segments, font: number) => list.reduce((n, s) => n + Math.floor((s.right - s.left + 1) / (symbolWidth(font) + 1)), 0);
      if (capacity(usable, size) < group.notes.length) usable = segments;
      while (chosenSize > minimum && capacity(usable, chosenSize) < group.notes.length) chosenSize = Math.max(minimum, chosenSize - 1);
      placements = [];
      let index = 0;
      for (let segmentIndex = 0; segmentIndex < usable.length; segmentIndex++) {
          const segment = usable[segmentIndex];
          const width = Math.min(symbolWidth(chosenSize), segment.right - segment.left);
          const count = Math.max(1, Math.floor((segment.right - segment.left + 1) / (width + 1)));
          const take = segmentIndex === usable.length - 1 ? group.notes.length - index : Math.min(count, group.notes.length - index);
          for (let j = 0; j < take; j++, index++)
            placements.push({ note: group.notes[index], segment, x: segment.left + (j % count) * (width + 1), line: Math.floor(j / count) });
      }
    }
    // A whole group gets its own vertical offset where necessary; another group cannot overlap it.
    for (const segment of segments) {
      const local = placements.filter(n => n.segment.row.id === segment.row.id);
      if (!local.length) continue;
      const h = lineHeight(chosenSize), w = Math.min(symbolWidth(chosenSize), segment.right - segment.left);
      let offset = 4;
      for (;;) {
        const conflicts = local.flatMap(n => occupied[segment.row.id].filter(b => n.x < b.right + 1 && n.x + w + 1 > b.left && offset + n.line * h < b.bottom + 2 && offset + (n.line + 1) * h + 2 > b.top));
        if (!conflicts.length) break;
        offset = Math.max(...conflicts.map(b => b.bottom)) + 3;
      }
      for (const n of local) {
        const top = offset + n.line * h;
        items.push({ id: n.note.id, group: group.id, row: segment.row.id, left: n.x, top, width: w, fontSize: chosenSize, compact, rangeLeft: segment.left, rangeRight: segment.right, symbolRows: bands.map((v,i)=>`${i===3?chosenSize*1.2:v}px`).join(' '), height:h });
        occupied[segment.row.id].push({ left: n.x, right: n.x + w, top, bottom: top + h });
        heights[segment.row.id] = Math.max(heights[segment.row.id], top + h + 4);
      }
    }
  }
  return { items, heights };
}
