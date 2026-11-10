import type { Project, ScoreStyle } from './music';
import { DEFAULT_SCORE_STYLE, readScoreStyle } from './score-style';

export function ScoreSettings({p,onChange,printOnly=false}:{p:Project;onChange:(style:ScoreStyle)=>void;printOnly?:boolean}) {
  const style=readScoreStyle(p);
  const print=(change:Partial<ScoreStyle>)=>onChange({...style,...change,printPreset:'custom'});
  return <div className="score-appearance-controls">
    <label>PDF 排版<select aria-label="PDF 排版预设" value={style.printPreset} onChange={e=>e.target.value==='large'?onChange({...style,printPreset:'large',printOrientation:'landscape',topPrintSize:22,lyricPrintSize:18,fillPrintSize:16,printBarsPerRow:4}):print({})}><option value="large">大字紧凑</option><option value="custom">自定义</option></select></label>
    {!printOnly&&<label>歌词字号 <select aria-label="歌词字号" value={style.lyricFontSize} onChange={e=>onChange({...style,lyricFontSize:Number(e.target.value)})}>{Array.from({length:19},(_,i)=>14+i).map(n=><option key={n} value={n}>{n} px</option>)}</select></label>}
    {([{key:'topPrintSize',label:'打印音名 / 和弦',min:16,max:36},{key:'lyricPrintSize',label:'打印歌词',min:12,max:30},{key:'fillPrintSize',label:'打印加花',min:12,max:24}] as const).map(({key,label,min,max})=><label key={key}>{label}<select aria-label={label+'字号'} value={style[key]} onChange={e=>print({[key]:Number(e.target.value)})}>{Array.from({length:max-min+1},(_,i)=>min+i).map(n=><option key={n} value={n}>{n} pt</option>)}</select></label>)}
    <label>纸张方向<select aria-label="打印纸张方向" value={style.printOrientation} onChange={e=>print({printOrientation:e.target.value as 'portrait'|'landscape',printBarsPerRow:e.target.value==='portrait'?2:4})}><option value="portrait">A4 纵向</option><option value="landscape">A4 横向</option></select></label>
    <label>打印每行<select aria-label="打印每行小节数" value={style.printBarsPerRow} onChange={e=>print({printBarsPerRow:Number(e.target.value) as 2|4})}><option value="2">2 小节</option><option value="4">4 小节</option></select></label>
    {!printOnly&&<><div className="score-palette">{(['lyrics','top','fill','mark'] as const).map((key,i)=><label key={key}>{['歌词','音名 / 和弦','加花','演奏标记'][i]}<input type="color" aria-label={`${['歌词','顶部音名','加花','演奏标记'][i]}颜色`} value={style.colors[key]} onChange={e=>onChange({...style,colors:{...style.colors,[key]:e.target.value}})}/></label>)}</div><button type="button" className="text-action" onClick={()=>onChange({...DEFAULT_SCORE_STYLE,colors:{...DEFAULT_SCORE_STYLE.colors}})}>恢复字号与默认配色</button></>}
    <label>打印配色 <select aria-label="打印配色" value={style.printColor?'color':'mono'} onChange={e=>onChange({...style,printColor:e.target.value==='color'})}><option value="color">彩色</option><option value="mono">黑白</option></select></label>
  </div>;
}
