import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionToTime, type Project } from './music.ts';
import { rowTimePercent } from './tracks.ts';
import { exportThreeTrackHtml } from './three-track-export.ts';
import { DEFAULT_SCORE_STYLE, readScoreStyle, scoreStyleVariables, scorePageCss } from './score-style.ts';

const base = (): Project => ({
  id: 'portable', title: '三轨排练谱', artist: '原创素材', duration: 16, originalKey: 'C Major', key: 'C Major',
  bpm: 120, meter: '4/4', offset: 0, beatTimes: [], sections: [], chords: [], lyrics: [], notes: [], markers: [], stems: [],
  manualFills: [], analysis: { state: 'idle', stage: '', progress: 0, warnings: [] }, updatedAt: '', revision: 1, isDemo: false,
});
const attributes = (html: string, id: string): string => {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`<button[^>]*data-id="${escaped}"[^>]*>`).exec(html);
  assert.ok(found, `Missing ${id}`);
  return found[0];
};
const numberAttribute = (html: string, id: string, name: string): number => Number(new RegExp(`${name}="([^"]*)"`).exec(attributes(html, id))?.[1]);

test('portable chart contains three independent tracks per shared row, never old generated notes or markers', () => {
  const p = base();
  p.chords = [{ id: 'c', bar: 2, beat: 3.5, label: 'Cmaj7/E', source: 'manual', confidence: 1, locked: true }];
  p.lyrics = [{ id: 'l', text: '歌词跨过小节线仍然完整', start: 1.8, end: 6, source: 'manual', locked: true }];
  p.notes = [{ id: 'old-auto-note', midi: 40, start: 2, duration: .5, source: 'analysis', confidence: .8, locked: false }];
  p.markers = [{ id: 'old-marker', time: 2, label: 'FILL', text: '自动加花不可迁入', source: 'analysis' }];
  p.manualFills = [{ id: 'fill-group', notes: [{ id: 'written', digit: 4, start: 2, end: 2.25, lines: 1, octave: 2 }] }];
  const snapshot = JSON.stringify(p), html = exportThreeTrackHtml(p);
  assert.equal((html.match(/class="score-row"/g) ?? []).length, 2);
  assert.equal((html.match(/class="track chord-track"/g) ?? []).length, 2);
  assert.equal((html.match(/class="track fill-track"/g) ?? []).length, 2);
  assert.equal((html.match(/class="track lyric-track"/g) ?? []).length, 2);
  assert.match(html, /class="track chord-track"[\s\S]*class="track fill-track"[\s\S]*class="track lyric-track"/);
  assert.ok(html.includes('歌词跨过小节线仍然完整') && html.includes('Cmaj7/E') && html.includes('Imaj7/III'));
  assert.match(attributes(html, 'written'), /data-group="fill-group"/);
  assert.ok(!html.includes('old-auto-note') && !html.includes('old-marker') && !html.includes('自动加花不可迁入'));
  assert.equal(JSON.stringify(p), snapshot);
});

test('fractional harmony, pickup lyrics and lyrics across row boundaries retain exact audio times and appear once', () => {
  const p = { ...base(), offset: 1, beatTimes: [0, .5, 1.1, 1.65, 2.25, 2.75, 3.3, 3.8, 4.45], duration: 17 };
  p.chords = [{ id: 'fractional', bar: 1, beat: 3.625, label: 'G/B', source: 'manual', confidence: 1, locked: true }];
  p.lyrics = [
    { id: 'pickup', text: '弱拍起唱', start: .1, end: 2, source: 'manual', locked: true },
    { id: 'long-line', text: '一整句跨越小节和谱面换行仍然只出现一次且没有省略', start: positionToTime(p, 4, 4), end: positionToTime(p, 6, 2), source: 'manual', locked: true },
    { id: 'boundary', text: '结尾完整', start: p.duration, end: p.duration, source: 'manual', locked: true },
  ];
  const html = exportThreeTrackHtml(p);
  assert.equal(numberAttribute(html, 'fractional', 'data-time'), positionToTime(p, 1, 3.625));
  assert.equal(numberAttribute(html, 'fractional', 'data-anchor'), rowTimePercent(p, 1, 4, positionToTime(p, 1, 3.625)) / 100);
  assert.equal(numberAttribute(html, 'pickup', 'data-anchor'), rowTimePercent(p, 1, 4, .1) / 100);
  p.lyrics.forEach(lyric => {
    assert.equal(numberAttribute(html, lyric.id, 'data-start'), lyric.start);
    assert.equal(numberAttribute(html, lyric.id, 'data-end'), lyric.end);
    assert.equal((html.match(new RegExp(`data-id="${lyric.id}"`, 'g')) ?? []).length, 1);
    assert.ok(html.includes(lyric.text));
  });
});

test('manual fill symbols support rests, each underline value and upper or lower octave dots', () => {
  const p = base();
  p.manualFills = [{ id: 'phrase', notes: [
    { id: 'rest', digit: 0, start: 0, end: .5, lines: 0, octave: 0 },
    { id: 'one-line', digit: 1, start: .5, end: .75, lines: 1, octave: 1 },
    { id: 'two-lines', digit: 2, start: .75, end: .875, lines: 2, octave: -2 },
  ] }];
  const html = exportThreeTrackHtml(p);
  assert.match(html, /data-digit="0" data-lines="0" data-octave="0"/);
  assert.match(html, /data-digit="1" data-lines="1" data-octave="1">[\s\S]*?<span class="octave above">•<\/span>/);
  assert.match(html, /data-digit="2" data-lines="2" data-octave="-2">[\s\S]*?<span class="rhythm"><i><\/i><i><\/i><\/span><span class="octave below">••<\/span>/);
  assert.equal(numberAttribute(html, 'two-lines', 'data-time'), .75);
  assert.equal(numberAttribute(html, 'two-lines', 'data-end'), .875);
});

test('all user-controlled text and attributes are escaped, and the offline reader needs no external source', () => {
  const p = base();
  p.title = '</title><script>throw new Error("unsafe")</script>';
  p.artist = '<img src=x onerror="unsafe">';
  p.sections = [{ id: 's', name: '<&"段落', startBar: 1, endBar: 8, color: '#007aff' }];
  p.chords = [{ id: 'c" onclick="unsafe', bar: 1, beat: 1, label: '<img src=x>', source: 'manual', confidence: 1, locked: true }];
  p.lyrics = [{ id: 'text" autofocus', text: '</button><script>unsafe</script> & "保留"', start: 0, end: 1, source: 'manual', locked: true }];
  const html = exportThreeTrackHtml(p);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.ok(html.includes('&lt;/title&gt;') && html.includes('&lt;img src=x&gt;'));
  assert.ok(html.includes('data-id="c&quot; onclick=&quot;unsafe"'));
  assert.ok(html.includes('&lt;/button&gt;&lt;script&gt;unsafe&lt;/script&gt; &amp; &quot;保留&quot;'));
  assert.ok(!html.includes('<img src=x') && !html.includes(' src="http') && !html.includes('fetch(') && !html.includes('import('));
  const reader = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(reader); assert.doesNotThrow(() => new Function(reader));
});

test('legacy projects default to an empty manual fill track, never bass pitch guesses', () => {
  const p = base(); delete p.manualFills;
  p.chords = [
    { id: 'analysis-bass-root-old', bar: 1, beat: 1, label: 'E?', source: 'analysis', confidence: .5, locked: false },
    { id: 'harmony', bar: 1, beat: 3, label: 'Am7', source: 'analysis', confidence: .8, locked: false },
  ];
  const html = exportThreeTrackHtml(p);
  assert.ok(html.includes('class="track fill-track"') && html.includes('Am7'));
  assert.ok(!html.includes('analysis-bass-root-old') && !html.includes('E?') && !html.includes('class="event fill"'));
});

test('structure mode retains covered and unassigned bar ranges and click-to-seek, without detailed tracks', () => {
  const p = base(); p.sections = [{ id: 'verse', name: 'Verse', startBar: 3, endBar: 5, color: '#007aff' }];
  const html = exportThreeTrackHtml(p, 'structure');
  assert.equal((html.match(/class="section-card"/g) ?? []).length, 3);
  assert.ok(html.includes('1–2 小节') && html.includes('3–5 小节') && html.includes('6–8 小节'));
  assert.ok(html.includes('data-time="4"') && html.includes('歌曲结构总览'));
  assert.ok(!html.includes('class="score-row"') && !html.includes('class="event lyric"'));
});

test('6/8 with a tempo change maps all three tracks using the existing music grid', () => {
  const p = { ...base(), meter: '6/8', bpm: 80, duration: 10, beatTimes: [0, .375, .75, 1.125, 1.5, 1.875, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75] };
  const start = positionToTime(p, 2, 3.5);
  p.chords = [{ id: 'change', bar: 2, beat: 3.5, label: 'Dm7', source: 'manual', confidence: 1, locked: true }];
  p.lyrics = [{ id: 'time-kept', text: '变速保持时间', start, end: start + .25, source: 'manual', locked: true }];
  p.manualFills = [{ id: 'group', notes: [{ id: 'fill-kept', digit: 3, start, end: start + .25, lines: 1, octave: 0 }] }];
  const html = exportThreeTrackHtml(p);
  ['change', 'time-kept', 'fill-kept'].forEach(id => {
    assert.equal(numberAttribute(html, id, 'data-time'), start);
    assert.ok(Math.abs(numberAttribute(html, id, 'data-anchor') - rowTimePercent(p, 1, 4, start) / 100) < 1e-9);
  });
});

test('first-bar and clipped last-bar rulers use the same coordinates as all track anchors', () => {
  const p = { ...base(), offset: .75, duration: 6.9 };
  p.chords = [{ id: 'first-downbeat', bar: 1, beat: 1, label: 'C', source: 'manual', confidence: 1, locked: true }];
  const html = exportThreeTrackHtml(p);
  const anchor = rowTimePercent(p, 1, 4, .75) / 100;
  assert.equal(numberAttribute(html, 'first-downbeat', 'data-anchor'), anchor);
  const boundary = rowTimePercent(p, 1, 4, positionToTime(p, 2, 1));
  assert.ok(html.includes(`<i class="bar-line" style="left:${boundary}%">`));
  const firstRuler = /<div class="bar-ruler" data-bar="1"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(firstRuler);
  const localBeat = Number(/<span style="left:([^"]*)%">1<\/span>/.exec(firstRuler[1])?.[1]);
  assert.ok(Math.abs(localBeat / 100 * boundary / 100 - anchor) < 1e-9);
});

test('score style defaults and valid custom print styles survive portable export without moving events', () => {
  const p = base();
  assert.deepEqual(readScoreStyle(p), DEFAULT_SCORE_STYLE);
  p.scoreStyle = { lyricFontSize: 28, lyricPrintSize: 17, colors: { lyrics: '#123456', top: '#234567', fill: '#345678', mark: '#456789' }, printColor: false };
  p.lyrics = [{ id: 'styled', text: '字体放大后仍在原时间', start: 4.25, end: 7, source: 'manual', locked: true }];
  const saved = JSON.stringify(p), html = exportThreeTrackHtml(p);
  assert.match(html, /class="page score-print-mono"/);
  assert.match(html, /--lyric-font:28px;--lyric-print-font:17pt/);
  assert.match(html, /--score-lyrics:#123456;--score-top:#234567;--score-fill:#345678;--score-mark:#456789/);
  assert.match(html, /\.page \.event\.lyric\{font-size:var\(--lyric-print-font,12pt\)\}/);
  assert.equal(numberAttribute(html, 'styled', 'data-time'), 4.25);
  assert.equal(numberAttribute(html, 'styled', 'data-end'), 7);
  assert.equal(JSON.stringify(p), saved);
});

test('untrusted styles cannot inject markup or CSS and out-of-range font sizes use bounded values', () => {
  const p = base();
  p.scoreStyle = { lyricFontSize: 200, lyricPrintSize: Number.NaN, colors: { lyrics: '</style><script>bad</script>', top: 'red;background:url(x)', fill: '#abc', mark: '#aAbBcC' }, printColor: true };
  const normalized = readScoreStyle(p);
  assert.equal(normalized.lyricFontSize, 32);
  assert.equal(normalized.lyricPrintSize, 12);
  assert.deepEqual(normalized.colors, { ...DEFAULT_SCORE_STYLE.colors, mark: '#aAbBcC' });
  assert.equal(scoreStyleVariables(p)['--lyric-font'], '32px');
  const html = exportThreeTrackHtml(p);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.ok(!html.includes('background:url(x)') && !html.includes('<script>bad'));
});

test('portable bass mode renders exact timed pitch classes and scale degrees without legacy harmony', () => {
  const p = base(); p.topTrack = 'bass';
  p.bassEvents = [{ id: 'bass-low-a', start: .31, end: 2.75, pitchClass: 9, confidence: .9, source: 'analysis', locked: false }];
  p.chords = [{ id: 'legacy-harmony', bar: 1, beat: 1, label: 'Cmaj7', confidence: .7, source: 'analysis', locked: false }];
  const html = exportThreeTrackHtml(p);
  assert.ok(html.includes('<header>贝斯音名</header>'));
  assert.match(html, /<span class="chord-name">A<\/span><small class="degree">6<\/small>/);
  assert.ok(!html.includes('legacy-harmony') && !html.includes('Cmaj7'));
  assert.equal(numberAttribute(html, 'bass-low-a', 'data-time'), .31);
  assert.equal(numberAttribute(html, 'bass-low-a', 'data-end'), 2.75);
  p.topTrack = 'chords';
  assert.ok(exportThreeTrackHtml(p).includes('Cmaj7'));
});

test('A4 direction fixes physical print width before notation measurement and persists in portable controls', () => {
  const p = base();
  assert.equal(readScoreStyle(p).printOrientation, 'portrait');
  assert.equal(scoreStyleVariables(p)['--score-page-width'], '186mm');
  assert.match(scorePageCss(p), /size:A4 portrait;margin:12mm/);
  p.scoreStyle = { ...DEFAULT_SCORE_STYLE, printOrientation: 'landscape' };
  assert.equal(scoreStyleVariables(p)['--score-page-width'], '273mm');
  const html = exportThreeTrackHtml(p);
  assert.ok(html.includes('@page{size:A4 landscape;margin:12mm}'));
  assert.ok(html.includes('<option value="landscape" selected>A4 横向</option>'));
  assert.ok(html.includes('.page{width:var(--score-page-width,186mm);max-width:none}'));
});

test('portable fill notation keeps original pitches and times, and embeds shared cross-line connection geometry', () => {
  const p = base();
  p.manualFills = [{ id: 'written', notes: [
    { id: 'a', digit: 3, start: .5, end: 1, lines: 0, octave: 1, notation: { cut: true, accent: true, connection: { kind: 'slideUp', targetNoteId: 'b' } } },
    { id: 'b', digit: 4, start: 1, end: 1.25, lines: 1, octave: 0, notation: { dead: true } },
  ] }];
  const snapshot = JSON.stringify(p), html = exportThreeTrackHtml(p);
  assert.ok(html.includes('<span title="切音">切</span>') && html.includes('<span title="重音">&gt;</span>'));
  assert.match(html, /data-digit="4" data-lines="1" data-octave="0">[\s\S]*?<span class="digit dead" title="闷音 \/ 死音">×<\/span>/);
  assert.ok(html.includes('const layoutConnections='));
  assert.ok(html.includes('data-connection') && html.includes('fill-connections'));
  assert.equal(numberAttribute(html, 'b', 'data-start'), 1);
  assert.equal(numberAttribute(html, 'b', 'data-end'), 1.25);
  assert.equal(JSON.stringify(p), snapshot);
  const reader = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(reader); assert.doesNotThrow(() => new Function(reader));
});
