import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const output=path.resolve('../docs/verification');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto('http://127.0.0.1:8000',{waitUntil:'networkidle'});
  await page.locator('.home-page').waitFor();
  await page.screenshot({path:path.join(output,'home-2.1-final.png'),fullPage:true});
  await page.getByRole('button',{name:'曲谱编辑',exact:true}).click();
  await page.locator('.number-note').first().waitFor();
  await page.screenshot({path:path.join(output,'score-2.1-desktop.png'),fullPage:true});
  await page.emulateMedia({media:'print'});
  await page.waitForTimeout(300);
  await page.pdf({path:path.join(output,'score-2.1-a4.pdf'),format:'A4',printBackground:false});
  await page.pdf({path:path.join(output,'score-2.1-a4-landscape.pdf'),format:'A4',landscape:true,printBackground:false});
  await page.emulateMedia({media:'screen'});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(output,'score-2.1-mobile-final.png'),fullPage:true});
  console.log('Captured final 2.1 home, three-layer score, mobile and both A4 orientations; original demo read only.');
}finally{await browser.close();}
