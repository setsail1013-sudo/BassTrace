import { useState } from 'react';
import { Check,Trash2 } from 'lucide-react';
import { barCount,beatsPerBar,positionToTime,timeToPosition,type BassEvent,type Project } from './music';
import { bassName,bassDegree } from './top-track';

export function BassEventForm({p,selected,onApply,onDelete}:{p:Project;selected:string;onApply:(event:BassEvent)=>void;onDelete:(id:string)=>void}) {
  const event=p.bassEvents?.find(e=>e.id===selected), at=event?timeToPosition(p,event.start):null;
  const [pitch,setPitch]=useState(event?.pitchClass??0),[bar,setBar]=useState(Math.max(1,at?.bar??(Number(selected.split(':')[1])||1))),[beat,setBeat]=useState(at&&at.bar>=1?at.beat:Number(selected.split(':')[2])||1);
  const startDefault=event?.start??Math.max(0,positionToTime(p,bar,beat));
  const [end,setEnd]=useState(event?.end??Math.min(p.duration,positionToTime(p,bar,beat+beatsPerBar(p)/2))),[error,setError]=useState('');
  // Preserve an existing pickup timestamp until the user explicitly edits its position.
  const [positionChanged,setPositionChanged]=useState(false);
  const start=positionChanged?positionToTime(p,bar,beat):startDefault;
  return <form onSubmit={e=>{e.preventDefault();if(start<0||start>=p.duration||end<=start||end>p.duration){setError('开始和结束位置需要位于歌曲内，结束晚于开始。');return;}onApply({id:event?.id??crypto.randomUUID(),start,end,pitchClass:pitch,confidence:1,source:'manual',locked:true});}}>
    <p className="modal-description">填写贝斯主要音名。音名记录实际低音，不代表完整和弦。</p>
    <label>贝斯音名<select autoFocus aria-label="贝斯音名" value={pitch} onChange={e=>setPitch(Number(e.target.value))}>{Array.from({length:12},(_,i)=><option key={i} value={i}>{bassName(p,i)}</option>)}</select></label>
    <div className="form-row"><label>小节<input type="number" min="1" max={barCount(p)} required value={bar} onChange={e=>{setPositionChanged(true);setBar(Number(e.target.value));}}/></label><label>拍点<input type="number" min="1" max={beatsPerBar(p)+.9999} step="any" required value={beat} onChange={e=>{setPositionChanged(true);setBeat(Number(e.target.value));}}/></label></div>
    <label>结束时间（秒）<input type="number" min={Math.max(0,start)+.001} max={p.duration} step="any" required value={end} onChange={e=>setEnd(Number(e.target.value))}/></label>
    <div className="edit-preview"><span>{start.toFixed(3)} 秒</span><strong>{bassDegree(p,pitch)}</strong><small>相对于 {p.key} 的音阶级数</small></div>
    {error&&<p className="form-error">{error}</p>}<div className="form-actions">{event&&<button className="danger" type="button" onClick={()=>onDelete(event.id)}><Trash2 size={15}/>删除音名</button>}<button className="primary" type="submit"><Check size={16}/>保存音名</button></div>
  </form>;
}
