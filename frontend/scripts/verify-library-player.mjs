import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {batchFixture,testWav} from './batch-fixture.mjs';
const out=fileURLToPath(new URL('../../docs/verification/',import.meta.url));await fs.mkdir(out,{recursive:true});
const first=batchFixture();first.title='B Song';first.artist='周杰伦';first.stems.push({...first.stems[0],id:'bass',name:'贝斯',url:'/media/qa/bass.wav'});
let songs=[first,{...structuredClone(first),id:'11111111-1111-1111-1111-111111111111',title:'阿杜 - A Song',artist:''},{...structuredClone(first),id:'22222222-2222-2222-2222-222222222222',title:'C Song',artist:'',stems:first.stems.slice(0,1)}];
let playlists=[],failUpdate=false,saves=0;const errors=[],checks=[];
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.__audios=[];const AudioClass=window.Audio;window.Audio=function(...args){const audio=new AudioClass(...args);window.__audios.push(audio);return audio;};});
const wav=testWav();await page.route('**/media/qa/**',r=>{const range=r.request().headers().range?.match(/bytes=(\d+)-(\d*)/);if(range){const start=Number(range[1]),end=Math.min(wav.length-1,range[2]?Number(range[2]):wav.length-1);return r.fulfill({status:206,body:wav.subarray(start,end+1),contentType:'audio/wav',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${wav.length}`}});}return r.fulfill({body:wav,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes'}});});
await page.route('**/api/projects**',r=>{
  const req=r.request(),u=new URL(req.url()).pathname;if(u==='/api/projects')return r.fulfill({json:songs});
  const id=u.split('/').at(-1);if(req.method()==='PUT'){songs=songs.map(p=>p.id===id?{...req.postDataJSON(),revision:p.revision+1}:p);saves++;}
  return r.fulfill({json:songs.find(p=>p.id===id)||songs[0]});
});
await page.route('**/api/playlists**',r=>{
  const req=r.request(),method=req.method(),id=new URL(req.url()).pathname.split('/').at(-1);
  if(method==='GET')return r.fulfill({json:playlists});
  if(method==='POST'){const next={...req.postDataJSON(),id:'list-'+(playlists.length+1)};playlists.push(next);return r.fulfill({status:201,json:next});}
  if(method==='PUT'){if(failUpdate)return r.fulfill({status:503,json:{detail:'模拟保存失败，请重试'}});const next=req.postDataJSON();playlists=playlists.map(p=>p.id===id?next:p);return r.fulfill({json:next});}
  if(method==='DELETE'){playlists=playlists.filter(p=>p.id!==id);return r.fulfill({status:204});}
});
const run=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
try{
 await page.goto(process.env.BASSCHART_TEST_URL||'http://127.0.0.1:8001');await expect(page.locator('.sidebar-song-row > button:first-child')).toHaveCount(3);
 await run('A-Z title and artist ordering, filename artist inference, search',async()=>{
  expect(await page.locator('.sidebar-songs strong').allTextContents()).toEqual(['A Song','B Song','C Song']);
  await page.getByRole('button',{name:'曲库排序',exact:true}).click();await page.getByRole('menuitemradio',{name:'歌手 A–Z',exact:true}).click();
  expect(await page.locator('.sidebar-songs small').allTextContents()).toEqual(['阿杜','周杰伦','未知歌手']);
  await page.getByRole('textbox',{name:'搜索曲库',exact:true}).fill('阿杜');await expect(page.locator('.sidebar-song-row > button:first-child')).toHaveCount(1);
  await page.getByRole('textbox',{name:'搜索曲库',exact:true}).fill('');
 });
 await run('Create, add/remove, rename, retry errors, reload and delete playlist without deleting songs',async()=>{
  await page.getByRole('button',{name:'新建歌单',exact:true}).click();await page.getByRole('textbox',{name:'新歌单名称'}).fill('周末演出');await page.getByRole('button',{name:'创建',exact:true}).click();
  await page.getByRole('button',{name:'添加歌曲',exact:true}).click();await page.getByRole('checkbox',{name:'将 A Song 加入歌单',exact:true}).check();
  await page.getByRole('checkbox',{name:'将 B Song 加入歌单',exact:true}).check();expect(playlists[0].projectIds).toHaveLength(2);
  failUpdate=true;await page.getByRole('checkbox',{name:'将 C Song 加入歌单',exact:true}).check();await expect(page.locator('.library-view .library-error')).toContainText('保存失败');expect(playlists[0].projectIds).toHaveLength(2);
  failUpdate=false;await page.getByRole('checkbox',{name:'将 C Song 加入歌单',exact:true}).check();expect(playlists[0].projectIds).toHaveLength(3);
  await page.getByRole('button',{name:'完成选曲',exact:true}).click();await page.getByRole('button',{name:'从歌单移除 C Song'}).click();expect(playlists[0].projectIds).toHaveLength(2);
  await page.getByRole('button',{name:'重命名歌单',exact:true}).click();await page.getByRole('textbox',{name:'歌单名称',exact:true}).fill('演出 Set 1');await page.getByRole('button',{name:'保存名称',exact:true}).click();
  await page.reload();await expect(page.locator('.playlist-nav')).toContainText('演出 Set 1');await page.locator('.playlist-nav button').filter({hasText:'演出 Set 1'}).click();
  await expect(page.locator('.library-song-open')).toHaveCount(2);await page.getByRole('button',{name:'删除歌单',exact:true}).click();await page.locator('.playlist-delete').getByRole('button',{name:'删除歌单',exact:true}).click();
  await expect(page.locator('.library-song-open')).toHaveCount(3);expect(songs).toHaveLength(3);expect(saves).toBe(0);
 });
 await run('Floating stem switch keeps playback and audio instances; arrows jump bars without editing selected fill',async()=>{
  await page.locator('.sidebar-song-row > button:first-child').filter({hasText:'B Song'}).click();await page.locator('.manual-fill-note').first().click();
  const original=JSON.stringify(songs[0].manualFills),count=await page.evaluate(()=>window.__audios.length);
  await page.keyboard.press('Space');await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/);
  await page.keyboard.press('Shift+B');await expect(page.locator('.listen-dock').getByRole('button',{name:'原曲',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Shift+B');await expect(page.locator('.listen-dock').getByRole('button',{name:'只听贝斯',exact:true})).toHaveAttribute('aria-pressed','true');
  expect(await page.evaluate(()=>window.__audios.length)).toBe(count);await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/);
  const wave=page.getByRole('slider',{name:'音频时间轴',exact:true});await wave.scrollIntoViewIfNeeded();const box=await wave.boundingBox();await wave.click({position:{x:box.width*5.1/48,y:10}});
  await expect.poll(()=>page.evaluate(()=>window.__audios.at(-2).currentTime)).toBeGreaterThanOrEqual(5);await page.keyboard.press('ArrowRight');await expect.poll(async()=>Number(await page.getByRole('slider',{name:'播放位置',exact:true}).inputValue())).toBeGreaterThanOrEqual(6);
  expect(Number(await page.getByRole('slider',{name:'播放位置',exact:true}).inputValue())).toBeLessThan(7);
  await page.keyboard.press('ArrowLeft');await expect.poll(async()=>Number(await page.getByRole('slider',{name:'播放位置',exact:true}).inputValue())).toBeGreaterThanOrEqual(4);expect(Number(await page.getByRole('slider',{name:'播放位置',exact:true}).inputValue())).toBeLessThan(5);
  await page.locator('.manual-fill-note').first().focus();await page.keyboard.press('ArrowRight');const saved=saves;await page.keyboard.press('Control+s');await expect.poll(()=>saves).toBeGreaterThan(saved);expect(JSON.stringify(songs[0].manualFills)).toBe(original);
  const before=await page.locator('.listen-dock').boundingBox();await page.evaluate(()=>scrollTo(0,1000));const after=await page.locator('.listen-dock').boundingBox();expect(after.y).toBe(before.y);
  await page.locator('.play-button').click();await page.evaluate(()=>scrollTo(0,0));
 });
 await run('Input shortcuts stay text, unavailable bass disabled, desktop and mobile layout',async()=>{
  await page.getByRole('button',{name:'编辑备注',exact:true}).click();const field=page.getByRole('textbox',{name:'效果器预设',exact:true});await field.fill('123');await field.press('Home');await field.press('ArrowRight');await field.press('Shift+B');await expect(field).toHaveValue('1B23');await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(250);await page.screenshot({path:path.join(out,'library-player-desktop.png')});
  await page.locator('.sidebar-song-row > button:first-child').filter({hasText:'C Song'}).click();await expect(page.locator('.listen-dock').getByRole('button',{name:'只听贝斯',exact:true})).toBeDisabled();
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'曲库',exact:true}).click();await page.waitForTimeout(250);await page.screenshot({path:path.join(out,'library-player-mobile.png'),fullPage:true});const brand=await page.locator('.brand').boundingBox(),nav=await page.locator('.sidebar nav').boundingBox();expect(brand.x+brand.width).toBeLessThanOrEqual(nav.x);
  expect(await page.locator('.listen-dock').evaluate(e=>e.getBoundingClientRect().right<=innerWidth)).toBe(true);
  await expect(page.getByRole('textbox',{name:'搜索曲库',exact:true})).toBeVisible();
 });
 expect(errors).toEqual([]);await fs.writeFile(path.join(out,'library-player-results.json'),JSON.stringify({checks,errors},null,2));
}catch(e){await page.screenshot({path:path.join(out,'library-player-failure.png'),fullPage:true});throw e;}finally{await browser.close();}
