import { flushSync } from 'react-dom';
import { LibraryTransfer, useBatchImport, type TransferMode } from './LibraryTransfer';
import type { LibraryScope } from './library';
import { TrashPanel } from './TrashPanel';
import { FeaturePanel } from './FeaturePanel';
import { featureRunning,keyLabel } from './project-features';
import { cleanLyricAnchors } from './lyric-marks';
import { SongInfoForm } from './SongInfoForm';
import { LibrarySidebar, LibraryView, useLibrary } from './LibraryPanel';
import { adjacentBarTime } from './library';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { ThreeTrackScore } from './ThreeTrackScore';
import { useCommands, useCommandActions, type Command } from './commands';
import { packTxtLyrics } from './tracks';
import { exportThreeTrackHtml } from './three-track-export';
import { BassEventForm } from './BassEventForm';
import { mergeAnalysisView } from './analysis-view';
import { usePdfExport } from './usePdfExport';
import { PerformanceNotes } from './PerformanceNotes';
import { readPerformanceNotes, type PerformanceNotes as Notes } from './performance-notes';
import { Presence, usePageMotion } from './motion';
import { ScoreSettings } from './ScoreSettings';
import { readScoreStyle, scoreStyleVariables, scorePageCss, DEFAULT_SCORE_STYLE } from './score-style';
import { topEvents, topEventAt, topEventTime, topEventLabel, copySectionTop } from './top-track';
import { resampleBeatTimes } from './tempo';
import { HomePage } from './HomePage';
import LyricAlignment, { type LyricAlignmentOptions } from './LyricAlignment';
import './lyric-alignment.css';
import { AudioLines, Music2, LayoutDashboard, Library, Settings2, ArrowUpRight, Upload, Download, Plus, ChevronDown, ChevronRight, ChevronLeft, Play, Pause, SkipBack, Repeat2, Volume2, Headphones, WandSparkles, SlidersHorizontal, Check, X, Save, CircleHelp, Clock3, Layers3, FileText, ListMusic, Pencil, Trash2, LoaderCircle, AlertCircle, FolderOpen, Maximize2, RotateCcw, LockKeyhole } from 'lucide-react';
import type { Project, Chord, Lyric, Section, ScoreStyle } from './music';
import { beatsPerBar, beatSeconds, barCount, copySectionChords, positionToTime, timeToPosition, transposeProject, romanChord, parseLrc, toLrc, formatTime, makeGrid, displaySections, displayChords, isBassRootCandidate, lyricsForBar, exportHtml } from './music';

type Mode = 'chart' | 'structure';
type AnalysisSource = 'original' | 'bass' | 'uploaded_bass';
type Modal = 'deleteSong' | 'trash' | 'songInfo' | 'export' | 'lyrics' | 'grid' | 'analysis' | 'help' | 'section' | 'chord' | 'lyric' | null;
type Health = { capabilities?: Record<string, unknown>; [key: string]: unknown };
const uid = () => crypto.randomUUID();
function lyricImportOptions(){const lane=document.querySelector<HTMLElement>('.editable-lyric-track'),row=document.querySelector('.score-row');const style=lane?getComputedStyle(lane):null;const size=style?parseFloat(style.fontSize):20;const canvas=document.createElement('canvas').getContext('2d');if(canvas)canvas.font=`${size}px ${style?.fontFamily||"-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif"}`;return {rowWidth:Math.max(120,lane?.clientWidth||window.innerWidth-(window.innerWidth>650?360:100)),barsPerRow:row?.querySelectorAll('.bar-ruler').length||(window.innerWidth<=650?2:4),fontSize:size,measureText:(text:string)=>canvas?.measureText(text).width||[...text].length*size};}
const sectionLabel = (name:string,index:number) => /^候选段落/.test(name)?`段落 ${String(index+1).padStart(2,'0')}`:name;
const colors = ['#8aaca0', '#c9b685', '#91aacb', '#b59bc2', '#c99c84'];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) { let message = await response.text(); try { const body = JSON.parse(message); message = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail); } catch { /* plain text */ } throw new Error(message || `请求失败 ${response.status}`); }
  return response.json();
}
function download(content: string, name: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function App() {
  const { invoke } = useCommandActions();
  const library=useLibrary();
  const [transferMode,setTransferMode]=useState<TransferMode|null>(null),[transferScope,setTransferScope]=useState<LibraryScope>({}),[importMenu,setImportMenu]=useState(false);
  const batch=useBatchImport(refreshLibrary);
  const latestSave=useRef<()=>Promise<boolean>>(async()=>true);
  latestSave.current=async()=>{if(!dirtyRef.current)return true;return !!await save(false)&&!dirtyRef.current;};
  async function beforeLibraryExport(){flushSync(()=>window.dispatchEvent(new Event('basschart:commit-lyric')));await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));return latestSave.current();}
  async function refreshLibrary(){const items=await api<Project[]>('/api/projects');setProjects(items);await library.reload();}
  function openTransfer(mode:TransferMode,scope?:LibraryScope){setImportMenu(false);setTransferScope(scope??(library.selected?{playlistId:library.selected}:library.selectedFolder&&library.selectedFolder!=='unfiled'?{folderId:library.selectedFolder}:{}));setTransferMode(mode);}

  const [project, setProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [health, setHealth] = useState<Health>({});
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [emptyLibrary,setEmptyLibrary]=useState(false),[deleteTarget,setDeleteTarget]=useState<Project|null>(null);
  const previousListen=useRef('original'),audioProject=useRef(''),playingRef=useRef(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const editVersion = useRef(0);
  const [nav, setNav] = useState<'home'|'studio'|'score'|'library'>('home');
  const [mode, setMode] = useState<Mode>('chart');
  const [degree, setDegree] = useState(false);
  const pdf=usePdfExport(project,mode,degree);
  const [modal, setModal] = useState<Modal>(null);
  const songInfoSession=useRef(0);
  const [selected, setSelected] = useState('');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);playingRef.current=playing;
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(.8);
  const [mix, setMix] = useState<Record<string, number>>({original: 1, bass: 0, drums: 0, vocals: 0, other: 0});
  const [loop, setLoop] = useState<[number, number] | null>(null);
  const [loopA,setLoopA]=useState<number|null>(null);
  const [stagedLyrics,setStagedLyrics]=useState<{raw:string;count:number}|null>(null);
  const [rows, setRows] = useState(4);
  const [fontSize, setFontSize] = useState(16);
  const [bassEnhanced,setBassEnhanced]=useState(true);
  const importSource=useRef<AnalysisSource>('original');
  const analysisBase=useRef<Project|null>(null);
  const [autoFollow,setAutoFollow]=useState(true);
  const history=useRef<{past:Project[];future:Project[]}>({past:[],future:[]});
  const [historyState,setHistoryState]=useState({undo:0,redo:0});
  const autoSaveFailed=useRef(false);
  const audio = useRef<Record<string, HTMLAudioElement>>({});
  const auditionEnd = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const p = project;
  const displayedProjects=projects.map(item=>item.id===p?.id?p:item);
  const notesSession=useRef<{before:Notes;entry:Project|null;future:Project[]}|null>(null);
  usePageMotion(nav);
  const message = (text: string) => { setToast(text); setTimeout(() => setToast(''), 4200); };

  async function load(id = 'demo') {
    if(!id){setProject(null);setEmptyLibrary(true);setBusy(false);return;}setEmptyLibrary(false);
    try { setBusy(true); setError(''); pause(); const next = await api<Project>(`/api/projects/${id}`); analysisBase.current=next.analysis.state==='running'?next:null; setProject(next); localStorage.setItem('basschart.active-project',next.id); resetHistory(); setBassEnhanced(true); setStagedLyrics(null);setLoopA(null); setDirty(false); dirtyRef.current = false; setTime(0); setLoop(null); setMix({original: next.stems.some(s=>s.id==='bass'&&s.available)?0:1, bass: next.stems.some(s=>s.id==='bass'&&s.available)?1:0, drums: 0, vocals: 0, other: 0}); setMode('chart'); setProjects(await api<Project[]>('/api/projects')); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  useEffect(() => { void api<Project[]>('/api/projects').then(items=>{const remembered=localStorage.getItem('basschart.active-project');return load(items.find(item=>item.id===remembered)?.id||items.find(item=>!item.isDemo)?.id||(items.length?'demo':''));}).catch(()=>void load()); void api<Health>('/api/health').then(setHealth).catch(() => {}); }, []);
  useEffect(() => {
    if(!p)return;
    const changedProject=audioProject.current!==p.id;
    if(changedProject){Object.values(audio.current).forEach(a=>{a.pause();a.src='';});audio.current={};audioProject.current=p.id;setPlaying(false);}
    const active=new Set<string>();
    for(const stem of p.stems.filter(s=>s.available&&s.url)){
      active.add(stem.id);const url=stem.id==='bass'&&bassEnhanced&&stem.enhancedUrl?stem.enhancedUrl:stem.url;
      if(audio.current[stem.id]?.getAttribute('src')===url)continue;
      const previous=audio.current[stem.id],at=audio.current.original?.currentTime??time;previous?.pause();if(previous)previous.src='';
      const a=new Audio(url);a.preload='metadata';audio.current[stem.id]=a;
      a.addEventListener('loadedmetadata',()=>{a.currentTime=Math.min(at,p.duration);a.playbackRate=speed;a.volume=Math.min(1,(mix[stem.id]??0)*volume);if(!changedProject&&playingRef.current&&(stem.id==='original'||(mix[stem.id]??0)>0))void a.play().catch(()=>message('音轨加载失败，请重试'));},{once:true});
    }
    for(const id of Object.keys(audio.current))if(!active.has(id)){audio.current[id].pause();audio.current[id].src='';delete audio.current[id];}
  },[p?.id,p?.stems.map(s=>s.available?`${s.url}|${s.enhancedUrl??''}`:'').join('|'),bassEnhanced]);
  useEffect(()=>()=>{Object.values(audio.current).forEach(a=>{a.pause();a.src='';});},[]);
  useEffect(() => { for (const [id, a] of Object.entries(audio.current)) { a.volume = Math.min(1, Math.max(0, (mix[id] ?? 0) * volume)); a.playbackRate = speed; } }, [mix, volume, speed, p?.stems.map(s => `${s.url}|${s.enhancedUrl??''}`).join('|'), bassEnhanced]);
  useEffect(() => { const timer = setInterval(() => { if (playing && p) { const a = audio.current.original; if (!a) return; const t = a.currentTime;
      if (auditionEnd.current !== null && t >= auditionEnd.current) { const end=auditionEnd.current; pause(); seek(end); return; }
      if (loop && t >= loop[1]) { seek(loop[0]); return; }
      setTime(t); if (a.ended || t >= p.duration) { pause(); setTime(p.duration); }
      for (const [id, stem] of Object.entries(audio.current)) if (id !== 'original' && Math.abs(stem.currentTime - t) > .15) stem.currentTime = t;
    } }, 70); return () => clearInterval(timer); }, [playing, p?.id, loop]);
  useEffect(() => { if (!p || !featureRunning(p)) return; const timer = setInterval(async () => { try { const next = await api<Project>(`/api/projects/${p.id}`); setProject(current => {if(!current||current.id!==next.id)return current;if(!dirtyRef.current)return next;if(next.analysis.state==='complete'&&analysisBase.current?.id===current.id)return mergeAnalysisView(current,next,analysisBase.current);return {...current,analysis:next.analysis,lyricAlignment:next.lyricAlignment,keyAnalysis:next.keyAnalysis,harmonyAnalysis:next.harmonyAnalysis,backingAnalysis:next.backingAnalysis,stems:next.stems,revision:next.revision};}); if (p.analysis.state==='running'&&next.analysis.state==='complete') {setBassEnhanced(true);setMix({original:0,bass:1,drums:0,vocals:0,other:0});message('贝斯音名分析完成，请试听校正');}if(p.backingAnalysis?.state==='running'&&next.backingAnalysis?.state==='complete')message('无贝斯伴奏已生成，点击右侧即可试听');if(p.harmonyAnalysis?.state==='running'&&next.harmonyAnalysis?.state==='complete')message('和弦候选已完成，可在调性与和弦识别中查看'); } catch (e) { message(String(e)); } }, 1800); return () => clearInterval(timer); }, [p?.id,p?.analysis.state,p?.lyricAlignment?.state,p?.keyAnalysis?.state,p?.harmonyAnalysis?.state,p?.backingAnalysis?.state]);
  useEffect(()=>{if(!dirty||saving||autoSaveFailed.current||(p&&featureRunning(p)))return;const timer=setTimeout(()=>void save(false),1800);return()=>clearTimeout(timer);},[p,dirty,saving]);
  useEffect(()=>{if(autoFollow&&playing&&nav==='score')document.querySelector('.score-row.playing,.bar.playing')?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'nearest'});},[p?timeToPosition(p,time).bar:0,playing,nav,autoFollow]);
  useEffect(() => { const before = (e: BeforeUnloadEvent) => { if(dirtyRef.current){e.preventDefault();} }; window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before); }, []);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement;
    const timer = requestAnimationFrame(() => { const panel = document.querySelector<HTMLElement>('.modal'); if (panel && !panel.contains(document.activeElement)) panel.querySelector<HTMLElement>('input,textarea,select,button')?.focus(); });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !document.activeElement?.closest('.modal')) return;
      const items = [...document.querySelectorAll<HTMLElement>('.modal button:not(:disabled),.modal input:not([hidden]),.modal textarea,.modal select,.modal summary')].filter(e => e.getClientRects().length);
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && at === 0) { event.preventDefault(); items.at(-1)?.focus(); }
      if (!event.shiftKey && at === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
    };
    window.addEventListener('keydown', trap);
    return () => { cancelAnimationFrame(timer); window.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus(); };
  }, [modal]);

  function resetHistory(){notesSession.current=null;history.current={past:[],future:[]};setHistoryState({undo:0,redo:0});autoSaveFailed.current=false;}
  function edit(fn:(current:Project)=>Project){if(!p)return;const changed=fn(p);if(changed===p)return;const next=cleanLyricAnchors(changed);if((changed.lyricAnchors??[]).length>(next.lyricAnchors??[]).length)message('关联字词或事件已变化，请重新指定蓝色标记');history.current.past.push(p);if(history.current.past.length>80)history.current.past.shift();history.current.future=[];setHistoryState({undo:history.current.past.length,redo:0});editVersion.current++;setProject({...next,updatedAt:new Date().toISOString()});setDirty(true);dirtyRef.current=true;autoSaveFailed.current=false;}
  function beginNotes(){if(p)notesSession.current={before:readPerformanceNotes(p),entry:null,future:[...history.current.future]};}
  function changeNotes(notes:Notes){
    if(!p)return;if(JSON.stringify(readPerformanceNotes(p))===JSON.stringify(notes))return;
    if(!notesSession.current)beginNotes();
    if(!notesSession.current!.entry){notesSession.current!.entry=p;edit(current=>({...current,performanceNotes:notes}));}
    else {setProject({...p,performanceNotes:notes,updatedAt:new Date().toISOString()});editVersion.current++;setDirty(true);dirtyRef.current=true;autoSaveFailed.current=false;}
  }
  function endNotes(cancel:boolean){
    const session=notesSession.current;notesSession.current=null;
    if(cancel&&session?.entry&&p){
      if(history.current.past.at(-1)===session.entry){history.current.past.pop();history.current.future=session.future;}
      setHistoryState({undo:history.current.past.length,redo:history.current.future.length});
      setProject({...p,performanceNotes:session.before,updatedAt:new Date().toISOString()});editVersion.current++;setDirty(true);dirtyRef.current=true;autoSaveFailed.current=false;
    }
  }
  function restore(direction:'undo'|'redo'){if(!p)return;const stack=direction==='undo'?history.current.past:history.current.future;const next=stack.pop();if(!next)return;(direction==='undo'?history.current.future:history.current.past).push(p);setProject({...next,revision:p.revision,analysis:p.analysis,lyricAlignment:p.lyricAlignment,harmonyAnalysis:p.harmonyAnalysis,backingAnalysis:p.backingAnalysis,audioSource:p.audioSource,stems:p.stems,updatedAt:new Date().toISOString()});setHistoryState({undo:history.current.past.length,redo:history.current.future.length});editVersion.current++;setDirty(true);dirtyRef.current=true;autoSaveFailed.current=false;}
  async function save(notify=true): Promise<Project | null> {
    if (!p || saving) return null; const submittedVersion=editVersion.current; setSaving(true);
    try {
      const next = await api<Project>(`/api/projects/${p.id}`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
      if(submittedVersion===editVersion.current){setProject(next);setDirty(false);dirtyRef.current=false;if(notify)message('工程已保存到本机');}
      else {setProject(current=>current?.id===next.id?{...current,revision:next.revision,analysis:next.analysis,lyricAlignment:next.lyricAlignment,stems:next.stems}:current);if(notify)message('已保存提交版本，后续修改将继续保存');}
      setProjects(prev=>prev.map(item=>item.id===p.id?next:item));autoSaveFailed.current=false; return next;
    }catch(e){autoSaveFailed.current=true;message(String(e));return null;}finally{setSaving(false);}
  }
  async function alignLyrics(options:LyricAlignmentOptions){if(!p)return;const current=dirtyRef.current?await save():p;if(!current||dirtyRef.current)return;try{const next=await api<Project>(`/api/projects/${p.id}/lyrics/align`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...options,revision:current.revision})});setProject(next);message('歌词任务已开始，原文和人工时间会保留');}catch(e){message(String(e));}}
  function acceptAlignment(id:string){if(!p)return;const line=p.lyricAlignment?.lines.find(item=>item.id===id);if(!line||line.start===null||line.end===null)return;edit(current=>({...current,lyrics:line.lyricId?current.lyrics.map(item=>item.id===line.lyricId?{...item,start:line.start!,end:line.end!,locked:true,source:'manual' as const}:item):[...current.lyrics,{id:uid(),text:line.text,start:line.start!,end:line.end!,locked:true,source:'manual' as const}]}));}
  function updateStyle(style:ScoreStyle){edit(current=>({...current,scoreStyle:style}));}
  function chooseAudio(source:AnalysisSource='original'){importSource.current=source;fileInput.current?.click();}
  function downloadStem(id:string,enhanced=false){const stem=p?.stems.find(s=>s.id===id);const url=enhanced?stem?.enhancedUrl:stem?.url;if(!url||!p)return;const a=document.createElement('a');a.href=url;a.download=`${p.title}-${id}${enhanced?'-增强':''}.wav`;a.click();}
  function safeTranspose(steps:number){if(!p)return;try{const next=transposeProject(p,steps);edit(()=>next);}catch(e){message(String(e));}}
  function printChart(){
    if(!p)return;
    const frame=document.createElement('iframe');frame.className='no-print';frame.title='打印排练谱';
    Object.assign(frame.style,{position:'fixed',left:'-20000px',width:'1120px',height:'1px',border:'0'});
    frame.onload=async()=>{try{const win=frame.contentWindow as (Window & {__scoreReady?:Promise<unknown>})|null;if(!win)return;await win.__scoreReady;win.addEventListener('afterprint',()=>frame.remove(),{once:true});win.focus();win.print();}catch(e){frame.remove();message(String(e));}};
    frame.srcdoc=exportThreeTrackHtml(p,mode,degree);document.body.append(frame);
  }
  function pause() { auditionEnd.current=null; Object.values(audio.current).forEach(a=>a.pause()); setPlaying(false); }
  function seek(t: number) { if(!p) return; auditionEnd.current=null; const next = Math.max(0, Math.min(p.duration, t)); Object.values(audio.current).forEach(a=>{if(Number.isFinite(next))a.currentTime=next;}); setTime(next); }
  async function play(from?:number) { if(!p) return; auditionEnd.current=null;if(from!==undefined)seek(from);else {if(time>=p.duration)seek(loop?.[0]??0);if(loop&&(time<loop[0]||time>=loop[1]))seek(loop[0]);} try { await Promise.all(Object.entries(audio.current).filter(([id])=>id==='original'||(mix[id]??0)>0).map(([id,a])=>{a.volume=Math.min(1,(mix[id]??0)*volume); a.playbackRate=speed; return a.play();})); setPlaying(true); }catch{pause();message('音频播放失败，请检查导入文件或音轨是否可用');} }
  async function audition(start:number,end:number){if(!p||end<=start)return;pause();setLoop(null);seek(start);auditionEnd.current=end;try{await Promise.all(Object.entries(audio.current).filter(([id])=>id==='original'||(mix[id]??0)>0).map(([id,a])=>{a.volume=Math.min(1,(mix[id]??0)*volume);a.playbackRate=speed;return a.play();}));setPlaying(true);}catch{pause();message('片段试听失败，请检查音轨是否可用');}}
  function markLoopB(){if(loopA===null){message('先在起点点击 A，再移动到终点点击 B');return;}if(time<=loopA+.01){message('B 点需要晚于 A 点');return;}setLoop([loopA,time]);seek(loopA);message('已设置 A–B 循环');}
  function toggleLoop(section?: Section) { if(!p) return; if(section){const a=positionToTime(p,section.startBar,1), b=Math.min(p.duration,positionToTime(p,section.endBar+1,1)); setLoop([Math.max(0,a),b]); seek(a);}else setLoop(loop?null:[0,p.duration]); }
  async function switchProject(id:string) { if(dirtyRef.current && !await save())return; if(dirtyRef.current){message('仍有新的编辑，请保存后再切换工程');return;} await load(id); setNav('score'); }
  async function upload(file?:File,source:AnalysisSource='original') { if(!file)return; if(dirtyRef.current && !await save())return; pause(); setBusy(true); try{const form=new FormData();form.append('file',file);let next=await api<Project>('/api/projects/upload',{method:'POST',body:form});if(stagedLyrics){const raw=stagedLyrics.raw;const timed=/\[\d+:\d+(?:[.:]\d+)?\]/.test(raw);const lines=raw.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);const lyrics=timed?parseLrc(raw,next.duration):packTxtLyrics(next,raw,lyricImportOptions(),uid);next=await api<Project>(`/api/projects/${next.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...next,lyrics:lyrics.map(line=>({...line,source:'manual',locked:timed})),lyricsOriginal:raw})});}setProject(next);localStorage.setItem('basschart.active-project',next.id);setMode('chart');setMix({original:1,bass:0,drums:0,vocals:0,other:0});setStagedLyrics(null);setLoopA(null);resetHistory();setTime(0);setLoop(null);setDirty(false);dirtyRef.current=false;setNav('score');setProjects(await api<Project[]>('/api/projects'));setBassEnhanced(true);setModal(null);message('已导入，正在准备贝斯分离与音名分析');try{analysisBase.current=next;next=await api<Project>(`/api/projects/${next.id}/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,separate:false,transcribe:false})});setProject(next);}catch(analysisError){message(`音频已保存；${String(analysisError)}`);setModal('analysis');}}catch(e){message(String(e));}finally{setBusy(false);if(fileInput.current)fileInput.current.value='';} }
  async function importJson(file?:File) { if(!file||!p)return; try{const value=JSON.parse(await file.text()); if(!value.title||!Array.isArray(value.chords)||!Array.isArray(value.lyrics)||!Array.isArray(value.sections))throw new Error('不是有效的 BassTrace / BassChart 工程'); const imported={...p,...value,manualFills:value.manualFills??[],id:p.id,revision:p.revision,stems:p.stems,duration:p.duration,analysis:p.analysis,isDemo:p.isDemo}; const validated=await api<Project>(`/api/projects/${p.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(imported)}); setProject(validated);resetHistory();setDirty(false);dirtyRef.current=false;message('谱面已验证并保存，音频使用当前工程'); }catch(e){message(String(e));}finally{if(jsonInput.current)jsonInput.current.value='';} }
  async function analyze(source:AnalysisSource,separate:boolean){ if(!p)return; const current=dirty?await save():p;if(!current)return;try{analysisBase.current=current;const next=await api<Project>(`/api/projects/${p.id}/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,separate,transcribe:false})});setProject(next);setMode('chart');if(source==='bass'||source==='uploaded_bass')setMix({original:0,bass:1,drums:0,vocals:0,other:0});setModal(null);}catch(e){message(String(e));} }
  function drop(e:DragEvent<HTMLElement>,bar:number){if(!p)return;e.preventDefault();const rect=e.currentTarget.getBoundingClientRect();const beat=Math.max(1,Math.min(beatsPerBar(p)+.75,1+Math.round((e.clientX-rect.left)/rect.width*beatsPerBar(p)*4)/4));const [type,id]=e.dataTransfer.getData('text/plain').split(':');if(type==='chord')edit(v=>({...v,chords:v.chords.map(c=>c.id===id?{...c,bar,beat,locked:true,source:'manual' as const}:c)}));if(type==='lyric'){const t=positionToTime(p,bar,beat);edit(v=>({...v,lyrics:v.lyrics.map(l=>l.id===id?{...l,start:t,end:Math.min(v.duration,t+l.end-l.start),locked:true,source:'manual' as const}:l)}));} }

  function renameSong() { if(p){songInfoSession.current++;setModal('songInfo');} }
  function saveCurrent() {
    const form = document.querySelector<HTMLFormElement>('.modal form');
    if (!form) { void save(); return; }
    form.requestSubmit(); requestAnimationFrame(() => { if (!document.querySelector('.modal form')) invoke('project.save'); });
  }
  function exportFile(kind: 'html' | 'json' | 'lrc') { if (!p) return; if (kind === 'html') download(exportThreeTrackHtml(p, mode, degree), `${p.title}.html`, 'text/html;charset=utf-8'); else if (kind === 'json') download(JSON.stringify(p, null, 2), `${p.title}.basschart.json`, 'application/json'); else download(toLrc(p), `${p.title}.lrc`); }
  function jumpBar(direction:-1|1){if(!p)return;const now=playing&&audio.current.original?audio.current.original.currentTime:time;const next=adjacentBarTime(p,now,direction);if(loop&&(next<loop[0]||next>=loop[1]))setLoop(null);seek(next);}
  function toggleListening(){if(!p?.stems.some(s=>s.id==='bass'&&s.available)){message('贝斯轨尚未就绪，请先完成贝斯分离');return;}listenTo((mix.bass??0)>0?'original':'bass');}
  function listenTo(id:string){
    const at=audio.current.original?.currentTime??time;
    for(const [stem,a] of Object.entries(audio.current)){a.volume=stem===id?volume:0;if(stem!=='original'&&stem!==id)a.pause();else if(playing){if(Math.abs(a.currentTime-at)>.05)a.currentTime=at;void a.play().catch(()=>message('音轨播放失败，请重试'));}}
    setMix(Object.fromEntries(['original','bass','drums','vocals','other','backing'].map(stem=>[stem,stem===id?1:0])));
  }
  function toggleBacking(){if((mix.backing??0)>0){listenTo(previousListen.current);return;}if(!p?.stems.some(s=>s.id==='backing'&&s.available)){void runFeature('backing');return;}previousListen.current=Object.keys(mix).find(id=>mix[id]>0)||'original';listenTo('backing');}
  async function runFeature(kind:'key'|'chords'|'backing'){if(!p)return;const current=dirtyRef.current?await save(false):p;if(!current||dirtyRef.current)return;try{analysisBase.current=current;const next=await api<Project>(`/api/projects/${p.id}/features/${kind}`,{method:'POST'});setProject(next);message(kind==='backing'?'正在生成无贝斯伴奏':'分析任务已开始');}catch(e){message(String(e));}}
  function requestDelete(target:Project){setDeleteTarget(target);setModal('deleteSong');}
  async function deleteSong(){if(!deleteTarget||busy)return;const target=deleteTarget;setBusy(true);try{if(p?.id===target.id&&dirtyRef.current){if(!await save(false)||dirtyRef.current)return;}const r=await fetch(`/api/projects/${target.id}`,{method:'DELETE'});if(!r.ok){const body=await r.json();throw Error(body.detail||'删除失败');}setDeleteTarget(null);setModal(null);const list=await api<Project[]>('/api/projects');setProjects(list);await library.reload();if(p?.id===target.id){pause();Object.values(audio.current).forEach(a=>{a.pause();a.src='';});audio.current={};audioProject.current='';localStorage.removeItem('basschart.active-project');resetHistory();setDirty(false);dirtyRef.current=false;if(list.length)await load(list[0].id);else{setProject(null);setEmptyLibrary(true);}}message('歌曲已移入回收站');}catch(e){message(String(e));}finally{setBusy(false);}}
  function restoredSong(next:Project){setProjects(items=>[next,...items.filter(i=>i.id!==next.id)]);void library.reload();if(!p){setProject(next);setEmptyLibrary(false);setNav('score');}message('歌曲已恢复');}

  function copyCurrentSection() {
    if (!p) return;
    const score = document.querySelector<HTMLElement>('.three-track-score'), focused = score?.dataset.objectKind === 'section' ? score.dataset.objectId : undefined;
    const bar = timeToPosition(p, time).bar, section = p.sections.find(s => s.id === focused) ?? p.sections.find(s => bar >= s.startBar && bar <= s.endBar);
    if (!section) return;
    setSelected(section.id); setModal('section'); requestAnimationFrame(() => { const details = document.querySelector<HTMLDetailsElement>('.section-copy'); if (details) { details.open = true; details.querySelector('input')?.focus(); } });
  }
  const available = !!p && !busy;
  const appCommands: Command[] = [
    { id: 'project.save', label: '保存工程', keys: ['Ctrl+S'], inInput: true, inDialog: true, enabled: available && !saving, run: saveCurrent },
    { id: 'history.undo', label: '撤销', keys: ['Ctrl+Z'], inInput: true, enabled: available, run: () => restore('undo') },
    { id: 'history.redo', label: '重做', keys: ['Ctrl+Shift+Z','Ctrl+Y'], inInput: true, enabled: available && historyState.redo > 0, run: () => restore('redo') },
    { id: 'project.audio', label: '导入歌曲', keys: ['Ctrl+O'], run: () => chooseAudio() },
    {id:'library.createFolder',label:'新建文件夹',group:'曲库',enabled:library.ready&&!library.pending,run:()=>{library.setCreatingFolder(true);setNav('library');}},
    {id:'library.createPlaylist',label:'新建歌单',group:'曲库',enabled:library.ready&&!library.pending,run:()=>{library.setCreating(true);setNav('library');}},
    {id:'library.batchImport',enabled:library.ready,label:'批量导入音乐文件',group:'曲库',run:()=>openTransfer('audio')},
    {id:'library.restore',enabled:library.ready,label:'恢复曲库备份',group:'曲库',run:()=>openTransfer('restore')},
    {id:'library.export',enabled:library.ready,label:'导出当前曲库分类完整备份',group:'曲库',run:()=>openTransfer('export')},
    { id: 'project.bassAudio', label: '导入独立贝斯轨', run: () => chooseAudio('uploaded_bass') },
    { id: 'project.lyrics', label: '导入歌词', keys: ['Ctrl+Shift+L'], run: () => setModal('lyrics') },
    { id: 'project.export', label: '导出曲谱', keys: ['Ctrl+Shift+E'], run: () => setModal('export') },
    { id: 'export.pdf', label: '下载大字 PDF', inDialog:true, enabled:!!p&&!pdf.busy, run:()=>void pdf.generate('download') },
    { id: 'export.pdfPreview', label: '预览 PDF', inDialog:true, enabled:!!p&&!pdf.busy, run:()=>void pdf.generate('preview') },
    { id: 'project.print', label: '浏览器打印 / 存为 PDF', keys: ['Ctrl+P'], inInput: true, inDialog: true, run: printChart },
    ...(['home','score','library'] as const).map((page, i) => ({ id: `page.${page}`, label: ['打开首页','打开曲谱编辑','打开曲库'][i], keys: [`Alt+${i + 1}`], run: () => setNav(page) })),
    { id: 'song.rename', label: '修改曲名', run: renameSong },
    { id: 'song.info', label: '编辑歌曲信息', run: renameSong },
    { id: 'song.grid', label: '修改 BPM、拍号和首拍位置', keys: ['G'], run: () => setModal('grid') },
    { id: 'song.analysis', label: '分析贝斯音名与分离设置', enabled: available && !!p&&!featureRunning(p), run: () => setModal('analysis') },
    ...(['Chord','Fill','Section'] as const).map((kind, i) => ({ id: `score.add${kind}`, label: [p?.topTrack==='bass'?'添加贝斯音名':'添加和弦','添加手写加花','添加段落'][i], keys: [['Shift+C'],['Shift+F'],['Shift+S']][i], enabled: available && (nav !== 'score' || mode !== 'chart'), run: () => { setNav('score'); setMode('chart'); requestAnimationFrame(() => { if (document.querySelector('.three-track-score')) invoke(`score.add${kind}`); }); } })),
    { id: 'song.transposeUp', label: '升高半音', keys: ['Alt+ArrowUp'], run: () => safeTranspose(1) },
    { id: 'song.transposeDown', label: '降低半音', keys: ['Alt+ArrowDown'], run: () => safeTranspose(-1) },
    { id: 'view.degree', label: '切换音名或和弦 / 级数', keys: ['D'], run: () => {if(p?.keyAnalysis?.confirmed||p?.keyAnalysis?.detectedKey||p?.isDemo)setDegree(v=>!v);else message('请先识别或人工确认调性');} },
    { id: 'view.mode', label: '切换三轨谱 / 结构总览', keys: ['V'], run: () => { setNav('score'); setMode(v => v === 'chart' ? 'structure' : 'chart'); } },
    { id: 'view.larger', label: '增大字号', keys: ['Plus'], run: () => setFontSize(v => Math.min(22, v + 1)) },
    { id: 'view.smaller', label: '减小字号', keys: ['-'], run: () => setFontSize(v => Math.max(10, v - 1)) },
    ...(['bass','chords'] as const).map(topTrack=>({id:`view.top.${topTrack}`,label:topTrack==='bass'?'顶部显示贝斯音名':'顶部显示原有和弦',run:()=>edit(current=>({...current,topTrack}))})),
    ...[-1,1].map(delta=>({id:`view.lyricSize.${delta}`,label:delta>0?'增大歌词字号':'减小歌词字号',run:()=>{if(p){const style=readScoreStyle(p);updateStyle({...style,lyricFontSize:Math.min(32,Math.max(14,style.lyricFontSize+delta))});}}})),
    {id:'view.resetStyle',label:'恢复默认字号与配色',run:()=>updateStyle({...DEFAULT_SCORE_STYLE,colors:{...DEFAULT_SCORE_STYLE.colors}})},
    ...[true,false].map(printColor=>({id:`view.print.${printColor}`,label:printColor?'彩色打印':'黑白打印',inDialog:true,run:()=>{if(p)updateStyle({...readScoreStyle(p),printColor});}})),
    ...(['portrait','landscape'] as const).map(printOrientation=>({id:`view.print.${printOrientation}`,label:printOrientation==='portrait'?'A4 纵向打印':'A4 横向打印',inDialog:true,run:()=>{if(p)updateStyle({...readScoreStyle(p),printOrientation,printBarsPerRow:printOrientation==='portrait'?2:4,printPreset:'custom'});}})),
    { id: 'view.follow', label: '切换自动跟谱', run: () => setAutoFollow(v => !v) },
    ...[2,4,6,8].map(n => ({ id: `view.rows.${n}`, label: `每行显示 ${n} 小节`, run: () => setRows(n) })),
    { id: 'section.copy', label: '复制当前段落的音名或和弦', enabled: available && !!p?.sections.length, run: copyCurrentSection },
    ...(p?.sections ?? []).flatMap(section => [
      { id: `section.edit.${section.id}`, label: `编辑段落：${section.name}`, group: '歌曲结构', run: () => { setSelected(section.id); setModal('section'); } },
      { id: `section.loop.${section.id}`, label: `循环段落：${section.name}`, group: '歌曲结构', run: () => toggleLoop(section) },
    ]),
    { id: 'audio.play', label: '播放 / 暂停', keys: ['Space'], run: () => playing ? pause() : void play() },
    { id:'audio.toggleStem',label:'切换原曲 / 贝斯',keys:['Shift+B'],enabled:available&&!modal&&!!p?.stems.some(s=>s.id==='bass'&&s.available),run:toggleListening },
    ...([-1,1] as const).flatMap(direction=>[
      {id:direction<0?'audio.previousBar':'audio.nextBar',label:direction<0?'定位上一个小节':'定位下一个小节',enabled:available&&!modal,run:()=>jumpBar(direction)},
      {id:direction<0?'audio.previousBarKey':'audio.nextBarKey',label:direction<0?'播放时：上一个小节':'播放时：下一个小节',keys:[direction<0?'ArrowLeft':'ArrowRight'],priority:100,enabled:available&&!modal&&playing,run:()=>jumpBar(direction)},
    ]),
    { id: 'audio.back', label: '后退五秒', keys: ['J'], run: () => seek(time - 5) },
    { id: 'audio.forward', label: '前进五秒', keys: ['L'], run: () => seek(time + 5) },
    { id: 'audio.start', label: '回到歌曲开头', keys: ['Home'], run: () => seek(0) },
    { id: 'audio.loopA', label: '设置循环 A 点', keys: ['A'], run: () => { setLoopA(time); message(`A 点 ${formatTime(time)}`); } },
    { id: 'audio.loopB', label: '设置循环 B 点', keys: ['B'], run: markLoopB },
    { id: 'audio.loop', label: '整曲循环 / 关闭循环', keys: ['R'], run: () => toggleLoop() },
    ...['original','bass','drums','vocals','other','backing'].map((stem, i) => ({ id: `audio.stem.${stem}`, label: `试听${['原曲','贝斯','鼓','人声','其他伴奏','无贝斯伴奏'][i]}`, enabled: available && !!p?.stems.some(s => s.id === stem && s.available), run: () => listenTo(stem) })),
    ...[true,false].map(enhanced=>({id:`audio.bass.${enhanced?'enhanced':'raw'}`,label:enhanced?'试听增强贝斯':'试听原始贝斯分轨',enabled:available&&!!p?.stems.some(s=>s.id==='bass'&&s.available&&(!enhanced||s.enhancedUrl)),run:()=>{setBassEnhanced(enhanced);listenTo('bass');}})),
    ...[.5,.75,1,1.25,1.5].map(n => ({ id: `audio.speed.${n}`, label: `播放速度 ${n}×`, run: () => setSpeed(n) })),
    ...[-.1,.1].map(n => ({ id: `audio.volume.${n}`, label: n > 0 ? '增加音量' : '减小音量', run: () => setVolume(v => Math.max(0, Math.min(1, v + n))) })),
    ...(['html','json','lrc'] as const).map(kind => ({ id: `export.${kind}`, label: `导出 ${kind.toUpperCase()}${kind === 'json' ? ' 工程' : kind === 'lrc' ? ' 歌词' : ' 互动谱'}`, inDialog: true, run: () => exportFile(kind) })),
    { id: 'project.importJson', label: '导入 JSON 工程', inDialog: true, run: () => { setModal(null); jsonInput.current?.click(); } },
    ...(p?.stems.filter(s => s.available && s.id !== 'original') ?? []).map(stem => ({ id: `export.stem.${stem.id}`, label: `导出${stem.name}音轨`, run: () => { const a = document.createElement('a'); a.href = stem.url; a.download = `${p!.title}-${stem.id}.wav`; a.click(); } })),
    {id:'export.bassEnhanced',label:'导出增强贝斯音轨',inDialog:true,enabled:available&&!!p?.stems.find(s=>s.id==='bass')?.enhancedUrl,run:()=>downloadStem('bass',true)},
    ...projects.map(item => ({ id: `project.open.${item.id}`, label: `打开工程：${item.title}`, group: '曲库', run: () => void switchProject(item.id) })),
    {id:'library.trash',label:'打开回收站',enabled:true,run:()=>setModal('trash')},
    {id:'song.delete',label:'当前歌曲移入回收站',enabled:!!p&&!featureRunning(p),run:()=>{if(p)requestDelete(p);}},
    {id:'audio.backing',label:'无贝斯伴奏 / 上次试听模式',keys:['Shift+M'],enabled:available&&!modal,run:toggleBacking},
    ...(['key','chords','backing'] as const).map((kind,i)=>({id:'feature.'+kind,label:['重新识别调性','按需识别和弦','生成无贝斯伴奏'][i],enabled:available&&!!p&&!featureRunning(p),run:()=>void runFeature(kind)})),
    { id: 'help.guide', label: '打开使用帮助', run: () => setModal('help') },
    { id: 'modal.close', label: '取消 / 关闭弹窗', keys: ['Escape'], enabled: !!modal, inInput: true, inDialog: true, priority: 50, run: () => setModal(null) },
    { id: 'modal.confirm', label: '确认当前表单', keys: ['Ctrl+Enter'], enabled: !!modal, inInput: true, inDialog: true, priority: 50, run: () => { const form = document.querySelector<HTMLFormElement>('.modal form'); if (form) form.requestSubmit(); else document.querySelector<HTMLButtonElement>('.modal .primary:not(:disabled)')?.click(); } },
  ];
  useCommands(appCommands.map(c => ({ ...c, enabled: c.enabled ?? available, group: c.group ?? '工作台' })));

  const transferUi=<LibraryTransfer mode={transferMode} scope={transferScope} library={library} batch={batch} onClose={()=>setTransferMode(null)} beforeExport={beforeLibraryExport} onRefresh={refreshLibrary}/>;
  if(!p&&emptyLibrary)return <div className="empty-library"><img className="brand-image" src="/basstrace-icon.png" alt=""/><h1>BassTrace</h1><button className="primary" onClick={()=>openTransfer('audio')}>导入音乐文件</button><button className="secondary" onClick={()=>openTransfer('restore')}>恢复曲库备份</button><LibraryView library={library} projects={displayedProjects} currentId="" onOpen={id=>void load(id).then(()=>setNav('score'))} onDelete={requestDelete} onTrash={()=>setModal('trash')} onTransfer={openTransfer}/>{modal==='trash'&&<ModalPanel title="回收站" close={()=>setModal(null)}><TrashPanel onRestore={restoredSong}/></ModalPanel>}{transferUi}{toast&&<p role="status">{toast}</p>}</div>;
  if(!p)return <div className="boot"><img className="brand-image" src="/basstrace-icon.png" alt=""/><h1>BassTrace</h1><p>{error?'暂时无法连接本地服务':'正在打开你的备曲工作台…'}</p>{error?<><small>{error}</small><button className="primary" onClick={()=>void load()}><RotateCcw size={16}/>重新连接</button><p className="muted">请使用项目中的 start.cmd 启动服务。</p></>:<LoaderCircle className="spin"/>}</div>;
  const chartSections=displaySections(p);const visibleChords=topEvents(p);const pos=timeToPosition(p,time); const section=chartSections.find(s=>pos.bar>=s.startBar&&pos.bar<=s.endBar); const totalBars=barCount(p); const currentChord=topEventAt(p,time);const scoreStyle=readScoreStyle(p);const topName=p.topTrack==='bass'?'贝斯音名':'和弦';
  const original=p.stems.find(s=>s.id==='original');

  return <div className={`app apple-app nav-${nav}`}>
    <style>{scorePageCss(p)}</style>
    <input ref={fileInput} type="file" accept=".mp3,.wav,.flac,.m4a" hidden onChange={e=>void upload(e.target.files?.[0],importSource.current)}/>
    <input ref={jsonInput} type="file" accept=".json" hidden onChange={e=>void importJson(e.target.files?.[0])}/>
    <aside className="sidebar no-print">
      <a className="brand" href="#" onClick={e=>{e.preventDefault();setNav('home');}}><img className="brand-image" src="/basstrace-icon.png" alt=""/><span>BassTrace</span></a>
      <nav aria-label="主导航"><button className={nav==='home'?'active':''} onClick={()=>invoke('page.home')}><Upload size={18}/>首页</button><button className={nav==='score'||nav==='studio'?'active':''} onClick={()=>invoke('page.score')}><FileText size={18}/>曲谱编辑</button><button className={nav==='library'?'active':''} onClick={()=>invoke('page.library')}><Library size={18}/>曲库</button></nav>
      <LibrarySidebar library={library} projects={displayedProjects} currentId={p.id} onOpen={id=>void switchProject(id)} onLibrary={()=>setNav('library')} onDelete={requestDelete} onTrash={()=>setModal('trash')}/>
      <div className="library-import-entry"><button className="new-project" aria-expanded={importMenu} onClick={()=>setImportMenu(!importMenu)}><Plus size={16}/>{batch.running?'正在导入曲库…':'导入曲库'}</button>{importMenu&&<div className="library-import-menu"><button onClick={()=>openTransfer('audio')}>导入音乐文件</button><button onClick={()=>openTransfer('restore')}>恢复曲库备份</button></div>}</div>
      <div className="sidebar-bottom"><button className="help-link" title="快捷键帮助 · F1" onClick={()=>invoke('commands.help')}><CircleHelp size={16}/>快捷键与帮助</button><p className="local-note"><LockKeyhole size={12}/>文件保存在你的电脑</p></div>
    </aside>
    <div className="workspace">
      <header className="topbar no-print"><strong className="window-title">{nav==='home'?'BassTrace':nav==='library'?'我的曲库':'曲谱'}</strong><div className="top-actions"><button className="history-button" title="撤销 Ctrl+Z" disabled={!historyState.undo} onClick={()=>invoke('history.undo')}>↶</button><button className="history-button" title="重做 Ctrl+Shift+Z" disabled={!historyState.redo} onClick={()=>invoke('history.redo')}>↷</button><span className={'save-state '+(dirty?'unsaved':'')}><span/>{dirty?'正在保存…':'工程已保存'}</span><button className="secondary" title="保存工程 · Ctrl+S" onClick={()=>invoke('project.save')} disabled={saving}><Save size={15}/>保存工程</button><button className="primary" title="导出曲谱 · Ctrl+Shift+E" onClick={()=>invoke('project.export')}><Download size={15}/>导出曲谱</button></div></header>
      {nav==='home'?<HomePage p={p} preparedLyrics={stagedLyrics?.count} projects={displayedProjects} onAudio={(file,source)=>void upload(file,source)} onLyrics={()=>setModal('lyrics')} onAnalyze={()=>{setNav('score');setModal('analysis');}} onOpen={id=>void switchProject(id)} onScore={()=>setNav('score')}/>:nav==='library'?<LibraryView library={library} projects={displayedProjects} currentId={p.id} onOpen={id=>void switchProject(id)} onDelete={requestDelete} onTrash={()=>setModal('trash')} onTransfer={openTransfer}/>:<main className="score-workspace">
        <section className="song-heading"><div className="song-info"><span className="song-caption">{p.isDemo?'示例工程':`歌词与${topName}`}</span><h1>{p.title}<button title="编辑歌曲信息" aria-label="编辑歌曲信息" onClick={()=>invoke('song.info')}><Pencil size={15}/></button></h1><p><button className="song-artist-edit" title="编辑歌手" onClick={()=>invoke('song.info')}>{p.artist||'添加歌手'}</button><span>·</span>{formatTime(p.duration)}<span>·</span>{totalBars} 小节</p></div><div className="song-actions"><button className="secondary" onClick={()=>setModal('lyrics')}><FileText size={15}/>导入歌词</button><button className="secondary analyze-button" disabled={featureRunning(p)} onClick={()=>setModal('analysis')}>{p.analysis.state==='running'?<LoaderCircle size={15} className="spin"/>:<WandSparkles size={15}/>}<span>{p.analysis.state==='running'?`分析中 ${p.analysis.progress}%`:'分析贝斯音名'}</span></button></div></section>
        <FeaturePanel p={p} onRun={kind=>void runFeature(kind)} onEdit={edit}/><PerformanceNotes key={p.id} project={p} onBegin={beginNotes} onChange={changeNotes} onEnd={endNotes}/>
        <div className="metadata"><button aria-label="节拍与小节网格" title="节拍与小节网格 · G" onClick={()=>setModal('grid')}><Clock3 size={14}/><strong>{p.bpm}</strong><span>BPM</span></button><button onClick={()=>setModal('grid')}><strong>{p.meter}</strong><span>拍号</span></button><div><span>演奏调</span><strong>{keyLabel(p)}</strong><button title="降低半音 · Alt+↓" className="transpose" onClick={()=>safeTranspose(-1)}>−</button><button title="升高半音 · Alt+↑" className="transpose" onClick={()=>safeTranspose(1)}>+</button></div><span className="metadata-end">原调 {keyLabel(p,true)}</span></div>
        {p.analysis.state==='running'&&<div className="analysis-progress no-print" role="status"><span>{p.analysis.stage}</span><progress max="100" value={p.analysis.progress}/></div>}
        {p.analysis.state==='error'&&<div className="analysis-error no-print" role="alert"><AlertCircle size={16}/><span>{p.analysis.warnings.at(-1)||'分析未完成，请重新尝试。'}</span><button onClick={()=>setModal('analysis')}>重新分析</button></div>}
        {p.chords.some(isBassRootCandidate)&&<div className="score-notice no-print"><span>旧分析的候选仍保留在工程中。重新分析将提取独立贝斯的主要音名。</span><button onClick={()=>setModal('analysis')}>重新分析贝斯<ChevronRight size={13}/></button></div>}
        <section className="audio-panel no-print"><div className="audio-heading"><span><Headphones size={15}/>试听</span><span className="audio-caption">点击波形定位</span></div><div className="waveform" onClick={e=>{const r=e.currentTarget.getBoundingClientRect();seek((e.clientX-r.left)/r.width*p.duration);}} role="slider" aria-label="音频时间轴" aria-valuemin={0} aria-valuemax={p.duration} aria-valuenow={time} tabIndex={0} onKeyDown={e=>{if(playing)return;if(e.key==='ArrowRight'){e.preventDefault();seek(time+5);}if(e.key==='ArrowLeft'){e.preventDefault();seek(time-5);}}}><div className="wave-bars">{(original?.peaks.length?original.peaks:Array(160).fill(.03)).map((value,i)=><i key={i} className={i/(original?.peaks.length||160)<=time/p.duration?'heard':''} style={{height:`${Math.max(3,Math.min(1,Math.abs(value))*88)}%`}}/>)}</div>{loop&&<div className="loop-region" style={{left:`${loop[0]/p.duration*100}%`,width:`${(loop[1]-loop[0])/p.duration*100}%`}}/>}<div className="playhead" style={{left:`${time/p.duration*100}%`}}/></div></section>
        <details className="structure-details no-print"><summary><span>歌曲段落</span><small>{chartSections.length} 个段落</small><ChevronDown size={14}/></summary><div className="structure-strip">{chartSections.map((s,i)=><button key={s.id} style={{flex:Math.max(1,s.endBar-s.startBar+1),'--section-color':s.color||colors[i%colors.length]} as CSSProperties} className={s.id===section?.id?'section-block current':'section-block'} onClick={()=>seek(positionToTime(p,s.startBar,1))} onDoubleClick={()=>{setSelected(s.id);setModal('section');}}><span>{sectionLabel(s.name,i)}</span><small>{s.endBar-s.startBar+1} 小节</small></button>)}</div><button className="text-action" onClick={()=>{setSelected('');setModal('section');}}><Plus size={14}/>添加段落</button></details>
        <section className="chart-panel" ref={chartRef}><div className="chart-toolbar no-print"><div className="view-tabs"><button className={mode==='chart'?'active':''} onClick={()=>setMode('chart')}>三轨排练谱</button><button className={mode==='structure'?'active':''} onClick={()=>setMode('structure')}>结构总览</button></div><details className="chart-display-menu"><summary><SlidersHorizontal size={14}/>谱面设置</summary><div className="chart-options"><button title="播放自动跟谱" className={autoFollow?'active':''} onClick={()=>setAutoFollow(!autoFollow)}>自动跟谱</button><button className={degree?'active':''} onClick={()=>setDegree(!degree)} title="切换音名或和弦级数 · D" disabled={!p.keyAnalysis?.confirmed&&!p.keyAnalysis?.detectedKey&&!p.isDemo}>{degree?`显示${topName}`:'显示级数'}</button><select aria-label="顶部轨道" value={p.topTrack??'chords'} onChange={e=>edit(current=>({...current,topTrack:e.target.value as 'bass'|'chords'}))}><option value="bass">贝斯音名</option><option value="chords">原有和弦</option></select><ScoreSettings p={p} onChange={updateStyle}/><div className="font-controls"><button title="减小字号 · −" onClick={()=>setFontSize(Math.max(10,fontSize-1))}>A−</button><span>{fontSize}</span><button title="增大字号 · +" onClick={()=>setFontSize(Math.min(22,fontSize+1))}>A+</button></div><select aria-label="每行小节数" value={rows} onChange={e=>setRows(Number(e.target.value))}>{[2,4,6,8].map(n=><option key={n} value={n}>{n} 小节 / 行</option>)}</select></div></details></div>
          {!p.lyrics.length&&<div className="lyrics-needed no-print"><span>导入歌词，与和弦一起整理。</span><button className="text-action" onClick={()=>setModal('lyrics')}>导入 LRC / TXT<ChevronRight size={14}/></button></div>}
          <div className={`sheet lyrics-chord-sheet${scoreStyle.printColor?'':' score-print-mono'}`} style={{'--sheet-font':`${fontSize}px`,...scoreStyleVariables(p)} as CSSProperties}><div className="sheet-header"><div><h2>{p.title}</h2><p>{p.artist||`歌词与${topName}排练谱`}</p></div><div className="sheet-meta"><strong>{keyLabel(p)}</strong><span>♩ = {p.bpm}　{p.meter}</span><span>{totalBars} 小节</span></div></div>
            {mode==='structure'?<div className="overview">{chartSections.map((s,i)=><button key={s.id} onClick={()=>seek(positionToTime(p,s.startBar,1))}><span className="overview-index">{String(i+1).padStart(2,'0')}</span><div><strong>{sectionLabel(s.name,i)}</strong><small>{formatTime(positionToTime(p,s.startBar,1))} — {formatTime(Math.min(p.duration,positionToTime(p,s.endBar+1,1)))}</small></div><div className="overview-chords">{visibleChords.filter(c=>c.bar>=s.startBar&&c.bar<=s.endBar).map(c=>topEventLabel(p,c,degree)).filter((c,j,a)=>j===0||c!==a[j-1]).slice(0,8).join('　/　')}</div><b>{s.endBar-s.startBar+1}<small>小节</small></b></button>)}</div>:<ThreeTrackScore p={p} onNewSection={bar=>{setSelected(`new:${bar}`);setModal('section');}} chords={visibleChords} barsPerRow={rows} fontSize={fontSize} degree={degree} time={time} playing={playing} onEdit={edit} onChordEdit={id=>{setSelected(id);setModal('chord');}} onNewChord={(bar,beat=1)=>{setSelected(`new:${bar}:${beat}`);setModal('chord');}} onSeek={seek} onMarkSeek={at=>{if(loop&&(at<loop[0]||at>=loop[1]))setLoop(null);seek(at);if(!playing)void play(at);}} onStatus={message} onSectionEdit={id=>{setSelected(id);setModal('section');}} onLoop={toggleLoop}/>}
            {!visibleChords.length&&<div className="chords-empty no-print"><p>还没有可见的{topName}。可以分析贝斯，或点击小节右上角的 + 手动填写。</p><button className="secondary" onClick={()=>setModal('analysis')}>分析贝斯音名</button></div>}
            <div className="sheet-footer"><span>BassTrace</span><span>{p.analysis.state==='complete'?'分析初稿 · 试听校正':`歌词与${topName}谱`}　/　{keyLabel(p)}</span></div>
          </div>
        </section>
        {p.lyrics.length>0&&<details className="alignment-details no-print"><summary><span>歌词时间校正</span><ChevronDown size={14}/></summary><LyricAlignment p={p} onAlign={alignLyrics} onSeek={seek} onEditLyric={id=>{setSelected(id);setModal('lyric');}} onAccept={acceptAlignment}/></details>}
        {p.analysis.warnings.length>0&&<details className="analysis-details no-print"><summary>分析说明<small>{p.analysis.warnings.length} 条</small></summary>{p.analysis.warnings.map((warning,i)=><p key={i}>{warning}</p>)}</details>}
      </main>}
      <footer className="transport no-print"><div className="transport-song"><div className="mini-art"><Music2 size={19}/></div><span><strong>{p.title}</strong><small>{currentChord?topEventLabel(p,currentChord,degree):section?sectionLabel(section.name,chartSections.indexOf(section)):'准备播放'}</small></span></div><div className="transport-main"><div className="transport-controls"><button title="回到开头" onClick={()=>seek(loop?.[0]??0)}><SkipBack size={17}/></button><button className="play-button" title="播放 / 暂停 (Space)" onClick={()=>invoke('audio.play')}>{playing?<Pause size={18} fill="currentColor"/>:<Play size={18} fill="currentColor"/>}</button><button className={loop?'loop-button active':'loop-button'} title="整曲循环 / 关闭循环 · R" onClick={()=>toggleLoop()}><Repeat2 size={17}/></button></div><div className="transport-seek"><span>{formatTime(time)}</span><input aria-label="播放位置" type="range" min="0" max={p.duration} step=".05" value={time} onChange={e=>seek(Number(e.target.value))}/><span>{formatTime(p.duration)}</span></div></div><div className="transport-extra"><button className={loopA!==null?'active':''} title="将当前位置设为循环 A 点 · A" onClick={()=>{setLoopA(time);message(`A 点 ${formatTime(time)}`);}}>A</button><button title="将当前位置设为循环 B 点 · B" onClick={markLoopB}>B</button><select aria-label="播放速度" value={speed} onChange={e=>setSpeed(Number(e.target.value))}>{[.5,.75,1,1.25,1.5].map(n=><option key={n} value={n}>{n.toFixed(2).replace(/0$/,'')}×</option>)}</select><Volume2 size={16}/><input aria-label="主音量" type="range" min="0" max="1" step="any" value={volume} onChange={e=>setVolume(Number(e.target.value))}/></div></footer>
    </div>
    <aside className="listen-dock no-print" aria-label="悬浮试听面板"><strong>试听音轨</strong>{(['original','bass','backing'] as const).map(id=><button key={id} aria-pressed={(mix[id]??0)>0} className={(mix[id]??0)>0?'active':''} disabled={id==='backing'?(featureRunning(p)||p.audioSource==='uploaded_bass'):!p.stems.some(s=>s.id===id&&s.available)} title={id==='backing'?'Shift+M · 无贝斯伴奏 / 上次试听模式':id==='bass'&&!p.stems.some(s=>s.id==='bass'&&s.available)?'请先完成贝斯分离':'Shift+B 切换原曲 / 贝斯'} onClick={()=>id==='backing'?((mix.backing??0)>0?listenTo('backing'):toggleBacking()):invoke('audio.stem.'+id)}>{id==='original'?'原曲':id==='bass'?'只听贝斯':p.backingAnalysis?.state==='running'?'伴奏生成中…':p.stems.some(s=>s.id==='backing'&&s.available)?'无贝斯伴奏':'生成无贝斯伴奏'}</button>)}<small>Shift+B 切换音轨</small>{p.stems.find(s=>s.id==='bass')?.enhancedUrl&&<select aria-label="贝斯音量版本" value={bassEnhanced?'enhanced':'raw'} onChange={e=>{setBassEnhanced(e.target.value==='enhanced');listenTo('bass');}}><option value="enhanced">增强贝斯</option><option value="raw">原始贝斯分轨</option></select>}<div className="bar-jump"><button title="上一个小节 · 播放时 ←" aria-label="上一个小节" onClick={()=>invoke('audio.previousBar')}>←</button><button title="下一个小节 · 播放时 →" aria-label="下一个小节" onClick={()=>invoke('audio.nextBar')}>→</button></div></aside>
    {busy&&<div className="busy-overlay"><LoaderCircle className="spin"/><span>正在处理音频…</span></div>}<Presence>{toast?<div className="toast"><Check size={16}/>{toast}</div>:null}</Presence>
    {transferUi}<Presence>{modal&&<ModalPanel title={({deleteSong:'移入回收站',trash:'回收站',songInfo:'编辑歌曲信息',export:'导出曲谱',lyrics:'导入歌词',grid:'速度与拍号',analysis:'分析贝斯音名',help:'使用帮助',section:'编辑段落',chord:`编辑${topName}`,lyric:'歌词时间'})[modal]} close={()=>setModal(null)}>
      {modal==='deleteSong'&&deleteTarget&&<><p>将“{deleteTarget.title}”移入回收站？曲谱与音频会保留，可以恢复。</p><div className="form-actions"><button className="secondary" disabled={busy} onClick={()=>setModal(null)}>取消</button><button className="danger" disabled={busy} onClick={()=>void deleteSong()}>移入回收站</button></div></>}
      {modal==='trash'&&<TrashPanel onRestore={restoredSong}/>}
      {modal==='export'&&<div><p className="modal-description">导出{topName}、手写加花与歌词排练谱。</p><label className="checkbox"><input type="checkbox" checked={readPerformanceNotes(p).includeInExport} onChange={e=>edit(current=>({...current,performanceNotes:{...readPerformanceNotes(current),includeInExport:e.target.checked}}))}/>在谱头显示演出备注</label><ScoreSettings p={p} onChange={updateStyle} printOnly/><div className="export-grid"><button disabled={pdf.busy} onClick={()=>invoke('export.pdf')}>{pdf.busy?<LoaderCircle className="spin"/>:<Download/>}<strong>{pdf.busy?'正在生成 PDF…':'下载 PDF'}</strong><small>大字紧凑 · 直接保存文件</small></button><button disabled={pdf.busy} onClick={()=>invoke('export.pdfPreview')}><FileText/><strong>预览 PDF</strong><small>与下载文件完全一致</small></button><button onClick={()=>invoke('export.html')}><FileText/><strong>互动 HTML 谱</strong><small>独立打开，点击定位试听</small></button></div><div className="pdf-output">{pdf.error&&<p role="alert" className="pdf-error">{pdf.error}</p>}{pdf.preview&&<><iframe title="PDF 预览" src={pdf.preview}/><button className="text-action" onClick={pdf.closePreview}>收起预览</button></>}<button className="text-action" onClick={()=>invoke('project.print')}>浏览器打印 · Ctrl+P</button></div><details className="export-more"><summary>工程、歌词与音频</summary><button className="secondary" onClick={()=>invoke('export.json')}><Save size={15}/>JSON 工程</button><button className="secondary" onClick={()=>invoke('export.lrc')}><FileText size={15}/>LRC 歌词</button><button className="secondary" onClick={()=>{setModal(null);jsonInput.current?.click();}}><FolderOpen size={15}/>导入 JSON 工程</button>{p.stems.filter(s=>s.available&&s.id!=='original').map(s=><a className="stem-download" key={s.id} href={s.url} download={`${p.title}-${s.id}.wav`}><Download size={13}/>{s.name}音轨</a>)}{p.stems.find(s=>s.id==='bass')?.enhancedUrl&&<button className="stem-download" onClick={()=>invoke('export.bassEnhanced')}><Download size={13}/>增强贝斯音轨</button>}</details><p className="quiet-hint">PDF 按当前编辑内容生成，空轨道自动收起。字号与屏幕独立；HTML 可另选本机音频试听。</p></div>}
      {modal==='songInfo'&&<SongInfoForm key={`${p.id}-${songInfoSession.current}`} project={p} onCancel={()=>setModal(null)} onApply={(title,artist)=>{edit(current=>current.title===title&&current.artist===artist?current:{...current,title,artist});setModal(null);}}/>}
      {modal==='grid'&&<GridForm p={p} onApply={next=>{edit(()=>next);setModal(null);message('已更新速度与拍点');}}/>}
      {modal==='lyrics'&&<LyricsForm p={p} onApply={(lyrics,raw)=>{if(nav==='home'&&p.isDemo)setStagedLyrics({raw,count:lyrics.length});edit(v=>({...v,lyrics,lyricsOriginal:raw}));setModal(null);message('歌词已导入：双击编辑，句首空格／退格调 ¼ 拍，拖动碰到才推');}}/>}
      {modal==='chord'&&p.topTrack==='bass'&&<BassEventForm p={p} selected={selected} onApply={event=>{edit(current=>({...current,bassEvents:[...(current.bassEvents??[]).filter(e=>e.id!==event.id),event].sort((a,b)=>a.start-b.start)}));setModal(null);}} onDelete={id=>{edit(current=>({...current,bassEvents:(current.bassEvents??[]).filter(e=>e.id!==id)}));setModal(null);}}/>}
      {modal==='chord'&&p.topTrack!=='bass'&&<ChordForm p={p} selected={selected} onApply={chord=>{edit(v=>({...v,chords:[...v.chords.filter(c=>c.id!==chord.id),chord].sort((a,b)=>a.bar-b.bar||a.beat-b.beat)}));setModal(null);}} onDelete={id=>{edit(v=>({...v,chords:v.chords.filter(c=>c.id!==id)}));setModal(null);}}/>}
      {modal==='lyric'&&<LyricForm p={p} selected={selected} onApply={lyric=>{edit(v=>({...v,lyrics:v.lyrics.map(l=>l.id===lyric.id?lyric:l)}));setModal(null);}} onDelete={id=>{edit(v=>({...v,lyrics:v.lyrics.filter(l=>l.id!==id)}));setModal(null);}}/>}
      {modal==='section'&&<SectionForm p={p} selected={selected} onCopy={(source,target)=>{edit(current=>copySectionTop(current,source,target));setModal(null);message('段落顶部音名已复制，可撤销');}} onApply={s=>{edit(v=>({...v,sections:[...v.sections.filter(item=>item.id!==s.id),s].sort((a,b)=>a.startBar-b.startBar)}));setModal(null);}} onDelete={id=>{edit(v=>({...v,sections:v.sections.filter(s=>s.id!==id)}));setModal(null);}}/>}
      {modal==='analysis'&&<AnalysisForm p={p} health={health} onStart={analyze}/>}
      {modal==='help'&&<div className="help-content"><p>导入歌曲与歌词，在三条独立轨道上整理和弦、手写加花和歌词。</p><ol><li><strong>分析贝斯</strong><p>完整歌曲自动分离贝斯、增强音量，按半小节提取主要音名。音名表示实际低音候选，可试听校正。旧工程的和弦可在谱面设置中切换查看。</p></li><li><strong>导入歌词</strong><p>TXT 按原分行紧排，LRC 保留时间。双击歌词编辑，句首空格右移 ¼ 拍，退格删除前方空白。拖动只移动当前句，碰到后句才向后推。正文双空格拆分，前方空白耗尽后双退格合并。</p></li><li><strong>快速校正</strong><p>点击中间轨的空白拍位，输入 1234 后回车。点击、Ctrl+点击或从加花轨空白处框选数字，Delete 批量删除，[ ] 批量调整下划线；删除保留其余数字的时间。单选时 ↑ ↓ 调整八度点，拖动数字移动整组。空格播放暂停，输入文字时保留编辑功能。S 切音、X 闷音、H 击弦、P 勾弦、T 延音、Shift+A 重音、Shift+↑/↓ 滑音。数字太多时在顶部音名范围内缩排或换行，实际演奏时间保留。和弦仍可点击修改、拖动拍点；播放器 0.5× 用于慢练。</p></li><li><strong>保存与导出</strong><p>编辑会自动保存，也可按 Ctrl+S。按 Ctrl+K 搜索全部操作，F1 查看快捷键。谱面设置可单独放大歌词并调整四类颜色。导出 PDF 或互动 HTML，开始排练。</p></li></ol><button className="primary wide" onClick={()=>setModal(null)}>开始备曲</button></div>}
    </ModalPanel>}</Presence>
  </div>;
}

function ModalPanel({title,close,children,...motion}:{title:string;close:()=>void;children:React.ReactNode;inert?:boolean;'data-presence'?:string;'aria-hidden'?:boolean}){return <div {...motion} className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><div><span className="eyebrow">BASSCHART STUDIO</span><h2>{title}</h2></div><button onClick={close} title="关闭"><X size={20}/></button></header>{children}</section></div>;}
function GridForm({p,onApply}:{p:Project;onApply:(p:Project)=>void}) {
  const [bpm,setBpm]=useState(p.bpm),[meter,setMeter]=useState(p.meter),[offset,setOffset]=useState(p.offset);
  const [key,setKey]=useState(p.key),[originalKey,setOriginalKey]=useState(p.originalKey);
  const [custom,setCustom]=useState(p.beatTimes?.some((t,i,a)=>i>0&&Math.abs(t-a[i-1]-beatSeconds(p))>.001)||false),[grid,setGrid]=useState(p.beatTimes?.join(', ')||''),[err,setErr]=useState('');
  function changeTempo(ratio:number){
    if(!Number.isFinite(bpm)||bpm<=0){setErr('请先输入有效 BPM');return;}
    const nextBpm=Math.max(30,Math.min(300,bpm*ratio));
    if(custom){const times=grid.split(/[\s,]+/).filter(Boolean).map(Number);if(times.length<2||times.some((t,i)=>!Number.isFinite(t)||t<0||(i>0&&t<=times[i-1]))){setErr('请先填写有效的递增拍点，再调整半速 / 倍速');return;}setGrid(resampleBeatTimes(times,nextBpm/bpm).join(', '));}
    setBpm(nextBpm);setErr('');
  }
  return <form onSubmit={e=>{
    e.preventDefault();let beatTimes:number[]=[];
    if(custom){beatTimes=grid.split(/[\s,]+/).filter(Boolean).map(Number);if(beatTimes.length<2||beatTimes.some((t,i)=>!Number.isFinite(t)||t<0||(i>0&&t<=beatTimes[i-1]))||beatTimes[0]>p.duration){setErr('拍点时间必须为至少两个递增的非负秒数，首拍不能超出音频');return;}}
    let next:Project={...p,bpm,meter,key,originalKey,offset:custom?beatTimes[0]:offset,beatTimes};if(!custom)next={...next,beatTimes:makeGrid(next)};
    const chords=p.chords.map(c=>{const at=timeToPosition(next,positionToTime(p,c.bar,c.beat));return {...c,bar:Math.max(1,at.bar),beat:at.bar<1?1:Math.round(at.beat*10000)/10000,locked:true,source:'manual' as const};});
    const count=barCount(next);
    const sections=p.sections.map(s=>({...s,startBar:Math.min(count,Math.max(1,timeToPosition(next,positionToTime(p,s.startBar,1)).bar)),endBar:Math.min(count,Math.max(1,Math.ceil(timeToPosition(next,positionToTime(p,s.endBar+1,1)).bar-1)))})).sort((a,b)=>a.startBar-b.startBar).filter((s,i,a)=>i===0||s.startBar!==a[i-1].startBar).map((s,i,a)=>({...s,endBar:Math.max(s.startBar,Math.min(s.endBar,a[i+1]?a[i+1].startBar-1:count))}));
    onApply({...next,chords,sections});
  }}><p className="modal-description">修正首拍与速度后，歌词和和弦保留音频时间，并重新关联小节与拍点。</p>
  <div className="form-row"><label>速度（四分音符 BPM）<input type="number" value={bpm} min="30" max="300" step=".1" required onChange={e=>setBpm(Number(e.target.value))}/></label><label>拍号<select value={meter} onChange={e=>setMeter(e.target.value)}>{['4/4','3/4','6/8','2/4','5/4','7/8'].map(m=><option key={m}>{m}</option>)}</select></label></div>
  <div className="bpm-options"><button type="button" onClick={()=>changeTempo(.5)}>½ 速度</button><button type="button" onClick={()=>changeTempo(2)}>2× 速度</button><span>校正节拍网格；慢练请用播放器 0.5×</span></div>
  <label>第 1 小节首拍时间（秒）<input type="number" value={custom?Number(grid.split(/[\s,]+/).filter(Boolean)[0]||0):offset} disabled={custom} min="0" max={p.duration} step="any" required onChange={e=>setOffset(Number(e.target.value))}/></label>
  <div className="form-row"><label>原调<input value={originalKey} required pattern="[A-G][#b]?(m| Major| Minor)?" onChange={e=>setOriginalKey(e.target.value)} list="keys"/></label><label>演奏调<input value={key} required pattern="[A-G][#b]?(m| Major| Minor)?" onChange={e=>setKey(e.target.value)} list="keys"/></label><datalist id="keys">{['C','G','D','A','E','B','F#','F','Bb','Eb','Ab','Db','Am','Em','Bm','Dm','Gm','Cm'].map(k=><option key={k}>{k}</option>)}</datalist></div>
  <p className="quiet-hint">此处校正调性标签；整曲移调请使用工作台的 + / −。</p>
  <label className="checkbox"><input type="checkbox" checked={custom} onChange={e=>setCustom(e.target.checked)}/>使用逐拍时间网格（支持变速）</label>{custom&&<label>每一拍的绝对时间（秒，逗号分隔）<textarea rows={5} value={grid} onChange={e=>setGrid(e.target.value)}/></label>}{err&&<p className="form-error">{err}</p>}
  {custom&&<p className="quiet-hint">逐拍网格以这些时间为准；修改首拍请编辑第一个秒数。½ / 2× 会同步重采样拍点，单独修改 BPM 数字只更新标称速度。</p>}
  <p className="quiet-hint">6/8 每拍为八分音符。首拍前的和弦暂显示在第 1 拍。网格变化后请复核段落边界。</p><button className="primary wide" type="submit"><Check size={16}/>更新节拍网格</button></form>;
}
function LyricsForm({p,onApply}:{p:Project;onApply:(l:Lyric[],raw:string)=>void}){const [text,setText]=useState('');const [kind,setKind]=useState<'lrc'|'txt'>('lrc');const [err,setErr]=useState('');return <form onSubmit={e=>{e.preventDefault();let lyrics:Lyric[];if(kind==='lrc')lyrics=parseLrc(text,p.duration).map(l=>({...l,source:'manual',locked:true}));else {try{lyrics=packTxtLyrics(p,text,lyricImportOptions(),uid);}catch(error){setErr(String(error));return;}}if(!lyrics.length){setErr('没有解析到歌词，请检查文本或 LRC 时间标签');return;}onApply(lyrics,text);}}><div className="form-tabs"><button type="button" className={kind==='lrc'?'active':''} onClick={()=>setKind('lrc')}>LRC 时间歌词</button><button type="button" className={kind==='txt'?'active':''} onClick={()=>setKind('txt')}>TXT 纯文本</button></div><p className="modal-description">{kind==='lrc'?'读取歌词片段的真实时间标签，支持同一行多个时间标签。':'每行成为一个紧挨的片段。双击直接编辑；句首空格／退格调 ¼ 拍，拖动歌词碰到后句才推移。'}</p><label className="file-label"><Upload size={14}/>读取歌词文件<input type="file" accept=".lrc,.txt" hidden onChange={async e=>{const f=e.target.files?.[0];if(f)setText(await f.text());}}/></label><textarea className="lyrics-input" rows={9} required value={text} onChange={e=>setText(e.target.value)} placeholder={kind==='lrc'?'[00:10.00]城市的灯慢慢亮起\n[00:15.50]让节奏陪我们前行':'每一行填写一个歌词片段…'}/><p className="quiet-hint">导入将替换当前歌词；已有和弦与音符会保留。</p>{err&&<p className="form-error">{err}</p>}<button className="primary wide" type="submit"><Check size={16}/>导入歌词片段</button>{p.lyrics.length>0&&<details className="existing-lyrics"><summary>当前 {p.lyrics.length} 个片段</summary>{p.lyrics.slice(0,12).map(l=><p key={l.id}><span>{formatTime(l.start)}</span>{l.text}</p>)}</details>}</form>;}
function ChordForm({p,selected,onApply,onDelete}:{p:Project;selected:string;onApply:(c:Chord)=>void;onDelete:(id:string)=>void}){const existing=p.chords.find(c=>c.id===selected);const [label,setLabel]=useState(existing?.label||'C');const [bar,setBar]=useState(existing?.bar||Number(selected.split(':')[1])||1);const [beat,setBeat]=useState(existing?.beat||Number(selected.split(':')[2])||1);return <form onSubmit={e=>{e.preventDefault();onApply({id:existing?.id||uid(),label:label.trim(),bar,beat,source:'manual',locked:true,confidence:1});}}><p className="modal-description">和弦绑定到具体拍点，支持同一小节多个和弦。</p><label>和弦名称<input autoFocus required value={label} onChange={e=>setLabel(e.target.value)} placeholder="Cmaj7 / Am7 / D/F#" maxLength={40} title="例如 C、Am7、Cmaj7、Gsus4、D/F#"/></label><div className="form-row"><label>小节<input type="number" min="1" max={Math.max(barCount(p),bar)} value={bar} required onChange={e=>setBar(Number(e.target.value))}/></label><label>拍点<input type="number" min="1" max={beatsPerBar(p)+.75} step="any" value={beat} required onChange={e=>setBeat(Number(e.target.value))}/></label></div><div className="edit-preview"><span>{formatTime(positionToTime(p,bar,beat))}</span><strong>{romanChord(label,p.key)}</strong><small>相对于 {p.key}</small></div><div className="form-actions">{existing&&<button className="danger" type="button" onClick={()=>onDelete(existing.id)}><Trash2 size={15}/>删除</button>}<button className="primary" type="submit"><Check size={16}/>保存和弦</button></div></form>;}
function LyricForm({p,selected,onApply,onDelete}:{p:Project;selected:string;onApply:(l:Lyric)=>void;onDelete:(id:string)=>void}){const l=p.lyrics.find(l=>l.id===selected)!;const [text,setText]=useState(l.text),[start,setStart]=useState(l.start),[end,setEnd]=useState(l.end);return <form onSubmit={e=>{e.preventDefault();if(end<=start)return;onApply({...l,text,start,end,locked:true,source:'manual'});}}><label>歌词片段<input value={text} required onChange={e=>setText(e.target.value)}/></label><div className="form-row"><label>开始（秒）<input type="number" min="0" max={p.duration} step="any" required value={start} onChange={e=>setStart(Number(e.target.value))}/></label><label>结束（秒）<input type="number" min={start+.01} max={p.duration} step="any" required value={end} onChange={e=>setEnd(Number(e.target.value))}/></label></div><p className="quiet-hint">当前关联：第 {timeToPosition(p,start).bar} 小节，第 {timeToPosition(p,start).beat.toFixed(2)} 拍。</p><div className="form-actions"><button className="danger" type="button" onClick={()=>onDelete(l.id)}><Trash2 size={15}/>删除</button><button className="primary" type="submit"><Check size={16}/>保存片段</button></div></form>;}
function SectionForm({p,selected,onApply,onDelete,onCopy}:{p:Project;selected:string;onApply:(s:Section)=>void;onDelete:(id:string)=>void;onCopy:(s:Section,target:number)=>void}){
  const section=p.sections.find(item=>item.id===selected);
  const [name,setName]=useState(section?.name||'Verse'),[start,setStart]=useState(section?.startBar||((selected.startsWith('gap:')||selected.startsWith('new:'))?Number(selected.split(':')[1]):1)),[end,setEnd]=useState(section?.endBar||(selected.startsWith('gap:')?Number(selected.split(':')[2]):barCount(p)));
  const [color,setColor]=useState(section?.color||colors[0]),[err,setErr]=useState(''),[target,setTarget]=useState(section?.endBar?section.endBar+1:1);
  return <form onSubmit={event=>{event.preventDefault();if(end<start){setErr('结束小节应不早于开始小节');return;}if(p.sections.some(item=>item.id!==section?.id&&start<=item.endBar&&end>=item.startBar)){setErr('段落与已有段落重叠，请先调整相邻段落边界');return;}onApply({id:section?.id||uid(),name,startBar:start,endBar:end,color});}}>
    <label>段落名称<input value={name} required onChange={event=>setName(event.target.value)} list="section-names"/><datalist id="section-names">{['Intro','Verse 1','Chorus','Verse 2','Bridge','Interlude','Outro'].map(value=><option key={value} value={value}/>)}</datalist></label>
    <div className="form-row"><label>开始小节<input type="number" min="1" max={barCount(p)} value={start} required onChange={event=>setStart(Number(event.target.value))}/></label><label>结束小节<input type="number" min="1" max={barCount(p)} value={end} required onChange={event=>setEnd(Number(event.target.value))}/></label></div>
    <div className="color-picker">{colors.map(value=><button type="button" key={value} onClick={()=>setColor(value)} style={{background:value}}>{color===value&&<Check size={14}/>}</button>)}</div>
    {section&&<details className="section-copy"><summary>复制此段落的{p.topTrack==='bass'?'贝斯音名':'和弦'}</summary><label>目标开始小节<input aria-label="复制和弦的目标开始小节" type="number" min="1" max={barCount(p)-section.endBar+section.startBar} step="1" value={target} onChange={event=>setTarget(Number(event.target.value))}/></label><p className="quiet-hint">替换目标第 {target}–{target+section.endBar-section.startBar} 小节的{p.topTrack==='bass'?'贝斯音名':'和弦'}，保留各拍点。歌词和音符继续独立编辑。</p><button type="button" className="secondary" onClick={()=>{try{copySectionTop(p,section,target);onCopy(section,target);}catch(error){setErr(String(error));}}}>复制段落{p.topTrack==='bass'?'音名':'和弦'}</button></details>}
    {err&&<p className="form-error">{err}</p>}<div className="form-actions">{section&&<button className="danger" type="button" onClick={()=>onDelete(section.id)}><Trash2 size={15}/>删除段落</button>}<button className="primary" type="submit"><Check size={16}/>保存段落</button></div>
  </form>;
}
function AnalysisForm({p,health,onStart}:{p:Project;health:Health;onStart:(source:AnalysisSource,separate:boolean)=>Promise<void>}){
  const hasBass=p.stems.some(stem=>stem.id==='bass'&&stem.available);
  const [source,setSource]=useState<AnalysisSource>('original'),[separate,setSeparate]=useState(false);
  return <div><p className="modal-description">分离独立贝斯并增强音量，提取主要音名。按半小节整理，连续重复音合并；手写加花和歌词继续保留。</p>
    <label>导入音频<select aria-label="分析音频来源" value={source} onChange={e=>setSource(e.target.value as AnalysisSource)}><option value="original">完整原曲 · 必须分离贝斯</option><option value="bass">使用已有贝斯分轨</option><option value="uploaded_bass">我导入的是独立贝斯轨</option></select></label>
    {source!=='uploaded_bass'&&<label className="checkbox"><input type="checkbox" checked={separate} onChange={e=>setSeparate(e.target.checked)}/><span><strong>重新分离音轨</strong><small>{hasBass?'默认复用已分离的贝斯，勾选后重新生成。':'尚无贝斯分轨，将自动分离。'}</small></span></label>}
    <p className="quiet-hint">分离失败会停止并提示重试。音名 A、C、E 不表示大小调和弦；无法可靠识别的区间留白。人工校正与原有和弦都会保留。</p>
    <details><summary>本地服务状态</summary><pre className="health-info">{JSON.stringify(health.capabilities||health,null,2)}</pre></details>
    <button className="primary wide" disabled={p.analysis.state==='running'} onClick={()=>void onStart(source,source==='uploaded_bass'?false:separate)}><WandSparkles size={16}/>{p.analysis.state==='running'?'分析正在进行':'分析贝斯音名'}</button>
  </div>;
}

export default App;
