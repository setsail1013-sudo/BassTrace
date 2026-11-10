import type { Project } from './music';
import { featureRunning, keyLabel } from './project-features';

export function FeaturePanel({p,onRun,onEdit}:{p:Project;onRun:(kind:'key'|'chords'|'backing')=>void;onEdit:(fn:(p:Project)=>Project)=>void}) {
  const busy=featureRunning(p),limited=p.audioSource==='uploaded_bass';
  return <details className="feature-panel"><summary>调性与和弦识别</summary><div className="feature-controls">
    <div><strong>调性：{keyLabel(p)}</strong><button className="secondary" disabled={busy||limited} onClick={()=>onRun('key')}>重新识别调性</button>
      <form onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget),key=String(data.get('key'));onEdit(current=>({...current,key,originalKey:key,keyAnalysis:{state:'complete',stage:'人工确认',progress:100,warnings:[],candidates:[],detectedKey:null,...current.keyAnalysis,confirmed:true}}));}}>
        <label>人工确认调性<select name="key" key={p.key} defaultValue={p.key}>{['C','C#','Db','D','D#','Eb','E','F','F#','Gb','G','G#','Ab','A','A#','Bb','B'].flatMap(key=>[key,key+'m']).map(key=><option key={key}>{key}</option>)}</select></label><button className="secondary" type="submit">确认调性</button>
      </form>{p.keyAnalysis?.candidates.map(c=><button key={c.key} className="key-candidate" title="匹配分数，不是准确率" onClick={()=>onEdit(current=>({...current,key:c.key,originalKey:c.key,keyAnalysis:{...p.keyAnalysis!,confirmed:true}}))}>{c.key} · 匹配 {c.score.toFixed(2)}</button>)}
    </div><div><strong>和弦识别 · 按需运行</strong><p>使用完整歌曲和可用伴奏，贝斯音名单独保留。</p><button className="secondary" disabled={busy||limited} onClick={()=>onRun('chords')}>识别和弦</button>{p.harmonyAnalysis?.state==='complete'&&<button className="secondary" onClick={()=>onEdit(current=>({...current,topTrack:'chords'}))}>查看和弦</button>}</div>
    {limited&&<p>当前为独立贝斯文件，不能据此可靠判断完整调性或和弦；可手动确认调性。</p>}
    {[p.keyAnalysis,p.harmonyAnalysis,p.backingAnalysis].filter(task=>task&&task.state!=='idle').map((task,i)=><p key={i} role={task?.state==='error'?'alert':'status'}>{task?.stage}{task?.state==='running'?'…':''}</p>)}
  </div></details>;
}
