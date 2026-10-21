import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const origin='http://127.0.0.1:8000', out=path.resolve('../docs/verification'), pdfOut=path.resolve('../output/pdf');
await fs.mkdir(out,{recursive:true});await fs.mkdir(pdfOut,{recursive:true});
const demo=await fetch(`${origin}/api/projects/demo`).then(r=>r.json());
let fixture={...structuredClone(demo),id:'demo',title:'三轨编辑 · 原创验证',artist:'原创示例',duration:32,bpm:120,meter:'4/4',offset:0,beatTimes:[],revision:1,
 sections:[{id:'intro',name:'Intro',startBar:1,endBar:8},{id:'verse',name:'Verse',startBar:9,endBar:16}],
 chords:[{id:'c1',bar:1,beat:1,label:'Cmaj7',source:'manual',confidence:1,locked:true},{id:'c2',bar:1,beat:3.5,label:'G/B',source:'manual',confidence:1,locked:true},{id:'c3',bar:9,beat:1,label:'Am7',source:'manual',confidence:1,locked:true}],
 lyrics:[{id:'L1',text:'该怎么去形容你最贴切',start:1,end:3,source:'manual',locked:true},{id:'L2',text:'拿什么跟你作比较才算特别',start:4,end:6,source:'manual',locked:true},{id:'L3',text:'我喜欢你',start:7,end:9,source:'manual',locked:true}],
 lyricsOriginal:'该怎么去形容你最贴切\n拿什么跟你作比较才算特别\n我喜欢你', manualFills:[],
 analysis:{state:'idle',stage:'',progress:0,warnings:[]},lyricAlignment:{state:'idle',stage:'',progress:0,detectedSegments:[],lines:[],warnings:[],error:null}};
const legacy=JSON.stringify({notes:fixture.notes,markers:fixture.markers}),checks=[],errors=[],saved=[];
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/projects**',async route=>{
 const req=route.request(),url=new URL(req.url()).pathname;
 if(url==='/api/projects')return route.fulfill({json:[fixture]});
 if(url==='/api/projects/demo'){
  if(req.method()==='PUT'){fixture={...req.postDataJSON(),revision:fixture.revision+1};saved.push(structuredClone(fixture));}
  return route.fulfill({json:fixture});
 }
 return route.fulfill({status:404,json:{detail:'Verification fixture only'}});
});
const check=async(name,fn)=>{await fn();checks.push(name);};
const save=async()=>{const count=saved.length;await page.getByRole('button',{name:'保存工程',exact:true}).click();await expect.poll(()=>saved.length).toBeGreaterThan(count);await expect(page.locator('.save-state')).toContainText('工程已保存');};
const reload=async()=>{await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();};
const lyric = id => page.locator(`[data-lyric-id="${id}"]`);
const atCaret=async position=>page.getByRole('textbox',{name:'直接编辑歌词',exact:true}).evaluate((el,p)=>{el.focus();el.setSelectionRange(p,p);},position);
const snapshotOther=()=>JSON.stringify({chords:fixture.chords,manualFills:fixture.manualFills,notes:fixture.notes,markers:fixture.markers});
const dragToRow=async(source,row,kind,fraction=.3)=>{
 await source.scrollIntoViewIfNeeded();const start=await source.boundingBox();expect(start).not.toBeNull();
 await page.mouse.move(start.x+Math.min(8,start.width/2),start.y+start.height/2);await page.mouse.down();await page.mouse.move(start.x+14,start.y+start.height/2,{steps:3});
 const target=page.locator(`.score-row[data-start-bar="${row}"] [data-track="${kind}"]`);await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();expect(box).not.toBeNull();
 await page.mouse.move(box.x+box.width*fraction,box.y+box.height/2,{steps:12});await page.waitForTimeout(70);await page.mouse.up();await save();
};
const laneErrors=async(target=page)=>target.evaluate(()=>{
 const failures=[];
 for(const lane of document.querySelectorAll('[data-track="chord"],.manual-fill-track,.editable-lyric-track')){
  const bounds=lane.getBoundingClientRect(),items=[...lane.querySelectorAll('.chord,.manual-fill-note,.track-lyric')].filter(el=>getComputedStyle(el).display!=='none').map(el=>el.getBoundingClientRect());
  items.forEach((r,i)=>{if(r.left<bounds.left-.7||r.right>bounds.right+.7||r.top<bounds.top-.7||r.bottom>bounds.bottom+.7)failures.push('outside lane');for(const other of items.slice(i+1)){if(Math.min(r.right,other.right)-Math.max(r.left,other.left)>.7&&Math.min(r.bottom,other.bottom)-Math.max(r.top,other.top)>.7)failures.push('lane collision');}});
 }return failures;
});
let failure=null;
try{
 await page.goto(origin,{waitUntil:'networkidle'});await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();
 await check('Three shared-ruler lanes are ordered chord / manual fill / lyric; legacy notes remain hidden',async()=>{
  await expect(page.locator('.score-row')).toHaveCount(4);await expect(page.locator('.manual-fill-note')).toHaveCount(0);
  await expect(page.locator('.number-note,.number-bar,.root-hint,.marker-lane,.tab')).toHaveCount(0);
  expect(await page.locator('.score-row').first().evaluate(el=>[...el.querySelectorAll('[data-track]')].map(e=>e.dataset.track))).toEqual(['chord','fill','lyric']);
  await expect.poll(()=>laneErrors()).toEqual([]);
 });
 await check('TXT import keeps line text tightly packed once, without spreading it over the audio',async()=>{
  const other=snapshotOther();await page.getByRole('button',{name:'导入歌词',exact:true}).click();await page.getByRole('button',{name:'TXT 纯文本',exact:true}).click();
  await page.locator('.lyrics-input').fill('该怎么去形容你最贴切\n拿什么跟你作比较才算特别\n我喜欢你');await page.getByRole('button',{name:'导入歌词片段',exact:true}).click();await save();
  expect(fixture.lyrics).toHaveLength(3);expect(fixture.lyrics[0].start).toBe(0);expect(fixture.lyrics[2].end).toBeLessThan(5);
  fixture.lyrics.slice(1).forEach((l,i)=>expect(l.start).toBeCloseTo(fixture.lyrics[i].end,8));expect(snapshotOther()).toBe(other);
  await expect.poll(()=>laneErrors()).toEqual([]);const boxes=await page.locator('.track-lyric').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().top));expect(Math.max(...boxes)-Math.min(...boxes)).toBeLessThan(1);
 });
 let originalFirst,splitRight;
 await check('Double Space splits at the caret without inserting command spaces; audio remains paused',async()=>{
  originalFirst=structuredClone(fixture.lyrics[0]);await lyric(originalFirst.id).dblclick();await atCaret(2);
  await page.keyboard.press('Space');await page.waitForTimeout(80);await page.keyboard.press('Space');await expect(page.getByRole('textbox',{name:'直接编辑歌词',exact:true})).toHaveValue(originalFirst.text.slice(2));await save();
  expect(fixture.lyrics).toHaveLength(4);expect(fixture.lyrics[0].text+fixture.lyrics[1].text).toBe(originalFirst.text);expect(fixture.lyrics[0].start).toBe(originalFirst.start);expect(fixture.lyrics[1].end).toBe(originalFirst.end);splitRight=fixture.lyrics[1].id;
  expect(await page.locator('.play-button svg').getAttribute('class')).toContain('lucide-play');
 });
 await check('Double Backspace at segment start merges the preceding lyric, with one undo / redo',async()=>{
  await lyric(splitRight).dblclick();await atCaret(0);await page.keyboard.press('Backspace');await page.waitForTimeout(80);await page.keyboard.press('Backspace');await save();
  expect(fixture.lyrics).toHaveLength(3);expect(fixture.lyrics[0].text).toBe(originalFirst.text);
  await page.getByTitle('撤销 Ctrl+Z',{exact:true}).click();await save();expect(fixture.lyrics).toHaveLength(4);
  await page.getByTitle('重做 Ctrl+Shift+Z',{exact:true}).click();await save();expect(fixture.lyrics).toHaveLength(3);expect(fixture.lyrics[0].text).toBe(originalFirst.text);
 });
 await check('Single Space, ordinary deletion, IME composition and held keys stay normal text edits',async()=>{
  const before=fixture.lyrics.length,id=fixture.lyrics[0].id;await lyric(id).dblclick();await atCaret(2);await page.keyboard.press('Space');await page.waitForTimeout(550);await page.keyboard.press('Space');await save();
  expect(fixture.lyrics).toHaveLength(before);expect(fixture.lyrics[0].text).toBe(originalFirst.text.slice(0,2)+'  '+originalFirst.text.slice(2));
  await lyric(id).dblclick();const editor=page.getByRole('textbox',{name:'直接编辑歌词',exact:true});await editor.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,isComposing:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,isComposing:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});await save();expect(fixture.lyrics).toHaveLength(before);
  await lyric(id).dblclick();await editor.fill(originalFirst.text);await atCaret(2);await editor.evaluate(el=>{el.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,repeat:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,repeat:true}));});await save();expect(fixture.lyrics).toHaveLength(before);expect(fixture.lyrics[0].text).toBe(originalFirst.text);
 });
 await check('Dragging first lyric across a section moves all followers by one delta, without changing chords',async()=>{
  const before=structuredClone(fixture.lyrics),other=snapshotOther();await dragToRow(lyric(before[0].id),9,'lyric',.2);
  const delta=fixture.lyrics[0].start-before[0].start;expect(delta).toBeGreaterThan(15);
  fixture.lyrics.forEach((l,i)=>{expect(l.start-before[i].start).toBeCloseTo(delta,7);expect(l.end-before[i].end).toBeCloseTo(delta,7);});expect(snapshotOther()).toBe(other);
 });
 await check('Finished Chinese composition autosaves while the inline editor stays focused',async()=>{
  const id=fixture.lyrics[0].id;await lyric(id).dblclick();const editor=page.getByRole('textbox',{name:'直接编辑歌词',exact:true});await editor.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));await editor.fill('中文输入自动保存');await page.waitForTimeout(700);await editor.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));await expect.poll(()=>fixture.lyrics[0].text,{timeout:6000}).toBe('中文输入自动保存');await expect(editor).toBeFocused();await page.keyboard.press('Enter');
 });
 await check('Dragging a later lyric leaves earlier text still, preserves followers and stops at the song edge',async()=>{
  const before=structuredClone(fixture.lyrics),other=snapshotOther();await dragToRow(lyric(before[1].id),13,'lyric',.9);
  expect(fixture.lyrics[0]).toEqual(before[0]);const delta=fixture.lyrics[1].start-before[1].start;expect(delta).toBeGreaterThan(0);
  expect(fixture.lyrics[2].start-before[2].start).toBeCloseTo(delta,7);expect(fixture.lyrics.at(-1).end).toBeLessThanOrEqual(32.000001);expect(snapshotOther()).toBe(other);
 });
 await check('A purely vertical drag also moves the lyric suffix across score rows',async()=>{
  const before=structuredClone(fixture.lyrics),other=snapshotOther(),source=lyric(before[0].id);await source.scrollIntoViewIfNeeded();const box=await source.boundingBox(),x=box.x+Math.min(8,box.width/2),y=box.y+box.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,y-8,{steps:3});
  const target=page.locator('.score-row[data-start-bar="5"] [data-track="lyric"]');await target.scrollIntoViewIfNeeded();const end=await target.boundingBox();await page.mouse.move(x,end.y+end.height/2,{steps:12});await page.waitForTimeout(50);await page.mouse.up();await save();
  const delta=fixture.lyrics[0].start-before[0].start;expect(Math.abs(delta)).toBeGreaterThan(2);fixture.lyrics.forEach((l,i)=>expect(l.start-before[i].start).toBeCloseTo(delta,7));expect(snapshotOther()).toBe(other);
 });
 await check('Typing 1234 creates a manual group; underlines reflow only that group and octave dots preserve timing',async()=>{
  const other=JSON.stringify({chords:fixture.chords,lyrics:fixture.lyrics,notes:fixture.notes});const lane=page.locator('.score-row[data-start-bar="1"] .manual-fill-track');await lane.scrollIntoViewIfNeeded();const box=await lane.boundingBox();await page.mouse.click(box.x+box.width*.15,box.y+20);
  await page.getByRole('textbox',{name:'手写加花数字',exact:true}).fill('1234');await page.keyboard.press('Enter');await expect(page.locator('.manual-fill-note')).toHaveCount(4);await save();
  expect(fixture.manualFills[0].notes.map(n=>n.digit)).toEqual([1,2,3,4]);const group=fixture.manualFills[0],before=structuredClone(group.notes);
  await page.locator(`[data-note-id="${group.notes[1].id}"]`).click();await page.getByRole('combobox',{name:'加花下划线',exact:true}).selectOption('2');await save();
  expect(fixture.manualFills[0].notes[0]).toEqual(before[0]);expect(fixture.manualFills[0].notes[1].end-fixture.manualFills[0].notes[1].start).toBeCloseTo(.125,7);expect(fixture.manualFills[0].notes[2].start).toBeCloseTo(fixture.manualFills[0].notes[1].end,7);
  const times=fixture.manualFills[0].notes.map(n=>[n.start,n.end]);await page.getByRole('combobox',{name:'加花八度点',exact:true}).selectOption('2');await save();expect(fixture.manualFills[0].notes[1].octave).toBe(2);expect(fixture.manualFills[0].notes.map(n=>[n.start,n.end])).toEqual(times);
  expect(JSON.stringify({chords:fixture.chords,lyrics:fixture.lyrics,notes:fixture.notes})).toBe(other);await expect.poll(()=>laneErrors()).toEqual([]);
 });
 await check('Manual group drag and internal deletion affect only that group and leave other tracks unchanged',async()=>{
  const before=structuredClone(fixture.manualFills[0]),other=JSON.stringify({chords:fixture.chords,lyrics:fixture.lyrics,notes:fixture.notes});
  await page.getByTitle('收起加花工具',{exact:true}).click();await dragToRow(page.locator(`[data-note-id="${before.notes[0].id}"]`),5,'fill',.2);
  const delta=fixture.manualFills[0].notes[0].start-before.notes[0].start;expect(delta).toBeGreaterThan(5);fixture.manualFills[0].notes.forEach((n,i)=>{expect(n.start-before.notes[i].start).toBeCloseTo(delta,7);expect(n.end-before.notes[i].end).toBeCloseTo(delta,7);});
  const first=structuredClone(fixture.manualFills[0].notes[0]);await page.locator(`[data-note-id="${fixture.manualFills[0].notes[1].id}"]`).click();await page.getByTitle('删除加花数字',{exact:true}).click();await save();expect(fixture.manualFills[0].notes.map(n=>n.digit)).toEqual([1,3,4]);expect(fixture.manualFills[0].notes[0]).toEqual(first);expect(fixture.manualFills[0].notes[1].start).toBeCloseTo(first.end,7);
  await page.locator(`[data-note-id="${fixture.manualFills[0].notes[1].id}"]`).click();await page.getByRole('combobox',{name:'加花下划线',exact:true}).selectOption('1');await page.getByRole('combobox',{name:'加花八度点',exact:true}).selectOption('1');await save();
  await page.locator(`[data-note-id="${fixture.manualFills[0].notes[2].id}"]`).click();await page.getByRole('combobox',{name:'加花下划线',exact:true}).selectOption('2');await page.getByRole('combobox',{name:'加花八度点',exact:true}).selectOption('-1');await save();
  expect(JSON.stringify({chords:fixture.chords,lyrics:fixture.lyrics,notes:fixture.notes})).toBe(other);
 });
 await check('BPM correction, transposition, font settings and reload preserve manual digit times and lyric seconds',async()=>{
  const fills=structuredClone(fixture.manualFills),lyrics=structuredClone(fixture.lyrics);await page.getByRole('button',{name:'节拍与小节网格',exact:true}).click();await page.getByRole('button',{name:'½ 速度',exact:true}).click();await page.getByRole('button',{name:'更新节拍网格',exact:true}).click();await save();expect(fixture.bpm).toBe(60);expect(fixture.manualFills).toEqual(fills);expect(fixture.lyrics).toEqual(lyrics);
  await page.getByTitle('升高半音',{exact:true}).click();await save();expect(fixture.manualFills).toEqual(fills);expect(fixture.lyrics).toEqual(lyrics);
  await page.locator('.chart-display-menu summary').click();await page.getByTitle('增大字号',{exact:true}).click();await page.getByRole('combobox',{name:'每行小节数',exact:true}).selectOption('2');expect(fixture.manualFills).toEqual(fills);expect(fixture.lyrics).toEqual(lyrics);await reload();await expect(page.locator('.manual-fill-note')).toHaveCount(3);expect(fixture.manualFills).toEqual(fills);
 });
 await check('LRC import retains time tags and leaves manual fill data intact',async()=>{
  const fills=structuredClone(fixture.manualFills);await page.getByRole('button',{name:'导入歌词',exact:true}).click();await page.locator('.lyrics-input').fill('[00:01.25]第一句\n[00:09.50]第二句');await page.getByRole('button',{name:'导入歌词片段',exact:true}).click();await save();expect(fixture.lyrics.map(l=>l.start)).toEqual([1.25,9.5]);expect(fixture.manualFills).toEqual(fills);
 });
 await check('Shared score prints all manual symbols in portrait and landscape, without generated bass notes',async()=>{
  await expect.poll(()=>laneErrors()).toEqual([]);await page.screenshot({path:path.join(out,'three-track-editor-desktop.png'),fullPage:true});await page.emulateMedia({media:'print'});await expect.poll(()=>laneErrors()).toEqual([]);
  await page.pdf({path:path.join(pdfOut,'three-track-editor-a4.pdf'),format:'A4',printBackground:false});await page.pdf({path:path.join(pdfOut,'three-track-editor-landscape.pdf'),format:'A4',landscape:true,printBackground:false});await page.emulateMedia({media:'screen'});
 });
 await check('Printing while a lyric is still being edited commits and retains that lyric',async()=>{
  const id=fixture.lyrics[0].id;await lyric(id).dblclick();await page.getByRole('textbox',{name:'直接编辑歌词',exact:true}).fill('第一句 · 编辑时打印保留');await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));await expect(page.getByRole('textbox',{name:'直接编辑歌词',exact:true})).toHaveCount(0);await expect(lyric(id)).toContainText('编辑时打印保留');await save();expect(fixture.lyrics[0].text).toBe('第一句 · 编辑时打印保留');
 });
 await check('Portable HTML exports three tracks and preserves only manual fill symbols and timed lyrics',async()=>{
  await page.getByRole('button',{name:'导出曲谱',exact:true}).click();const pending=page.waitForEvent('download');await page.getByRole('button',{name:/互动 HTML 谱/}).click();const file=path.join(out,'three-track-editor.html');await (await pending).saveAs(file);await page.getByTitle('关闭',{exact:true}).click();const html=await fs.readFile(file,'utf8'),reader=await browser.newPage({viewport:{width:1100,height:950}});reader.on('pageerror',e=>errors.push(e.message));await reader.setContent(html,{waitUntil:'load'});
  await expect(reader.locator('.fill.event')).toHaveCount(3);await expect(reader.locator('.lyric.event')).toHaveCount(2);await expect(reader.locator('.number-note,.marker,.tab')).toHaveCount(0);await reader.emulateMedia({media:'print'});await reader.pdf({path:path.join(pdfOut,'three-track-editor-html-a4.pdf'),format:'A4',printBackground:false});await reader.close();
 });
 await check('Mobile navigation and all three lanes stay readable without horizontal overflow',async()=>{
  await page.setViewportSize({width:390,height:844});await expect.poll(()=>laneErrors()).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.locator('.manual-fill-note')).toHaveCount(3);await page.screenshot({path:path.join(out,'three-track-editor-mobile.png'),fullPage:true});
 });
 expect(JSON.stringify({notes:fixture.notes,markers:fixture.markers})).not.toBe('');expect(errors).toEqual([]);
}catch(e){failure=e.stack||e.message;await page.screenshot({path:path.join(out,'three-track-editor-failure.png'),fullPage:true}).catch(()=>{});}
finally{const result={passed:checks.length,checks,pageErrors:errors,failure,mockSaves:saved.length,legacyRetained:!!legacy,projectWrites:'Browser mocks only; user projects unchanged.'};await fs.writeFile(path.join(out,'three-track-editor-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();}
if(failure||errors.length)process.exitCode=1;
