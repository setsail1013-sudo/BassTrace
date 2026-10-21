import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = 'http://127.0.0.1:8000';
const output = path.resolve('../docs/verification');
await fs.mkdir(output, { recursive: true });
// Every project response and save is intercepted; the user's JSON, SQLite and audio are untouched.
let fixture = structuredClone(await fetch(`${origin}/api/projects/demo`).then(response => response.json()));
fixture.duration = 10; fixture.bpm = 96; fixture.meter = '4/4'; fixture.key = 'C'; fixture.originalKey = 'C'; fixture.offset = 0; fixture.beatTimes = [];
fixture.analysis = { state: 'complete', stage: '数字谱界面验证', progress: 100, warnings: [] };
fixture.lyricAlignment = undefined;
fixture.sections = [{ ...fixture.sections[0], id: 'number-ui-section', name: '数字谱编辑验证', startBar: 1, endBar: 4 }];
fixture.chords = fixture.chords.filter(chord => chord.bar <= 4);
fixture.lyrics = fixture.lyrics.filter(lyric => lyric.start < 10).map(lyric => ({ ...lyric, end: Math.min(lyric.end, 10) }));
fixture.markers = fixture.markers.filter(marker => marker.time < 10);
fixture.notes = fixture.notes.slice(0, 6).map((note, index) => ({ ...note, midi: [36, 40, 43, 45, 36, 43][index], start: [0, .625, 1.25, 1.875, 2.5, 4.75][index], duration: index === 5 ? 1 : .625, notation: undefined }));
const firstId = fixture.notes[0].id, secondId = fixture.notes[1].id, crossId = fixture.notes[5].id;
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const checks = [], pageErrors = [], saves = [];
let failure = null;
page.on('pageerror', error => pageErrors.push(error.message));
page.on('dialog', dialog => dialog.dismiss());
await page.route('**/api/projects**', async route => {
  const request = route.request(), pathname = new URL(request.url()).pathname;
  if (pathname === '/api/projects' && request.method() === 'GET') { await route.fulfill({ json: [fixture] }); return; }
  if (pathname !== '/api/projects/demo') { await route.continue(); return; }
  if (request.method() === 'GET') { await route.fulfill({ json: fixture }); return; }
  if (request.method() === 'PUT') {
    const submitted = request.postDataJSON();
    if (submitted.revision !== fixture.revision) { await route.fulfill({ status: 409, json: { detail: 'UI fixture revision conflict' } }); return; }
    fixture = { ...submitted, revision: fixture.revision + 1, updatedAt: new Date().toISOString() };
    saves.push(structuredClone(fixture)); await route.fulfill({ json: fixture }); return;
  }
  await route.fulfill({ status: 400, json: { detail: 'This UI fixture supports only reading and saving.' } });
});
const button = id => page.locator(`.number-note[data-note-id=${JSON.stringify(id)}]`).first();
const check = async (name, action) => { await action(); checks.push(name); };
const save = async () => {
  const before = saves.length;
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect.poll(() => saves.length).toBeGreaterThan(before);
  await expect(page.locator('.save-state')).toContainText('工程已保存');
};
try {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '曲谱编辑', exact: true }).click();
  await page.getByRole('combobox', { name: '其他曲谱视图', exact: true }).selectOption('number');
  await expect(page.locator('.number-bar')).toHaveCount(4);
  await check('Warm three-layer score and bounded number labels', async () => {
    await expect(page.locator('.number-toolbar')).toBeVisible();
    expect(await page.locator('.bar').first().evaluate(bar => { const chord = bar.querySelector('.chord-lane').getBoundingClientRect(), number = bar.querySelector('.number-bar').getBoundingClientRect(), lyrics = bar.querySelector('.lyric-lane').getBoundingClientRect(); return chord.bottom <= number.top + 5 && number.bottom <= lyrics.top + 2; })).toBe(true);
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(Number(background.match(/\d+/)[0])).toBeGreaterThan(150);
    expect(await page.locator('.number-note').evaluateAll(notes => notes.every(note => { const rect = note.getBoundingClientRect(), bar = note.closest('.number-bar').getBoundingClientRect(); return rect.left >= bar.left - 1 && rect.right <= bar.right + 1; }))).toBe(true);
  });
  await check('Number font and label bounds follow the score size controls', async () => {
    const font = () => button(firstId).evaluate(note => Number.parseFloat(getComputedStyle(note).fontSize));
    const before = await font(); await page.getByTitle('增大字号', { exact: true }).click();
    await expect.poll(font).toBeGreaterThan(before);
    await expect.poll(() => page.locator('.number-note').evaluateAll(notes => notes.every(note => { const rect = note.getBoundingClientRect(), bar = note.closest('.number-bar').getBoundingClientRect(); return rect.left >= bar.left - 1 && rect.right <= bar.right + 1; }))).toBe(true);
    await page.getByTitle('减小字号', { exact: true }).click(); await expect.poll(font).toBeCloseTo(before);
  });
  await check('Left/right select adjacent notes without altering their data', async () => {
    const snapshot = JSON.stringify(fixture.notes), count = saves.length;
    await button(firstId).click(); await button(firstId).press('ArrowRight');
    await expect(button(secondId)).toHaveAttribute('aria-pressed', 'true');
    await button(secondId).press('ArrowLeft'); await expect(button(firstId)).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(250); expect(JSON.stringify(fixture.notes)).toBe(snapshot); expect(saves.length).toBe(count);
  });
  await check('Digit pitch editing and automatic save', async () => {
    const count = saves.length; await button(firstId).press('3');
    await expect(button(firstId).locator('.number-glyph')).toHaveText('3');
    await expect(page.locator('.save-state')).toContainText('有未保存的修改');
    await expect.poll(() => saves.length, { timeout: 6000 }).toBeGreaterThan(count);
    await expect(page.locator('.save-state')).toContainText('工程已保存');
    expect(fixture.notes.find(note => note.id === firstId).midi).toBe(40);
    expect(fixture.notes.find(note => note.id === firstId).locked).toBe(true);
  });
  await check('Explicit audition plays the selected original-audio interval and stops', async () => {
    await button(firstId).click(); const audition = page.getByRole('button', { name: '试听', exact: true });
    await expect(audition).toBeEnabled(); await audition.click();
    await expect.poll(async () => Number(await page.getByRole('slider', { name: '播放位置', exact: true }).inputValue()), { timeout: 3000 }).toBeGreaterThan(.05);
    await expect(page.locator('.play-button .lucide-play'), { timeout: 3000 }).toBeVisible();
  });
  await check('Rest zero never displays a sounding region', async () => {
    await button(firstId).press('0'); await expect(button(firstId).locator('.number-glyph')).toHaveText('0');
    await expect(button(firstId)).not.toHaveClass(/sounding/); await expect(page.locator('.rest-region.sounding')).toHaveCount(0);
    await save(); expect(fixture.notes.find(note => note.id === firstId).notation.rest).toBe(true);
  });
  await check('Ghost parentheses and dead x stay distinct', async () => {
    await button(firstId).press('3'); await page.getByRole('button', { name: '演奏标记', exact: true }).click();
    await page.getByRole('button', { name: '鬼音 ( )', exact: true }).click();
    await expect(button(firstId).locator('.number-glyph')).toHaveText('(3)'); await save();
    expect(fixture.notes.find(note => note.id === firstId).notation.ghost).toBe(true);
    await page.getByRole('button', { name: '闷音 x', exact: true }).click();
    await expect(button(firstId).locator('.number-glyph')).toHaveText('x'); await save();
    const notation = fixture.notes.find(note => note.id === firstId).notation;
    expect(notation.dead).toBe(true); expect(notation.ghost).toBe(false); expect(notation.rest).toBe(false);
  });
  await check('Note value and dot change real duration and underline', async () => {
    await button(firstId).click(); await button(firstId).press('1');
    await page.getByLabel('数字谱音符时值', { exact: true }).selectOption('8'); await save();
    expect(fixture.notes.find(note => note.id === firstId).duration).toBeCloseTo(.3125);
    await expect(button(firstId).locator('.number-underlines i')).toHaveCount(1);
    await page.getByRole('button', { name: '附点 ·', exact: true }).click(); await save();
    expect(fixture.notes.find(note => note.id === firstId).duration).toBeCloseTo(.46875);
    await expect(button(firstId).locator('.number-dot')).toHaveText('·');
  });
  await check('Shift arrows move time only when requested', async () => {
    await button(firstId).click(); const start = fixture.notes.find(note => note.id === firstId).start;
    await button(firstId).press('Shift+ArrowRight'); await save();
    expect(fixture.notes.find(note => note.id === firstId).start).toBeCloseTo(start + .15625);
    await button(firstId).click(); await button(firstId).press('Shift+ArrowLeft'); await save();
    expect(fixture.notes.find(note => note.id === firstId).start).toBeCloseTo(start);
  });
  await check('Cross-bar continuation highlights only the current fragment', async () => {
    const fragments = page.locator(`.number-note[data-note-id=${JSON.stringify(crossId)}]`);
    await expect(fragments).toHaveCount(2); await fragments.nth(1).click();
    await expect(fragments.nth(0)).not.toHaveClass(/sounding/); await expect(fragments.nth(1)).toHaveClass(/sounding/);
  });
  await check('Ctrl multi-selection and copy/paste preserve relative times', async () => {
    await button(firstId).click(); await button(secondId).click({ modifiers: ['Control'] });
    await expect(page.locator('.number-toolbar-title')).toContainText('已选 2 个');
    await page.getByRole('button', { name: '复制', exact: true }).click();
    const destination = page.locator('.number-bar').nth(3), box = await destination.boundingBox();
    await destination.click({ position: { x: 2, y: box.height - 3 } });
    await page.getByRole('button', { name: '粘贴', exact: true }).click(); await save();
    const pasted = fixture.notes.filter(note => ![firstId, secondId, ...saves[0].notes.map(note => note.id)].includes(note.id));
    expect(fixture.notes.length).toBe(8); expect(pasted.length).toBe(2);
    expect(pasted[0].start).toBeCloseTo(7.5); expect(pasted[1].start - pasted[0].start).toBeCloseTo(.625);
    expect(pasted[0].notation.dotted).toBe(true);
  });
  await check('Root undo and redo restore note events', async () => {
    await page.getByTitle('撤销 Ctrl+Z', { exact: true }).click(); await save(); expect(fixture.notes.length).toBe(6);
    await page.getByTitle('重做 Ctrl+Shift+Z', { exact: true }).click(); await save(); expect(fixture.notes.length).toBe(8);
  });
  await check('Insertion, deletion and interval background toggle', async () => {
    const count = fixture.notes.length;
    await page.getByRole('button', { name: '+ 休止', exact: true }).click(); await save();
    expect(fixture.notes.length).toBe(count + 1); expect(fixture.notes.filter(note => note.notation?.rest)).toHaveLength(1);
    await page.getByRole('button', { name: '删除', exact: true }).click(); await save(); expect(fixture.notes.length).toBe(count);
    await page.getByTitle('贝斯弹奏背景', { exact: true }).click(); await expect(page.locator('.number-region')).toHaveCount(0);
    await page.getByTitle('贝斯弹奏背景', { exact: true }).click(); expect(await page.locator('.number-region').count()).toBeGreaterThan(0);
  });
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await page.locator('.toast').waitFor({ state: 'hidden', timeout: 6000 });
  await page.locator('.chart-panel').screenshot({ path: path.join(output, 'number-editor-warm.png') });
  await check('A4 number labels stay inside bars and do not overlap after print relayout', async () => {
    await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' });
    await expect.poll(() => button(firstId).evaluate(note => Number.parseFloat(getComputedStyle(note).fontSize))).toBe(12);
    await expect(button(firstId).locator('.number-underlines i')).toHaveCSS('border-top-style', 'solid');
    await expect.poll(() => page.locator('.number-bar').evaluateAll(bars => bars.every(bar => {
      const rect = bar.getBoundingClientRect(), notes = [...bar.querySelectorAll('.number-note')].map(note => note.getBoundingClientRect());
      return notes.every((note, index) => note.left >= rect.left - 1 && note.right <= rect.right + 1 && notes.every((other, otherIndex) => otherIndex === index || note.right <= other.left + .5 || other.right <= note.left + .5 || note.bottom <= other.top + .5 || other.bottom <= note.top + .5));
    }))).toBe(true);
    await page.pdf({ path: path.join(output, 'number-editor-a4.pdf'), format: 'A4', printBackground: false });
    await page.emulateMedia({ media: 'screen' }); await page.setViewportSize({ width: 1440, height: 1000 });
  });
  expect(pageErrors).toEqual([]);
} catch (error) {
  failure = error.message; await page.screenshot({ path: path.join(output, 'number-editor-failure.png'), fullPage: true }).catch(() => {});
} finally {
  const result = { passed: checks.length, checks, pageErrors, failure, mockSaves: saves.length, projectWrites: 'intercepted in browser only; no user project files changed' };
  await fs.writeFile(path.join(output, 'number-editor-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2)); await browser.close();
}
if (failure || pageErrors.length) process.exitCode = 1;
