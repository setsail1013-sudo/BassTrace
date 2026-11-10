import { chromium } from 'playwright';
import { exportThreeTrackHtml } from '../dist-renderer/score.mjs';

let browser;
const watchdog=setTimeout(async()=>{process.stderr.write('PDF 排版超时，请减少每行小节数后重试。');await Promise.race([browser?.close(),new Promise(resolve=>setTimeout(resolve,3000))]);process.exit(1);},45000);
try {
  const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
  const {project,mode='chart',degree=false}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  browser=await chromium.launch({channel:'msedge',headless:true,timeout:15000});
  const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  await page.emulateMedia({media:'print'});
  await page.setContent(exportThreeTrackHtml(project,mode,degree),{waitUntil:'load',timeout:15000});
  await page.evaluate(()=>window.__scoreReady);
  const pdf=await page.pdf({preferCSSPageSize:true,printBackground:true,scale:1,timeout:20000});
  process.stdout.write(pdf);
} catch(error) {
  process.stderr.write(error instanceof Error?error.message:String(error));process.exitCode=1;
} finally {clearTimeout(watchdog);await browser?.close();}
