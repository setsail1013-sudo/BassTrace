import type { Project, ScoreStyle } from './music';
import { DEFAULT_SCORE_STYLE, readScoreStyle } from './score-style';

export function ScoreSettings({p,onChange,printOnly=false}:{p:Project;onChange:(style:ScoreStyle)=>void;printOnly?:boolean}) {
  const style=readScoreStyle(p);
  return <div className="score-appearance-controls">
    {!printOnly&&<label>歌词字号 <select aria-label="歌词字号" value={style.lyricFontSize} onChange={e=>onChange({...style,lyricFontSize:Number(e.target.value)})}>{Array.from({length:19},(_,i)=>14+i).map(n=><option key={n} value={n}>{n} px</option>)}</select></label>}
    <label>打印歌词 <select aria-label="打印歌词字号" value={style.lyricPrintSize} onChange={e=>onChange({...style,lyricPrintSize:Number(e.target.value)})}>{Array.from({length:11},(_,i)=>10+i).map(n=><option key={n} value={n}>{n} pt</option>)}</select></label>
    <label>纸张方向 <select aria-label="打印纸张方向" value={style.printOrientation} onChange={e=>onChange({...style,printOrientation:e.target.value as 'portrait'|'landscape'})}><option value="portrait">A4 纵向</option><option value="landscape">A4 横向</option></select></label>
    {!printOnly&&<><div className="score-palette">{(['lyrics','top','fill','mark'] as const).map((key,i)=><label key={key}>{['歌词','音名 / 和弦','加花','演奏标记'][i]}<input type="color" aria-label={`${['歌词','顶部音名','加花','演奏标记'][i]}颜色`} value={style.colors[key]} onChange={e=>onChange({...style,colors:{...style.colors,[key]:e.target.value}})}/></label>)}</div><button type="button" className="text-action" onClick={()=>onChange({...DEFAULT_SCORE_STYLE,colors:{...DEFAULT_SCORE_STYLE.colors}})}>恢复字号与默认配色</button></>}
    <label>打印配色 <select aria-label="打印配色" value={style.printColor?'color':'mono'} onChange={e=>onChange({...style,printColor:e.target.value==='color'})}><option value="color">彩色</option><option value="mono">黑白</option></select></label>
  </div>;
}
