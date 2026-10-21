import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const output=path.resolve('../docs/verification');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto('http://127.0.0.1:8000',{waitUntil:'networkidle'});
 await page.locator('.sheet-header').waitFor();
 await page.screenshot({path:path.join(output,'studio-desktop.png'),fullPage:true});
 await page.emulateMedia({media:'print'});
 await page.pdf({path:path.join(output,'print-a4.pdf'),format:'A4',printBackground:false});
 await page.pdf({path:path.join(output,'print-a4-landscape.pdf'),format:'A4',landscape:true,printBackground:false});
 await page.emulateMedia({media:'screen'});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:path.join(output,'studio-mobile.png'),fullPage:false});
 console.log('Captured desktop, mobile, A4 portrait and landscape from original demo.');
}finally{await browser.close();}
