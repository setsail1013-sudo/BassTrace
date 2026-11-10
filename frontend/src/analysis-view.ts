import { positionToTime,timeToPosition,type BassEvent,type Project } from './music';

/** Merge a finished job with edits still in the local autosave buffer. */
export function mergeAnalysisView(current:Project,incoming:Project,base:Project):Project {
  const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  const next:Project={...incoming};
  const fields=['title','artist','key','originalKey','sections','lyrics','lyricsOriginal','manualFills','notes','markers','scoreStyle','topTrack','performanceNotes','lyricAnchors'] as const;
  for(const key of fields) if(!equal(current[key],base[key])) Object.assign(next,{[key]:current[key]});
  const manualGrid=(['bpm','meter','offset','beatTimes'] as const).some(key=>!equal(current[key],base[key]));
  if(manualGrid) for(const key of ['bpm','meter','offset','beatTimes'] as const) Object.assign(next,{[key]:current[key]});
  const source=!equal(current.chords,base.chords)?current:incoming;
  next.chords=source.chords.map(chord=>{const at=timeToPosition(next,positionToTime(source,chord.bar,chord.beat));return {...chord,bar:Math.max(1,at.bar),beat:at.bar<1?1:at.beat};});
  if(!equal(current.bassEvents,base.bassEvents)) {
    const before=new Map((base.bassEvents??[]).map(e=>[e.id,e]));
    const local=current.bassEvents??[],ids=new Set(local.map(e=>e.id));
    const changed=local.filter(e=>!equal(e,before.get(e.id)));
    const removed=(base.bassEvents??[]).filter(e=>!ids.has(e.id));
    const protectedRanges=[...changed,...removed],changedIds=new Set(changed.map(e=>e.id));
    const candidates=(incoming.bassEvents??[]).flatMap(event=>{
      if(changedIds.has(event.id)||removed.some(e=>e.id===event.id))return [];
      let parts:BassEvent[]=[event];
      for(const block of protectedRanges)parts=parts.flatMap(part=>{
        if(part.end<=block.start||part.start>=block.end)return [part];
        const split:BassEvent[]=[];
        if(part.start<block.start)split.push({...part,end:block.start});
        if(part.end>block.end)split.push({...part,id:`${event.id}-local-${block.end.toFixed(6)}`.slice(0,120),start:block.end});
        return split;
      });
      return parts;
    });
    next.bassEvents=[...candidates,...changed].sort((a,b)=>a.start-b.start);
  }
  return next;
}
