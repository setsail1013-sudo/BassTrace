import { barCount, beatsPerBar, displaySections, formatTime, positionToTime, type Project } from './music';
import { rowTimePercent, scoreRows } from './tracks';
import { fillLayoutGroups, fillLayoutRows, layoutCompactFills } from './fill-layout';
import { layoutFillConnections } from './fill-techniques';
import { topEvents, topEventTime, topEventLabel } from './top-track';
import { readScoreStyle, scoreStyleVariables, scorePageCss } from './score-style';

const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

interface ExportEvent { id: string; start: number; end: number; fraction: number; markup: string; kind: 'chord' | 'fill' | 'lyric'; group?: string }
interface ExportRow { startBar: number; endBar: number; sectionId: string; events: ExportEvent[] }

/** A portable, read-only chart. Audio stays local and only user-written fills are included. */
export function exportThreeTrackHtml(p: Project, mode: 'chart' | 'structure' = 'chart'): string {
  const beats = beatsPerBar(p), count = barCount(p), sections = displaySections(p);
  const style = readScoreStyle(p), topLabel = p.topTrack === 'bass' ? '贝斯音名' : '和弦';
  const styleAttribute = Object.entries(scoreStyleVariables(p)).map(([key, value]) => `${key}:${value}`).join(';');
  const rows: ExportRow[] = scoreRows(p, 4).map(row => ({ ...row, events: [] }));
  const fillModel = JSON.stringify({ rows: fillLayoutRows(p, rows, 1), groups: fillLayoutGroups(p), manualFills: p.manualFills ?? [] }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const place = (start: number): { row: ExportRow; fraction: number } => {
    const row = rows.find(item => start >= (item.startBar === 1 ? 0 : positionToTime(p, item.startBar, 1)) - 1e-8 && start < Math.min(p.duration, positionToTime(p, item.endBar + 1, 1)) - 1e-8)
      ?? (start < 0 ? rows[0] : rows[rows.length - 1]);
    return { row, fraction: clamp(rowTimePercent(p, row.startBar, row.endBar, start) / 100, 0, 1) };
  };
  topEvents(p).forEach(chord => {
    const start = finite(topEventTime(p, chord));
    const { row, fraction } = place(start);
    row.events.push({ id: chord.id, start, end: Math.max(start, finite(chord.end ?? start)), fraction, kind: 'chord', markup: `<span class="chord-name">${escapeHtml(chord.label)}</span><small class="degree">${escapeHtml(topEventLabel(p, chord, true))}</small>` });
  });
  (p.manualFills ?? []).forEach(group => group.notes.forEach(note => {
    const start = finite(note.start), end = Math.max(start, finite(note.end, start));
    const { row, fraction } = place(start);
    const octave = clamp(Math.round(finite(note.octave)), -2, 2), lines = clamp(Math.round(finite(note.lines)), 0, 2);
    const dots = '•'.repeat(Math.abs(octave));
    const notation = note.digit === 0 ? null : note.notation;
    row.events.push({ id: note.id, start, end, fraction, kind: 'fill', group: group.id, markup: `<span class="fill-symbol lines-${lines}" data-digit="${escapeHtml(note.digit)}" data-lines="${lines}" data-octave="${octave}"><span class="connection-space" aria-hidden="true"></span><span class="technique-marks"><span${notation?.cut ? ' title="切音"' : ''}>${notation?.cut ? '切' : ''}</span><span${notation?.accent ? ' title="重音"' : ''}>${notation?.accent ? '&gt;' : ''}</span></span><span class="octave above">${note.digit !== 0 && !notation?.dead && octave > 0 ? dots : ''}</span><span class="digit${notation?.dead ? ' dead' : ''}"${notation?.dead ? ' title="闷音 / 死音"' : ''}>${notation?.dead ? '×' : escapeHtml(note.digit)}</span><span class="rhythm">${'<i></i>'.repeat(lines)}</span><span class="octave below">${note.digit !== 0 && !notation?.dead && octave < 0 ? dots : ''}</span></span>` });
  }));
  p.lyrics.forEach(lyric => {
    const start = finite(lyric.start), end = Math.max(start, finite(lyric.end, start));
    const { row, fraction } = place(start);
    row.events.push({ id: lyric.id, start, end, fraction, kind: 'lyric', markup: `<span class="lyric-text">${escapeHtml(lyric.text)}</span>` });
  });
  const eventHtml = (event: ExportEvent): string => `<button type="button" class="event ${event.kind}" data-id="${escapeHtml(event.id)}"${event.group !== undefined ? ` data-group="${escapeHtml(event.group)}"` : ''} data-time="${event.start}" data-start="${event.start}" data-end="${event.end}" data-anchor="${event.fraction}" title="${escapeHtml(formatTime(event.start))}" style="left:${event.fraction * 100}%">${event.markup}</button>`;
  let body: string;
  if (mode === 'structure') {
    body = `<div class="structure">${sections.map(section => `<button type="button" class="section-card" data-time="${finite(positionToTime(p, section.startBar, 1))}"><strong>${escapeHtml(section.name)}</strong><span>${section.startBar}–${section.endBar} 小节 · ${section.endBar - section.startBar + 1} 小节</span></button>`).join('')}</div>`;
  } else {
    body = sections.map((section, index) => `<section class="song-section"><h2><span>${String(index + 1).padStart(2, '0')}</span>${escapeHtml(section.name)}<small>${section.endBar - section.startBar + 1} 小节</small></h2>${rows.filter(row => row.sectionId === section.id).map(row => {
      const bars = row.endBar - row.startBar + 1;
      const rulers = Array.from({ length: bars }, (_, i) => {
        const bar = row.startBar + i;
        const left = i === 0 ? 0 : rowTimePercent(p, row.startBar, row.endBar, positionToTime(p, bar, 1));
        const right = i === bars - 1 ? 100 : rowTimePercent(p, row.startBar, row.endBar, positionToTime(p, bar + 1, 1));
        const labels = Array.from({ length: beats }, (_, beat) => {
          const percent = rowTimePercent(p, row.startBar, row.endBar, positionToTime(p, bar, beat + 1));
          return percent >= -1e-8 && percent < 100 - 1e-8 && right > left ? `<span style="left:${(percent - left) / (right - left) * 100}%">${beat + 1}</span>` : '';
        }).join('');
        return `<div class="bar-ruler" data-bar="${bar}" data-start="${finite(positionToTime(p, bar, 1))}" data-end="${finite(positionToTime(p, bar + 1, 1))}" style="left:${left}%;width:${right - left}%"><b>${String(bar).padStart(2, '0')}</b>${labels}</div>`;
      }).join('');
      const grid = Array.from({ length: bars - 1 }, (_, i) => `<i class="bar-line" style="left:${rowTimePercent(p, row.startBar, row.endBar, positionToTime(p, row.startBar + i + 1, 1))}%"></i>`).join('');
      const tracks = (['chord', 'fill', 'lyric'] as const).map(kind => `<div class="track ${kind}-track"><header>${({ chord: topLabel, fill: '加花', lyric: '歌词' })[kind]}</header><div class="track-events" data-kind="${kind}">${row.events.filter(event => event.kind === kind).map(eventHtml).join('')}</div></div>`).join('');
      return `<article class="score-row" data-first-bar="${row.startBar}" data-last-bar="${row.endBar}" style="--bar-count:${bars}"><div class="row-grid" aria-hidden="true">${grid}</div><div class="ruler">${rulers}</div>${tracks}</article>`;
    }).join('')}</section>`).join('');
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(p.title)} · BassChart Studio</title><style>${styles}${compactStyles}</style><style id="pageStyle">${scorePageCss(p)}</style></head><body><main class="page${style.printColor ? '' : ' score-print-mono'}" style="${escapeHtml(styleAttribute)}"><div class="controls"><div class="control-actions"><label class="file-choice">选择本地音频<input id="audioFile" type="file" accept="audio/*"></label>${mode === 'chart' ? '<label class="degree-choice"><input id="degrees" type="checkbox">显示级数</label>' : ''}<label class="degree-choice"><input id="printColor" type="checkbox"${style.printColor ? ' checked' : ''}>彩色打印</label><label class="degree-choice">纸张<select id="printOrientation" aria-label="打印纸张方向"><option value="portrait"${style.printOrientation === 'portrait' ? ' selected' : ''}>A4 纵向</option><option value="landscape"${style.printOrientation === 'landscape' ? ' selected' : ''}>A4 横向</option></select></label><button type="button" id="printChart">打印 / 存为 PDF</button></div><audio id="player" controls preload="metadata"></audio><p id="audioHint">选择本地音频后，可点击谱面定位试听。</p></div><header class="sheet-header"><div><h1>${escapeHtml(p.title)}</h1>${p.artist ? `<p>${escapeHtml(p.artist)}</p>` : ''}</div><p class="song-meta"><strong>${escapeHtml(p.key)}</strong><span>♩ = ${escapeHtml(p.bpm)} · ${escapeHtml(p.meter)} · ${count} 小节</span></p></header>${body}<footer>BassChart Studio · ${mode === 'chart' ? `${topLabel} / 手写加花 / 歌词` : '歌曲结构总览'}</footer></main><noscript><style>.event{position:static!important;display:inline-flex;margin:6px;max-width:100%}.event::before{display:none}.track-events{height:auto!important;display:flex;flex-wrap:wrap;align-items:start}.row-grid{display:none}</style></noscript><script>const fillModel=${fillModel};const layoutFills=${layoutCompactFills.toString()};const layoutConnections=${layoutFillConnections.toString()};${script}</script></body></html>`;
}

const styles = String.raw`
*{box-sizing:border-box}html{color-scheme:light}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}.page{max-width:1120px;padding:32px 36px;margin:auto}button,input{font:inherit}button{color:inherit;cursor:pointer}button:focus-visible,.file-choice:focus-within{outline:2px solid #007aff;outline-offset:4px}.controls{position:sticky;top:0;z-index:10;background:rgba(245,245,247,.96);padding:12px 0;border-bottom:1px solid #d2d2d7}.control-actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.control-actions>button,.file-choice{border:1px solid #d2d2d7;border-radius:8px;background:white;padding:8px 12px;cursor:pointer;font-size:13px}.file-choice input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.degree-choice{display:flex;align-items:center;gap:6px;font-size:13px}audio{display:block;width:100%;height:38px;margin-top:10px}.controls p{font-size:12px;color:#6e6e73;margin:6px 0 0}.sheet-header{display:flex;justify-content:space-between;gap:24px;border-bottom:1px solid #d2d2d7;padding:32px 0 24px;margin-bottom:24px}h1{font-size:28px;line-height:1.3;margin:0;overflow-wrap:anywhere}.sheet-header p{margin:8px 0 0;color:#6e6e73;font-size:13px}.song-meta{text-align:right;white-space:nowrap}.song-meta strong{display:block;color:#1d1d1f;font-size:20px;margin-bottom:8px}.song-meta span{display:block}.song-section h2{display:flex;gap:12px;align-items:center;font-size:17px;font-weight:600;margin:28px 0 14px;break-after:avoid}.song-section h2>span{padding:5px 8px;background:#e9e9ee;border-radius:7px;font-size:12px;font-weight:400}.song-section h2>small{font-size:12px;color:#86868b;font-weight:400}.score-row{position:relative;background:white;border:1px solid #d2d2d7;margin:0 0 12px;padding:0 10px 10px;break-inside:avoid;page-break-inside:avoid}.row-grid{position:absolute;inset:0 10px 0;pointer-events:none}.bar-line{position:absolute;top:0;bottom:0;border-left:1px solid #e5e5ea}.ruler{position:relative;height:34px}.bar-ruler{position:absolute;min-width:0;font-size:10px;color:#86868b;height:34px}.bar-ruler b{position:absolute;top:7px;left:6px;font-weight:400;line-height:1}.bar-ruler span{position:absolute;top:20px;padding-left:6px;font-size:9px;line-height:1}.bar-ruler.active{background:#007aff0d}.track{position:relative;padding:4px 0 5px}.track>header{font-size:9px;color:#a1a1a6;margin:0 0 9px 6px;line-height:1}.track+.track{border-top:1px solid #f0f0f2}.track-events{position:relative;min-height:32px;contain:layout}.event{position:absolute;top:0;left:0;margin:0;padding:0 4px;border:0;background:transparent;max-width:100%;width:max-content;text-align:left;line-height:1.5;border-radius:3px;white-space:normal;overflow-wrap:anywhere;cursor:pointer}.event::before{content:"";position:absolute;top:-5px;left:var(--anchor-shift,0px);width:1px;height:4px;background:#86868b}.event.playing{background:#007aff12}.chord{font-size:19px;font-weight:650;line-height:1.25}.chord .degree{display:none;font-size:11px;font-weight:400;color:#6e6e73;margin-top:4px}.show-degrees .chord .degree{display:block}.lyric{padding:0;font-size:14px;white-space:pre-wrap;line-height:1.8}.fill{font-size:21px;line-height:1;min-width:18px;text-align:center;padding:0 2px}.fill-symbol{display:grid;grid-template-rows:7px 23px auto 7px;justify-items:center;min-width:14px}.digit{font-weight:500}.octave{font:11px/7px Arial,sans-serif;letter-spacing:0;white-space:nowrap}.rhythm{width:14px;display:flex;flex-direction:column;gap:2px;padding-top:1px}.rhythm i{display:block;width:100%;height:0;border-top:1px solid currentColor}.below{margin-top:2px}.fill .below:empty{margin-top:0}.structure{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.section-card{padding:18px;border:1px solid #d2d2d7;border-radius:8px;background:white;text-align:left;break-inside:avoid}.section-card span{display:block;color:#6e6e73;font-size:12px;margin-top:6px}footer{text-align:center;color:#86868b;font-size:10px;border-top:1px solid #e5e5ea;padding-top:14px;margin-top:20px}
@media(max-width:650px){.page{padding:16px 12px}.sheet-header{padding:24px 0 18px;gap:12px}h1{font-size:22px}.song-meta strong{font-size:17px}.song-meta span{font-size:11px}.chord{font-size:16px}.lyric{font-size:13px}.fill{font-size:19px}.structure{grid-template-columns:1fr}.score-row{padding-left:6px;padding-right:6px}.row-grid{left:6px;right:6px}.control-actions{gap:8px}.control-actions>button,.file-choice{padding:7px 9px}.degree-choice{font-size:12px}}
@media print{@page{margin:12mm}body{background:white;color:black;font-size:12px}.page{max-width:none;width:100%;padding:0}.controls{display:none}.sheet-header{padding:0 0 16px;margin-bottom:18px}h1{font-size:23px}.sheet-header p,.song-meta span,.song-meta strong,.song-section h2>small,footer{color:black}.song-section h2{font-size:14px;margin-top:20px}.song-section h2>span{background:none;border:1px solid #aaa}.score-row{margin-bottom:9px;border-color:#888;break-inside:avoid;page-break-inside:avoid}.bar-line{border-color:#ddd}.track+.track{border-color:#ddd}.track>header,.bar-ruler{color:#555}.event{color:black}.event::before{background:black}.chord{font-size:16px}.chord .degree{color:black}.lyric{font-size:12px}.fill{font-size:14px;min-width:9px;padding:0}.fill-symbol{min-width:9px;grid-template-rows:7px 16px auto 7px}.rhythm{width:100%}.event.playing,.bar-ruler.active{background:none}.section-card{border-color:#888;color:black}.section-card span{color:black}}
`;

// Deliberately self-contained: this document must also run from a file:// URL offline.
const script = String.raw`
(()=>{const player=document.getElementById('player');let audioUrl;
function layoutTrack(track){
  const width=track.clientWidth;if(!width)return;
  const events=Array.from(track.querySelectorAll('.event'));const lanes=[];const placements=[];
  events.sort((a,b)=>Number(a.dataset.anchor)-Number(b.dataset.anchor));
  events.forEach(event=>{
    event.style.width='max-content';event.style.maxWidth=width+'px';event.style.top='0px';
    const anchor=Math.max(0,Math.min(width,Number(event.dataset.anchor)*width));
    const measured=Math.min(width,event.getBoundingClientRect().width);const left=Math.max(0,Math.min(anchor,width-measured));
    event.style.width=measured+'px';event.style.left=left+'px';event.style.setProperty('--anchor-shift',(anchor-left)+'px');
    const height=event.getBoundingClientRect().height;const right=left+measured;
    const gap=track.dataset.kind==='lyric'?0:track.dataset.kind==='fill'?1:7;
    let lane=lanes.findIndex(items=>items.every(prior=>right+gap<=prior.left+.5||left+.5>=prior.right+gap));
    if(lane<0){lane=lanes.length;lanes.push([])}lanes[lane].push({left,right,height});placements.push({event,lane,height});
  });
  let top=0;const tops=lanes.map(items=>{const result=top;top+=Math.max(...items.map(item=>item.height))+11;return result});
  placements.forEach(item=>{item.event.style.top=tops[item.lane]+'px';item.event.dataset.lane=String(item.lane)});
  track.style.height=Math.max(track.dataset.kind==='fill'?39:29,top?top-5:0)+'px';
}
const fillNodes=new Map(Array.from(document.querySelectorAll('.event.fill')).map(node=>[node.dataset.id,node]));
function measureFills(){
  const rowNodes=new Map(Array.from(document.querySelectorAll('.score-row')).map(row=>[Number(row.dataset.firstBar),row]));
  const printing=window.matchMedia('print').matches;
  const rows=fillModel.rows.map(row=>({...row,width:Math.max(1,rowNodes.get(row.id)?.querySelector('.fill-track .track-events')?.clientWidth||650)}));
  const result=layoutFills(rows,fillModel.groups,printing?14:window.innerWidth<=650?16:19,12);
  result.items.forEach(at=>{
    const node=fillNodes.get(at.id),track=rowNodes.get(at.row)?.querySelector('.fill-track .track-events');if(!node||!track)return;
    if(node.parentElement!==track)track.appendChild(node);
    Object.assign(node.style,{left:at.left+'px',top:at.top+'px',width:at.width+'px',maxWidth:at.width+'px',fontSize:at.fontSize+'px'});
    node.dataset.compact=String(at.compact);node.dataset.rangeLeft=String(at.rangeLeft);node.dataset.rangeRight=String(at.rangeRight);
  });
  Object.entries(result.heights).forEach(([id,height])=>{const track=rowNodes.get(Number(id))?.querySelector('.fill-track .track-events');if(track)track.style.height=height+'px'});
  document.querySelectorAll('.fill-connections').forEach(node=>node.remove());
  const paths=layoutConnections(result.items,fillModel.manualFills);
  for(const [id,row] of rowNodes){
    const track=row.querySelector('.fill-track .track-events'),connections=paths.filter(path=>path.row===id);if(!track||!connections.length)continue;
    const namespace='http://www.w3.org/2000/svg',svg=document.createElementNS(namespace,'svg');svg.classList.add('fill-connections');svg.setAttribute('aria-hidden','true');
    connections.forEach(connection=>{
      const path=document.createElementNS(namespace,'path');path.setAttribute('d',connection.path);path.setAttribute('data-connection',connection.kind);svg.appendChild(path);
      if(connection.label){const label=document.createElementNS(namespace,'text');label.setAttribute('x',connection.labelX);label.setAttribute('y',connection.labelY);label.textContent=connection.label;svg.appendChild(label)}
    });track.appendChild(svg);
  }
}
function measureChart(){document.querySelectorAll('.track-events:not([data-kind="fill"])').forEach(layoutTrack);measureFills()}
let scheduled=false;function scheduleLayout(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;measureChart()})}
measureChart();window.addEventListener('resize',scheduleLayout);window.addEventListener('beforeprint',measureChart);window.addEventListener('afterprint',measureChart);window.matchMedia('print').addEventListener('change',measureChart);if(document.fonts)document.fonts.ready.then(measureChart);if(window.ResizeObserver){const observer=new ResizeObserver(scheduleLayout);document.querySelectorAll('.score-row').forEach(row=>observer.observe(row))}
const degrees=document.getElementById('degrees');if(degrees)degrees.addEventListener('change',()=>{document.body.classList.toggle('show-degrees',degrees.checked);measureChart()});
document.getElementById('printColor').addEventListener('change',event=>{document.querySelector('.page').classList.toggle('score-print-mono',!event.target.checked)});
document.getElementById('printOrientation').addEventListener('change',event=>{const landscape=event.target.value==='landscape';document.querySelector('.page').style.setProperty('--score-page-width',landscape?'273mm':'186mm');document.getElementById('pageStyle').textContent='@page{size:A4 '+(landscape?'landscape':'portrait')+';margin:12mm}';measureChart()});
document.getElementById('printChart').addEventListener('click',()=>{measureChart();window.print()});
document.getElementById('audioFile').addEventListener('change',event=>{const file=event.target.files&&event.target.files[0];if(!file)return;if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=URL.createObjectURL(file);player.src=audioUrl;document.getElementById('audioHint').textContent='音频已载入，可点击音名、和弦、加花或歌词定位试听。'});
document.addEventListener('click',event=>{const target=event.target instanceof Element?event.target.closest('[data-time]'):null;if(!target||!player.src)return;const time=Math.max(0,Number(target.dataset.time));player.currentTime=Number.isFinite(player.duration)?Math.min(time,player.duration):time;player.play().catch(()=>{})});
player.addEventListener('timeupdate',()=>{const time=player.currentTime;document.querySelectorAll('.bar-ruler').forEach(bar=>bar.classList.toggle('active',time>=Number(bar.dataset.start)&&time<Number(bar.dataset.end)));document.querySelectorAll('.event').forEach(event=>event.classList.toggle('playing',time>=Number(event.dataset.start)&&time<Math.max(Number(event.dataset.end),Number(event.dataset.start)+.15)))});
window.addEventListener('pagehide',()=>{if(audioUrl)URL.revokeObjectURL(audioUrl)});
})();
`;

const compactStyles = `
.page .event.chord,.page .chord .degree{color:var(--score-top,#1D4ED8)}
.page .event.lyric{font-size:var(--lyric-font,20px);color:var(--score-lyrics,#1D1D1F)}
.page .event.fill{color:var(--score-fill,#167047);padding:0;min-width:0}
.fill::before{display:none}.fill .fill-symbol{min-width:0;width:100%;grid-template-rows:12px 22px 9px 1.1em 6px 9px}
.fill .rhythm{width:100%;height:6px;align-self:start}.fill .digit{font-size:inherit}
.technique-marks{display:flex;flex-direction:column;align-items:center;white-space:nowrap;font:10px/11px sans-serif}.technique-marks>span{height:11px}
.page .technique-marks,.page .digit.dead,.page .fill-connections{color:var(--score-mark,#C62828)}
.fill-connections{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:2}
.fill-connections path{fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}
.fill-connections text{fill:currentColor;font:9px sans-serif;text-anchor:middle;paint-order:stroke;stroke:white;stroke-width:2px;stroke-linejoin:round}
.show-degrees .chord .chord-name{display:none}.show-degrees .page .chord .degree{display:block;font-size:inherit;font-weight:inherit;margin:0}
@media print{
  .page,.page *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{width:var(--score-page-width,186mm);max-width:none}
  .page .event.lyric{font-size:var(--lyric-print-font,12pt)}
  .page.score-print-mono{--score-lyrics:#000!important;--score-top:#000!important;--score-fill:#000!important;--score-mark:#000!important}
}
`;
