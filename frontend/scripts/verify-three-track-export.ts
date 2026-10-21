import { chromium, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exportThreeTrackHtml } from '../src/three-track-export.ts';
import { type Project } from '../src/music.ts';
import { packTxtLyrics } from '../src/tracks.ts';

const out = path.resolve('../docs/verification');
await fs.mkdir(out, { recursive: true });
const fixture: Project = {
  id: 'three-track-export', title: '城市夜行 · 三轨排练谱', artist: '原创验证素材', duration: 32,
  originalKey: 'C Major', key: 'C Major', bpm: 120, meter: '4/4', offset: .75, beatTimes: [],
  sections: [{ id: 'intro', name: 'Intro', startBar: 1, endBar: 4, color: '#007aff' }, { id: 'verse', name: 'Verse', startBar: 5, endBar: 12, color: '#007aff' }, { id: 'chorus', name: 'Chorus', startBar: 13, endBar: 16, color: '#007aff' }],
  chords: Array.from({ length: 16 }, (_, index) => ({ id: `chord-${index}`, bar: index + 1, beat: 1, label: ['Cmaj7', 'Am7', 'Dm7', 'G7'][index % 4], source: 'manual', confidence: 1, locked: true })),
  lyrics: [
    { id: 'pickup', text: '弱拍起唱保留完整', start: 0, end: 1, source: 'manual', locked: true },
    { id: 'cross-bar', text: '这一句从小节末尾开始跨过小节线，歌词的每一个字都完整保留', start: 2.5, end: 7.5, source: 'manual', locked: true },
    { id: 'near-row-end', text: '这一句开始在一行末尾，允许独立换行而不缩成竖排，也不会和加花轨道互相挤压', start: 8.6, end: 12, source: 'manual', locked: true },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `dense-${index}`, text: `歌词片段 ${index + 1} 保留原文与空 格`, start: 9 + index * .18, end: 9.8 + index * .18, source: 'manual' as const, locked: true })),
    { id: 'tail', text: '结束边界的歌词不会遗漏', start: 32, end: 32, source: 'manual', locked: true },
  ],
  manualFills: [{ id: 'first-group', notes: Array.from({ length: 14 }, (_, index) => ({ id: `written-${index}`, digit: (index % 8) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7, start: 2.1 + index * .125, end: 2.225 + index * .125, lines: (index % 3) as 0 | 1 | 2, octave: ((index % 5) - 2) as -2 | -1 | 0 | 1 | 2 })) }, { id: 'cross-row-group', notes: [{ id: 'fill-row-end', digit: 4, start: 8.6, end: 8.85, lines: 1, octave: 2 }, { id: 'fill-next-row', digit: 5, start: 8.85, end: 9, lines: 2, octave: -2 }] }],
  notes: [{ id: 'old-note-should-not-display', midi: 44, start: 1, duration: .5, source: 'analysis', confidence: .8, locked: false }],
  markers: [{ id: 'old-auto-fill', time: 1, label: 'FILL', text: '旧自动加花不显示', source: 'analysis' }], stems: [],
  analysis: { state: 'complete', stage: '', progress: 100, warnings: [] }, updatedAt: '', revision: 1, isDemo: false,
};
fixture.chords.push(...Array.from({ length: 5 }, (_, index) => ({ id: `dense-chord-${index}`, bar: 1, beat: 3 + index * .14, label: ['Cmaj7/E', 'Fmaj7(add13)', 'G7/B', 'Dm7', 'Am7'][index], source: 'manual' as const, confidence: 1, locked: true })));
const html = exportThreeTrackHtml(fixture);
await fs.writeFile(path.join(out, 'three-track-portable.html'), html);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const failures: string[] = [], checks: string[] = [], requests: string[] = [];
page.on('pageerror', error => failures.push(error.message));
page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
const check = async (name: string, action: () => Promise<void>) => { await action(); checks.push(name); };
const verifyLayout = async (target: Page = page) => target.evaluate(() => {
  const errors: string[] = [];
  document.querySelectorAll<HTMLElement>('.track-events').forEach(track => {
    const bounds = track.getBoundingClientRect();
    const events = [...track.querySelectorAll<HTMLElement>('.event')];
    events.forEach((event, i) => {
      const rect = event.getBoundingClientRect();
      if (rect.left < bounds.left - .6 || rect.right > bounds.right + .6 || rect.top < bounds.top - .6 || rect.bottom > bounds.bottom + .6) errors.push(`outside: ${event.dataset.id}`);
      const anchor = rect.left + parseFloat(event.style.getPropertyValue('--anchor-shift'));
      const wanted = bounds.left + Number(event.dataset.anchor) * track.clientWidth;
      if (Math.abs(anchor - wanted) > .6) errors.push(`time anchor moved: ${event.dataset.id}`);
      events.slice(i + 1).forEach(other => {
        const next = other.getBoundingClientRect();
        if (Math.min(rect.right, next.right) - Math.max(rect.left, next.left) > .6 && Math.min(rect.bottom, next.bottom) - Math.max(rect.top, next.top) > .6) errors.push(`overlap: ${event.dataset.id} / ${other.dataset.id}`);
      });
    });
  });
  if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('horizontal document overflow');
  return errors;
});
const checkContents = async () => {
  await expect(page.locator('.event.chord')).toHaveCount(21);
  await expect(page.locator('.event.fill')).toHaveCount(16);
  await expect(page.locator('.event.lyric')).toHaveCount(fixture.lyrics.length);
  for (const lyric of fixture.lyrics) await expect(page.locator(`[data-id="${lyric.id}"] .lyric-text`)).toHaveText(lyric.text);
  expect(await page.locator('body').innerText()).not.toContain('旧自动加花不显示');
  await expect.poll(() => verifyLayout()).toEqual([]);
};

try {
  await page.setContent(html, { waitUntil: 'load' });
  await check('Desktop standalone export has separate collision-free tracks and retains exact time anchors', async () => {
    await checkContents();
    expect(requests).toEqual([]);
    await page.screenshot({ path: path.join(out, 'three-track-portable-desktop.png'), fullPage: true });
  });
  await check('Degree display recalculates chord height without losing fill or lyric text', async () => {
    await page.getByRole('checkbox', { name: '显示级数' }).check();
    await expect(page.locator('.degree').first()).toBeVisible(); await checkContents();
    await page.getByRole('checkbox', { name: '显示级数' }).uncheck();
  });
  await check('TXT tight packing leaves adjacent fragments on one baseline with no added collision gap', async () => {
    const pairPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pair = { ...fixture, duration: 8, offset: 0, sections: [], chords: [], manualFills: [], lyrics: [
      { id: 'packed-0', text: '紧挨着的第一句', start: 0, end: 2, source: 'manual' as const, locked: true },
      { id: 'packed-1', text: '第二句紧跟着', start: 0, end: 2, source: 'manual' as const, locked: true },
    ] };
    await pairPage.setContent(exportThreeTrackHtml(pair), { waitUntil: 'load' });
    const sizes = await pairPage.evaluate(() => ({
      width: document.querySelector<HTMLElement>('.lyric-track .track-events')!.clientWidth,
      text: Object.fromEntries([...document.querySelectorAll<HTMLElement>('.event.lyric')].map(event => [event.innerText, event.getBoundingClientRect().width])),
    }));
    let id = 0;
    pair.lyrics = packTxtLyrics(pair, pair.lyrics.map(lyric => lyric.text).join('\n'), { rowWidth: sizes.width, barsPerRow: 4, fontSize: 14, measureText: text => sizes.text[text] }, () => `packed-${id++}`);
    await pairPage.setContent(exportThreeTrackHtml(pair), { waitUntil: 'load' });
    await expect.poll(() => verifyLayout(pairPage)).toEqual([]);
    await expect(pairPage.locator('.event.lyric')).toHaveCount(2);
    await expect(pairPage.locator('[data-id="packed-0"]')).toHaveAttribute('data-lane', '0');
    await expect(pairPage.locator('[data-id="packed-1"]')).toHaveAttribute('data-lane', '0');
    await pairPage.screenshot({ path: path.join(out, 'three-track-portable-packed-lyrics.png'), fullPage: true });
    await pairPage.close();
  });
  await check('Mobile viewport retains all original text and dots with no overlaps or horizontal scroll', async () => {
    await page.setViewportSize({ width: 390, height: 850 }); await checkContents();
    await page.screenshot({ path: path.join(out, 'three-track-portable-mobile.png'), fullPage: true });
  });
  await check('Black-and-white print styles retain all tracks in portrait and landscape widths', async () => {
    await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' }); await checkContents();
    await expect(page.locator('.controls')).not.toBeVisible();
    await page.screenshot({ path: path.join(out, 'three-track-portable-print.png'), fullPage: true });
    await page.setViewportSize({ width: 1123, height: 794 }); await checkContents();
    await page.emulateMedia({ media: 'screen' }); await page.setViewportSize({ width: 1280, height: 900 });
  });
  await check('Local audio attachment enables accurate click-to-seek without network access', async () => {
    const samples = 8000 * 40, wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    await page.locator('#audioFile').setInputFiles({ name: 'local-test.wav', mimeType: 'audio/wav', buffer: wav });
    await expect.poll(() => page.locator('#player').evaluate((audio: HTMLAudioElement) => Number.isFinite(audio.duration))).toBe(true);
    await page.locator('[data-id="cross-bar"]').click();
    await expect.poll(() => page.locator('#player').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThanOrEqual(2.5);
    const time = await page.locator('#player').evaluate((audio: HTMLAudioElement) => { const value = audio.currentTime; audio.pause(); return value; });
    expect(time).toBeLessThan(3); expect(requests).toEqual([]);
  });
  await check('Portable structure overview keeps section navigation and no old automatic fill data', async () => {
    await page.setContent(exportThreeTrackHtml(fixture, 'structure'), { waitUntil: 'load' });
    await expect(page.locator('.section-card')).toHaveCount(3);
    await expect(page.locator('.score-row')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('旧自动加花不显示');
  });
  expect(failures).toEqual([]);
  await fs.writeFile(path.join(out, 'three-track-portable-verification.json'), JSON.stringify({ checks, failures, networkRequests: requests }, null, 2));
  console.log(`Passed ${checks.length} portable export checks.`);
} finally { await browser.close(); }
