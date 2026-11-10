import { useEffect, useRef, useState } from 'react';
import type { Project } from './music';
import { readScoreStyle } from './score-style';

export function usePdfExport(project: Project | null, mode: 'chart' | 'structure', degree: boolean) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<string|null>(null);
  const cache=useRef<{key:string;url:string}|null>(null),request=useRef<AbortController|null>(null);
  useEffect(()=>()=>{request.current?.abort();if(cache.current)URL.revokeObjectURL(cache.current.url);cache.current=null;},[]);
  useEffect(()=>{request.current?.abort();request.current=null;setBusy(false);setError('');setPreview(null);if(cache.current)URL.revokeObjectURL(cache.current.url);cache.current=null;},[project?.id]);
  async function generate(action:'download'|'preview') {
    if(!project||request.current)return;
    const p={...project,scoreStyle:readScoreStyle(project)};
    const key=JSON.stringify([p.id,p.title,p.artist,p.key,p.originalKey,p.keyAnalysis,p.lyricAnchors,p.lyricAlignment?.detectedSegments,p.performanceNotes,p.bpm,p.offset,p.beatTimes,p.meter,p.duration,p.sections,p.chords,p.bassEvents,p.topTrack,p.manualFills,p.lyrics,p.scoreStyle,mode,degree]);
    setError('');
    const controller=new AbortController();request.current=controller;setBusy(true);
    try {
      if(cache.current?.key!==key){
        const response=await fetch(`/api/projects/${p.id}/export/pdf`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:p,mode,degree}),signal:controller.signal});
        if(!response.ok){const body=await response.json().catch(()=>null);throw Error(typeof body?.detail==='string'?body.detail:'PDF 生成失败，请重试。');}
        if(!response.headers.get('Content-Type')?.includes('application/pdf'))throw Error('服务器未返回 PDF，请重试。');
        const blob=await response.blob();if(controller.signal.aborted)return;
        if(cache.current)URL.revokeObjectURL(cache.current.url);
        cache.current={key,url:URL.createObjectURL(blob)};setPreview(null);
      }
      if(action==='preview')setPreview(cache.current!.url);
      else {const link=document.createElement('a');link.href=cache.current!.url;link.download=(p.title.replace(/[<>:"/\\|?*]/g,'_')||'排练谱')+'.pdf';link.click();}
    } catch(e) {if(!controller.signal.aborted)setError(e instanceof Error?e.message:String(e));}
    finally {if(request.current===controller){request.current=null;setBusy(false);}}
  }
  return {busy,error,preview,generate,closePreview:()=>setPreview(null)};
}
