import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const origin='http://127.0.0.1:8000',out=path.resolve('../docs/verification'),pdf=path.resolve('../output/pdf');
await fs.mkdir(out,{recursive:true});await fs.mkdir(pdf,{recursive:true});
const note=(id,digit,start,end)=>({id,digit,start,end,lines:2,octave:0,notation:null});
let fixture={id:'bass-ui-fixture',title:'贝斯音名与彩色谱 · 原创验证',artist:'交互验证',duration:32,bpm:120,meter:'4/4',offset:0,beatTimes:[],key:'C',originalKey:'C',revision:1,updatedAt:'',isDemo:false,topTrack:'bass',
 sections:[{id:'s1',name:'Intro',startBar:1,endBar:8,color:'#aaa'},{id:'s2',name:'Verse',startBar:9,endBar:16,color:'#aaa'}],
 chords:[{id:'old',bar:1,beat:1,label:'Cmaj7',source:'manual',locked:true,confidence:1}],
 bassEvents:[{id:'b1',start:0,end:.5,pitchClass:0},{id:'b2',start:.5,end:16,pitchClass:9},{id:'b3',start:16,end:32,pitchClass:7}].map(e=>({...e,source:'analysis',locked:false,confidence:.8})),
 lyrics:[{id:'l1',text:'这是完整显示的原创歌词',start:1,end:6,order:0},{id:'l2',text:'大字与颜色更容易辨认',start:7,end:14,order:1},{id:'l3',text:'歌词跟随音频保持时间',start:18,end:26,order:2}].map(e=>({...e,source:'manual',locked:true})),
 manualFills:[{id:'dense',notes:Array.from({length:24},(_,i)=>note(`n${i}`,i<2?1:(i%7+1),i*.125,(i+1)*.125))},{id:'across',notes:Array.from({length:4},(_,i)=>({...note(`x${i}`,i+1,7.5+i*.5,8+i*.5),lines:0,notation:i<3?{connection:{kind:'hammer',targetNoteId:`x${i+1}`}}:null}))}],notes:[],markers:[],
 analysis:{state:'idle',stage:'',progress:0,warnings:[]},lyricAlignment:{state:'idle',stage:'',progress:0,detectedSegments:[],lines:[],warnings:[],error:null},
 stems:[{id:'original',name:'原曲',url:'/media/qa/original.wav',available:true,peaks:[.1,.2,.4,.3]},{id:'bass',name:'贝斯',url:'/media/qa/bass.wav',enhancedUrl:'/media/qa/bass-enhanced.wav',gainDb:12,available:true,peaks:[.1,.2,.1]}]};
const wav=Buffer.alloc(44+8000*32*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);for(let i=0;i<8000*32;i++)wav.writeInt16LE(Math.round(6000*Math.sin(2*Math.PI*110*i/8000)),44+i*2);
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});const errors=[],checks=[],requests=[];let saves=0,analysisRequests=[],uploadCount=0;
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/media/qa/**',route=>{requests.push(new URL(route.request().url()).pathname);return route.fulfill({contentType:'audio/wav',body:wav});});
await page.route('**/api/projects**',route=>{const req=route.request(),url=new URL(req.url()).pathname;if(url==='/api/projects')return route.fulfill({json:[fixture]});if(url.endsWith('/upload')){uploadCount++;fixture={...fixture,id:'uploaded-ui-fixture',analysis:{...fixture.analysis,state:'idle'}};return route.fulfill({json:fixture});}if(url.endsWith('/analyze')){analysisRequests.push(req.postDataJSON());return route.fulfill({json:fixture});}if(url===`/api/projects/${fixture.id}`){if(req.method()==='PUT'){fixture={...req.postDataJSON(),revision:fixture.revision+1};saves++;}return route.fulfill({json:fixture});}return route.fulfill({status:404,json:{detail:'QA only'}});});
const save=async()=>{const before=saves;await page.keyboard.press('Control+s');await expect.poll(()=>saves).toBeGreaterThan(before);};
const load=async()=>{await page.goto(origin);await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();await expect(page.locator('.manual-fill-note')).toHaveCount(28);};
const mark=async(key)=>{await page.locator('[data-note-id="n0"]').click();await page.keyboard.press(key);await save();return fixture.manualFills[0].notes[0];};
const check=async(name,run)=>{await run();checks.push(name);console.log('PASS '+name);};
const bounds=async()=>page.evaluate(()=>{
 const bad=[];for(const selector of ['.manual-fill-track','.editable-lyric-track','.chord-track'])for(const lane of document.querySelectorAll(selector)){
  const outer=lane.getBoundingClientRect(),nodes=[...lane.querySelectorAll('.manual-fill-note,.track-lyric,.chord')],boxes=nodes.map(n=>n.getBoundingClientRect());
  boxes.forEach((r,i)=>{if(r.left<outer.left-1||r.right>outer.right+1||r.bottom>outer.bottom+1)bad.push('outside:'+nodes[i].textContent);for(const b of boxes.slice(i+1))if(Math.min(r.right,b.right)-Math.max(r.left,b.left)>1&&Math.min(r.bottom,b.bottom)-Math.max(r.top,b.top)>1)bad.push('overlap');});
 }return bad;
});
let failure;
try{
 await load();
 await check('Default20px lyrics, independent colors, enhanced bass playback source',async()=>{
  await expect(page.locator('.track-lyric').first()).toHaveCSS('font-size','20px');await expect(page.locator('.chord').first()).toHaveCSS('color','rgb(29, 78, 216)');await expect(page.locator('.manual-fill-note').first()).toHaveCSS('color','rgb(22, 112, 71)');await expect.poll(()=>requests.some(p=>p.endsWith('bass-enhanced.wav'))).toBe(true);
  await page.getByRole('combobox',{name:'贝斯音量版本'}).selectOption('raw');await expect.poll(()=>requests.some(p=>p.endsWith('/bass.wav'))).toBe(true);await page.getByRole('combobox',{name:'贝斯音量版本'}).selectOption('enhanced');
 });
 await check('Every technique shortcut toggles, preserves time and supports undo',async()=>{
  const times=fixture.manualFills[0].notes.map(n=>[n.start,n.end]);
  for(const [key,kind] of [['Shift+ArrowUp','slideUp'],['Shift+ArrowDown','slideDown'],['h','hammer'],['p','pull'],['t','tie']]){expect((await mark(key)).notation.connection.kind).toBe(kind);expect((await mark(key)).notation.connection).toBeNull();}
  expect((await mark('s')).notation.cut).toBe(true);expect((await mark('Shift+a')).notation.accent).toBe(true);expect((await mark('x')).notation.dead).toBe(true);await expect(page.locator('[data-note-id="n0"] .fill-dead')).toHaveCSS('color','rgb(198, 40, 40)');await mark('x');await mark('Shift+ArrowUp');
  expect(fixture.manualFills[0].notes.map(n=>[n.start,n.end])).toEqual(times);await page.keyboard.press('Control+z');await save();expect(fixture.manualFills[0].notes[0].notation.connection).toBeNull();await page.keyboard.press('Control+Shift+z');await save();expect(fixture.manualFills[0].notes[0].notation.connection.kind).toBe('slideUp');
  await expect(page.locator('.fill-connections path').first()).toHaveCSS('stroke','rgb(198, 40, 40)');
 });
 await check('Input typing does not trigger techniques; font/color settings retain lyrics times and persist',async()=>{
  const marks=JSON.stringify(fixture.manualFills),times=fixture.lyrics.map(l=>[l.start,l.end]);await page.locator('[data-lyric-id="l1"]').dblclick();const box=page.getByRole('textbox',{name:'直接编辑歌词',exact:true});await box.fill('输入不会触发技法 ');await box.press('End');await box.pressSequentially('s x h p t A');await save();expect(JSON.stringify(fixture.manualFills)).toBe(marks);
  await page.locator('.chart-display-menu>summary').click();await page.getByRole('combobox',{name:'歌词字号',exact:true}).selectOption('24');await page.getByLabel('歌词颜色',{exact:true}).fill('#302050');await page.getByRole('combobox',{name:'打印歌词字号',exact:true}).selectOption('14');await page.locator('.chart-display-menu>summary').click();await save();expect(fixture.lyrics.map(l=>[l.start,l.end])).toEqual(times);await load();await expect(page.locator('.track-lyric').first()).toHaveCSS('font-size','24px');await expect(page.locator('.track-lyric').first()).toHaveCSS('color','rgb(48, 32, 80)');
 });
 await check('Bass edit, degree, keyboard move, transpose and legacy top switch',async()=>{
  const b=page.locator('[data-chord-id="b1"]');await b.focus();await page.keyboard.press('ArrowRight');await save();expect(fixture.bassEvents[0].start).toBeCloseTo(.125);expect(fixture.bassEvents[0].end).toBeCloseTo(.625);await page.keyboard.press('Control+z');await save();await b.click();await expect(page.getByRole('dialog',{name:'编辑贝斯音名'})).toBeVisible();await page.getByRole('combobox',{name:'贝斯音名',exact:true}).selectOption('2');await page.getByRole('button',{name:'保存音名',exact:true}).click();await save();expect(fixture.bassEvents[0].pitchClass).toBe(2);
  await page.keyboard.press('d');await expect(b).toContainText('2');await page.keyboard.press('d');const manual=JSON.stringify(fixture.manualFills);await page.keyboard.press('Alt+ArrowUp');await save();expect(fixture.bassEvents[0].pitchClass).toBe(3);expect(JSON.stringify(fixture.manualFills)).toBe(manual);await page.keyboard.press('Control+z');await save();
  await page.locator('.chart-display-menu>summary').click();await page.getByRole('combobox',{name:'顶部轨道',exact:true}).selectOption('chords');await expect(page.locator('.chord').first()).toContainText('Cmaj7');await page.getByRole('combobox',{name:'顶部轨道',exact:true}).selectOption('bass');await page.locator('.chart-display-menu>summary').click();
 });
 await check('BPM correction preserves bass/fill/lyric times',async()=>{
  const bass=structuredClone(fixture.bassEvents),fills=structuredClone(fixture.manualFills),lyrics=fixture.lyrics.map(l=>[l.start,l.end]);await page.keyboard.press('g');await page.getByRole('button',{name:'½ 速度',exact:true}).click();await page.getByRole('button',{name:'更新节拍网格',exact:true}).click();await save();expect(fixture.bassEvents).toEqual(bass);expect(fixture.manualFills).toEqual(fills);expect(fixture.lyrics.map(l=>[l.start,l.end])).toEqual(lyrics);await page.keyboard.press('Control+z');await save();
 });
 await check('Dense and cross-row fills fit desktop and mobile with all28 symbols',async()=>{
  await expect.poll(bounds).toEqual([]);await page.screenshot({path:path.join(out,'bass-upgrade-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await expect(page.locator('.manual-fill-note')).toHaveCount(28);await expect.poll(bounds).toEqual([]);await page.screenshot({path:path.join(out,'bass-upgrade-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
 });
 await check('A4 portrait/landscape retain print font and four colors; mono remains optional',async()=>{
  await page.emulateMedia({media:'print'});await expect(page.locator('.track-lyric').first()).toHaveCSS('font-size','18.6667px');await expect(page.locator('.chord').first()).toHaveCSS('color','rgb(29, 78, 216)');await expect.poll(bounds).toEqual([]);
  await page.pdf({path:path.join(pdf,'bass-upgrade-portrait.pdf'),format:'A4',preferCSSPageSize:true,printBackground:true});
  await page.emulateMedia({media:'screen'});await page.locator('.chart-display-menu>summary').click();await page.getByRole('combobox',{name:'打印纸张方向',exact:true}).selectOption('landscape');await page.locator('.chart-display-menu>summary').click();await page.emulateMedia({media:'print'});await expect.poll(bounds).toEqual([]);await page.pdf({path:path.join(pdf,'bass-upgrade-landscape.pdf'),format:'A4',landscape:true,preferCSSPageSize:true,printBackground:true});
  await page.emulateMedia({media:'screen'});await page.locator('.chart-display-menu>summary').click();await page.getByRole('combobox',{name:'打印配色',exact:true}).selectOption('mono');await page.locator('.chart-display-menu>summary').click();await page.emulateMedia({media:'print'});for(const selector of ['.track-lyric','.chord','.manual-fill-note'])await expect(page.locator(selector).first()).toHaveCSS('color','rgb(0, 0, 0)');await page.emulateMedia({media:'screen'});await expect(page.locator('.chord').first()).toHaveCSS('color','rgb(29, 78, 216)');
 });
 await check('HTML download contains styles, pitch names, techniques and unchanged real times',async()=>{
  await page.keyboard.press('Control+Shift+e');const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'互动 HTML 谱'}).click();const download=await downloaded;const file=path.join(out,'bass-upgrade-ui-export.html');await download.saveAs(file);const html=await fs.readFile(file,'utf8');expect(html).toContain('贝斯音名');expect(html).toContain('data-id="b1"');expect(html).toContain('data-start="0.125"');expect(html).toContain('slideUp');expect(html).toContain('#302050');await page.keyboard.press('Escape');
 });
 await check('Full song uploads automatically request mandatory bass pipeline; explicit isolated upload sends its source',async()=>{
  await page.keyboard.press('Alt+1');await page.getByRole('combobox',{name:'导入音频类型'}).selectOption('original');await page.locator('.import-file input').setInputFiles({name:'原创测试.wav',mimeType:'audio/wav',buffer:wav});await expect.poll(()=>analysisRequests.length).toBe(1);expect(analysisRequests[0].source).toBe('original');await page.keyboard.press('Alt+1');await page.getByRole('combobox',{name:'导入音频类型'}).selectOption('uploaded_bass');await page.locator('.import-file input').setInputFiles({name:'独立贝斯.wav',mimeType:'audio/wav',buffer:wav});await expect.poll(()=>analysisRequests.length).toBe(2);expect(analysisRequests[1].source).toBe('uploaded_bass');expect(uploadCount).toBe(2);
 });
 expect(errors).toEqual([]);
}catch(error){failure=String(error.stack??error);await page.screenshot({path:path.join(out,'bass-upgrade-failure.png'),fullPage:true});console.error(failure);process.exitCode=1;}
finally{await fs.writeFile(path.join(out,'bass-upgrade-ui-results.json'),JSON.stringify({checks,errors,saves,failure:failure??null},null,2));await browser.close();}
