import { barCount, beatsPerBar, copySectionChords, displayChords, positionToTime, romanChord, timeToPosition, type BassEvent, type Chord, type Project, type Section } from './music';
import { numberPitch } from './notation';

export function bassName(p: Pick<Project, 'key'>, pitch: number): string {
  const flats = /[b♭]/.test(p.key) || /^(F|Dm|Gm|Cm|Fm)(?:$|\s)/.test(p.key);
  return (flats ? ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'] : ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'])[((pitch % 12) + 12) % 12];
}
export function bassDegree(p: Pick<Project, 'key'>, pitch: number): string { return numberPitch(60 + pitch, p.key).text; }
export function topEvents(p: Project): Chord[] {
  if (p.topTrack !== 'bass') return displayChords(p);
  return [...(p.bassEvents ?? [])].sort((a,b) => a.start - b.start).map(event => {
    const at = timeToPosition(p, event.start);
    return { ...event, bar: Math.max(1, at.bar), beat: at.bar < 1 ? 1 : at.beat, label: bassName(p, event.pitchClass) };
  });
}
export function topEventTime(p: Project, event: Chord): number { return p.topTrack === 'bass' ? event.start ?? 0 : positionToTime(p, event.bar, event.beat); }
export function topEventLabel(p: Project, event: Chord, degree = false): string {
  if (!degree) return event.label;
  const bass = p.topTrack === 'bass' ? p.bassEvents?.find(b => b.id === event.id) : undefined;
  return bass ? bassDegree(p, bass.pitchClass) : romanChord(event.label, p.key);
}
export function topEventAt(p: Project, time: number): Chord | undefined {
  return topEvents(p).filter(event => topEventTime(p,event) <= time && (p.topTrack !== 'bass' || time < (event.end ?? p.duration))).at(-1);
}

export function copySectionTop(p: Project, source: Section, targetBar: number, makeId: () => string = () => crypto.randomUUID()): Project {
  if (p.topTrack !== 'bass') return copySectionChords(p, source, targetBar);
  const length = source.endBar - source.startBar + 1;
  if (!Number.isInteger(targetBar) || targetBar < 1 || targetBar + length - 1 > barCount(p)) throw new Error('目标段落超出歌曲小节范围');
  const from = source.startBar === 1 ? 0 : positionToTime(p,source.startBar,1), until = Math.min(p.duration,positionToTime(p,source.endBar+1,1));
  const target = targetBar === 1 ? 0 : positionToTime(p,targetBar,1), targetEnd = Math.min(p.duration,positionToTime(p,targetBar+length,1));
  const selected = (p.bassEvents ?? []).filter(e => e.start < until && e.end > from);
  if (!selected.length) throw new Error('此段落没有可复制的贝斯音名');
  const shift = (time: number) => { const at = timeToPosition(p,time); return positionToTime(p,at.bar + targetBar-source.startBar,at.beat); };
  const copied = selected.map(e => ({ ...e, id:makeId(),start:Math.max(target,shift(Math.max(from,e.start))),end:Math.min(targetEnd,shift(Math.min(until,e.end))),source:'manual' as const,locked:true })).filter(e=>e.end>e.start);
  const retained: BassEvent[] = (p.bassEvents ?? []).flatMap(e => {
    if (e.end <= target || e.start >= targetEnd) return [e];
    const pieces: BassEvent[]=[];
    if(e.start<target) pieces.push({...e,end:target,source:'manual',locked:true});
    if(e.end>targetEnd) pieces.push({...e,id:makeId(),start:targetEnd,source:'manual',locked:true});
    return pieces;
  });
  return {...p,bassEvents:[...retained,...copied].sort((a,b)=>a.start-b.start)};
}
