import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = 'http://127.0.0.1:8000';
const out = path.resolve('../docs/verification');
const pdfOut = path.resolve('../output/pdf');
await fs.mkdir(out, { recursive: true });
await fs.mkdir(pdfOut, { recursive: true });
const demo = await fetch(`${origin}/api/projects/demo`).then(r => r.json());
const chord = (id, bar, beat, label, source = 'analysis', locked = false) => ({ id, bar, beat, label, source, locked, confidence: .8 });
let fixture = {
  ...structuredClone(demo), title: '城市夜行 · 排练示例', artist: '原创验证素材', duration: 20, bpm: 96,
  meter: '4/4', offset: 0, beatTimes: [], revision: 1,
  sections: [{ id: 's1', name: 'Intro', startBar: 1, endBar: 4 }, { id: 's2', name: 'Verse', startBar: 5, endBar: 8 }],
  analysis: { state: 'complete', stage: '', progress: 100, warnings: [] },
  chords: [chord('a', 1, 1, 'Cmaj7'), chord('repeat', 1, 2, 'Cmaj7'), chord('b', 1, 3.625, 'G/B'), chord('c', 2, 1, 'Am7'), chord('d', 3, 1, 'Dm7'), chord('e', 4, 1, 'G7'), chord('f', 5, 1, 'Cmaj7'), chord('g', 6, 1, 'Am7'), chord('h', 7, 1, 'Dm7'), chord('i', 8, 1, 'G7'), chord('analysis-bass-root-old', 1, 1.5, 'E?'), chord('manual-pitch', 2, 2, 'F#?', 'manual', true)],
  notes: demo.notes.filter(n => n.start + n.duration <= 20),
  markers: [{ id: 'old-fill', label: 'FILL', time: 4, text: '保留的个人过门', source: 'manual' }],
  lyricsOriginal: '[00:01.00]城市的灯慢慢亮起\n[00:07.00]让节奏陪我们前行',
  lyrics: [{ id: 'l1', text: '城市的灯慢慢亮起', start: 1, end: 5, source: 'manual', locked: true }, { id: 'l2', text: '让节奏陪我们前行', start: 7, end: 11, source: 'manual', locked: true }],
  lyricAlignment: { state: 'idle', stage: '', progress: 0, detectedSegments: [], lines: [], warnings: [], error: null },
};
const checks = [], errors = [], requests = [], saves = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/projects**', async route => {
  const request = route.request(), pathname = new URL(request.url()).pathname;
  if (pathname === '/api/projects') return route.fulfill({ json: [fixture] });
  if (pathname === '/api/projects/demo/analyze') {
    requests.push(request.postDataJSON());
    fixture = { ...fixture, analysis: { state: 'error', stage: '分析失败', progress: 100, warnings: ['验证用分析错误：结果未生成'] } };
    return route.fulfill({ json: fixture });
  }
  if (pathname === '/api/projects/demo') {
    if (request.method() === 'PUT') { fixture = { ...request.postDataJSON(), revision: fixture.revision + 1 }; saves.push(fixture.revision); }
    return route.fulfill({ json: fixture });
  }
  return route.fulfill({ status: 404, json: { detail: 'Unknown verification fixture' } });
});
const check = async (name, fn) => { await fn(); checks.push(name); };
const layoutErrors = async (target = page, portable = false) => target.evaluate(portable => {
  const failures = [];
  document.querySelectorAll(portable ? '.beats' : '.chord-lane').forEach(lane => {
    const bounds = lane.getBoundingClientRect(), elements = [...lane.querySelectorAll('.chord')], beats = Number(lane.dataset.beats || 4);
    const rectangles = elements.map(e => e.getBoundingClientRect());
    rectangles.forEach((rect, i) => {
      if (rect.left < bounds.left - .6 || rect.right > bounds.right + .6 || rect.top < bounds.top - .6 || rect.bottom > bounds.bottom + .6) failures.push('label outside bar');
      const raw = elements[i].style.getPropertyValue('--chord-anchor');
      const anchor = rect.left + (parseFloat(raw) || 0) * (raw.endsWith('%') ? rect.width / 100 : 1);
      if (Math.abs(anchor - (bounds.left + (Number(elements[i].dataset.beat) - 1) / beats * lane.clientWidth)) > .6) failures.push('beat anchor moved');
      rectangles.slice(i + 1).forEach(other => { if (Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > .5 && Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > .5) failures.push('labels overlap'); });
    });
  });
  return failures;
}, portable);
const save = async () => { const count = saves.length; await page.getByRole('button', { name: '保存工程', exact: true }).click(); await expect.poll(() => saves.length).toBeGreaterThan(count); await expect(page.locator('.save-state')).toContainText('工程已保存'); };
const setRate = async name => { await page.getByRole('button', { name: '节拍与小节网格', exact: true }).click(); await page.getByRole('button', { name, exact: true }).click(); await page.getByRole('button', { name: '更新节拍网格', exact: true }).click(); await save(); };
const settings = async () => { const menu = page.locator('.chart-display-menu'); if (!(await menu.getAttribute('open') !== null)) await menu.locator('summary').click(); };
let failure = null;
try {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await check('Simple light home retains audio and lyric import with only three navigation choices', async () => {
    await expect(page.locator('.import-zone')).toHaveCount(2);
    await expect(page.locator('.sidebar nav button')).toHaveCount(3);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(245, 245, 247)');
    await page.screenshot({ path: path.join(out, 'simple-home.png'), fullPage: true });
  });
  await page.getByRole('button', { name: '曲谱编辑', exact: true }).click();
  await check('Chart shows harmony and lyrics only, omitting legacy bass pitches and all old note/fill controls', async () => {
    await expect(page.locator('.chord')).toHaveCount(9);
    await expect(page.locator('.lyric')).toHaveCount(2);
    await expect(page.locator('.number-bar,.number-toolbar,.marker-lane,.root-hint,.tab')).toHaveCount(0);
    expect(await page.locator('.sheet').innerText()).not.toMatch(/E\?|F#\?|贝斯|FILL|E A D G|点击拍位/);
    await expect(page.locator('.view-tabs button')).toHaveCount(2);
    await expect(page.locator('.chart-options')).not.toBeVisible();
    await expect.poll(() => layoutErrors()).toEqual([]);
    await page.screenshot({ path: path.join(out, 'simple-score-desktop.png'), fullPage: true });
  });
  await check('Original-song analysis is default even with a Bass stem, with transcription disabled', async () => {
    const previous = structuredClone(fixture);
    await page.getByRole('button', { name: '分析和弦', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '分析音频来源', exact: true })).toHaveValue('original');
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    expect(requests.at(-1)).toEqual({ source: 'original', separate: false, transcribe: false });
    await expect(page.getByRole('alert')).toContainText('验证用分析错误');
    expect(fixture.chords).toEqual(previous.chords); expect(fixture.lyrics).toEqual(previous.lyrics); expect(fixture.notes).toEqual(previous.notes); expect(fixture.markers).toEqual(previous.markers);
  });
  await check('Bass-only analysis explains tempo-only scope and missing stem blocks submission', async () => {
    fixture.stems = fixture.stems.filter(s => s.id !== 'bass');
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '曲谱编辑', exact: true }).click();
    await page.getByRole('button', { name: '分析和弦', exact: true }).click();
    const source = page.getByRole('combobox', { name: '分析音频来源', exact: true });
    await expect(source).toHaveValue('original'); await source.selectOption('bass');
    await expect(page.locator('.modal .sheet-notice')).toContainText('贝斯根音和经过音不会写成和弦');
    await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
    await source.selectOption('uploaded_bass'); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeEnabled();
    await page.getByTitle('关闭', { exact: true }).click();
  });
  await check('PDF print layout contains only harmony and lyrics in both A4 orientations', async () => {
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.number-bar,.number-toolbar,.marker-lane,.root-hint')).toHaveCount(0);
    await expect.poll(() => layoutErrors()).toEqual([]);
    await page.pdf({ path: path.join(pdfOut, 'simple-chart-a4.pdf'), format: 'A4', printBackground: false });
    await page.pdf({ path: path.join(pdfOut, 'simple-chart-landscape.pdf'), format: 'A4', landscape: true, printBackground: false });
    await page.emulateMedia({ media: 'screen' });
  });
  await check('Exporting PDF from Home or Library renders the score before opening print', async () => {
    await page.evaluate(() => { window.__printCounts = []; window.print = () => window.__printCounts.push(document.querySelectorAll('.sheet .chord').length); });
    for (const nav of ['首页', '曲库']) {
      await page.getByRole('button', { name: nav, exact: true }).click();
      await expect(page.locator('.sheet')).toHaveCount(0);
      await page.getByRole('button', { name: '导出曲谱', exact: true }).click();
      await page.getByRole('button', { name: /PDF 排练谱/ }).click();
      await expect(page.locator('.sheet .chord')).toHaveCount(9);
    }
    await expect.poll(() => page.evaluate(() => window.__printCounts)).toEqual([9, 9]);
  });
  await check('Interactive HTML omits note and root candidates while retaining fractional harmonic beat anchors', async () => {
    await page.getByRole('button', { name: '导出曲谱', exact: true }).click();
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: /互动 HTML 谱/ }).click();
    const exported = path.join(out, 'simple-chart.html'); await (await pending).saveAs(exported); await page.getByTitle('关闭', { exact: true }).click();
    const html = await fs.readFile(exported, 'utf8');
    expect(html).not.toMatch(/E\?|F#\?|保留的个人过门|E–A–D–G/);
    const reader = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    reader.on('pageerror', e => errors.push(e.message)); await reader.setContent(html, { waitUntil: 'load' });
    await expect(reader.locator('.chord')).toHaveCount(9); await expect(reader.locator('.lyric')).toHaveCount(2);
    await expect(reader.locator('.portable-number,.portable-note,.marker,.root-hint,.tab')).toHaveCount(0);
    await expect.poll(() => layoutErrors(reader, true)).toEqual([]);
    expect(await reader.locator('[data-id="b"]').getAttribute('data-beat')).toBe('3.625');
    await reader.emulateMedia({ media: 'print' }); await reader.pdf({ path: path.join(pdfOut, 'simple-chart-html-a4.pdf'), format: 'A4', printBackground: false }); await reader.close();
  });
  const sparse = structuredClone(fixture);
  fixture = { ...fixture, analysis: { state: 'idle', stage: '', progress: 0, warnings: [] }, sections: [{ id: 'dense', name: '密集和弦校正', startBar: 1, endBar: 8 }], chords: Array.from({ length: 64 }, (_, i) => chord(`dense-${i}`, Math.floor(i / 8) + 1, 1 + (i % 8) / 2, ['Cmaj7', 'F#maj7/C#', 'G7', 'Am7', 'Dm7', 'Emaj7', 'Bm7', 'Cmaj7/G'][i % 8], 'manual', true)) };
  fixture.chords.push({ ...fixture.chords[7], id: 'dense-duplicate' });
  const dense = structuredClone(fixture);
  await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '曲谱编辑', exact: true }).click();
  await check('Halving/doubling BPM preserves every event audio time and all 65 chords without overlap', async () => {
    await expect(page.locator('.chord')).toHaveCount(65); await setRate('½ 速度'); expect(fixture.bpm).toBe(48);
    await expect(page.locator('.bar-number')).toHaveCount(4);
    fixture.chords.forEach((c, i) => expect(Math.abs(((c.bar - 1) * 4 + c.beat - 1) * 60 / 48 - ((dense.chords[i].bar - 1) * 4 + dense.chords[i].beat - 1) * 60 / 96)).toBeLessThan(.0002));
    expect(fixture.lyrics).toEqual(dense.lyrics); expect(fixture.notes).toEqual(dense.notes); expect(fixture.markers).toEqual(dense.markers);
    await expect.poll(() => layoutErrors()).toEqual([]);
    await page.locator('.sheet').screenshot({ path: path.join(out, 'simple-half-tempo-dense.png') });
    await setRate('2× 速度'); expect(fixture.bpm).toBe(96); await expect(page.locator('.bar-number')).toHaveCount(8);
    fixture.chords.forEach((c, i) => { expect(c.bar).toBe(dense.chords[i].bar); expect(c.beat).toBeCloseTo(dense.chords[i].beat, 7); });
    await expect.poll(() => layoutErrors()).toEqual([]);
  });
  await check('Slow playback is independent of BPM and leaves source events unchanged', async () => {
    const snapshot = JSON.stringify(fixture); await page.getByRole('combobox', { name: '播放速度', exact: true }).selectOption('0.5');
    await page.locator('.play-button').click(); await expect.poll(async () => Number(await page.getByRole('slider', { name: '播放位置', exact: true }).inputValue())).toBeGreaterThan(.15);
    await page.locator('.play-button').click(); expect(JSON.stringify(fixture)).toBe(snapshot);
  });
  await check('Nonuniform beat grid halving keeps recorded timing instead of flattening it', async () => {
    await page.getByRole('button', { name: '节拍与小节网格', exact: true }).click(); await page.getByLabel('使用逐拍时间网格（支持变速）', { exact: true }).check();
    await page.locator('.modal textarea').fill('0, .61, 1.28, 1.85'); await page.getByRole('button', { name: '更新节拍网格', exact: true }).click(); await save();
    await setRate('½ 速度'); expect(fixture.beatTimes).toEqual([0, 1.28, 2.42]); await expect.poll(() => layoutErrors()).toEqual([]);
  });
  await check('Dense chart remains bounded at 22px/eight bars per row, degrees and black/white print', async () => {
    await settings(); await page.getByRole('combobox', { name: '每行小节数', exact: true }).selectOption('8');
    for (let i = 0; i < 6; i++) await page.getByTitle('增大字号', { exact: true }).click();
    await expect.poll(() => layoutErrors()).toEqual([]); await page.getByTitle('切换和弦级数', { exact: true }).click(); await expect.poll(() => layoutErrors()).toEqual([]);
    await page.emulateMedia({ media: 'print' }); await expect.poll(() => layoutErrors()).toEqual([]); await page.emulateMedia({ media: 'screen' });
  });
  await check('Mobile home and chart have no horizontal overflow or harmonic label collisions', async () => {
    fixture = sparse; await page.setViewportSize({ width: 390, height: 844 }); await page.reload({ waitUntil: 'networkidle' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const nav of ['首页', '曲谱编辑', '曲库']) {
      const button = page.locator('.sidebar nav').getByRole('button', { name: nav, exact: true });
      await expect(button).toBeVisible(); expect(await button.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(0);
    }
    await page.getByRole('button', { name: '曲谱编辑', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await expect.poll(() => layoutErrors()).toEqual([]);
    await expect(page.getByTitle('将当前位置设为循环 A 点', { exact: true })).toBeVisible();
    await settings(); await expect(page.getByRole('combobox', { name: '每行小节数', exact: true })).toBeVisible(); await expect(page.getByTitle('增大字号', { exact: true })).toBeVisible();
    await page.locator('.chart-display-menu summary').click();
    await page.screenshot({ path: path.join(out, 'simple-score-mobile.png'), fullPage: true });
  });
  expect(errors).toEqual([]);
} catch (e) { failure = e.stack || e.message; await page.screenshot({ path: path.join(out, 'simple-studio-failure.png'), fullPage: true }).catch(() => {}); }
finally {
  const result = { passed: checks.length, checks, pageErrors: errors, failure, analysisRequests: requests, mockSaveCount: saves.length, projectWrites: 'Browser route fixtures only; no user projects changed.' };
  await fs.writeFile(path.join(out, 'simple-studio-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); await browser.close();
}
if (failure || errors.length) process.exitCode = 1;
