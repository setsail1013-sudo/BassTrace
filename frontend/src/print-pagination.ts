/** Serialized into the portable score. Keep this function free of module dependencies. */
export function paginateScore() {
  if (document.querySelector('.print-pages')) return;
  const source = document.querySelector<HTMLElement>('.page');
  if (!source) return;
  const landscape = (document.getElementById('printOrientation') as HTMLSelectElement)?.value !== 'portrait';
  const height = (landscape ? 186 : 273) * 96 / 25.4;
  const width = (landscape ? 273 : 186) * 96 / 25.4;
  const pages = document.createElement('div'); pages.className = 'print-pages';
  pages.style.cssText = source.style.cssText;
  // Continuation headers must be measurable before print-paginated hides the
  // source. The stylesheet otherwise keeps this container display:none.
  pages.style.display = 'block';
  if (source.classList.contains('score-print-mono')) pages.classList.add('score-print-mono');
  document.body.append(pages);
  let page: HTMLElement, used = 0, pageNumber = 0, continuationHeight = 0;
  const capacity = height - 24;
  function newPage() {
    page = document.createElement('section');page.className='print-page page';
    page.style.width=width+'px';page.style.height=height+'px';
    page.style.setProperty('--print-page-height',height+'px');
    if(source!.classList.contains('score-print-mono'))page.classList.add('score-print-mono');
    pages.append(page);used=0;
    const footer=document.createElement('div');footer.className='print-page-number';footer.textContent=String(++pageNumber);page.append(footer);
    if(pageNumber>1){
      const template=document.querySelector<HTMLTemplateElement>('#continuationHeader');
      const header=template?.content.firstElementChild?.cloneNode(true) as HTMLElement|undefined;
      if(header){page.append(header);continuationHeight=header.getBoundingClientRect().height+10;used=continuationHeight;}
    }
  }
  function append(node:HTMLElement,h:number,gap=6) {node.style.margin='0 0 '+gap+'px';page.append(node);used+=h+gap;}
  newPage();
  const heading=source.querySelector<HTMLElement>('.sheet-header');
  if(heading)append(heading.cloneNode(true) as HTMLElement,heading.getBoundingClientRect().height,10);
  // A hidden workbench keeps measurements identical to the final physical page.
  const bench=document.createElement('div');bench.className='page print-workbench';bench.style.cssText=source.style.cssText;
  Object.assign(bench.style,{position:'absolute',left:'-20000px',top:'0',width:width+'px',visibility:'hidden'});document.body.append(bench);
  // Long performance notes flow by measured text lines, without clipping or
  // repeating hidden text in the generated PDF's selectable text layer.
  for(const original of source.querySelectorAll<HTMLElement>('.performance-export-notes .performance-note')){
    const note=original.cloneNode(true) as HTMLElement;note.style.margin='0';bench.append(note);
    const h=note.getBoundingClientRect().height;
    if(h<=capacity-80){if(used+h+7>capacity)newPage();append(note,h,7);continue;}
    const lines=new Map<number,string>(),walker=document.createTreeWalker(note,NodeFilter.SHOW_TEXT);
    let node:Node|null;
    while((node=walker.nextNode())){let offset=0;for(const char of node.textContent??''){
      const range=document.createRange();range.setStart(node,offset);offset+=char.length;range.setEnd(node,offset);
      const y=Math.round(range.getBoundingClientRect().top*10)/10;lines.set(y,(lines.get(y)??'')+char);
    }}
    const lineHeight=parseFloat(getComputedStyle(note).lineHeight);
    let first=true;
    for(const text of lines.values()){
      if(used+lineHeight+2>capacity)newPage();
      const line=note.cloneNode(false) as HTMLElement;
      const label=first?note.querySelector('b')?.textContent??'':'';
      if(label&&text.startsWith(label)){const strong=document.createElement('b');strong.textContent=label;line.append(strong,document.createTextNode(text.slice(label.length)));}
      else line.textContent=text;
      line.style.whiteSpace='pre';line.style.height=lineHeight+'px';append(line,lineHeight,0);first=false;
    }
    used+=7;note.remove();
  }
  function lineFragments(row:HTMLElement) {
    for(const lyric of row.querySelectorAll<HTMLElement>('.event.lyric')) {
      if(lyric.getBoundingClientRect().height<capacity-60)continue;
      const walker=document.createTreeWalker(lyric,NodeFilter.SHOW_TEXT), lines=new Map<number,{parts:Array<{text:string;mark:HTMLElement|null}>;left:number;top:number}>();
      const base=lyric.getBoundingClientRect();let textNode:Node|null;
      while((textNode=walker.nextNode())) {
        const text=textNode.textContent??'';let offset=0;
        for(const char of text) {
          const range=document.createRange();range.setStart(textNode,offset);offset+=char.length;range.setEnd(textNode,offset);
          const rect=range.getBoundingClientRect();if(!rect.height)continue;
          const y=Math.round(rect.top*10)/10;
          const line=lines.get(y)??{parts:[],left:rect.left-base.left,top:rect.top-base.top};
          const mark=textNode.parentElement?.closest<HTMLElement>('.lyric-change-mark')??null;
          const last=line.parts.at(-1);if(last&&last.mark===mark)last.text+=char;else line.parts.push({text:char,mark});lines.set(y,line);
        }
      }
      const font=getComputedStyle(lyric),lineHeight=parseFloat(font.lineHeight)||parseFloat(font.fontSize)*1.8;
      for(const line of lines.values()) {
        const fragment=lyric.cloneNode(false) as HTMLElement;
        for(const part of line.parts){if(part.mark){const mark=part.mark.cloneNode(false) as HTMLElement;mark.textContent=part.text;fragment.append(mark);}else fragment.append(document.createTextNode(part.text));}
        fragment.dataset.fragment='true';fragment.style.left=(parseFloat(lyric.style.left)+line.left)+'px';
        fragment.style.top=(parseFloat(lyric.style.top)+line.top)+'px';fragment.style.whiteSpace='pre';
        fragment.style.height=lineHeight+'px';fragment.style.lineHeight=lineHeight+'px';fragment.style.padding='0';
        lyric.parentElement!.append(fragment);
      }
      lyric.remove();
    }
  }
  function addRow(original:HTMLElement) {
    const row=original.cloneNode(true) as HTMLElement;row.style.margin='0';bench.append(row);
    const h=row.getBoundingClientRect().height;
    if(h<=capacity-80) {if(used+h+6>capacity)newPage();append(row,h);return;}
    lineFragments(row);
    const bounds=row.getBoundingClientRect(),ruler=row.querySelector<HTMLElement>('.ruler');
    const rulerHeight=ruler?.getBoundingClientRect().height??28;
    const intervals=[...row.querySelectorAll<HTMLElement>('.event,.ruler')].map(el=>{
      const r=el.getBoundingClientRect(),pad=el.dataset.fragment?0:1;return {start:r.top-bounds.top-pad,end:r.bottom-bounds.top+pad};
    });
    let from=0;
    while(from<h-.5) {
      const repeat=from>0?rulerHeight:0;
      if(capacity-used-repeat<80)newPage();
      let cut=Math.min(h,from+capacity-used-repeat-8);
      for(let i=0;i<intervals.length+1;i++) {const cross=intervals.filter(r=>r.start<cut-.1&&r.end>cut+.1);if(!cross.length)break;cut=Math.min(...cross.map(r=>r.start));}
      if(cut<=from+1){if(used>continuationHeight){newPage();continue;}throw Error('谱行内容过高，请减小打印字号或每行小节数。');}
      const fragment=document.createElement('div');fragment.className='print-row-fragment';
      if(repeat&&ruler){const repeated=ruler.cloneNode(true) as HTMLElement;repeated.setAttribute('aria-label','小节续排');fragment.append(repeated);}
      const clip=document.createElement('div');clip.className='print-row-clip';clip.style.height=(cut-from)+'px';
      const copy=row.cloneNode(true) as HTMLElement;
      // Remove clipped text as well as hiding it: PDF extraction/search must not
      // repeat every off-page lyric and digit in each continuation fragment.
      const selector='.event,.ruler,.fill-connections path,.fill-connections text';
      const originals=[...row.querySelectorAll(selector)],clones=[...copy.querySelectorAll(selector)];
      originals.forEach((node,index)=>{
        const r=node.getBoundingClientRect();
        if(r.bottom-bounds.top<=from+.1 || r.top-bounds.top>=cut-.1) {
          // Keep the ruler's block height; removing it would shift all absolute
          // track contents upwards and clip the first line on continuation pages.
          if(node.classList.contains('ruler'))clones[index]?.replaceChildren();else clones[index]?.remove();
        }
      });
      Object.assign(copy.style,{position:'absolute',width:'100%',height:h+'px',left:'0',top:-from+'px'});clip.append(copy);fragment.append(clip);
      append(fragment,cut-from+repeat);from=cut;if(from<h-.5)newPage();
    }
    row.remove();
  }
  for(const section of source.querySelectorAll<HTMLElement>('.song-section')) {
    const title=section.querySelector<HTMLElement>('h2'), rows=[...section.querySelectorAll<HTMLElement>('.score-row')];
    const titleHeight=title?.getBoundingClientRect().height??0;
    const firstHeight=rows[0]?.getBoundingClientRect().height??0;
    const firstBlock=firstHeight>capacity-titleHeight-12?Math.min(160,firstHeight):firstHeight;
    if(used+titleHeight+6+firstBlock>capacity)newPage();
    if(title)append(title.cloneNode(true) as HTMLElement,titleHeight);
    rows.forEach(addRow);
  }
  for(const card of source.querySelectorAll<HTMLElement>('.section-card')) {const h=card.getBoundingClientRect().height;if(used+h>capacity)newPage();append(card.cloneNode(true) as HTMLElement,h);}
  bench.remove();document.body.classList.add('print-paginated');
}
