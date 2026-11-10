import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {batchFixture,testWav} from './batch-fixture.mjs';
const origin=process.env.BASSCHART_TEST_URL||'http://127.0.0.1:8001',out=path.resolve('../docs/verification');await fs.mkdir(out,{recursive:true});
let fixture=batchFixture(),saves=0,pdfRequests=0;
// Use an existing ID for the read-only PDF endpoint; all editor writes are intercepted.
const data=path.resolve('../backend/data/projects');for(const id of await fs.readdir(data)){try{const p=JSON.parse(await fs.readFile(path.join(data,id,'project.json'),'utf8'));if(p.duration>=48&&id!=='demo'){fixture.id=id;break;}}catch{}}
if(process.env.BASSCHART_TEST_PROJECT_ID)fixture.id=process.env.BASSCHART_TEST_PROJECT_ID;
const original=structuredClone(fixture),wav=testWav(),errors=[],checks=[];
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
  window.__printCalls=[];window.addEventListener('message',event=>{if(event.data?.type==='score-print-test')window.__printCalls.push(event.data);});
  window.print=()=>{window.parent.postMessage({type:'score-print-test',title:document.title,font:document.querySelector('.page')?.style.getPropertyValue('--lyric-print-font')},'*');window.dispatchEvent(new Event('afterprint'));};
});
await page.route('**/media/qa/**',r=>r.fulfill({contentType:'audio/wav',body:wav}));
await page.route('**/api/projects**',r=>{const req=r.request(),u=new URL(req.url()).pathname;if(u.endsWith('/export/pdf')){pdfRequests++;return r.continue();}if(u==='/api/projects')return r.fulfill({json:[fixture]});if(u===`/api/projects/${fixture.id}`){if(req.method()==='PUT'){fixture={...req.postDataJSON(),revision:fixture.revision+1};saves++;}return r.fulfill({json:fixture});}return r.fulfill({status:404,json:{detail:'Test fixture only'}});});
const save=async()=>{const count=saves;await page.keyboard.press('Control+s');await expect.poll(()=>saves).toBeGreaterThan(count);};
const selected=()=>page.locator('.manual-fill-note.selected');
const note=id=>page.locator(`[data-note-id="${id}"]`);
const run=async(name,test)=>{await test();checks.push(name);console.log('PASS '+name);};
let failure;
try{
 await page.goto(origin);await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();await expect(page.locator('.manual-fill-note')).toHaveCount(12);
 await run('Space toggles once on score, toolbar and sliders; repeat is suppressed',async()=>{
  await note('first-0').click();await page.keyboard.press('Space');await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/);
  await page.keyboard.press('Space');await expect(page.locator('.play-button svg')).toHaveClass(/lucide-play/);
  await page.getByRole('slider',{name:'主音量'}).focus();await page.keyboard.down('Space');await page.keyboard.down('Space');await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/);await page.keyboard.up('Space');
  await page.keyboard.press('Space');await expect(page.locator('.play-button svg')).toHaveClass(/lucide-play/);
  await page.locator('.play-button').focus();await page.keyboard.press('Space');await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/);await page.keyboard.press('Space');
 });
 await run('Click/Ctrl/Shift selection, batch duration, delete and one-step undo/redo',async()=>{
  await note('first-0').click();await note('first-1').click({modifiers:['Control']});await expect(selected()).toHaveCount(2);
  await note('first-3').click({modifiers:['Shift']});await expect(selected()).toHaveCount(3);
  await page.keyboard.press(']');await save();expect(fixture.manualFills[0].notes.map(n=>n.lines)).toEqual([0,1,1,1]);
  expect(fixture.manualFills[0].notes.map(n=>n.start)).toEqual([0,.5,.75,1]);
  await page.keyboard.press('Control+z');await save();expect(fixture.manualFills[0].notes.map(n=>n.start)).toEqual([0,.5,1,1.5]);
  await note('first-0').click();await note('first-2').click({modifiers:['Control']});await page.keyboard.press('Delete');await save();
  expect(fixture.manualFills[0].notes.map(n=>n.start)).toEqual([.5,1.5]);expect(fixture.lyrics).toEqual(original.lyrics);
  await page.keyboard.press('Control+z');await expect(page.locator('.manual-fill-note')).toHaveCount(12);
  await page.keyboard.press('Control+Shift+z');await expect(page.locator('.manual-fill-note')).toHaveCount(10);
  await page.keyboard.press('Control+z');await save();
 });
 await run('Marquee selects rendered digits, supports cross-row autoscroll, and keeps the add gesture',async()=>{
  await page.keyboard.press('Escape');const lane=page.locator('.manual-fill-track').first();await lane.scrollIntoViewIfNeeded();const box=await lane.boundingBox(),last=await note('first-3').boundingBox();
  await page.mouse.move(box.x+1,box.y+1);await page.mouse.down();await page.mouse.move(last.x+last.width+2,last.y+last.height+3,{steps:12});await page.mouse.up();await expect(selected()).toHaveCount(4);await expect(page.getByLabel('手写加花数字')).toHaveCount(0);
  await page.keyboard.press('Escape');await lane.scrollIntoViewIfNeeded();const start=await lane.boundingBox();
  await page.mouse.move(start.x+1,start.y+1);await page.mouse.down();await page.mouse.move(start.x+start.width-2,1090,{steps:12});await page.waitForTimeout(600);await page.mouse.up();expect(await selected().count()).toBeGreaterThan(4);
  await page.keyboard.press('Escape');await lane.click({position:{x:150,y:2}});await expect(page.getByLabel('手写加花数字')).toBeVisible();await page.keyboard.press('Escape');
 });
 await run('Input Space/IME remains editing; normal keyboard playback resumes afterwards',async()=>{
  const lyric=page.locator('[data-lyric-id="lyric-a"]');await lyric.dblclick();const field=page.getByRole('textbox',{name:'直接编辑歌词'});await field.focus();await page.keyboard.press('Space');await expect(page.locator('.play-button svg')).toHaveClass(/lucide-play/);
  await field.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',isComposing:true,bubbles:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});
  await page.keyboard.press('Enter');await page.keyboard.press('Control+z');await save();
 });
 await run('PDF preview and download use one binary, current unsaved title, and large saved settings',async()=>{
  await page.getByTitle('导出曲谱 · Ctrl+Shift+E').click();await page.getByRole('combobox',{name:'打印歌词字号'}).selectOption('20');
  await page.getByRole('button',{name:'预览 PDF',exact:false}).click();await expect(page.getByTitle('PDF 预览')).toBeVisible({timeout:60000});
  const url=await page.getByTitle('PDF 预览').getAttribute('src');const before=pdfRequests;
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'下载 PDF',exact:false}).click();const d=await downloaded;await d.saveAs(path.join(out,'downloaded-batch-score.pdf'));expect(pdfRequests).toBe(before);expect(await page.getByTitle('PDF 预览').getAttribute('src')).toBe(url);
  expect((await fs.readFile(path.join(out,'downloaded-batch-score.pdf'))).subarray(0,5).toString()).toBe('%PDF-');
  await page.getByTitle('关闭',{exact:true}).click();await save();expect(fixture.scoreStyle.lyricPrintSize).toBe(20);
 });
 await page.screenshot({path:path.join(out,'batch-editor-desktop.png'),fullPage:true});
 await run('Ctrl+P uses the shared portable print document and current large settings',async()=>{
  await page.keyboard.press('Control+p');await expect.poll(()=>page.evaluate(()=>window.__printCalls.length)).toBe(1);
  const print=await page.evaluate(()=>window.__printCalls[0]);expect(print.title).toContain(fixture.title);expect(print.font).toBe('20pt');
  await expect(page.getByTitle('打印排练谱')).toHaveCount(0);
 });
 await run('Mobile multi-select works across separate groups and toolbar buttons',async()=>{
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'多选加花',exact:true}).click();await note('first-0').click();await note('second-1').click();await expect(selected()).toHaveCount(2);
  await page.getByLabel('加花下划线',{exact:true}).selectOption('2');await save();expect(fixture.manualFills[0].notes[0].lines).toBe(2);expect(fixture.manualFills[1].notes[1].lines).toBe(2);
  await page.getByRole('button',{name:'删除选中加花',exact:true}).click();await expect(page.locator('.manual-fill-note')).toHaveCount(10);await page.keyboard.press('Control+z');await save();
  await page.screenshot({path:path.join(out,'batch-editor-mobile.png'),fullPage:true});
 });
 expect(errors).toEqual([]);
}catch(e){failure=e.stack;await page.screenshot({path:path.join(out,'batch-editor-failure.png'),fullPage:true}).catch(()=>{});}
finally{console.log(JSON.stringify({checks,errors,failure,pdfRequests,saves},null,2));await fs.writeFile(path.join(out,'batch-editor-results.json'),JSON.stringify({checks,errors,failure,pdfRequests,saves},null,2));await browser.close();}
if(failure||errors.length)process.exitCode=1;
