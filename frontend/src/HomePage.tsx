import { useState } from 'react';
import { ArrowUpRight, AudioLines, FileText, Upload, WandSparkles } from 'lucide-react';
import type { Project } from './music';

export function HomePage({p,preparedLyrics,projects,onAudio,onLyrics,onAnalyze,onOpen,onScore}:{p:Project;preparedLyrics?:number;projects:Project[];onAudio:(file?:File,source?:'original'|'uploaded_bass')=>void;onLyrics:()=>void;onAnalyze:()=>void;onOpen:(id:string)=>void;onScore:()=>void}){
  const [dragging,setDragging]=useState(false);
  const [source,setSource]=useState<'original'|'uploaded_bass'>('original');
  return <main className="home-page">
    <div className="home-intro"><h1>下一首，准备好了。</h1><p>导入歌曲与歌词，整理你的贝斯排练谱。</p></div>
    <div className="import-pair">
      <section className={'import-zone '+(dragging?'dragging':'')} onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);onAudio(e.dataTransfer.files[0],source);}}>
        <AudioLines size={34}/><span className="import-index">01 / AUDIO</span><h2>导入音频</h2><p>完整歌曲自动分离贝斯、增强音量并分析。<br/>MP3 · WAV · FLAC · M4A</p><select aria-label="导入音频类型" value={source} onChange={e=>setSource(e.target.value as 'original'|'uploaded_bass')}><option value="original">完整原曲</option><option value="uploaded_bass">已经分离的独立贝斯轨</option></select><label className="import-file"><Upload size={16}/>选择音频<input type="file" accept=".mp3,.wav,.flac,.m4a" hidden onChange={e=>onAudio(e.target.files?.[0],source)}/></label>
        {!p.isDemo&&<small className="material-ready">已准备 · {p.title}</small>}
      </section>
      <section className="import-zone"><FileText size={34}/><span className="import-index">02 / LYRICS</span><h2>导入歌词</h2><p>粘贴正确歌词，或读取 TXT / LRC。<br/>LRC 保留时间，TXT 可手动对齐。</p><button className="text-action" onClick={onLyrics}>粘贴或选择歌词<ArrowUpRight size={16}/></button><small className="material-ready">{preparedLyrics?`已准备 · ${preparedLyrics} 个片段，导入音频时会带入`:p.lyrics.length?`当前工程 · ${p.lyrics.length} 个歌词片段`:'可在导入音频后添加歌词'}</small></section>
    </div>
    <div className="home-action"><button className="primary" onClick={onAnalyze}><WandSparkles size={17}/>分析当前歌曲</button><button className="text-action" onClick={onScore}>打开当前曲谱<ArrowUpRight size={16}/></button><span>{p.isDemo?'也可以先浏览原创演示工程':'音频留在本机，人工校正随工程保存'}</span></div>
    <section className="recent-projects"><div><h2>最近的工程</h2><span>继续上次的备曲</span></div>{projects.slice(0,4).map(item=><button key={item.id} onClick={()=>onOpen(item.id)}><span>{item.title}<small>{item.isDemo?'原创演示':item.artist||'本地音频'}</small></span><span>{item.bpm} BPM</span><ArrowUpRight size={16}/></button>)}</section>
  </main>;
}
