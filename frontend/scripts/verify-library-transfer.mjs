import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import {batchFixture,testWav} from './batch-fixture.mjs';
const base=process.env.BASSCHART_TEST_URL||'http://127.0.0.1:8003';
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1366,height:768}}),errors=[],checks=[];
const out=new URL('../../docs/verification/',import.meta.url);await fs.mkdir(out,{recursive:true});
page.on('pageerror',e=>errors.push(e.message));
const api=async(url,body,method='POST')=>{const r=await page.request.fetch(base+url,{method,...(body?{data:body}:{})});expect(r.ok(),await r.text()).toBeTruthy();return r.status()===204?null:r.json();};
const run=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
try{
 const marker=await api('/api/test-library',null,'GET');if(marker.isolated!==true||marker.fixture!=='basstrace-library-transfer')throw Error('This fixture requires backend.tests.serve_library_qa; refusing to modify an ordinary library');
 for(const p of await api('/api/projects',null,'GET')){await api('/api/projects/'+p.id,null,'DELETE');await api('/api/trash/'+p.id,null,'DELETE');}
 for(const f of (await api('/api/folders',null,'GET')).folders)await api('/api/folders/'+f.id,null,'DELETE');
 for(const p of await api('/api/playlists',null,'GET'))await api('/api/playlists/'+p.id,null,'DELETE');
 const wav=testWav(),projects=[];
 for(let i=0;i<8;i++){const r=await page.request.post(base+'/api/projects/upload',{multipart:{file:{name:`QA ${i+1}.wav`,mimeType:'audio/wav',buffer:wav},source:'original'}});expect(r.ok(),await r.text()).toBeTruthy();const p=await r.json();const fixture=batchFixture();projects.push(await api('/api/projects/'+p.id,{...fixture,id:p.id,title:`QA ${i+1}`,stems:p.stems,revision:p.revision},'PUT'));}
 await page.addInitScript(()=>{window.__audios=[];const A=window.Audio;window.Audio=function(...a){const x=new A(...a);window.__audios.push(x);return x;};});
 await page.goto(base);await expect(page.locator('.sidebar-song-row')).toHaveCount(8);
 await run('Brand and 1366x768 sidebar fits at least six complete songs',async()=>{
  await expect(page).toHaveTitle(/BassTrace/);
  const visible=await page.locator('.sidebar-songs').evaluate(el=>{const b=el.getBoundingClientRect();return [...el.children].filter(c=>{const r=c.getBoundingClientRect();return r.top>=b.top&&r.bottom<=b.bottom;}).length;});
  expect(visible).toBeGreaterThanOrEqual(6);console.log('Complete rows:',visible);
  await page.screenshot({path:new URL('basstrace-desktop.png',out).pathname.slice(1)});
 });
 await run('Folder create, bulk move, rename, deletion and playlist independence',async()=>{
  await page.locator('.sidebar').getByRole('button',{name:'新建文件夹',exact:true}).click();await page.locator('.sidebar').getByRole('textbox',{name:'新文件夹名称'}).fill('  排练文件夹  ');await page.locator('.sidebar').getByRole('button',{name:'创建',exact:true}).click();
  await page.getByRole('button',{name:'全部歌曲',exact:true}).click();
  const folder=(await api('/api/folders',null,'GET')).folders[0];
  await page.getByRole('checkbox',{name:'选择 QA 1',exact:true}).check();await page.getByRole('checkbox',{name:'选择 QA 2',exact:true}).check();
  await page.getByLabel('移入文件夹',{exact:true}).selectOption(folder.id);await page.getByRole('button',{name:'移动所选',exact:true}).click();
  await page.getByLabel('曲库分类',{exact:true}).selectOption('folder:'+folder.id);await expect(page.locator('.library-song-open')).toHaveCount(2);
  await page.getByRole('button',{name:'重命名文件夹',exact:true}).click();await page.getByRole('textbox',{name:'文件夹名称',exact:true}).fill('演出资料');await page.getByRole('button',{name:'保存名称',exact:true}).click();
  await expect(page.locator('.library-view h1')).toHaveText('演出资料');
  const list=await api('/api/playlists',{name:'演出歌单',projectIds:[projects[0].id]});
  await page.reload();await page.getByRole('button',{name:'全部歌曲',exact:true}).click();await page.getByLabel('曲库分类',{exact:true}).selectOption('folder:'+folder.id);
  await page.getByRole('button',{name:'删除文件夹',exact:true}).click();await page.locator('.playlist-delete').getByRole('button',{name:'删除文件夹',exact:true}).click();await expect(page.locator('.library-song-open')).toHaveCount(8);
  expect((await api('/api/playlists',null,'GET')).find(p=>p.id===list.id).projectIds).toEqual([projects[0].id]);
 });
 await run('Batch import mixed successes, no playback interruption, failure retry without duplicate success',async()=>{
  await page.getByRole('button',{name:'全部歌曲',exact:true}).click();await page.locator('.sidebar-song-row > button:first-child').first().click();await page.locator('.play-button').click();
  await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/);const count=await page.evaluate(()=>window.__audios.length);const active=await page.evaluate(()=>localStorage.getItem('basschart.active-project'));
  await page.getByRole('button',{name:'导入曲库',exact:true}).click();await page.getByRole('button',{name:'导入音乐文件',exact:true}).click();const dialog=page.getByRole('dialog',{name:'批量导入音乐'});
  await dialog.getByLabel('音乐文件',{exact:true}).setInputFiles([{name:'新增一.wav',mimeType:'audio/wav',buffer:wav},{name:'损坏.wav',mimeType:'audio/wav',buffer:Buffer.from('bad')},{name:'新增二.wav',mimeType:'audio/wav',buffer:wav}]);
  await dialog.getByRole('checkbox').uncheck();await dialog.getByRole('button',{name:'导入 3 首音乐',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('已处理 3 / 3 首',{timeout:30000});
  await expect(dialog.locator('.batch-row.complete')).toHaveCount(2);await expect(dialog.locator('.batch-row.error')).toHaveCount(1);
  expect(await page.evaluate(()=>window.__audios.length)).toBe(count);expect(await page.evaluate(()=>localStorage.getItem('basschart.active-project'))).toBe(active);await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/);
  await dialog.getByRole('button',{name:'重试失败项'}).click();await expect(dialog.getByRole('status')).toHaveText('已处理 3 / 3 首');expect((await api('/api/projects',null,'GET')).length).toBe(10);
  await dialog.getByRole('button',{name:'关闭曲库操作'}).click();await page.locator('.play-button').click();
 });
 await run('Real selected archive download, validation preview, restore copies and rich score data',async()=>{
  await page.getByRole('button',{name:'全部歌曲',exact:true}).click();await page.getByRole('checkbox',{name:'选择 QA 1',exact:true}).check();await page.getByRole('button',{name:'备份所选',exact:true}).click();let d=page.getByRole('dialog',{name:'导出曲库备份'});await d.getByRole('button',{name:'生成完整备份'}).click();
  const link=d.getByRole('link',{name:'下载 .basstrace.zip 备份'});await expect(link).toBeVisible({timeout:20000});const downloaded=await page.request.get(base+await link.getAttribute('href'));expect(downloaded.ok()).toBeTruthy();const zip=await downloaded.body();
  await d.getByRole('button',{name:'关闭曲库操作'}).click();await page.getByRole('button',{name:'恢复备份',exact:true}).click();d=page.getByRole('dialog',{name:'恢复曲库备份'});await d.getByLabel('选择曲库备份').setInputFiles({name:'test.basstrace.zip',mimeType:'application/zip',buffer:zip});await d.getByRole('button',{name:'上传并校验备份'}).click();await expect(d.getByRole('button',{name:'确认恢复为新副本'})).toBeVisible({timeout:20000});await expect(d).toContainText('1 首歌曲');await d.getByRole('button',{name:'确认恢复为新副本'}).click();await expect(d.getByRole('status')).toHaveText('已恢复 1 首歌曲',{timeout:20000});
  const all=await api('/api/projects',null,'GET');expect(all.length).toBe(11);const copy=all.find(p=>p.title==='QA 1'&&p.id!==projects[0].id);expect(copy.manualFills).toEqual(projects[0].manualFills);expect(copy.lyrics).toEqual(projects[0].lyrics);expect(copy.stems[0].url).toContain(copy.id);expect(copy.analysis.state).toBe('idle');
  await d.getByRole('button',{name:'清理本次备份临时文件'}).click();await d.getByRole('button',{name:'关闭曲库操作'}).click();
 });
 await run('Mobile folder creation and bulk controls remain accessible without horizontal overflow',async()=>{
  await page.setViewportSize({width:390,height:844});await page.keyboard.press('Alt+3');await page.locator('.library-folder-controls').getByRole('button',{name:'新建文件夹',exact:true}).click();const form=page.locator('.mobile-library-creation');await form.getByRole('textbox',{name:'新文件夹名称'}).fill('手机文件夹');await form.getByRole('button',{name:'创建',exact:true}).click();await expect(page.locator('.library-view h1')).toHaveText('手机文件夹');
  await page.getByLabel('曲库分类',{exact:true}).selectOption('all');await page.getByRole('checkbox',{name:'选择 QA 2',exact:true}).check();await expect(page.getByRole('button',{name:'移动所选',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);await page.screenshot({path:new URL('basstrace-mobile.png',out).pathname.slice(1),fullPage:true});
 });
 await run('Cancel queued songs keeps current upload; auto-analysis processes strictly serially',async()=>{
  await page.setViewportSize({width:1366,height:768});await page.getByRole('button',{name:'全部歌曲',exact:true}).click();
  let release;const gate=new Promise(resolve=>{release=resolve;});let first=true;
  await page.route('**/api/projects/upload',async r=>{if(first){first=false;await gate;}await r.continue();});
  await page.getByRole('button',{name:'导入音乐',exact:true}).click();let d=page.getByRole('dialog',{name:'批量导入音乐'});
  await d.getByLabel('音乐文件',{exact:true}).setInputFiles([1,2,3].map(i=>({name:`取消测试${i}.wav`,mimeType:'audio/wav',buffer:wav})));
  await d.getByRole('button',{name:'导入 3 首音乐',exact:true}).click();await expect(d.getByRole('button',{name:'取消等待中的歌曲'})).toBeEnabled();await d.getByRole('button',{name:'取消等待中的歌曲'}).click();release();
  await expect(d.locator('.batch-row.cancelled')).toHaveCount(2);await expect(d.getByRole('status')).toHaveText('已处理 6 / 6 首',{timeout:15000});await page.unroute('**/api/projects/upload');
  let active=0,maxActive=0,started=0;
  await page.route('**/api/projects/*/analyze',async r=>{active++;maxActive=Math.max(maxActive,active);started++;await new Promise(resolve=>setTimeout(resolve,250));const id=new URL(r.request().url()).pathname.split('/')[3],p=await api('/api/projects/'+id,null,'GET');active--;await r.fulfill({json:{...p,analysis:{...p.analysis,state:'complete',progress:100}}});});
  await d.getByLabel('音乐文件',{exact:true}).setInputFiles([1,2].map(i=>({name:`自动分析队列${i}.wav`,mimeType:'audio/wav',buffer:wav})));await d.getByRole('checkbox').check();await d.getByRole('button',{name:'导入 2 首音乐',exact:true}).click();await expect(d.getByRole('status')).toHaveText('已处理 8 / 8 首',{timeout:15000});expect(started).toBe(2);expect(maxActive).toBe(1);
  await page.unroute('**/api/projects/*/analyze');await d.getByRole('button',{name:'关闭曲库操作'}).click();
 });
 expect(errors).toEqual([]);await fs.writeFile(new URL('basstrace-library.json',out),JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
