import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {batchFixture,testWav} from './batch-fixture.mjs';
import {exportThreeTrackHtml} from '../dist-renderer/score.mjs';
const out=path.resolve('../docs/verification'),pdfOut=path.resolve('../output/pdf');
await fs.mkdir(out,{recursive:true});await fs.mkdir(pdfOut,{recursive:true});
let fixture=batchFixture(),saves=0;const results=[],errors=[];
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1050}});
page.on('pageerror',e=>errors.push(e.message));
const wav=testWav();
await page.route('**/media/qa/**',r=>r.fulfill({contentType:'audio/wav',body:wav}));
await page.route('**/api/projects**',r=>{
  const u=new URL(r.request().url()).pathname;
  if(u==='/api/projects')return r.fulfill({json:[fixture]});
  if(r.request().method()==='PUT'){fixture={...r.request().postDataJSON(),revision:fixture.revision+1};saves++;}
  return r.fulfill({json:fixture});
});
const run=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name);};
const save=async()=>{const before=saves;await page.keyboard.press('Control+s');await expect.poll(()=>saves).toBeGreaterThan(before);};
try{
 await page.goto(process.env.BASSCHART_TEST_URL||'http://127.0.0.1:8001');await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();
 await run('Notes autosave while editing, one-session undo/redo, cancel after autosave',async()=>{
  await page.getByRole('button',{name:'编辑备注',exact:true}).click();
  await page.getByRole('textbox',{name:'效果器预设',exact:true}).fill('03 号 · 温暖指弹');
  await page.getByRole('textbox',{name:'弹奏方式',exact:true}).fill('主歌轻指弹\n副歌加强力度');
  await page.getByRole('textbox',{name:'注意事项',exact:true}).fill('第二遍副歌后停两拍，尾奏看鼓手');
  await expect.poll(()=>fixture.performanceNotes?.reminders).toBe('第二遍副歌后停两拍，尾奏看鼓手');
  await expect(page.getByRole('textbox',{name:'注意事项',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.keyboard.press('Control+z');await save();expect(fixture.performanceNotes?.effectsPreset??'').toBe('');
  await page.keyboard.press('Control+Shift+z');await save();expect(fixture.performanceNotes.effectsPreset).toBe('03 号 · 温暖指弹');
  await page.getByRole('button',{name:'编辑备注',exact:true}).click();
  await page.getByRole('textbox',{name:'效果器预设',exact:true}).fill('99 临时');
  await expect.poll(()=>fixture.performanceNotes.effectsPreset).toBe('99 临时');
  await page.getByRole('button',{name:'取消',exact:true}).click();await save();expect(fixture.performanceNotes.effectsPreset).toBe('03 号 · 温暖指弹');
 });
 await run('IME is not saved mid-composition; spaces remain text; navigation keeps audio alive',async()=>{
  await page.getByRole('button',{name:'编辑备注',exact:true}).click();const input=page.getByRole('textbox',{name:'注意事项',exact:true});
  const before=fixture.performanceNotes.reminders;
  await input.dispatchEvent('compositionstart');await input.fill('拼音输入中的草稿');
  await page.waitForTimeout(2000);expect(fixture.performanceNotes.reminders).toBe(before);
  await input.dispatchEvent('compositionend');await expect.poll(()=>fixture.performanceNotes.reminders).toBe('拼音输入中的草稿');
  await input.press('End');await input.press('Space');await input.press('Space');await expect(page.locator('.play-button svg')).toHaveClass(/lucide-play/);
  await page.getByRole('button',{name:'完成',exact:true}).click();await page.locator('.play-button').click();
  await page.waitForTimeout(300);const first=Number(await page.getByRole('slider',{name:'播放位置',exact:true}).inputValue());
  await page.getByRole('button',{name:'曲库',exact:true}).click();await page.waitForTimeout(400);
  await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();
  await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/);
  expect(Number(await page.getByRole('slider',{name:'播放位置',exact:true}).inputValue())).toBeGreaterThan(first);
  await page.locator('.play-button').click();
 });
 await run('Modal exit is inert, rapid reopen works, reduced motion and mobile notes',async()=>{
  await page.keyboard.press('Control+Shift+e');await expect(page.getByRole('dialog',{name:'导出曲谱',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+e');
  await expect(page.getByRole('dialog',{name:'导出曲谱',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.locator('.modal')).toHaveCount(0);
  await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('F1');
  expect(await page.locator('.command-panel').evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
  await page.keyboard.press('Escape');await expect(page.locator('.command-panel')).toHaveCount(0);
  await save();await page.reload();await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();
  await expect(page.locator('.notes-summary')).toContainText('03 号 · 温暖指弹');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'performance-notes-mobile.png'),fullPage:true});
  expect(await page.locator('.performance-notes').evaluate(el=>el.getBoundingClientRect().right<=innerWidth)).toBe(true);
  await page.setViewportSize({width:1440,height:1050});await page.screenshot({path:path.join(out,'performance-notes-desktop.png'),fullPage:true});
 });
 for(const kind of ['landscape','portrait','mono','long'])await run('PDF performance header '+kind,async()=>{
  const p=batchFixture();p.title='演出备注 · 大字排练谱';p.key='D';p.originalKey='C';p.keyAnalysis={state:'complete',stage:'人工确认',progress:100,warnings:[],candidates:[],detectedKey:null,confirmed:true};
  p.performanceNotes={effectsPreset:'03 号 · 温暖指弹',technique:'主歌轻指弹\n副歌加强力度',reminders:kind==='long'?Array.from({length:180},(_,i)=>`第 ${i+1} 项：尾奏看鼓手，保持节奏。`).join('\n'):'第二遍副歌后停两拍，尾奏看鼓手',includeInExport:true};
  p.scoreStyle={printPreset:'custom',printOrientation:kind==='portrait'?'portrait':'landscape',printBarsPerRow:kind==='portrait'?2:4,printColor:kind!=='mono'};
  const pdfPage=await browser.newPage({viewport:{width:1440,height:1000}});pdfPage.on('pageerror',e=>errors.push(e.message));await pdfPage.emulateMedia({media:'print'});
  await pdfPage.setContent(exportThreeTrackHtml(p));await pdfPage.evaluate(()=>window.__scoreReady);
  const notes=await pdfPage.locator('.print-pages .performance-note').allTextContents();
  expect(notes.join('').replace(/\s/g,'')).toBe(('效果器预设：'+p.performanceNotes.effectsPreset+'弹奏方式：'+p.performanceNotes.technique+'注意事项：'+p.performanceNotes.reminders).replace(/\s/g,''));
  expect(await pdfPage.locator('.print-pages .performance-meta').innerText()).toContain('调性：D（原调 C）');
  const physicalWidth=await pdfPage.locator('.print-page').first().evaluate(e=>e.getBoundingClientRect().width);expect(Math.round(physicalWidth)).toBe(kind==='portrait'?703:1032);
  const pages=await pdfPage.locator('.print-page').count();expect(await pdfPage.locator('.print-pages .continuation-header').count()).toBe(pages-1);
  const overflow=await pdfPage.locator('.print-page').evaluateAll(pages=>pages.flatMap(p=>[...p.children].filter(c=>!c.classList.contains('print-page-number')&&c.getBoundingClientRect().bottom>p.getBoundingClientRect().bottom-15).map(c=>c.className)));
  expect(overflow).toEqual([]);
  expect(await pdfPage.locator('.print-pages .performance-note').first().evaluate(e=>getComputedStyle(e).fontSize)).toBe('18.6667px');
  expect(await pdfPage.locator('.print-pages .reminders').first().evaluate(e=>getComputedStyle(e).color)).toBe(kind==='mono'?'rgb(0, 0, 0)':'rgb(198, 40, 40)');
  expect((await pdfPage.locator('.print-pages .event.lyric').allTextContents()).join('')).toBe(p.lyrics.map(l=>l.text).join(''));
  await pdfPage.locator('.print-page').first().screenshot({path:path.join(out,`performance-pdf-${kind}.png`)});
  await pdfPage.pdf({path:path.join(pdfOut,`performance-notes-${kind}.pdf`),preferCSSPageSize:true,printBackground:true});await pdfPage.close();
 });
 expect(errors).toEqual([]);await fs.writeFile(path.join(out,'performance-notes-results.json'),JSON.stringify({results,errors},null,2));
}catch(e){await page.screenshot({path:path.join(out,'performance-notes-failure.png'),fullPage:true});throw e;}finally{await browser.close();}
