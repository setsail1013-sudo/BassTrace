import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {batchFixture,testWav} from './batch-fixture.mjs';
import {exportThreeTrackHtml} from '../dist-renderer/score.mjs';
const out=fileURLToPath(new URL('../../docs/verification/',import.meta.url));await fs.mkdir(out,{recursive:true});
const first=batchFixture();first.title='未知歌手 - 测试歌';first.artist='';
let songs=[first,{...structuredClone(first),id:'22222222-2222-2222-2222-222222222222',title:'另一首歌',artist:'Bob'}],saves=0;
const musical=JSON.stringify([first.lyrics,first.manualFills,first.bassEvents,first.chords]),checks=[],errors=[];
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{localStorage.setItem('basschart.active-project','batch-qa');window.__audios=[];const Native=window.Audio;window.Audio=function(...args){const a=new Native(...args);window.__audios.push(a);return a;};});
await page.route('**/api/playlists**',r=>r.fulfill({json:[]}));
await page.route('**/media/qa/**',r=>r.fulfill({contentType:'audio/wav',body:testWav()}));
await page.route('**/api/projects**',r=>{const req=r.request(),u=new URL(req.url()).pathname;if(u==='/api/projects')return r.fulfill({json:songs});const id=u.split('/').at(-1);if(req.method()==='PUT'){songs=songs.map(p=>p.id===id?{...req.postDataJSON(),revision:p.revision+1}:p);saves++;}return r.fulfill({json:songs.find(p=>p.id===id)||songs[0]});});
const run=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
const dialog=()=>page.getByRole('dialog',{name:'编辑歌曲信息',exact:true});
const open=async()=>{await page.getByRole('button',{name:'编辑歌曲信息',exact:true}).click();await expect(dialog()).toBeVisible();};
const save=async()=>{const before=saves;await page.keyboard.press('Control+s');await expect.poll(()=>saves).toBeGreaterThan(before);};
try{
 await page.goto(process.env.BASSCHART_TEST_URL||'http://127.0.0.1:8001');await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();
 await run('Minimal sidebar, keyboard sort menu, compact notes and jump controls',async()=>{
  await expect(page.locator('.sidebar-library>.library-caption')).toHaveText('曲库');await expect(page.getByRole('textbox',{name:'搜索曲库',exact:true})).not.toHaveAttribute('placeholder');
  await page.getByRole('button',{name:'曲库排序',exact:true}).focus();await page.keyboard.press('Space');await expect(page.getByRole('menu')).toBeVisible();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'曲库排序'})).toHaveAttribute('title','排序：歌手 A–Z');await expect(page.locator('.play-button svg')).toHaveClass(/lucide-play/);
  await page.getByRole('button',{name:'曲库排序'}).click();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'曲库排序'})).toBeFocused();
  const notes=await page.locator('.performance-notes').boundingBox();expect(notes.height).toBeLessThan(60);expect((await page.getByRole('button',{name:'编辑备注',exact:true}).boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('.performance-notes')).not.toContainText('添加效果器');await expect(page.locator('.listen-dock')).not.toContainText('跳小节');await expect(page.getByRole('button',{name:'上一个小节',exact:true})).toBeVisible();
 });
 await run('Song form validation, cancellation, composition and input keyboard protection',async()=>{
  await page.getByRole('button',{name:'添加歌手',exact:true}).click();await expect(dialog().getByRole('textbox',{name:'歌手',exact:true})).toHaveValue('');
  await dialog().getByRole('textbox',{name:'歌名',exact:true}).fill('  ');await expect(dialog().getByRole('button',{name:'保存',exact:true})).toBeDisabled();await dialog().getByRole('button',{name:'取消',exact:true}).click();await expect(dialog()).toHaveCount(0);expect(saves).toBe(0);
  await open();const artist=dialog().getByRole('textbox',{name:'歌手',exact:true});await artist.dispatchEvent('compositionstart');await artist.fill('王菲');await artist.press('Enter');await expect(dialog()).toBeVisible();expect(saves).toBe(0);await artist.dispatchEvent('compositionend');await artist.press('End');await artist.press('Space');await artist.press('ArrowLeft');await artist.press('Shift+B');await expect(artist).toHaveValue('王菲B ');await expect(page.locator('.play-button svg')).toHaveClass(/lucide-play/);await artist.press('Escape');await expect(dialog()).toHaveCount(0);
 });
 await run('Artist-only edit preserves title and audio; immediate library updates and one-step undo/redo',async()=>{
  await page.locator('.play-button').click();await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/);const count=await page.evaluate(()=>window.__audios.length);
  await open();await dialog().getByRole('textbox',{name:'歌手',exact:true}).fill('  Adele / 王菲  ');await dialog().getByRole('button',{name:'保存',exact:true}).click();await expect(dialog()).toHaveCount(0);
  await expect(page.locator('.sidebar-song-row > button:first-child').first()).toContainText('Adele / 王菲');await expect(page.locator('.song-info h1')).toContainText(first.title);expect(await page.evaluate(()=>window.__audios.length)).toBe(count);await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/);
  await page.keyboard.press('Control+z');await expect(page.getByRole('button',{name:'添加歌手',exact:true})).toBeVisible();await expect(page.locator('.sidebar-songs')).not.toContainText('Adele');await page.keyboard.press('Control+Shift+z');await expect(page.locator('.sidebar-songs')).toContainText('Adele / 王菲');
  await expect.poll(()=>songs[0].artist).toBe('Adele / 王菲');await page.locator('.play-button').click();expect(songs[0].title).toBe(first.title);expect(JSON.stringify([songs[0].lyrics,songs[0].manualFills,songs[0].bassEvents,songs[0].chords])).toBe(musical);
  await page.getByRole('textbox',{name:'搜索曲库',exact:true}).fill('Adele');await expect(page.locator('.sidebar-song-row > button:first-child')).toHaveCount(1);await page.getByRole('textbox',{name:'搜索曲库',exact:true}).fill('');
  await page.reload();await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();await expect(page.locator('.song-artist-edit')).toHaveText('Adele / 王菲');
 });
 await run('Command entry, notes preservation, export artist and mobile menu layout',async()=>{
  await page.keyboard.press('Control+k');await page.getByRole('textbox',{name:'搜索操作或快捷键'}).fill('编辑歌曲信息');await page.keyboard.press('Enter');await expect(dialog()).toBeVisible();await page.keyboard.press('Escape');await expect(dialog()).toHaveCount(0);
  await page.getByRole('button',{name:'编辑备注',exact:true}).click();await page.getByRole('textbox',{name:'效果器预设',exact:true}).fill('03 号 · 温暖指弹');await page.getByRole('textbox',{name:'注意事项',exact:true}).fill('尾奏看鼓手');await page.getByRole('button',{name:'完成',exact:true}).click();await save();await expect(page.locator('.notes-summary')).toContainText('尾奏看鼓手');
  const html=exportThreeTrackHtml(songs[0]);expect(html).toContain('Adele / 王菲');expect(html).toContain('尾奏看鼓手');await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(250);await page.screenshot({path:out+'/song-info-desktop.png'});
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'曲库',exact:true}).click();await page.getByRole('button',{name:'曲库排序',exact:true}).click();const box=await page.getByRole('menu').boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(390);await page.waitForTimeout(250);await page.screenshot({path:out+'/song-info-mobile-library.png'});await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();await page.waitForTimeout(250);await page.screenshot({path:out+'/song-info-mobile.png'});await open();expect((await dialog().boundingBox()).width).toBeLessThanOrEqual(390);await expect(dialog().getByRole('textbox',{name:'歌手',exact:true})).toHaveValue('Adele / 王菲');
 });
 expect(errors).toEqual([]);await fs.writeFile(out+'/song-info-results.json',JSON.stringify({checks,errors},null,2));
}catch(e){await page.screenshot({path:out+'/song-info-failure.png',fullPage:true});throw e;}finally{await browser.close();}
