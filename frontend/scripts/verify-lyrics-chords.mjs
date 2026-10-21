import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = 'http://127.0.0.1:8000';
const output = path.resolve('../docs/verification');
await fs.mkdir(output, { recursive: true });
// This GET only copies the demo. All browser project writes and analysis jobs are mocked below.
const demo = await fetch(`${origin}/api/projects/demo`).then(response => response.json());
const chord = (id, bar, beat, label, source = 'analysis', locked = false) => ({ id, bar, beat, label, source, locked, confidence: .8 });
let fixture = {
  ...structuredClone(demo), duration: 8, bpm: 120, meter: '4/4', offset: 0, beatTimes: [], key: 'C Major', originalKey: 'C Major',
  sections: [{ id: 'plain-view', name: '歌词与和弦验证', startBar: 1, endBar: 4, color: '#cb986f' }],
  analysis: { state: 'idle', stage: '', progress: 0, warnings: [] },
  lyricAlignment: { state: 'idle', stage: '', progress: 0, detectedSegments: [], lines: [], warnings: [], error: null },
  lyricsOriginal: '先保留这一句歌词',
  lyrics: [{ id: 'original-line', text: '先保留这一句歌词', start: .5, end: 4, source: 'manual', locked: true }],
  notes: demo.notes.filter(note => note.start < 8),
  markers: [{ id: 'auto-fill', time: 1.5, label: 'FILL', text: '原曲自动候选', source: 'analysis' }, { id: 'manual-break', time: 3.2, label: 'BREAK', text: '人工保留备注', source: 'manual' }],
  stems: demo.stems.map(stem => stem.id === 'vocals' ? { ...stem, available: false, url: '' } : stem),
  chords: [chord('later-C', 3, 2, 'C', 'demo'), chord('first-C', 1, 1, 'C'), chord('hidden-C', 1, 2.5, 'C'), chord('actual-E', 1, 3.625, 'E'), chord('return-C', 2, 1.25, 'C'), chord('hidden-again', 2, 2, 'C'), chord('manual-C', 2, 2.5, 'C', 'manual'), chord('confirmed-C', 3, 1, 'C', 'analysis', true), chord('candidate-E', 4, 3.75, 'E?')],
};
const original = structuredClone(fixture);
const visibleIds = ['first-C', 'actual-E', 'return-C', 'manual-C', 'confirmed-C', 'candidate-E'];
const checks = [], pageErrors = [], requests = [], saves = [], blocked = [];
let failure = null;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', error => pageErrors.push(error.message));
await page.route('**/api/projects**', async route => {
  const request = route.request(), pathname = new URL(request.url()).pathname;
  if (pathname === '/api/projects' && request.method() === 'GET') { await route.fulfill({ json: [fixture] }); return; }
  if (pathname === '/api/projects/demo' && request.method() === 'GET') { await route.fulfill({ json: fixture }); return; }
  if (pathname === '/api/projects/demo' && request.method() === 'PUT') {
    const submitted = request.postDataJSON();
    if (submitted.revision !== fixture.revision) { await route.fulfill({ status: 409, json: { detail: 'UI fixture revision conflict' } }); return; }
    fixture = { ...submitted, revision: fixture.revision + 1, updatedAt: new Date().toISOString() };
    saves.push(structuredClone(fixture)); await route.fulfill({ json: fixture }); return;
  }
  if (pathname === '/api/projects/demo/analyze' && request.method() === 'POST') {
    requests.push(request.postDataJSON());
    fixture = { ...fixture, revision: fixture.revision + 1, analysis: { state: 'complete', stage: '模拟分析完成', progress: 100, warnings: [] } };
    await route.fulfill({ json: fixture }); return;
  }
  // Never allow an unexpected write/analysis request to reach real user storage.
  blocked.push(`${request.method()} ${pathname}`);
  await route.fulfill({ status: 400, json: { detail: 'This browser fixture blocks unsupported project operations.' } });
});
const check = async (name, action) => { await action(); checks.push(name); };
const plainScore = async () => {
  await expect(page.locator('.number-bar,.number-toolbar,.tab-staff,.marker-lane,.root-hint')).toHaveCount(0);
  // Print hides the toolbar; inspect its state without requiring an accessible visible button.
  await expect(page.locator('.view-tabs button').filter({ hasText: '歌词与和弦' })).toHaveClass(/active/);
};
const unchangedMusic = () => {
  expect(fixture.notes).toEqual(original.notes); expect(fixture.markers).toEqual(original.markers); expect(fixture.chords).toEqual(original.chords);
};
const save = async () => {
  const before = saves.length;
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect.poll(() => saves.length).toBeGreaterThan(before);
  await expect(page.locator('.save-state')).toContainText('工程已保存');
};
const openAnalysis = async () => { await page.locator('.analyze-button').click(); await expect(page.getByRole('combobox', { name: '分析音频来源', exact: true })).toBeVisible(); };
try {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '曲谱编辑', exact: true }).click();
  await check('Default score contains only lyrics and chords; stored notes and markers survive', async () => {
    await plainScore(); await expect(page.locator('.lyric')).toHaveCount(1);
    await save(); unchangedMusic();
  });
  await check('Only repeated unconfirmed automatic chords collapse; manual and confirmed events remain', async () => {
    expect(await page.locator('.chord').evaluateAll(items => items.map(item => item.dataset.chordId))).toEqual(visibleIds);
    expect(fixture.chords).toHaveLength(9);
    await expect(page.locator('.chord-candidate-note')).toContainText('完整和弦待确认');
  });
  await check('Multiple fractional beat anchors retain their real positions', async () => {
    await expect.poll(() => page.locator('.chord').evaluateAll(items => items.every(item => {
      const bounds = item.closest('.chord-lane').getBoundingClientRect(), rect = item.getBoundingClientRect();
      const raw = item.style.getPropertyValue('--chord-anchor'), anchor = rect.left + (parseFloat(raw) || 0) * (raw.endsWith('%') ? rect.width / 100 : 1);
      return rect.left >= bounds.left - .6 && rect.right <= bounds.right + .6 && Math.abs(anchor - bounds.left - (Number(item.dataset.beat) - 1) / 4 * item.closest('.chord-lane').clientWidth) < .6;
    }))).toBe(true);
    await expect(page.locator('.chord[data-chord-id="actual-E"]')).toHaveAttribute('data-beat', '3.625');
    await expect(page.locator('.chord[data-chord-id="return-C"]')).toHaveAttribute('data-beat', '1.25');
  });
  await page.getByRole('button', { name: '音频分析', exact: true }).click();
  await check('No-vocals projects disable AI lyric recognition and alignment', async () => {
    await expect(page.getByRole('button', { name: '识别音频歌词', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '按原文对齐', exact: true })).toBeDisabled();
    await expect(page.locator('.la-note')).toContainText('贝斯单轨没有人声');
  });
  await check('LRC file import preserves fractional timestamps and all existing music data', async () => {
    await page.getByRole('button', { name: /歌词导入与对齐/ }).click();
    const raw = '[ti:验证歌词]\n[00:00.500]第一句真实时间\n[00:03.250]第二句真实时间';
    await page.locator('.modal input[type="file"]').setInputFiles({ name: 'test.lrc', mimeType: 'text/plain', buffer: Buffer.from(raw) });
    await expect(page.locator('.lyrics-input')).toHaveValue(raw);
    await page.getByRole('button', { name: '导入歌词片段', exact: true }).click(); await save();
    expect(fixture.lyricsOriginal).toBe(raw);
    expect(fixture.lyrics.map(lyric => [lyric.start, lyric.end, lyric.locked])).toEqual([[.5, 3.25, true], [3.25, 8, true]]);
    unchangedMusic(); await expect(page.locator('.lyric')).toHaveCount(2);
  });
  await check('Analysis sends bass and uploaded_bass sources with bass note transcription disabled', async () => {
    await openAnalysis(); await expect(page.getByRole('combobox', { name: '分析音频来源', exact: true })).toHaveValue('bass');
    await page.getByRole('button', { name: '开始分析', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0);
    expect(requests[0]).toEqual({ source: 'bass', separate: false, transcribe: false });
    await openAnalysis(); await page.getByRole('combobox', { name: '分析音频来源', exact: true }).selectOption('uploaded_bass');
    await expect(page.locator('.modal input[type="checkbox"]')).toHaveCount(0);
    await page.getByRole('button', { name: '开始分析', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0);
    expect(requests[1]).toEqual({ source: 'uploaded_bass', separate: false, transcribe: false }); unchangedMusic(); await plainScore();
  });
  await check('Numeric and TAB views stay optional and switching back does not erase stored notes', async () => {
    await page.getByRole('combobox', { name: '其他曲谱视图', exact: true }).selectOption('number');
    await expect(page.locator('.number-bar')).toHaveCount(4); await expect(page.locator('.number-toolbar')).toBeVisible();
    await page.getByRole('combobox', { name: '其他曲谱视图', exact: true }).selectOption('tab');
    await expect(page.locator('.tab-staff')).toHaveCount(4); await expect(page.locator('.number-toolbar')).toHaveCount(0);
    await page.getByRole('button', { name: '歌词与和弦', exact: true }).click(); await plainScore(); unchangedMusic();
  });
  await check('Default HTML and A4 print keep lyrics/chords and explain uncertain root candidates', async () => {
    await page.getByRole('button', { name: '导出曲谱', exact: true }).click();
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: /互动 HTML 谱/ }).click();
    const download = await pending, htmlPath = path.join(output, 'lyrics-chords-default.html'); await download.saveAs(htmlPath);
    await page.getByTitle('关闭', { exact: true }).click();
    const reader = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    reader.on('pageerror', error => pageErrors.push(error.message));
    await reader.setContent(await fs.readFile(htmlPath, 'utf8'), { waitUntil: 'load' });
    expect(await reader.locator('.chord').evaluateAll(items => items.map(item => item.dataset.id))).toEqual(visibleIds);
    await expect(reader.locator('.lyric')).toHaveCount(2);
    await expect(reader.locator('.portable-number,.portable-note,.marker,.root-hint,.tab')).toHaveCount(0);
    await expect(reader.locator('.chord-candidate-note')).toHaveCount(1);
    await expect(reader.locator('.chord-candidate-note')).toContainText('完整和弦待确认');
    await expect(reader.locator('.chord[data-id="actual-E"]')).toHaveAttribute('data-time', '1.3125');
    await expect(reader.locator('.chord[data-id="return-C"]')).toHaveAttribute('data-time', '2.125');
    await reader.emulateMedia({ media: 'print' }); await expect(reader.locator('.chord-candidate-note')).toBeVisible();
    await reader.pdf({ path: path.join(output, 'lyrics-chords-default-a4.pdf'), format: 'A4', printBackground: false }); await reader.close();
    await page.getByRole('button', { name: '曲谱编辑', exact: true }).click();
    await page.locator('.sheet').screenshot({ path: path.join(output, 'lyrics-chords-default.png') });
    await page.emulateMedia({ media: 'print' }); await plainScore(); await page.emulateMedia({ media: 'screen' });
  });
  await check('A missing separated bass track blocks analysis until separation is explicitly selected', async () => {
    fixture = { ...fixture, stems: fixture.stems.map(stem => stem.id === 'bass' ? { ...stem, available: false, url: '' } : stem) };
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '音频分析', exact: true }).click(); await openAnalysis();
    const source = page.getByRole('combobox', { name: '分析音频来源', exact: true });
    await expect(source).toHaveValue('uploaded_bass'); await source.selectOption('bass');
    await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
    await expect(page.locator('.form-error')).toContainText('工程还没有贝斯轨');
    await page.locator('.modal input[type="checkbox"]').check();
    await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeEnabled();
    await page.getByTitle('关闭', { exact: true }).click(); expect(requests).toHaveLength(2);
  });
  expect(pageErrors).toEqual([]); expect(blocked).toEqual([]);
} catch (error) { failure = error.stack || String(error); }
finally {
  const result = { passed: checks.length, checks, pageErrors, analysisRequests: requests, saves: saves.length, blockedRequests: blocked, failure, fixture: 'browser-only mock; no real analysis or project writes' };
  await fs.writeFile(path.join(output, 'lyrics-chords-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  await browser.close();
}
if (failure) process.exitCode = 1;
