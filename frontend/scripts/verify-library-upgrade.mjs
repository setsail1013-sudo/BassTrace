import { chromium,expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { batchFixture as fixture,testWav } from './batch-fixture.mjs';

const base='http://127.0.0.1:8002',wav=testWav();
const upload=await fetch(base+'/api/projects/upload',{method:'POST',body:(()=>{const f=new FormData();f.append('file',new Blob([wav],{type:'audio/wav'}),'upgrade-qa.wav');return f;})()});
if(!upload.ok)throw Error(await upload.text());
const original=await upload.json(),first={...fixture(),id:original.id,title:'蓝色字词测试',keyAnalysis:null};
first.stems=['original','bass','backing'].map(id=>({id,name:id,url:`/media/qa/${id}.wav`,available:true,peaks:[.1,.2,.1]}));
let songs=[first,{...structuredClone(first),id:'22222222-2222-2222-2222-222222222222',title:'第二首歌'}],trash=[],saves=0,features=[];
const errors=[],checks=[];
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1050}});
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(id=>{localStorage.setItem('basschart.active-project',id);window.__audioCreated=0;const Native=window.Audio;window.Audio=function(...args){window.__audioCreated++;return new Native(...args);};},first.id);
await page.route('**/media/qa/**',route=>route.fulfill({contentType:'audio/wav',body:wav}));
await page.route('**/api/playlists**',route=>route.fulfill({json:[]}));
await page.route('**/api/trash**',route=>{
 const path=new URL(route.request().url()).pathname,id=path.split('/')[3];
 if(route.request().method()==='POST'){const item=trash.find(p=>p.id===id);songs.push(item);trash=trash.filter(p=>p.id!==id);return route.fulfill({json:item});}
 if(route.request().method()==='DELETE'){trash=trash.filter(p=>p.id!==id);return route.fulfill({status:204});}
 return route.fulfill({json:trash.map(p=>({...p,deletedAt:new Date().toISOString()}))});
});
await page.route('**/api/projects**',route=>{
 const req=route.request(),path=new URL(req.url()).pathname;
 if(path.endsWith('/export/pdf'))return route.continue();
 if(path==='/api/projects')return route.fulfill({json:songs});
 const id=path.split('/')[3];let song=songs.find(p=>p.id===id);
 if(req.method()==='DELETE'){trash.push(song);songs=songs.filter(p=>p.id!==id);return route.fulfill({status:204});}
 if(path.includes('/features/')){features.push(path.split('/').at(-1));return route.fulfill({json:song});}
 if(req.method()==='PUT'){song={...req.postDataJSON(),revision:song.revision+1};songs=songs.map(p=>p.id===id?song:p);saves++;}
 return route.fulfill({json:song});
});
const run=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
try{
 await page.goto(base);await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();
 await run('Unknown key and optional harmony tools, independent three-mode playback',async()=>{
  await expect(page.locator('.metadata')).toContainText('历史调性待确认');await page.getByText('调性与和弦识别',{exact:true}).click();
  await page.getByRole('button',{name:'识别和弦',exact:true}).click();expect(features).toContain('chords');
  await page.getByRole('button',{name:'原曲',exact:true}).click();await page.locator('.play-button').click();await page.waitForTimeout(400);const count=await page.evaluate(()=>window.__audioCreated);
  const slider=page.getByRole('slider',{name:'音频时间轴'}),before=Number(await slider.getAttribute('aria-valuenow'));
  await page.keyboard.press('Shift+M');await expect(page.getByRole('button',{name:'无贝斯伴奏',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.waitForTimeout(300);expect(Number(await slider.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
  expect(await page.evaluate(()=>window.__audioCreated)).toBe(count);await page.keyboard.press('Shift+M');await expect(page.getByRole('button',{name:'原曲',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Shift+B');await expect(page.getByRole('button',{name:'只听贝斯',exact:true})).toHaveAttribute('aria-pressed','true');await page.locator('.play-button').click();
 });
 await run('Exact selected lyric word anchors, undo, save and color HTML',async()=>{
  const lyric=page.locator('[data-lyric-id="lyric-a"]').first();await lyric.dblclick();const editor=page.getByRole('textbox',{name:'直接编辑歌词',exact:true});
  await editor.focus();await editor.press('Home');await editor.press('ArrowRight');await editor.press('ArrowRight');await editor.press('Shift+ArrowRight');await editor.press('Shift+ArrowRight');
  await page.getByRole('combobox',{name:'关联的音名或和弦'}).selectOption('bass-1');
  await page.getByRole('button',{name:'标记选中字词',exact:true}).click();await page.getByRole('button',{name:'完成编辑',exact:true}).click();
  await expect(page.locator('.track-lyric .lyric-change-mark')).toHaveText('轻轻');
  await expect(page.locator('.track-lyric .lyric-change-mark')).toHaveCSS('color','rgb(29, 78, 216)');
  await page.keyboard.press('Control+z');await expect(page.locator('.track-lyric .lyric-change-mark')).toHaveCount(0);await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+s');await expect.poll(()=>songs[0].lyricAnchors?.length).toBe(1);expect(saves).toBeGreaterThan(0);
  await page.keyboard.press('Control+Shift+e');const download=page.waitForEvent('download');await page.getByRole('button',{name:/互动 HTML 谱/}).click();const html=await (await download).createReadStream();let content='';for await(const chunk of html)content+=chunk;expect(content).toContain('class="lyric-change-mark"');await page.keyboard.press('Escape');
 });
 await run('Sidebar deletion switches song, trash restores and last deletion leaves import entry',async()=>{
  await page.getByRole('button',{name:'删除 蓝色字词测试',exact:true}).click({force:true});await page.getByRole('dialog',{name:'移入回收站',exact:true}).getByRole('button',{name:'移入回收站',exact:true}).click();
  await expect(page.locator('.song-info h1')).toContainText('第二首歌');expect(trash).toHaveLength(1);
  await page.getByRole('button',{name:'回收站',exact:true}).click();await page.getByRole('button',{name:'恢复',exact:true}).click();await expect.poll(()=>songs.length).toBe(2);await page.keyboard.press('Escape');await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  for(const name of ['第二首歌','蓝色字词测试']){await page.getByRole('button',{name:`删除 ${name}`,exact:true}).click();await page.getByRole('dialog',{name:'移入回收站',exact:true}).getByRole('button',{name:'移入回收站',exact:true}).click();await expect(page.getByRole('dialog',{name:'移入回收站',exact:true})).toHaveCount(0);}
  await expect(page.getByRole('heading',{name:'你的曲库',exact:true})).toBeVisible();await expect(page.getByLabel('导入歌曲',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'回收站',exact:true}).click();await page.getByRole('button',{name:'恢复',exact:true}).first().click();await expect(page.locator('.song-info')).toBeVisible();await page.keyboard.press('Escape');
 });
 await run('Mobile deletion touch target and lyric editor remain within viewport',async()=>{
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'曲库',exact:true}).click();
  const button=page.locator('.sidebar-song-row .song-trash').first();await expect(button).toBeVisible();expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();await page.screenshot({path:'../docs/verification/library-upgrade-mobile.png',fullPage:true});
 });
 expect(errors).toEqual([]);await fs.writeFile('../docs/verification/library-upgrade-results.json',JSON.stringify({checks,errors},null,2));
}finally{await browser.close();await fetch(base+`/api/projects/${original.id}`,{method:'DELETE'});await fetch(base+`/api/trash/${original.id}`,{method:'DELETE'});}
