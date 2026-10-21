import { beatsPerBar, exportHtml, positionToTime, timeToPosition } from './music';
import type { Project } from './music';
import { numberFragments, numberLabel, numberPitch, noteRhythm } from './notation';

const escape=(value:string)=>value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
/** Optional number-score export; the default lyrics-and-chords chart uses exportHtml directly. */
export function exportNumberHtml(p:Project,mode:'chart'|'tab'|'structure',regions=true,printRegions=false):string{
  let html=exportHtml(p,mode);
  if(mode!=='chart')return html;
  html=html.replace(/(<article class="bar" data-start="([^"]+)" data-end="([^"]+)">[\s\S]*?)(<div class="lyrics">)/g,(_,before:string,from:string,to:string,after:string)=>{
    const start=Number(from),end=Number(to),bar=timeToPosition(p,start).bar,size=beatsPerBar(p);
    const fragments=numberFragments(p,start,end);
    const numbers=fragments.map(fragment=>{
      const note=fragment.note,at=timeToPosition(p,fragment.start),pitch=numberPitch(note.midi,p.key),rhythm=noteRhythm(p,note);
      const left=(at.beat-1)/size*100,finish=(timeToPosition(p,fragment.end).bar-bar)*100+(timeToPosition(p,fragment.end).beat-1)/size*100;
      const octaves=note.notation?.rest||note.notation?.dead?'':'·'.repeat(Math.min(4,Math.abs(pitch.octave)));
      const glyph=fragment.continued&&!note.notation?.rest?'—':numberLabel(p,note);
      const background=regions&&!note.notation?.rest?`<i class="portable-region" style="left:${left}%;width:${Math.max(0,Math.min(100,finish)-left)}%"></i>`:'';
      return `${background}<button class="portable-note" data-id="${escape(note.id)}" data-label="${escape(glyph)}" data-beat="${at.beat}" data-time="${fragment.start}" style="left:${left}%" title="${note.start.toFixed(3)} 秒 · ${note.duration.toFixed(3)} 秒"><span class="portable-octave">${pitch.octave>0?octaves:''}</span><span>${escape(glyph)}${rhythm.dotted?'·':''}</span><span class="portable-lines">${'<i></i>'.repeat(rhythm.lines)}</span><span class="portable-octave">${pitch.octave<0?octaves:''}</span>${note.notation?.tie||fragment.continues?'<span class="portable-tie">⌒</span>':''}${note.notation?.slur?'<span class="portable-tie">︵</span>':''}</button>`;
    }).join('');
    return `${before}<div class="portable-number" data-beats="${size}" aria-label="数字贝斯音符">${numbers}</div>${after}`;
  });
  const css='.portable-number{position:relative;min-height:64px;border-bottom:1px solid #ded2bf;margin:8px 0}.portable-note{position:absolute;font:700 18px/1.2 Consolas,monospace;display:flex;align-items:center;flex-direction:column;padding:0;color:#79583d;white-space:normal;overflow-wrap:anywhere}.portable-note:before{content:"";position:absolute;left:var(--chord-anchor,0px);top:0;width:1px;height:3px;background:#af8f6e}.portable-octave{font-size:14px;height:7px;line-height:7px}.portable-lines{display:flex;flex-direction:column;gap:2px;width:100%}.portable-lines i{height:0;border-top:1px solid currentColor;width:100%}.portable-region{position:absolute;top:15px;bottom:9px;background:rgba(203,152,111,.15);pointer-events:none}.portable-tie{font-size:12px;line-height:10px}@media print{.portable-region{print-color-adjust:exact;-webkit-print-color-adjust:exact}.portable-note{color:#000;font-size:12px}.portable-octave{font-size:9px}}';
  html=html.replace('</style>',`${css}</style>`);
  if(!printRegions)html=html.replace('</style>','@media print{.portable-region{display:none}}</style>');
  const script=`function measureNumbers(){document.querySelectorAll('.portable-number').forEach(container=>{const elements=[...container.querySelectorAll('.portable-note')],byId=new Map(elements.map(item=>[item.dataset.id,item])),widths=new Map();elements.forEach(item=>{item.style.width='max-content';widths.set(item.dataset.label,Math.max(widths.get(item.dataset.label)||0,item.getBoundingClientRect().width+4));});const base=Math.max(1,window.matchMedia('print').matches?Math.min(240,container.clientWidth):container.clientWidth);const layout=layoutChordLabels(elements.map(item=>({id:item.dataset.id,label:item.dataset.label,beat:Number(item.dataset.beat)})),Number(container.dataset.beats),base,label=>widths.get(label)||0),heights=[];layout.items.forEach(item=>{const el=byId.get(item.id);el.style.left=item.left/base*100+'%';el.style.width=item.width/base*100+'%';el.style.setProperty('--chord-anchor',(item.anchor-item.left)/Math.max(1,item.width)*100+'%');heights[item.row]=Math.max(heights[item.row]||0,el.getBoundingClientRect().height);});const tops=[];let total=4;heights.forEach((height,row)=>{tops[row]=total;total+=height+8;});layout.items.forEach(item=>byId.get(item.id).style.top=tops[item.row]+'px');container.style.height=Math.max(64,total)+'px';});}measureNumbers();window.addEventListener('resize',measureNumbers);window.addEventListener('beforeprint',measureNumbers);window.addEventListener('afterprint',measureNumbers);window.matchMedia('print').addEventListener('change',measureNumbers);document.fonts.ready.then(measureNumbers);`;
  return html.replace('</script>',`${script}</script>`);
}
