import { useRef, useState } from 'react';
import type { Project } from './music';

export function SongInfoForm({project,onApply,onCancel}:{project:Project;onApply:(title:string,artist:string)=>void;onCancel:()=>void}) {
  const [title,setTitle]=useState(project.title),[artist,setArtist]=useState(project.artist);
  const composing=useRef(false);
  function submit(){if(!composing.current&&title.trim())onApply(title.trim(),artist.trim());}
  return <form className="song-info-form" onSubmit={e=>{e.preventDefault();submit();}}
    onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
    onKeyDown={e=>{
      if(composing.current||e.nativeEvent.isComposing||e.keyCode===229){e.stopPropagation();if(e.key==='Enter')e.preventDefault();return;}
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onCancel();}
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopPropagation();submit();}
      if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase()))e.stopPropagation();
    }}>
    <label>歌名<input autoFocus required maxLength={300} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>歌手<input maxLength={300} value={artist} onChange={e=>setArtist(e.target.value)}/></label>
    <div className="song-info-actions"><button type="button" className="secondary" onClick={onCancel}>取消</button><button type="submit" className="primary" disabled={!title.trim()}>保存</button></div>
  </form>;
}
