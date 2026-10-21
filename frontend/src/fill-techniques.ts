import type { ManualFill, ManualFillNote, Project } from './music';
import type { FillPlacement } from './fill-layout';

export type FillConnectionKind = 'slideUp' | 'slideDown' | 'hammer' | 'pull' | 'tie';
export type FillTechnique = 'cut' | 'dead' | 'accent' | FillConnectionKind;
export const fillTechniqueLabels: Record<FillTechnique, string> = { slideUp: '上滑音', slideDown: '下滑音', cut: '切音', dead: '闷音 / 死音', hammer: '击弦', pull: '勾弦', tie: '延音线', accent: '重音' };

export function connectionError(notes: ManualFillNote[], index: number, kind: FillConnectionKind): string | null {
  const note = notes[index], next = notes[index + 1];
  if (!note || !next) return '请先在这一组加花中添加下一个数字。';
  if (!note.digit || !next.digit || note.notation?.dead || next.notation?.dead) return '休止和闷音不能连接滑音、击勾弦或延音线。';
  if (kind === 'tie' && (note.digit !== next.digit || note.octave !== next.octave || Math.abs(note.end - next.start) > 1e-6)) return '延音线需要相邻、相同数字和八度的两个音。';
  return null;
}

/** Preserve explicit endpoints: deletion never connects across the missing note. */
export function cleanFillNotation(group: ManualFill): ManualFill {
  let changed = false;
  const notes = group.notes.map((note, index) => {
    const notation = note.notation;
    if (!notation) return note;
    const connection = notation.connection;
    const invalid = connection && (group.notes[index + 1]?.id !== connection.targetNoteId || !!connectionError(group.notes, index, connection.kind));
    if (note.digit === 0 && (notation.cut || notation.dead || notation.accent || connection)) {
      changed = true; return { ...note, notation: { cut: false, dead: false, accent: false, connection: null } };
    }
    if (invalid) { changed = true; return { ...note, notation: { ...notation, connection: null } }; }
    return note;
  });
  return changed ? { ...group, notes } : group;
}

export function setFillTechnique(p: Project, groupId: string, noteId: string, technique: FillTechnique): Project {
  const group = p.manualFills?.find(g => g.id === groupId), index = group?.notes.findIndex(n => n.id === noteId) ?? -1;
  if (!group || index < 0) return p;
  const note = group.notes[index];
  if (!note.digit) throw new RangeError('休止符不添加演奏技法。');
  let notation = { ...note.notation };
  if (technique === 'cut' || technique === 'dead' || technique === 'accent') notation = { ...notation, [technique]: !notation[technique] };
  else if (notation.connection?.kind === technique) notation.connection = null;
  else {
    const error = connectionError(group.notes, index, technique);
    if (error) throw new RangeError(error);
    notation.connection = { kind: technique, targetNoteId: group.notes[index + 1].id };
  }
  const updated = cleanFillNotation({ ...group, notes: group.notes.map(n => n.id === noteId ? { ...n, notation } : n) });
  return { ...p, manualFills: p.manualFills!.map(g => g.id === groupId ? updated : g) };
}

export interface FillConnectionPath {
  id: string; row: number; path: string; label: string; labelX: number; labelY: number;
  continuesFrom: boolean; continuesTo: boolean; kind: FillConnectionKind;
}

/** Self-contained: the offline score embeds this exact function. Coordinates are display-only. */
export function layoutFillConnections(placements: FillPlacement[], groups: ManualFill[]): FillConnectionPath[] {
  const result: FillConnectionPath[] = [], byId = new Map(placements.map(p => [p.id, p]));
  for (const group of groups) for (const [index, note] of group.notes.entries()) {
    const link = note.notation?.connection, next = group.notes[index + 1];
    if (!link || next?.id !== link.targetNoteId || !note.digit || !next.digit || note.notation?.dead || next.notation?.dead) continue;
    const a = byId.get(note.id), b = byId.get(next.id); if (!a || !b) continue;
    const sameLine = a.row === b.row && Math.abs(a.top - b.top) < 1;
    const parts = sameLine ? [{ at: a, from: a.left + a.width / 2, to: b.left + b.width / 2, fromPrevious: false, toNext: false }]
      : [{ at: a, from: a.left + a.width / 2, to: a.rangeRight, fromPrevious: false, toNext: true },
        { at: b, from: b.rangeLeft, to: b.left + b.width / 2, fromPrevious: true, toNext: false }];
    for (const [part, item] of parts.entries()) {
      const x1 = item.from, x2 = Math.max(x1 + .5, item.to), y = item.at.top + 9;
      const slide = link.kind === 'slideUp' || link.kind === 'slideDown';
      const startY = slide && link.kind === 'slideUp' ? y + 3 : y - (slide ? 3 : 0);
      const endY = slide && link.kind === 'slideDown' ? y + 3 : y - (slide ? 3 : 0);
      let path = slide ? `M${x1},${startY} L${x2},${endY}` : `M${x1},${y} Q${(x1 + x2) / 2},${y - 11} ${x2},${y}`;
      if (item.fromPrevious) path += ` M${x1},${startY - 2} L${x1},${startY + 2}`;
      if (item.toNext) path += ` M${x2},${endY - 2} L${x2},${endY + 2}`;
      result.push({ id: `${note.id}-${part}`, row: item.at.row, path, label: link.kind === 'hammer' ? 'H' : link.kind === 'pull' ? 'P' : '', labelX: (x1 + x2) / 2, labelY: y - 1, continuesFrom: item.fromPrevious, continuesTo: item.toNext, kind: link.kind });
    }
  }
  return result;
}
