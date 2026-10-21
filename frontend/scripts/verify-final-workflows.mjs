import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const origin='http://127.0.0.1:8000',output=path.resolve('../docs/verification');
await fs.mkdir(output,{recursive:true});
const demo=structuredClone(await fetch(`${origin}/api/projects/demo`).then(r=>r.json()));
demo.analysis={state:'complete',stage:'界面验证',progress:100,warnings:[]};demo.lyricAlignment=undefined;
const projects=new Map([['demo',demo]]),checks=[],errors=[],saves=[],loopSamples=[];
const rawLyrics='第一段测试歌词\n第二段测试歌词\n第三段测试歌词',uploadedId='qa-uploaded-audio',duration=12;
const baseChord=demo.chords[0],browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});let uploadCount=0,failure=null;
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
await page.route('**/api/projects**',async route=>{
 const request=route.request(),pathname=new URL(request.url()).pathname;
 if(pathname==='/api/projects'&&request.method()==='GET'){await route.fulfill({json:[...projects.values()]});return;}
 if(pathname==='/api/projects/upload'&&request.method()==='POST'){
  uploadCount++;const project={...structuredClone(demo),id:uploadedId,title:'先歌词后音频验证',isDemo:false,duration,bpm:96,meter:'4/4',key:'C',originalKey:'C',offset:0,beatTimes:[],revision:1,lyrics:[],lyricsOriginal:'',analysis:{state:'idle',stage:'',progress:0,warnings:[]},
   sections:[{...demo.sections[0],id:'qa-source',name:'来源段落',startBar:1,endBar:2},{...demo.sections[0],id:'qa-target',name:'目标段落',startBar:3,endBar:4}],
   chords:[{...baseChord,id:'qa-a',bar:1,beat:1.25,label:'Cmaj7'},{...baseChord,id:'qa-b',bar:1,beat:3.625,label:'G7'},{...baseChord,id:'qa-c',bar:2,beat:2.875,label:'Am7'},{...baseChord,id:'qa-d',bar:3,beat:2,label:'Dm7'},{...baseChord,id:'qa-e',bar:4,beat:1,label:'G'}],
   notes:demo.notes.filter(n=>n.start+n.duration<=duration),markers:[]};projects.set(uploadedId,project);await route.fulfill({json:project});return;
 }
 const id=pathname.split('/')[3],existing=projects.get(id);
 if(!existing){await route.fulfill({status:404,json:{detail:'Unknown UI fixture project'}});return;}
 if(request.method()==='GET'){await route.fulfill({json:existing});return;}
 if(request.method()==='PUT'){
  const submitted=request.postDataJSON();if(submitted.revision!==existing.revision){await route.fulfill({status:409,json:{detail:'UI fixture revision conflict'}});return;}
  const saved={...submitted,revision:existing.revision+1,updatedAt:new Date().toISOString()};projects.set(id,saved);saves.push({id,revision:saved.revision});await route.fulfill({json:saved});return;
 }
 await route.fulfill({status:400,json:{detail:'UI fixture supports read/save/upload only.'}});
});
const check=async(name,fn)=>{await fn();checks.push(name);},current=()=>projects.get(uploadedId);
const seek=async value=>{await page.getByRole('slider',{name:'播放位置',exact:true}).evaluate((input,next)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(next));input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},value);await expect(page.getByRole('slider',{name:'播放位置',exact:true})).toHaveValue(String(value));};
const save=async()=>{const before=saves.length;await page.getByRole('button',{name:'保存工程',exact:true}).click();await expect.poll(()=>saves.length).toBeGreaterThan(before);await expect(page.locator('.save-state')).toContainText('工程已保存');};
try{
 await page.goto(origin,{waitUntil:'networkidle'});
 await check('TXT before audio retains original text and remaps placeholders to the new duration',async()=>{
  await page.getByRole('button',{name:'粘贴或选择歌词',exact:true}).click();await page.getByRole('button',{name:'TXT 纯文本',exact:true}).click();
  await page.locator('.file-label input[type=file]').setInputFiles({name:'qa-lyrics.txt',mimeType:'text/plain',buffer:Buffer.from(rawLyrics)});await expect(page.locator('.lyrics-input')).toHaveValue(rawLyrics);
  await page.getByRole('button',{name:'导入歌词片段',exact:true}).click();await expect(page.getByText('已准备 · 3 个片段，导入音频时会带入',{exact:true})).toBeVisible();
  await page.locator('.import-zone input[type=file]').setInputFiles({name:'qa-audio.wav',mimeType:'audio/wav',buffer:Buffer.from('RIFF-UI-upload-fixture-WAVE')});
  await expect(page.locator('.song-heading h1')).toContainText('先歌词后音频验证');await page.getByTitle('关闭',{exact:true}).click();
  expect(uploadCount).toBe(1);expect(current().lyricsOriginal).toBe(rawLyrics);expect(current().lyrics.map(l=>l.text)).toEqual(['第一段测试歌词','第二段测试歌词','第三段测试歌词']);expect(current().lyrics[0].start).toBe(0);current().lyrics.slice(1).forEach((l,i)=>expect(l.start).toBeCloseTo(current().lyrics[i].end,8));expect(current().lyrics.at(-1).end).toBeLessThan(5);expect(current().lyrics.every(l=>!l.locked&&l.source==='manual')).toBe(true);
 });
 await check('A/B loop uses seek points, loops actual audio, and resumes normal playback when closed',async()=>{
  await seek(1.25);await page.getByTitle('将当前位置设为循环 A 点 · A',{exact:true}).click();await seek(2.05);await page.getByTitle('将当前位置设为循环 B 点 · B',{exact:true}).click();
  await expect(page.locator('.loop-button')).toHaveClass(/active/);await expect(page.getByRole('slider',{name:'播放位置',exact:true})).toHaveValue('1.25');
  const interval=await page.locator('.loop-region').evaluate(r=>({left:Number.parseFloat(r.style.left),width:Number.parseFloat(r.style.width)}));expect(interval.left).toBeCloseTo(1.25/duration*100);expect(interval.width).toBeCloseTo(.8/duration*100);
  await page.locator('.play-button').click();for(let i=0;i<22;i++){await page.waitForTimeout(100);loopSamples.push(Number(await page.getByRole('slider',{name:'播放位置',exact:true}).inputValue()));}
  expect(loopSamples.every(v=>v>=1.24&&v<=2.07)).toBe(true);expect(loopSamples.some((v,i)=>i>0&&v<loopSamples[i-1]-.15)).toBe(true);
  await page.getByTitle('整曲循环 / 关闭循环 · R',{exact:true}).click();await expect(page.locator('.loop-button')).not.toHaveClass(/active/);await expect(page.locator('.loop-region')).toHaveCount(0);
  await expect.poll(async()=>Number(await page.getByRole('slider',{name:'播放位置',exact:true}).inputValue()),{timeout:3000}).toBeGreaterThan(2.1);await page.locator('.play-button').click();
 });
 await check('Section copy keeps fractional beats and independent notes/lyrics, including undo/redo',async()=>{
  const initial=structuredClone(current()),notes=JSON.stringify(initial.notes),lyrics=JSON.stringify(initial.lyrics);
  await page.getByTitle('编辑段落 · F2',{exact:true}).first().click();await page.locator('.section-copy summary').click();await page.getByLabel('复制和弦的目标开始小节',{exact:true}).fill('3');await page.getByRole('button',{name:'复制段落和弦',exact:true}).click();await save();
  const target=p=>p.chords.filter(c=>c.bar>=3&&c.bar<=4).map(c=>[c.bar,c.beat,c.label]);expect(target(current())).toEqual([[3,1.25,'Cmaj7'],[3,3.625,'G7'],[4,2.875,'Am7']]);expect(JSON.stringify(current().notes)).toBe(notes);expect(JSON.stringify(current().lyrics)).toBe(lyrics);expect(current().chords.filter(c=>c.bar<3)).toEqual(initial.chords.filter(c=>c.bar<3));
  const copied=structuredClone(current().chords);await page.getByTitle('撤销 Ctrl+Z',{exact:true}).click();await save();expect(current().chords).toEqual(initial.chords);await page.getByTitle('重做 Ctrl+Shift+Z',{exact:true}).click();await save();expect(current().chords).toEqual(copied);expect(JSON.stringify(current().notes)).toBe(notes);expect(JSON.stringify(current().lyrics)).toBe(lyrics);
 });expect(errors).toEqual([]);
}catch(e){failure=e.message;await page.screenshot({path:path.join(output,'final-workflows-failure.png'),fullPage:true}).catch(()=>{});}
finally{const result={passed:checks.length,checks,pageErrors:errors,failure,mockUploads:uploadCount,mockSaves:saves.length,loopSamples,projectWrites:'browser route fixtures only; user projects were not modified'};await fs.writeFile(path.join(output,'final-workflows-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();}
if(failure||errors.length)process.exitCode=1;
