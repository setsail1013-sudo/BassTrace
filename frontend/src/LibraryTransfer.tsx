import { useEffect, useRef, useState } from 'react';
import type { LibraryState } from './LibraryPanel';
import type { LibraryScope } from './library';
import type { Project } from './music';
import { featureRunning } from './project-features';

export type TransferMode='audio'|'restore'|'export';
type Row={id:string;file:File;state:'waiting'|'running'|'complete'|'error'|'cancelled';message:string;projectId?:string;fileSaved?:boolean;source:'original'|'uploaded_bass';folderId:string|null;analyze:boolean};
export async function libraryApi<T>(url:string,method='GET',body?:unknown):Promise<T>{
  const response=await fetch(url,{method,...(body instanceof FormData?{body}:body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  if(!response.ok){const data=await response.json().catch(()=>null);throw Error(typeof data?.detail==='string'?data.detail:'曲库操作失败，请重试');}return response.status===204?undefined as T:response.json();
}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export function useBatchImport(onRefresh:()=>Promise<void>){
  const [rows,setRows]=useState<Row[]>([]),[running,setRunning]=useState(false);const items=useRef<Row[]>([]),working=useRef(false),alive=useRef(true),refresh=useRef(onRefresh);refresh.current=onRefresh;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  function publish(){if(alive.current)setRows([...items.current]);}
  async function drain(){if(working.current)return;working.current=true;setRunning(true);
    try{while(alive.current){const row=items.current.find(r=>r.state==='waiting');if(!row)break;row.state='running';row.message='正在导入';publish();
      try{
        if(!row.projectId){if(row.file.size>300*1024**2)throw Error('单首音频不能超过 300MB');const form=new FormData();form.append('file',row.file);form.append('source',row.source);const p=await libraryApi<Project>('/api/projects/upload','POST',form);row.projectId=p.id;publish();}
        if(!row.fileSaved){await libraryApi('/api/folders/move','POST',{projectIds:[row.projectId],folderId:row.folderId});row.fileSaved=true;await refresh.current();}
        if(row.analyze){let p=await libraryApi<Project>(`/api/projects/${row.projectId}`);
          if(!featureRunning(p)){p=await libraryApi<Project>(`/api/projects/${row.projectId}/analyze`,'POST',{source:row.source,separate:false,transcribe:false});}
          while(featureRunning(p)&&alive.current){row.message=p.analysis.stage||'正在分析';publish();await sleep(1600);p=await libraryApi<Project>(`/api/projects/${row.projectId}`);}
          if(!alive.current)break;if(p.analysis.state==='error')throw Error(p.analysis.stage||'分析失败，可重试');
        }
        row.state='complete';row.message=row.analyze?'导入与分析完成':'导入完成，等待手动分析';
      }catch(error){row.state='error';row.message=String(error);}publish();try{await refresh.current();}catch{/* keep successful imported files */}
    }}finally{working.current=false;if(alive.current)setRunning(false);}
  }
  function add(files:File[],options:Pick<Row,'source'|'folderId'|'analyze'>){items.current.push(...files.map(file=>({id:crypto.randomUUID(),file,state:'waiting' as const,message:'等待导入',...options})));publish();void drain();}
  function retry(){items.current.filter(r=>r.state==='error').forEach(r=>{r.state='waiting';r.message='等待重试';});publish();void drain();}
  function cancel(){items.current.filter(r=>r.state==='waiting').forEach(r=>{r.state='cancelled';r.message='已取消';});publish();}
  useEffect(()=>{if(!running)return;const guard=(e:BeforeUnloadEvent)=>e.preventDefault();window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[running]);
  return {rows,running,add,retry,cancel};
}
type Job={id:string;kind:'export'|'import';state:'queued'|'running'|'ready'|'complete'|'error';progress:number;message:string;downloadUrl?:string;preview?:{songs:number;folders:string[];playlists:string[];bytes:number}};
export function LibraryTransfer({mode,scope,library,batch,onClose,beforeExport,onRefresh}:{mode:TransferMode|null;scope:LibraryScope;library:LibraryState;batch:ReturnType<typeof useBatchImport>;onClose:()=>void;beforeExport:()=>Promise<boolean>;onRefresh:()=>Promise<void>}){
  const [files,setFiles]=useState<File[]>([]),[source,setSource]=useState<'original'|'uploaded_bass'>('original'),[folder,setFolder]=useState(''),[analyze,setAnalyze]=useState(true),[exportScope,setExportScope]=useState('current');
  const [job,setJob]=useState<Job|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uploadPercent,setUploadPercent]=useState(0);const refresh=useRef(onRefresh);refresh.current=onRefresh;
  const [archive,setArchive]=useState<File|null>(null);const input=useRef<HTMLInputElement>(null),panel=useRef<HTMLDivElement>(null),returnFocus=useRef<HTMLElement|null>(null);
  const requestLock=useRef(false);
  useEffect(()=>{if(mode){setError('');setFolder(library.selectedFolder&&library.selectedFolder!=='unfiled'?library.selectedFolder:'');setExportScope('current');returnFocus.current=document.activeElement as HTMLElement;requestAnimationFrame(()=>panel.current?.querySelector<HTMLElement>('button,input,select')?.focus());}else{returnFocus.current?.isConnected&&returnFocus.current.focus();}},[mode]);
  useEffect(()=>{if(!job||!['queued','running'].includes(job.state))return;let closed=false;const timer=setInterval(()=>void libraryApi<Job>('/api/library/jobs/'+job.id).then(next=>{if(closed)return;setJob(next);setError('');if(next.kind==='import'&&next.state==='complete')void refresh.current();}).catch(e=>{if(!closed)setError(String(e));}),1200);return()=>{closed=true;clearInterval(timer);};},[job?.id,job?.state]);
  useEffect(()=>{if(!busy)return;const guard=(e:BeforeUnloadEvent)=>e.preventDefault();window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[busy]);
  async function perform(fn:()=>Promise<Job>){if(requestLock.current)return;requestLock.current=true;setBusy(true);setError('');try{setJob(await fn());}catch(e){setError(String(e));}finally{requestLock.current=false;setBusy(false);}}
  function uploadBackup(file:File){if(file.size>10*1024**3)return Promise.reject(Error('备份包不能超过 10GiB'));return new Promise<Job>((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','/api/library/imports');xhr.upload.onprogress=e=>{if(e.lengthComputable)setUploadPercent(Math.round(e.loaded/e.total*100));};xhr.onerror=()=>reject(Error('上传中断，请重新选择备份文件重试'));xhr.onload=()=>{try{const data=JSON.parse(xhr.responseText);xhr.status<300?resolve(data):reject(Error(typeof data.detail==='string'?data.detail:'备份上传失败'));}catch{reject(Error('服务器返回无效响应'));}};const form=new FormData();form.append('file',file);xhr.send(form);});}
  if(!mode)return null;
  const jobRelevant=job&&(mode==='restore'?job.kind==='import':mode==='export'?job.kind==='export':false),processing=!!job&&['queued','running'].includes(job.state);
  return <div className="modal-backdrop library-transfer-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={panel} className="modal library-transfer" role="dialog" aria-modal="true" aria-label={mode==='audio'?'批量导入音乐':mode==='restore'?'恢复曲库备份':'导出曲库备份'} onKeyDown={e=>{e.stopPropagation();if(e.nativeEvent.isComposing)return;if(e.key==='Escape'){e.preventDefault();onClose();}if(e.key==='Tab'){const controls=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')].filter(el=>el.getClientRects().length),at=controls.indexOf(document.activeElement as HTMLElement);if(e.shiftKey&&at===0){e.preventDefault();controls.at(-1)?.focus();}else if(!e.shiftKey&&at===controls.length-1){e.preventDefault();controls[0]?.focus();}}}}>
    <div className="transfer-heading"><h2>{mode==='audio'?'批量导入音乐':mode==='restore'?'恢复曲库备份':'导出曲库备份'}</h2><button aria-label="关闭曲库操作" onClick={onClose}>×</button></div>
    {mode==='audio'&&<><label>音乐文件<input ref={input} type="file" multiple accept=".mp3,.wav,.flac,.m4a" onChange={e=>setFiles(Array.from(e.target.files??[]))}/></label><div className="transfer-options"><label>目标文件夹<select value={folder} onChange={e=>setFolder(e.target.value)}><option value="">未分类</option>{library.folderIndex.folders.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label><label>音频来源<select value={source} onChange={e=>setSource(e.target.value as typeof source)}><option value="original">完整原曲</option><option value="uploaded_bass">独立贝斯</option></select></label></div><label className="checkbox"><input type="checkbox" checked={analyze} onChange={e=>setAnalyze(e.target.checked)}/>导入后自动分析（逐首处理）</label><button className="primary" disabled={!files.length||!library.ready} onClick={()=>{batch.add(files,{source,folderId:folder||null,analyze});setFiles([]);if(input.current)input.current.value='';}}>导入 {files.length||''} 首音乐</button>
      {batch.rows.length>0&&<><p role="status">已处理 {batch.rows.filter(r=>['complete','error','cancelled'].includes(r.state)).length} / {batch.rows.length} 首{batch.running?' · 后台继续处理':''}</p><progress max={batch.rows.length} value={batch.rows.filter(r=>['complete','error','cancelled'].includes(r.state)).length}/><div className="batch-rows">{batch.rows.map(row=><div key={row.id} className={'batch-row '+row.state}><strong>{row.file.name}</strong><span>{row.message}</span></div>)}</div><div className="transfer-actions"><button disabled={!batch.rows.some(r=>r.state==='waiting')} onClick={batch.cancel}>取消等待中的歌曲</button><button disabled={!batch.rows.some(r=>r.state==='error')} onClick={batch.retry}>重试失败项</button></div></>}
    </>}
    {mode==='export'&&<><p>包含原曲、已有分轨、完整校谱、文件夹和歌单；回收站不包含在内。</p><label>导出范围<select value={exportScope} onChange={e=>setExportScope(e.target.value)}><option value="current">{scope.projectIds?'所选歌曲':scope.folderId?'当前文件夹':scope.playlistId?'当前歌单':'全部活动曲库'}</option><option value="all">全部活动曲库</option></select></label><button className="primary" disabled={busy||processing} onClick={()=>void perform(async()=>{if(!await beforeExport())throw Error('请先完成当前编辑的保存');return libraryApi<Job>('/api/library/exports','POST',exportScope==='all'?{}:scope);})}>生成完整备份</button></>}
    {mode==='restore'&&<><p>恢复为新的歌曲和分类副本，不覆盖现有曲库。重复导入同一备份也会创建副本。</p><input type="file" aria-label="选择曲库备份" accept=".zip,.basstrace.zip" disabled={busy||processing} onChange={e=>{setArchive(e.target.files?.[0]??null);setError('');}}/><button className="primary" disabled={!archive||busy||processing} onClick={()=>{setUploadPercent(0);void perform(()=>uploadBackup(archive!));}}>{busy?`上传中 ${uploadPercent}%`:'上传并校验备份'}</button></>}
    {jobRelevant&&<div className="transfer-job"><p role="status">{job.message}</p><progress value={job.progress} max={100}/>{job.state==='ready'&&job.preview&&<><p>{job.preview.songs} 首歌曲 · {(job.preview.bytes/1024**2).toFixed(1)} MB</p><p>文件夹：{job.preview.folders.join('、')||'无'}<br/>歌单：{job.preview.playlists.join('、')||'无'}</p><button className="primary" disabled={busy} onClick={()=>void perform(async()=>{if(!await beforeExport())throw Error('请先保存当前编辑');return libraryApi<Job>(`/api/library/imports/${job.id}/confirm`,'POST');})}>确认恢复为新副本</button></>}{job.state==='complete'&&job.downloadUrl&&<a className="primary" href={job.downloadUrl} download>下载 .basstrace.zip 备份</a>}</div>}
    {jobRelevant&&!processing&&<button disabled={busy} className="text-action" onClick={async()=>{setError('');try{await libraryApi(`/api/library/jobs/${job.id}`,'DELETE');setJob(null);}catch(e){setError(String(e));}}}>{job.state==='ready'?'取消本次恢复并清理临时文件':'清理本次备份临时文件'}</button>}
    {error&&<p className="library-error" role="alert">{error}</p>}
  </div></div>;
}
