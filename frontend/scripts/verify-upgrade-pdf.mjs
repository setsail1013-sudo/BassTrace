import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {batchFixture,testWav} from './batch-fixture.mjs';
import {exportThreeTrackHtml} from '../dist-renderer/score.mjs';

const output=path.resolve('../output/pdf'),qa=path.resolve('../docs/verification');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const results=[];
try{
 for(const kind of ['landscape','portrait','mono','long']){
  const p=batchFixture();p.title='字词标记验收';p.key='D';p.originalKey='D';p.keyAnalysis={state:'complete',stage:'',progress:100,warnings:[],detectedKey:'D',candidates:[],confirmed:true};
  p.lyricAnchors=[{id:'link',lyricId:'lyric-a',startOffset:2,endOffset:4,text:'轻轻',eventId:'bass-1',track:'bass'}];
  p.scoreStyle={...p.scoreStyle,printOrientation:kind==='portrait'?'portrait':'landscape',printBarsPerRow:kind==='portrait'?2:4,printColor:kind!=='mono'};
  if(kind==='long'){p.lyrics[0].text='晚风轻轻'+('长歌词跨页，所有字词完整显示。'.repeat(130));p.lyricAnchors.push({id:'later',lyricId:'lyric-a',startOffset:170,endOffset:174,text:p.lyrics[0].text.slice(170,174),eventId:'bass-1',track:'bass'});}
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.emulateMedia({media:'print'});await page.setContent(exportThreeTrackHtml(p));await page.evaluate(()=>window.__scoreReady);
  expect(errors).toEqual([]);const marks=page.locator('.print-pages .lyric-change-mark');expect(await marks.count()).toBeGreaterThanOrEqual(p.lyricAnchors.length);expect((await marks.allTextContents()).join('')).toContain('轻轻');
  expect((await page.locator('.print-pages .event.lyric').allTextContents()).join('')).toBe(p.lyrics.map(l=>l.text).join(''));
  const color=await marks.first().evaluate(el=>getComputedStyle(el).color);expect(color).toBe(kind==='mono'?'rgb(0, 0, 0)':'rgb(29, 78, 216)');
  if(kind==='mono')expect(await marks.first().evaluate(el=>getComputedStyle(el).textDecorationLine)).toContain('underline');
  const measured={kind,pages:await page.locator('.print-page').count(),marks:await marks.count(),color};expect(measured.pages).toBeGreaterThan(0);
  await page.screenshot({path:path.join(qa,`upgrade-pdf-${kind}.png`),fullPage:true});await page.pdf({path:path.join(output,`upgrade-${kind}.pdf`),preferCSSPageSize:true,printBackground:true});
  results.push(measured);await page.close();console.log('PASS PDF '+kind);
 }
 // Check the real HTTP export accepts the current snapshot without saving it.
 const form=new FormData();form.append('file',new Blob([testWav()],{type:'audio/wav'}),'pdf-upgrade.wav');const created=await fetch('http://127.0.0.1:8002/api/projects/upload',{method:'POST',body:form});const saved=await created.json();
 try{const p={...batchFixture(),id:saved.id,lyricAnchors:[{id:'a',lyricId:'lyric-a',startOffset:2,endOffset:4,text:'轻轻',eventId:'bass-1',track:'bass'}]};
  const response=await fetch(`http://127.0.0.1:8002/api/projects/${saved.id}/export/pdf`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:p,mode:'chart',degree:false})});
  if(!response.ok)throw Error(await response.text());const bytes=Buffer.from(await response.arrayBuffer());expect(bytes.subarray(0,4).toString()).toBe('%PDF');await fs.writeFile(path.join(output,'upgrade-http.pdf'),bytes);
  const after=await(await fetch(`http://127.0.0.1:8002/api/projects/${saved.id}`)).json();expect(after.revision).toBe(saved.revision);expect(after.lyrics).toEqual([]);console.log('PASS HTTP PDF snapshot without saving');
 }finally{await fetch(`http://127.0.0.1:8002/api/projects/${saved.id}`,{method:'DELETE'});await fetch(`http://127.0.0.1:8002/api/trash/${saved.id}`,{method:'DELETE'});}
 await fs.writeFile(path.join(qa,'upgrade-pdf-results.json'),JSON.stringify(results,null,2));
}finally{await browser.close();}
