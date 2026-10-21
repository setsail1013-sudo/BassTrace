import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import type { Project, ManualFill } from '../src/music';

// Match a production bundle: tsx's keepNames helper is a module closure and cannot
// travel with Function.toString() into the deliberately standalone HTML reader.
const bundled = await build({ entryPoints: ['src/three-track-export.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, minify: true, keepNames: false });
const { exportThreeTrackHtml } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`) as typeof import('../src/three-track-export');

const group = (id: string, start: number, count: number): ManualFill => ({ id, notes: Array.from({ length: count }, (_, i) => ({
  id: `${id}-${i}`, digit: (i % 7 + 1) as 1, start: start + i * .125, end: start + (i + 1) * .125, lines: (i % 3) as 0 | 1 | 2, octave: (i % 5 - 2) as 0,
  notation: { cut: i % 5 === 0, accent: i % 4 === 0, dead: i === count - 1, connection: i + 1 < count - 1 ? { kind: (['slideUp', 'slideDown', 'hammer', 'pull'] as const)[i % 4], targetNoteId: `${id}-${i + 1}` } : null },
})) });
const project: Project = { id: 'portable-color-check', title: '彩色排练谱 · 原创验证', artist: '字号与演奏技法', duration: 16, originalKey: 'C Major', key: 'C Major', bpm: 120, meter: '4/4', offset: 0, beatTimes: [], sections: [], chords: [], notes: [], markers: [], stems: [], updatedAt: '', revision: 1, isDemo: false,
  topTrack: 'bass', bassEvents: [{ id: 'b1', start: 0, end: 1, pitchClass: 0, confidence: 1, source: 'manual', locked: true }, { id: 'b2', start: 1, end: 12, pitchClass: 9, confidence: 1, source: 'manual', locked: true }, { id: 'b3', start: 12, end: 16, pitchClass: 7, confidence: 1, source: 'manual', locked: true }],
  lyrics: [{ id: 'l1', text: '这是用来检查中文歌词字号的一整句原创文字', start: 1, end: 7, source: 'manual', locked: true }, { id: 'l2', text: '不同颜色与滑音切音标记清楚可见', start: 9, end: 14, source: 'manual', locked: true }],
  manualFills: [group('tight', 0, 32), group('cross-row', 7.5, 8)], analysis: { state: 'idle', stage: '', progress: 0, warnings: [] },
};
const output = path.resolve('../docs/verification'); await fs.mkdir(output, { recursive: true });
const pdfOutput = path.resolve('../output/pdf'); await fs.mkdir(pdfOutput, { recursive: true });
const html = exportThreeTrackHtml(project); await fs.writeFile(path.join(output, 'bass-style-portable.html'), html);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.setContent(html); await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.event.lyric').first()).toHaveCSS('font-size', '20px');
  await expect(page.locator('.event.lyric').first()).toHaveCSS('color', 'rgb(29, 29, 31)');
  await expect(page.locator('.event.chord').first()).toHaveCSS('color', 'rgb(29, 78, 216)');
  await expect(page.locator('.event.fill').first()).toHaveCSS('color', 'rgb(22, 112, 71)');
  await expect(page.locator('.digit.dead').first()).toHaveCSS('color', 'rgb(198, 40, 40)');
  await expect(page.locator('.fill-connections path').first()).toHaveCSS('stroke', 'rgb(198, 40, 40)');
  const checkBounds = async () => {
    await expect(page.locator('.event.fill')).toHaveCount(40);
    const failed = await page.locator('.event.fill').evaluateAll(notes => notes.flatMap(note => {
      const box = note.getBoundingClientRect(), lane = note.parentElement!.getBoundingClientRect();
      return box.left < lane.left - 1 || box.right > lane.right + 1 || box.bottom > lane.bottom + 1 ? [note.getAttribute('data-id')] : [];
    }));
    expect(failed).toEqual([]);
    const badSymbols = await page.locator('.event.fill').evaluateAll(notes => notes.flatMap(note => {
      const box = note.getBoundingClientRect();
      return Array.from(note.querySelectorAll('.digit,.octave,.technique-marks')).flatMap(symbol => {
        if (!symbol.textContent?.trim()) return [];
        const rect = symbol.getBoundingClientRect();
        return rect.left < box.left - 1 || rect.right > box.right + 1 || rect.bottom > box.bottom + 1 ? [note.getAttribute('data-id')] : [];
      });
    }));
    expect(badSymbols).toEqual([]);
    const badText = await page.locator('.event.lyric,.event.chord').evaluateAll(events => events.flatMap(event => {
      const box = event.getBoundingClientRect(), lane = event.parentElement!.getBoundingClientRect();
      return box.left < lane.left - 1 || box.right > lane.right + 1 || box.bottom > lane.bottom + 1 ? [event.getAttribute('data-id')] : [];
    }));
    expect(badText).toEqual([]);
    const actualTimes = await page.locator('.event.fill').evaluateAll(notes => Object.fromEntries(notes.map(note => [note.getAttribute('data-id'), [Number(note.getAttribute('data-start')), Number(note.getAttribute('data-end'))]])));
    expect(actualTimes).toEqual(Object.fromEntries(project.manualFills!.flatMap(group => group.notes.map(note => [note.id, [note.start, note.end]]))));
  };
  await checkBounds(); await page.screenshot({ path: path.join(output, 'bass-style-portable-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await checkBounds();
  await expect(page.locator('.event.lyric').first()).toHaveCSS('font-size', '20px');
  await page.screenshot({ path: path.join(output, 'bass-style-portable-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' }); await checkBounds();
  await expect(page.locator('.event.lyric').first()).toHaveCSS('font-size', '16px');
  await expect(page.locator('.event.chord').first()).toHaveCSS('color', 'rgb(29, 78, 216)');
  await page.screenshot({ path: path.join(output, 'bass-style-portable-print.png'), fullPage: true });
  await page.pdf({ path: path.join(pdfOutput, 'bass-style-portable-a4.pdf'), preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' }); await page.locator('#printOrientation').selectOption('landscape'); await page.emulateMedia({ media: 'print' }); await checkBounds();
  await page.pdf({ path: path.join(pdfOutput, 'bass-style-portable-landscape.pdf'), preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' }); await page.locator('#printOrientation').selectOption('portrait'); await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => { const check = document.getElementById('printColor') as HTMLInputElement; check.checked = false; check.dispatchEvent(new Event('change')); });
  for (const selector of ['.event.lyric', '.event.chord', '.event.fill', '.digit.dead']) await expect(page.locator(selector).first()).toHaveCSS('color', 'rgb(0, 0, 0)');
  await expect(page.locator('.fill-connections path').first()).toHaveCSS('stroke', 'rgb(0, 0, 0)');
  await page.pdf({ path: path.join(pdfOutput, 'bass-style-portable-monochrome.pdf'), preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' }); await expect(page.locator('.event.chord').first()).toHaveCSS('color', 'rgb(29, 78, 216)');
  expect(errors).toEqual([]);
  await fs.writeFile(path.join(output, 'bass-style-export-results.json'), JSON.stringify({ passed: true, notes: 40, checks: ['lyric 20px / print12pt', 'four colors', 'red technique symbols and connections', 'compact and cross-row bounds', 'all lyrics and note data retained', 'desktop and mobile', 'portrait and landscape A4', 'monochrome print'], errors }, null, 2));
  console.log('PASS portable colors, 20px/12pt lyrics, compact/cross-row techniques, desktop/mobile/print bounds, monochrome print, no runtime errors');
} finally { if (errors.length) console.error('Browser errors:', errors); await browser.close(); }
