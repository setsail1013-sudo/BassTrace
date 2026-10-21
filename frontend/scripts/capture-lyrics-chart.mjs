import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const origin='http://127.0.0.1:8000',output=path.resolve('../docs/verification');
await fs.mkdir(output,{recursive:true});
const fixture=structuredClone(await fetch(`${origin}/api/projects/demo`).then(r=>r.json()));
Object.assign(fixture,{title:'歌词与和弦排练谱 · 示例',artist:'示例工程',duration:20,bpm:96,meter:'4/4',offset:0,beatTimes:[],sections:[{id:'verse',name:'主歌',startBar:1,endBar:4,color:'#91aacb'},{id:'chorus',name:'副歌',startBar:5,endBar:8,color:'#c9b685'}],analysis:{state:'idle',stage:'',progress:0,warnings:[]}});
fixture.chords=Array.from({length:8},(_,i)=>({id:`c${i}`,bar:i+1,beat:1,label:['Cmaj7','Am7','Dm7','G7'][i%4],source:'manual',locked:true,confidence:1}));
fixture.chords.push({id:'mid-line',bar:3,beat:3,label:'G7',source:'manual',locked:true,confidence:1});
fixture.lyrics=['城市的灯慢慢亮起','让节奏陪我们前行','穿过熟悉的街角','把心事唱给你听','当夜色落在肩上','我们再一起合唱','记住这一刻的旋律','让音乐带我们远行'].map((text,i)=>({id:`l${i}`,text,start:i*2.5,end:(i+1)*2.5,source:'manual',locked:true}));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.route('**/api/projects',route=>route.fulfill({json:[fixture]}));
 await page.route('**/api/projects/demo',route=>route.fulfill({json:fixture}));
 await page.goto(origin,{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();
 await expect(page.locator('.number-bar')).toHaveCount(0);
 await expect(page.locator('.marker-lane')).toHaveCount(0);
 await expect(page.locator('.lyric')).toHaveCount(8);
 await page.screenshot({path:path.join(output,'lyrics-chords-desktop.png'),fullPage:true});
 await page.emulateMedia({media:'print'});
 await page.pdf({path:path.join(output,'lyrics-chords-a4.pdf'),format:'A4',printBackground:false});
 await page.pdf({path:path.join(output,'lyrics-chords-landscape.pdf'),format:'A4',landscape:true,printBackground:false});
 await page.emulateMedia({media:'screen'});
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:path.join(output,'lyrics-chords-mobile.png'),fullPage:true});
 console.log('Captured default lyrics/chords chart and A4 portrait/landscape; browser-only fixture, user projects untouched.');
}finally{await browser.close();}
