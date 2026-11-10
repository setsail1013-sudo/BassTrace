import type { Lyric, LyricAnchor, Project } from './music';
import { topEvents,topEventTime } from './top-track';

export interface LyricMark {start:number;end:number;eventId:string;time:number;manual:boolean}
export function lyricMarks(p:Project,lyric:Lyric):LyricMark[] {
  const events=topEvents(p),track=p.topTrack==='bass'?'bass':'chords';
  const validAnchors=(p.lyricAnchors??[]).filter(a=>a.lyricId===lyric.id&&a.track===track&&lyric.text.slice(a.startOffset,a.endOffset)===a.text);
  const manual=validAnchors.flatMap(a=>{
    const event=events.find(e=>e.id===a.eventId);
    return !a.disabled&&event
      ?[{start:a.startOffset,end:a.endOffset,eventId:a.eventId,time:topEventTime(p,event),manual:true}]:[];
  });
  const found=[...manual];
  for(const segment of p.lyricAlignment?.detectedSegments??[]) {
    if(segment.text.trim()!==lyric.text.trim()||segment.end<=lyric.start||segment.start>=lyric.end)continue;
    let cursor=0;
    for(const word of segment.words) {
      const text=word.text.trim(),start=lyric.text.indexOf(text,cursor);if(!text||start<0)continue;
      cursor=start+text.length;
      const event=events.find(e=>{const at=topEventTime(p,e);return at>=word.start-1e-6&&at<word.end-1e-6;});
      if(event&&word.confidence>=.65&&!validAnchors.some(a=>a.disabled&&a.startOffset<cursor&&a.endOffset>start)&&!found.some(m=>m.start<cursor&&m.end>start))found.push({start,end:cursor,eventId:event.id,time:topEventTime(p,event),manual:false});
    }
  }
  return found.sort((a,b)=>a.start-b.start);
}
export function lyricFragments(p:Project,lyric:Lyric):Array<{text:string;mark?:LyricMark}> {
  const result:Array<{text:string;mark?:LyricMark}>=[];let cursor=0;
  for(const mark of lyricMarks(p,lyric)){if(mark.start<cursor)continue;if(mark.start>cursor)result.push({text:lyric.text.slice(cursor,mark.start)});result.push({text:lyric.text.slice(mark.start,mark.end),mark});cursor=mark.end;}
  if(cursor<lyric.text.length)result.push({text:lyric.text.slice(cursor)});return result;
}
export function addLyricAnchor(p:Project,lyricId:string,start:number,end:number,eventId:string):Project {
  const lyric=p.lyrics.find(l=>l.id===lyricId),event=topEvents(p).find(e=>e.id===eventId);
  if(!lyric||!event||!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>lyric.text.length||start>=end)return p;
  if([start,end].some(i=>i>0&&i<lyric.text.length&&/[\uD800-\uDBFF]/u.test(lyric.text[i-1])&&/[\uDC00-\uDFFF]/u.test(lyric.text[i])))return p;
  const track=p.topTrack==='bass'?'bass':'chords';
  const anchor:LyricAnchor={id:crypto.randomUUID(),lyricId,startOffset:start,endOffset:end,text:lyric.text.slice(start,end),eventId,track};
  return {...p,lyricAnchors:[...(p.lyricAnchors??[]).filter(a=>a.lyricId!==lyricId||a.track!==track||a.endOffset<=start||a.startOffset>=end),anchor]};
}
export function cleanLyricAnchors(p:Project):Project {
  const anchors=(p.lyricAnchors??[]).filter(a=>{const l=p.lyrics.find(l=>l.id===a.lyricId);return l?.text.slice(a.startOffset,a.endOffset)===a.text&&(a.track==='bass'?(p.bassEvents??[]):p.chords).some(e=>e.id===a.eventId);});
  return anchors.length===(p.lyricAnchors??[]).length?p:{...p,lyricAnchors:anchors};
}
export function removeLyricMark(p:Project,lyricId:string,start:number,end:number,eventId:string):Project {
  const next=addLyricAnchor(p,lyricId,start,end,eventId);
  return next===p?p:{...next,lyricAnchors:next.lyricAnchors!.map((a,i,all)=>i===all.length-1?{...a,disabled:true}:a)};
}
