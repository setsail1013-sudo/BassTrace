import { useEffect,useState } from 'react';
import type { Project } from './music';

interface Entry {id:string;title:string;artist:string;deletedAt:string}
export function TrashPanel({onRestore}:{onRestore:(p:Project)=>void}) {
  const [items,setItems]=useState<Entry[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState('');
  async function reload(){try{const r=await fetch('/api/trash');if(!r.ok)throw Error('回收站加载失败');setItems(await r.json());}catch(e){setError(String(e));}}
  useEffect(()=>{void reload();},[]);
  async function action(id:string,restore:boolean){setBusy(true);setError('');try{const r=await fetch(`/api/trash/${id}${restore?'/restore':''}`,{method:restore?'POST':'DELETE'});if(!r.ok){const body=await r.json();throw Error(body.detail||'操作失败');}if(restore)onRestore(await r.json());setConfirm('');await reload();}catch(e){setError(String(e));}finally{setBusy(false);}}
  return <div className="trash-panel"><p>歌曲保留至你主动彻底删除；恢复时会重新加入仍存在的原歌单。</p>{error&&<p role="alert">{error}<button onClick={()=>void reload()}>重试</button></p>}{items.length===0&&<p>回收站为空</p>}{items.map(item=><article key={item.id}><div><strong>{item.title}</strong><small>{item.artist} · {new Date(item.deletedAt).toLocaleDateString()}</small></div><button disabled={busy} onClick={()=>void action(item.id,true)}>恢复</button><button disabled={busy} className="danger" onClick={()=>setConfirm(item.id)}>彻底删除</button>{confirm===item.id&&<div className="purge-confirm" role="alert">彻底删除“{item.title}”及项目中的音频？此操作无法恢复。<button disabled={busy} onClick={()=>void action(item.id,false)}>确认彻底删除</button><button disabled={busy} onClick={()=>setConfirm('')}>取消</button></div>}</article>)}</div>;
}
