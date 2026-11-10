import { keyLabel } from './project-features';
import type { Project } from './music';

export interface PerformanceNotes {
  effectsPreset: string;
  technique: string;
  reminders: string;
  includeInExport: boolean;
}
export const EMPTY_PERFORMANCE_NOTES: PerformanceNotes = { effectsPreset: '', technique: '', reminders: '', includeInExport: true };
export function readPerformanceNotes(p: Pick<Project, 'performanceNotes'>): PerformanceNotes {
  return { ...EMPTY_PERFORMANCE_NOTES, ...p.performanceNotes };
}
export const noteFields = [
  { key: 'effectsPreset', label: '效果器预设', placeholder: '03 号 · 温暖指弹' },
  { key: 'technique', label: '弹奏方式', placeholder: '主歌轻指弹，副歌加强力度' },
  { key: 'reminders', label: '注意事项', placeholder: '第二遍副歌后停两拍，尾奏看鼓手' },
] as const;

/** Ignore beat-tracker jitter; flag sustained tempo changes greater than 8%. */
export function hasTempoChanges(p: Pick<Project, 'beatTimes'>): boolean {
  const times=p.beatTimes??[], windows:number[]=[];
  for(let i=0;i+4<times.length;i+=4) windows.push((times[i+4]-times[i])/4);
  if(windows.length<2)return false;
  return Math.max(...windows)>Math.min(...windows)*1.08;
}
export function performanceHeader(p: Project, escape: (s: unknown)=>string): string {
  const notes=readPerformanceNotes(p);
  const meta=`调性：${escape(keyLabel(p))}${p.key!==p.originalKey?`（原调 ${escape(keyLabel(p,true))}）`:''}　｜　速度：${escape(p.bpm)} BPM${hasTempoChanges(p)?'（有变速）':''}　｜　拍号：${escape(p.meter)}`;
  return `<header class="sheet-header performance-header"><h1>${escape(p.title)}</h1><p class="performance-meta">${meta}</p>${p.artist?`<p class="performance-artist">${escape(p.artist)}</p>`:''}</header><div class="performance-export-notes">${notes.includeInExport?noteFields.filter(field=>notes[field.key].trim()).map(field=>`<p class="performance-note ${field.key}"><b>${field.label}：</b><span>${escape(notes[field.key])}</span></p>`).join(''):''}</div><template id="continuationHeader"><div class="continuation-header"><b>${escape(p.title)}</b><span>${meta}</span></div></template>`;
}
