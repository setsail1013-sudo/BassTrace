import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const origin = 'http://127.0.0.1:8000', out = path.resolve('../docs/verification'), pdf = path.resolve('../output/pdf');
await fs.mkdir(out, { recursive: true }); await fs.mkdir(pdf, { recursive: true });
const demo = await fetch(`${origin}/api/projects/demo`).then(r => r.json());
let fixture = { ...demo, id: 'demo', title: '编辑交互 · 原创验证', artist: '原创测试', duration: 32, bpm: 120, meter: '4/4', offset: 0, beatTimes: [],
  sections: [{ id: 's1', name: 'Intro', startBar: 1, endBar: 8, color: '#aaa' }, { id: 's2', name: 'Verse', startBar: 9, endBar: 16, color: '#aaa' }],
  chords: [{ id: 'c1', label: 'Cmaj7', bar: 1, beat: 1, source: 'manual', locked: true, confidence: 1 }, { id: 'c2', label: 'G/B', bar: 1, beat: 2, source: 'manual', locked: true, confidence: 1 }, { id: 'c3', label: 'Am7', bar: 3, beat: 1, source: 'manual', locked: true, confidence: 1 }],
  lyrics: [{ id: 'a', text: '第一句原创歌词', start: 1, end: 6, order: 0 }, { id: 'b', text: '第二句', start: 6, end: 12, order: 1 }, { id: 'c', text: '第三句', start: 12, end: 15, order: 2 }, { id: 'd', text: '结尾歌词', start: 24, end: 27, order: 3 }].map(l => ({ ...l, source: 'manual', locked: true })),
  manualFills: [], lyricsOriginal: '第一句原创歌词\n第二句\n第三句\n结尾歌词', analysis: { state: 'idle', progress: 0, stage: '', warnings: [] }, lyricAlignment: { state: 'idle', progress: 0, stage: '', lines: [], detectedSegments: [], warnings: [], error: null } };
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message)); let saves = 0;
await page.route('**/api/projects**', async route => {
  const req = route.request(), url = new URL(req.url()).pathname;
  if (url === '/api/projects') return route.fulfill({ json: [fixture] });
  if (url === '/api/projects/demo') { if (req.method() === 'PUT') { fixture = { ...req.postDataJSON(), revision: fixture.revision + 1 }; saves++; } return route.fulfill({ json: fixture }); }
  return route.fulfill({ status: 404, json: { detail: 'Fixture only' } });
});
const lyric = id => page.locator(`button[data-lyric-id="${id}"]`);
const editor = () => page.getByRole('textbox', { name: '直接编辑歌词', exact: true });
const caret = async n => editor().evaluate((el, pos) => { el.focus(); el.setSelectionRange(pos, pos); }, n);
const save = async () => { const count = saves; await page.keyboard.press('Control+s'); await expect.poll(() => saves).toBeGreaterThan(count); };
const load = async () => { await page.goto(origin, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: '曲谱编辑', exact: true }).click(); };
const check = async (name, run) => { await run(); checks.push(name); console.log('PASS ' + name); };
const drag = async (id, row, fraction) => {
  const source = lyric(id); await source.scrollIntoViewIfNeeded(); const start = await source.boundingBox();
  await page.mouse.move(start.x + 3, start.y + start.height / 2); await page.mouse.down(); await page.mouse.move(start.x + 12, start.y + start.height / 2, { steps: 3 });
  const lane = page.locator(`.score-row[data-start-bar="${row}"] [data-track="lyric"]`); await lane.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' })); await page.waitForTimeout(80); const end = await lane.boundingBox();
  await page.mouse.move(end.x + end.width * fraction + 3, end.y + end.height / 2, { steps: 12 }); await page.waitForTimeout(80); await page.mouse.up(); await save();
};
const overlapErrors = async target => target.evaluate(() => {
  const errors = [];
  for (const lane of document.querySelectorAll('.manual-fill-track,.editable-lyric-track,.chord-track,.track-events')) {
    const bounds = lane.getBoundingClientRect();
    const nodes = [...lane.querySelectorAll('.manual-fill-note,.track-lyric,.chord,.event')].filter(e => getComputedStyle(e).display !== 'none');
    const boxes = nodes.map(e => e.getBoundingClientRect());
    boxes.forEach((r, i) => {
      if (r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1) errors.push('outside lane ' + nodes[i].textContent);
      const lo = Number(nodes[i].dataset.rangeLeft), hi = Number(nodes[i].dataset.rangeRight);
      if (Number.isFinite(lo) && Number.isFinite(hi) && (r.left < bounds.left + lo - 1 || r.right > bounds.left + hi + 1)) errors.push('outside chord');
      for (const b of boxes.slice(i + 1)) if (Math.min(r.right, b.right) - Math.max(r.left, b.left) > 1 && Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 1) errors.push('overlap');
    });
  }
  return errors;
});
let failure = null;
try {
  await load(); await expect(page.locator('.score-row')).toHaveCount(4); await expect.poll(() => errors).toEqual([]);
  await check('Dragging into silence moves only the selected lyric despite continuous LRC end times', async () => {
    const before = structuredClone(fixture.lyrics); await drag('a', 1, .3);
    expect(fixture.lyrics[0].start).toBeGreaterThan(2); expect(fixture.lyrics[0].start).toBeLessThan(2.6); expect(fixture.lyrics.slice(1)).toEqual(before.slice(1));
    expect(fixture.lyrics[0].end - fixture.lyrics[0].start).toBeCloseTo(5, 8);
  });
  await check('Head Space and Backspace move exactly a quarter beat; fast double presses consume gaps, not text', async () => {
    const at = fixture.lyrics[0].start; await lyric('a').dblclick(); await caret(0); await page.keyboard.press('Space'); await page.keyboard.press('Space');
    await expect(editor()).toHaveValue('第一句原创歌词'); await page.keyboard.press('Backspace'); await save(); expect(fixture.lyrics[0].start).toBeCloseTo(at + .125, 7); expect(fixture.lyrics).toHaveLength(4);
    await page.keyboard.press('Control+z'); await save(); expect(fixture.lyrics[0].start).toBeCloseTo(at + .25, 7);
    await page.keyboard.press('Control+Shift+z'); await save(); expect(fixture.lyrics[0].start).toBeCloseTo(at + .125, 7);
  });
  await check('Text shortcuts split and merge with one undo; ordinary spaces and Chinese IME remain text', async () => {
    await lyric('a').dblclick(); await caret(2); await page.keyboard.press('Control+Enter'); await expect(editor()).toHaveValue('句原创歌词'); await save(); expect(fixture.lyrics).toHaveLength(5);
    const right = fixture.lyrics[1].id; await lyric(right).dblclick(); await page.keyboard.press('Control+Shift+Enter'); await save(); expect(fixture.lyrics).toHaveLength(4); expect(fixture.lyrics[0].text).toBe('第一句原创歌词');
    await lyric('a').dblclick(); await caret(2); await page.keyboard.press('Space'); await page.waitForTimeout(550); await page.keyboard.press('Space');
    await editor().evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, isComposing: true })); el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    await save(); expect(fixture.lyrics[0].text).toBe('第一  句原创歌词'); expect(fixture.lyrics).toHaveLength(4);
  });
  await check('Dragging past the next phrase pushes it but stops at a later gap; cross-section motion remains independent', async () => {
    const oldC = structuredClone(fixture.lyrics[2]), oldD = structuredClone(fixture.lyrics[3]), chord = JSON.stringify(fixture.chords);
    await drag('a', 1, .81); expect(fixture.lyrics[0].start).toBeGreaterThan(6); expect(fixture.lyrics[1].start).toBeGreaterThan(fixture.lyrics[0].start); expect(fixture.lyrics[2]).toEqual(oldC); expect(fixture.lyrics[3]).toEqual(oldD);
    await drag('c', 9, .2); expect(fixture.lyrics[2].start).toBeGreaterThan(16); expect(fixture.lyrics[3]).toEqual(oldD); expect(JSON.stringify(fixture.chords)).toBe(chord);
  });
  await check('Object keyboard movement, F2 and deletion share undo; input arrows remain caret movement', async () => {
    await lyric('c').focus(); const before = fixture.lyrics[2].start; await page.keyboard.press('ArrowLeft'); await save(); expect(fixture.lyrics[2].start).toBeCloseTo(before - .125, 7);
    await lyric('c').focus(); await page.keyboard.press('F2'); await expect(editor()).toBeVisible(); await caret(2); await page.keyboard.press('ArrowLeft'); expect(await editor().evaluate(e => e.selectionStart)).toBe(1); await page.keyboard.press('Escape');
    await lyric('b').focus(); const tail = structuredClone(fixture.lyrics.slice(2)); await page.keyboard.press('Delete'); await save(); expect(fixture.lyrics).toHaveLength(3); expect(fixture.lyrics.slice(1)).toEqual(tail); await page.keyboard.press('Control+z'); await save(); expect(fixture.lyrics).toHaveLength(4);
  });
  await check('Long fill stays inside its chord, wraps clearly, and keyboard notation preserves all note times', async () => {
    const lane = page.locator('.manual-fill-track').first(); await lane.scrollIntoViewIfNeeded(); const box = await lane.boundingBox(); await page.mouse.click(box.x + 1, box.y + 20);
    await page.getByRole('textbox', { name: '手写加花数字' }).fill('1234567012345670'); await page.keyboard.press('Enter'); await expect(page.locator('.manual-fill-note')).toHaveCount(16); await save();
    const note = page.locator('.manual-fill-note').first(); await note.click(); await expect(page.getByText('紧凑显示 · 演奏时间保留', { exact: true })).toBeVisible();
    await page.keyboard.press(']'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('7'); await save();
    const first = fixture.manualFills[0].notes[0]; expect(first.digit).toBe(7); expect(first.lines).toBe(1); expect(first.octave).toBe(1);
    await expect.poll(() => overlapErrors(page)).toEqual([]);
    const data = await page.locator('.manual-fill-note').evaluateAll(nodes => nodes.map(n => ({ top: n.offsetTop, font: parseFloat(getComputedStyle(n).fontSize), compact: n.dataset.compact })));
    expect(new Set(data.map(n => n.top)).size).toBeGreaterThan(1); expect(data.every(n => n.font >= 12 && n.compact === 'true')).toBeTruthy();
  });
  await check('Global shortcuts, contextual command search, forms and navigation work without stealing typed letters', async () => {
    await page.keyboard.press('F1'); await expect(page.getByRole('dialog', { name: '快捷键帮助', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k'); await page.getByRole('textbox', { name: '搜索操作或快捷键' }).fill('修改 BPM'); await page.keyboard.press('Enter'); await expect(page.getByRole('dialog', { name: '速度与拍号', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+3'); await expect(page.getByRole('heading', { name: '我的曲库', exact: true })).toBeVisible(); await page.keyboard.press('Alt+2');
    await lyric('a').dblclick(); await editor().fill('G D V A B R 文字保留'); await page.keyboard.press('Control+s'); expect(fixture.lyrics[0].text).toBe('G D V A B R 文字保留');
    await page.keyboard.press('Control+Shift+l'); await expect(page.getByRole('dialog', { name: '导入歌词', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  });
  await check('Save / reopen and BPM correction preserve timestamps and manual fills', async () => {
    const before = JSON.stringify({ lyrics: fixture.lyrics, fills: fixture.manualFills }); await load(); expect(JSON.stringify({ lyrics: fixture.lyrics, fills: fixture.manualFills })).toBe(before);
    await page.keyboard.press('g'); await page.getByRole('button', { name: '½ 速度', exact: true }).click(); await page.keyboard.press('Control+Enter'); await save(); expect(JSON.stringify({ lyrics: fixture.lyrics, fills: fixture.manualFills })).toBe(before);
    await page.keyboard.press('Control+z'); await save();
  });
  await check('Desktop and mobile keep all tracks and compact digits without overlaps', async () => {
    await expect.poll(() => overlapErrors(page)).toEqual([]); await page.screenshot({ path: path.join(out, 'editing-upgrade-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.manual-fill-note')).toHaveCount(16); await expect.poll(() => overlapErrors(page)).toEqual([]);
    await page.screenshot({ path: path.join(out, 'editing-upgrade-mobile.png'), fullPage: true }); await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('Print portrait / landscape and offline HTML use compact layout and keep all digits', async () => {
    await page.emulateMedia({ media: 'print' }); await page.waitForTimeout(150); await expect.poll(() => overlapErrors(page)).toEqual([]);
    await page.pdf({ path: path.join(pdf, 'editing-upgrade-a4.pdf'), format: 'A4', printBackground: false }); await page.pdf({ path: path.join(pdf, 'editing-upgrade-landscape.pdf'), format: 'A4', landscape: true, printBackground: false }); await page.emulateMedia({ media: 'screen' });
    await page.keyboard.press('Control+Shift+e'); const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /互动 HTML 谱/ }).click()]); const file = path.join(out, 'editing-upgrade-portable.html'); await download.saveAs(file);
    const reader = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); reader.on('pageerror', e => errors.push('HTML: ' + e.message)); await reader.goto('file:///' + file.replaceAll('\\', '/')); await expect(reader.locator('.event.fill')).toHaveCount(16); await expect.poll(() => overlapErrors(reader)).toEqual([]);
    await reader.emulateMedia({ media: 'print' }); await reader.pdf({ path: path.join(pdf, 'editing-upgrade-html-a4.pdf'), format: 'A4', printBackground: false }); await reader.close();
  });
  await check('At zero gap double Backspace merges; a press that consumes the last gap never arms a merge', async () => {
    await page.keyboard.press('Escape'); await page.keyboard.press('Control+Shift+l'); await page.getByRole('button', { name: 'TXT 纯文本', exact: true }).click(); await page.locator('.lyrics-input').fill('前句\n后句'); await page.getByRole('button', { name: '导入歌词片段', exact: true }).click(); await save();
    const right = fixture.lyrics[1].id; await lyric(right).dblclick(); await caret(0); await page.keyboard.press('Space'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await expect(editor()).toHaveValue('后句'); await expect(page.locator('[data-lyric-id]')).toHaveCount(2);
    await page.keyboard.press('Backspace'); await expect(editor()).toHaveValue('前句后句'); await save(); expect(fixture.lyrics).toHaveLength(1);
    await page.keyboard.press('Control+z'); await save(); expect(fixture.lyrics).toHaveLength(2);
  });
  await check('IME composition and held keys cannot move the head; undo in an active editor includes an unsaved draft', async () => {
    const first = structuredClone(fixture.lyrics[0]); await lyric(first.id).dblclick(); await caret(0);
    await editor().evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); for (let i = 0; i < 2; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, isComposing: true })); el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, repeat: true })); });
    await save(); expect(fixture.lyrics[0]).toEqual(first);
    await lyric(first.id).dblclick(); await editor().fill('尚未自动保存的改字'); await page.keyboard.press('Control+z'); await save(); expect(fixture.lyrics[0].text).toBe(first.text);
    await page.keyboard.press('Control+y'); await save(); expect(fixture.lyrics[0].text).toBe('尚未自动保存的改字');
  });
  await check('Command search keeps the live lyric caret for split and playback shortcuts respect edit focus', async () => {
    const first = fixture.lyrics[0].id; await lyric(first).dblclick(); await caret(2); await page.keyboard.press('Control+k'); await page.getByRole('textbox', { name: '搜索操作或快捷键' }).fill('在光标处拆分歌词'); await page.keyboard.press('Enter'); await expect(editor()).toHaveValue('自动保存的改字'); await save(); expect(fixture.lyrics).toHaveLength(3);
    await page.locator('body').click({ position: { x: 10, y: 10 } }); await page.keyboard.press('Space'); await expect(page.locator('.play-button svg')).toHaveClass(/lucide-pause/); await page.keyboard.press('Space'); await expect(page.locator('.play-button svg')).toHaveClass(/lucide-play/);
  });
  expect(errors).toEqual([]);
} catch (error) { failure = String(error.stack || error); console.error(failure); await page.screenshot({ path: path.join(out, 'editing-upgrade-failure.png'), fullPage: true }).catch(() => {}); }
await fs.writeFile(path.join(out, 'editing-upgrade-results.json'), JSON.stringify({ checks, errors, failure, saves }, null, 2)); await browser.close(); if (failure) process.exitCode = 1;
