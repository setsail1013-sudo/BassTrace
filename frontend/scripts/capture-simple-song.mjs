import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const origin = 'http://127.0.0.1:8000', id = 'b944a8cf-4e49-47f2-9257-87c63c7f5e18', out = path.resolve('../docs/verification');
const before = await fetch(`${origin}/api/projects/${id}`).then(r => r.json());
const errors = [], browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(id => localStorage.setItem('basschart.active-project', id), id);
let failure = null, visibleChords = 0, visibleLyrics = 0;
try {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '曲谱编辑', exact: true }).click();
  await expect(page.locator('.song-heading h1')).toContainText('红色高跟鞋');
  await expect(page.locator('.number-bar,.number-toolbar,.marker-lane,.root-hint,.tab,.score-notice')).toHaveCount(0);
  expect(await page.locator('.sheet').innerText()).not.toMatch(/[A-G][#b]?\?|FILL|贝斯根音|点击拍位/);
  visibleChords = await page.locator('.sheet .chord').count(); visibleLyrics = await page.locator('.sheet .lyric').count();
  expect(visibleChords).toBeGreaterThan(0); expect(visibleLyrics).toBe(before.lyrics.length);
  await page.screenshot({ path: path.join(out, 'red-high-heels-simple-desktop.png') });
  await page.locator('.lyric').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'red-high-heels-simple-lyrics.png') });
  expect(errors).toEqual([]);
  const after = await fetch(`${origin}/api/projects/${id}`).then(r => r.json()); expect(after).toEqual(before);
} catch (e) { failure = e.stack || e.message; }
finally {
  const result = { projectId: id, title: before.title, visibleChords, visibleLyrics, pageErrors: errors, failure, projectWrites: 'Read-only; API project unchanged.' };
  await fs.writeFile(path.join(out, 'red-high-heels-ui.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); await browser.close();
}
if (failure || errors.length) process.exitCode = 1;
