import { useEffect, useRef, useState } from 'react';
import type { Project } from './music';
import { noteFields, readPerformanceNotes, type PerformanceNotes as Notes } from './performance-notes';
import { useCommands } from './commands';
import { NotebookPen } from 'lucide-react';

export function PerformanceNotes({ project, onBegin, onChange, onEnd }: {
  project: Project; onBegin: ()=>void; onChange: (notes:Notes)=>void; onEnd: (cancel:boolean)=>void;
}) {
  const [open,setOpen]=useState(false), [draft,setDraft]=useState(()=>readPerformanceNotes(project));
  const composing=useRef(false), draftRef=useRef(draft), root=useRef<HTMLElement>(null);
  const current=readPerformanceNotes(project);
  function begin(){if(open)return;setDraft(current);draftRef.current=current;onBegin();setOpen(true);requestAnimationFrame(()=>root.current?.querySelector('textarea')?.focus());}
  function finish(cancel=false){if(!open||composing.current)return;onEnd(cancel);setOpen(false);}
  useEffect(()=>{const commit=()=>finish();window.addEventListener('basschart:commit-lyric',commit);return()=>window.removeEventListener('basschart:commit-lyric',commit);});
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(open&&event.target instanceof Node&&!root.current?.contains(event.target))finish();};
    document.addEventListener('pointerdown',outside,true);
    return()=>document.removeEventListener('pointerdown',outside,true);
  });
  useCommands([{id:'song.performanceNotes',label:'编辑演出备注',group:'演出准备',run:begin}]);
  const populated=noteFields.filter(field=>current[field.key].trim());
  return <section ref={root} className={`performance-notes no-print${!open&&!populated.length?' is-empty':''}`} aria-label="演出备注" onBlur={e=>{if(e.relatedTarget instanceof Node&&!e.currentTarget.contains(e.relatedTarget))finish();}}>
    <header><button type="button" className="notes-edit-button" onClick={()=>open?finish():begin()} aria-expanded={open}><NotebookPen size={20}/>{open?'收起':'编辑备注'}</button></header>
    {!open&&populated.length>0&&<div className="notes-summary">{populated.map(field=><div key={field.key} className={field.key}><span>{field.label}</span><p>{current[field.key]}</p></div>)}</div>}
    <div className="notes-expand" data-open={open} inert={!open}><div>
      <form onSubmit={e=>{e.preventDefault();finish();}} onKeyDown={e=>{
        if(e.nativeEvent.isComposing||e.keyCode===229)return;
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(true);}
        if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();e.stopPropagation();finish();}
      }}>
        <div className="notes-fields">{noteFields.map(field=><label key={field.key}>{field.label}<textarea rows={field.key==='effectsPreset'?2:3} maxLength={10000} placeholder={field.placeholder} value={draft[field.key]}
          onCompositionStart={()=>{composing.current=true;}}
          onCompositionEnd={e=>{composing.current=false;const next={...draftRef.current,[field.key]:e.currentTarget.value};draftRef.current=next;setDraft(next);onChange(next);}}
          onChange={e=>{const next={...draftRef.current,[field.key]:e.target.value};draftRef.current=next;setDraft(next);if(!composing.current)onChange(next);}}/></label>)}</div>
        <div className="notes-actions"><small>自动保存 · Ctrl+Enter 完成 · Esc 取消</small><button type="button" className="secondary" onClick={()=>finish(true)}>取消</button><button type="submit" className="primary">完成</button></div>
      </form>
    </div></div>
  </section>;
}
