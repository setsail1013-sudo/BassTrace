import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {batchFixture} from './batch-fixture.mjs';
import {exportThreeTrackHtml} from '../dist-renderer/score.mjs';
const out=path.resolve('../output/pdf'),qa=path.resolve('../docs/verification');await fs.mkdir(out,{recursive:true});await fs.mkdir(qa,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const results=[];
try{
 for(const kind of ['landscape','portrait','mono','dense']){
  console.log('Checking PDF '+kind);
  const fixture=batchFixture();fixture.scoreStyle={lyricFontSize:24,lyricPrintSize:18,topPrintSize:22,fillPrintSize:16,printBarsPerRow:kind==='portrait'?2:4,printPreset:'custom',printOrientation:kind==='portrait'?'portrait':'landscape',printColor:kind!=='mono',colors:{lyrics:'#1D1D1F',top:'#1D4ED8',fill:'#167047',mark:'#C62828'}};
  fixture.manualFills[0].notes[0].notation={cut:true,accent:true,connection:{kind:'slideUp',targetNoteId:'first-1'}};fixture.manualFills[0].notes[1].octave=2;
  if(kind==='dense'){
   fixture.bassEvents=[{...fixture.bassEvents[0],end:.5},{...fixture.bassEvents[1],start:.5,end:48}];
   fixture.manualFills=[{id:'long',notes:Array.from({length:96},(_,i)=>({id:`dense-${i}`,digit:i%7+1,start:i*.125,end:(i+1)*.125,lines:2,octave:i%5-2,notation:{cut:i%3===0,accent:i%4===0,connection:i<95?{kind:'hammer',targetNoteId:`dense-${i+1}`}:null}}))}];
   fixture.lyrics[0].text='大字歌词完整显示，不遗漏任何一句。'.repeat(65);
  }
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.emulateMedia({media:'print'});await page.setContent(exportThreeTrackHtml(fixture));await page.evaluate(()=>window.__scoreReady);
  expect(errors).toEqual([]);await expect(page.locator('.print-pages')).toBeVisible();
  expect((await page.locator('.print-pages .event.lyric').allTextContents()).join('')).toBe(fixture.lyrics.map(l=>l.text).join(''));
  expect((await page.locator('.print-pages .event.fill').evaluateAll(nodes=>nodes.map(n=>n.dataset.id))).sort()).toEqual(fixture.manualFills.flatMap(g=>g.notes.map(n=>n.id)).sort());
  const measured=await page.evaluate(()=>({pages:document.querySelectorAll('.print-page').length,top:getComputedStyle(document.querySelector('.print-pages .event.chord')).fontSize,lyric:getComputedStyle(document.querySelector('.print-pages .event.lyric')).fontSize,firstHasMusic:!!document.querySelector('.print-page .event'),width:document.querySelector('.print-page').getBoundingClientRect().width,overlap:[...document.querySelectorAll('.print-page')].flatMap(p=>[...p.children].filter(c=>!c.classList.contains('print-page-number')&&c.getBoundingClientRect().bottom>p.getBoundingClientRect().bottom-15).map(c=>c.className))}));
  expect(measured.firstHasMusic).toBe(true);expect(measured.top).toBe('29.3333px');expect(measured.lyric).toBe('24px');expect(measured.overlap).toEqual([]);
  await page.screenshot({path:path.join(qa,`batch-pdf-${kind}.png`),fullPage:true});
  await page.pdf({path:path.join(out,`batch-score-${kind}.pdf`),preferCSSPageSize:true,printBackground:true});
  results.push({kind,...measured});await page.close();
 }
 await fs.writeFile(path.join(qa,'batch-pdf-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
