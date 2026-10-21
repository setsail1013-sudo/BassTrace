import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignTab, barCount, copySectionChords, beatSeconds, chordAt, displayChords, displaySections, exportHtml, layoutChordLabels, lyricsForBar, makeGrid, parseLrc, positionToTime, romanChord, timeToPosition, toLrc, transposeChord, transposeProject, type Project, type Note, type Chord } from './music.ts';
import { exportNumberHtml } from './export.ts';

const base = (): Project => ({ id: 'test', title: 'Test', artist: 'Artist', duration: 8, originalKey: 'C Major', key: 'C Major', bpm: 120, meter: '4/4', offset: 0, beatTimes: [], sections: [], chords: [], lyrics: [], notes: [], markers: [], stems: [], analysis: { state: 'idle', stage: '', progress: 0, warnings: [] }, updatedAt: '', revision: 1, isDemo: false });
const note = (id: string, midi: number, start: number): Note => ({ id, midi, start, duration: 0.4, source: 'analysis', confidence: 0.8, locked: false });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('irregular grid, offset, fractional beats and inverse mapping', () => {
  const p = { ...base(), offset: 1, beatTimes: [0, 0.5, 1.1, 1.6, 2.3] };
  close(positionToTime(p, 1, 2.5), 1.8);
  close(positionToTime(p, 2, 1), 3.3);
  const position = timeToPosition(p, 1.8);
  assert.equal(position.bar, 1); close(position.beat, 2.5);
  for (const time of [-1, 0.4, 1, 1.8, 3.3, 12]) { const position = timeToPosition(p, time); close(positionToTime(p, position.bar, position.beat), time); }
  assert.equal(makeGrid(p)[0], 1);
});
test('6/8 uses eighth-note beats, and exact final bar boundary is not an extra bar', () => {
  const p = { ...base(), meter: '6/8', duration: 3 };
  close(beatSeconds(p), 0.25); close(positionToTime(p, 2, 1), 1.5);
  assert.equal(barCount(p), 2); assert.equal(barCount(base()), 4);
});
test('multiple chords per bar use beat positions independently of lyrics', () => {
  const p = base();
  p.chords = [{ id: 'a', bar: 1, beat: 1, label: 'C', source: 'analysis', confidence: 1, locked: false }, { id: 'b', bar: 1, beat: 3.5, label: 'G/B', source: 'manual', confidence: 1, locked: true }];
  assert.equal(chordAt(p, -0.1), undefined); assert.equal(chordAt(p, 1.24)?.label, 'C'); assert.equal(chordAt(p, 1.25)?.label, 'G/B');
});
test('display chords collapse only consecutive unconfirmed automatic repeats and retain genuine changes', () => {
  const chord = (id: string, bar: number, beat: number, label: string, source: Chord['source'] = 'analysis', locked = false): Chord => ({ id, bar, beat, label, source, locked, confidence: .8 });
  const p = base();
  p.chords = [chord('later-auto', 3, 2, 'C', 'demo'), chord('first', 1, 1, 'C'), chord('repeat', 1, 2.5, 'C'), chord('change-E', 1, 3.625, 'E'), chord('change-C', 2, 1.25, 'C'), chord('repeat-again', 2, 2, 'C'), chord('manual-repeat', 2, 2.5, 'C', 'manual'), chord('confirmed-repeat', 3, 1, 'C', 'analysis', true)];
  const snapshot = JSON.stringify(p.chords);
  const shown = displayChords(p);
  assert.deepEqual(shown.map(item => item.id), ['first', 'change-E', 'change-C', 'manual-repeat', 'confirmed-repeat']);
  assert.deepEqual(shown.map(item => [item.bar, item.beat]), [[1, 1], [1, 3.625], [2, 1.25], [2, 2.5], [3, 1]]);
  assert.deepEqual(displayChords(p.chords), shown);
  assert.equal(JSON.stringify(p.chords), snapshot);
  assert.equal(p.chords.length, 8);
});
test('display chords preserve same-position harmonic changes, manual repeats and chord qualities', () => {
  const p = base();
  const labels = ['C', 'C', 'E', 'C', 'C/E', 'C7', 'Cmaj7', 'Cmaj7'];
  p.chords = labels.map((label, index) => ({ id: String(index), bar: 1, beat: 2.5, label, source: index === 1 ? 'manual' : 'analysis', confidence: 1, locked: index === 7 }));
  assert.deepEqual(displayChords(p).map(item => item.id), labels.map((_, index) => String(index)));
  assert.deepEqual(displayChords([]), []);
});

test('bass pitch candidates never appear as harmony, including legacy saved charts and playback', () => {
  const p = base();
  p.chords = [
    { id: 'analysis-bass-root-old', bar: 1, beat: 1, label: 'E?', source: 'analysis', confidence: .5, locked: false },
    { id: 'legacy-confirmed-pitch', bar: 1, beat: 2, label: 'F#?', source: 'manual', confidence: .5, locked: true },
    { id: 'harmony', bar: 1, beat: 3.625, label: 'Cmaj7/E', source: 'analysis', confidence: .8, locked: false },
    { id: 'analysis-bass-root-renamed', bar: 2, beat: 2.25, label: 'Am7', source: 'manual', confidence: 1, locked: true },
  ];
  p.notes = [note('passing-tone', 41, 1)];
  p.markers = [{ id: 'fill', time: 1, label: 'FILL', text: '个人过门', source: 'manual' }];
  p.lyrics = [{ id: 'lyric', text: '歌词保留', start: 1, end: 3, source: 'manual', locked: true }];
  const snapshot = JSON.stringify(p);
  assert.deepEqual(displayChords(p).map(c => [c.label, c.bar, c.beat]), [['Cmaj7/E', 1, 3.625], ['Am7', 2, 2.25]]);
  assert.equal(chordAt(p, 1), undefined);
  assert.equal(chordAt(p, 1.3125)?.label, 'Cmaj7/E');
  const html = exportHtml(p);
  assert.ok(html.includes('歌词保留') && html.includes('Cmaj7/E'));
  assert.ok(!html.includes('E?') && !html.includes('F#?') && !html.includes('个人过门') && !html.includes('E–A–D–G'));
  assert.ok(!html.includes('<div class="tab">') && !html.includes('passing-tone'));
  assert.equal(JSON.stringify(p), snapshot);
});
test('dense chord labels occupy separate rows without moving their real beat anchors', () => {
  const input = [{ id: 'a', label: 'Fmaj7', beat: 1 }, { id: 'b', label: 'Cmaj7', beat: 1.5 }, { id: 'c', label: 'G7', beat: 3 }];
  const snapshot = JSON.stringify(input);
  const layout = layoutChordLabels(input, 4, 120, () => 50);
  assert.equal(layout.rows, 2);
  assert.deepEqual(layout.items.map(item => [item.id, item.anchor, item.left, item.row]), [['a', 0, 0, 0], ['b', 15, 15, 1], ['c', 60, 60, 0]]);
  for (const item of layout.items) {
    assert.ok(item.left >= 0 && item.left + item.width <= 120);
    for (const prior of layout.items.filter(prior => prior.row === item.row && prior.id !== item.id)) {
      assert.ok(item.left + item.width + 8 <= prior.left || prior.left + prior.width + 8 <= item.left);
    }
  }
  assert.equal(JSON.stringify(input), snapshot);
});
test('last-beat and oversized chord labels stay inside the bar, retaining point markers', () => {
  const layout = layoutChordLabels([{ id: 'tail', label: 'Cmaj7/E', beat: 4.9 }, { id: 'long', label: 'Cmaj7(add13)/E', beat: 2 }], 4, 200, label => label.includes('add') ? 350 : 88);
  const tail = layout.items.find(item => item.id === 'tail')!;
  const long = layout.items.find(item => item.id === 'long')!;
  close(tail.anchor, 195); assert.equal(tail.left, 112); assert.equal(tail.width, 88);
  assert.equal(long.left, 0); assert.equal(long.width, 200); assert.notEqual(long.row, tail.row);
});
test('coincident identical chord events are preserved and get separate readable rows', () => {
  const chords = ['a', 'b', 'c'].map(id => ({ id, label: 'Am7', beat: 3.5 }));
  const layout = layoutChordLabels(chords, 4, 240, () => 45);
  assert.equal(layout.items.length, 3); assert.equal(layout.rows, 3);
  assert.deepEqual(layout.items.map(item => [item.id, item.anchor, item.row]), [['a', 150, 0], ['b', 150, 1], ['c', 150, 2]]);
});
test('chord layout leaves eight pixels between labels and runs without module dependencies', () => {
  const isolated = Function(`return (${layoutChordLabels.toString()})`)() as typeof layoutChordLabels;
  const chords = [{ id: 'a', label: 'C', beat: 1 }, { id: 'b', label: 'G', beat: 1.96 }];
  assert.equal(isolated(chords, 4, 200, () => 40).rows, 1);
  assert.equal(isolated([{ ...chords[0] }, { ...chords[1], beat: 1.9 }], 4, 200, () => 40).rows, 2);
  assert.deepEqual(isolated([], 4, 200, () => 40), { items: [], rows: 0 });
});
test('slash chords, minor keys and spelled chromatic degrees', () => {
  assert.equal(transposeChord('Cmaj7/E', 2), 'Dmaj7/F#');
  assert.equal(transposeChord('Bb7/D', 2), 'C7/E');
  assert.equal(transposeChord('N.C.', 3), 'N.C.');
  assert.equal(romanChord('Am7', 'C Major'), 'vi7');
  assert.equal(romanChord('Am7', 'A Minor'), 'i7');
  assert.equal(romanChord('Cmaj7', 'A Minor'), 'IIImaj7');
  assert.equal(romanChord('E7/G#', 'A Minor'), 'V7/#VII');
  assert.equal(romanChord('D#dim7', 'C Major'), '#ii°7');
  assert.equal(romanChord('Eb', 'C Major'), 'bIII');
});
test('LRC multiple timestamps, offset and simultaneous lines get nonzero shared ends', () => {
  const lyrics = parseLrc('[offset:-500]\n[00:01.00][00:03.000]repeat\n[00:01.00]parallel\n[00:05.2]last', 8);
  assert.deepEqual(lyrics.map(lyric => [lyric.start, lyric.end]), [[0.5, 2.5], [0.5, 2.5], [2.5, 4.7], [4.7, 8]]);
  const p = { ...base(), lyrics };
  assert.deepEqual(parseLrc(toLrc(p), 8).map(lyric => [lyric.text, lyric.start, lyric.end]), lyrics.map(lyric => [lyric.text, lyric.start, lyric.end]));
});

test('pickup lyrics before the first downbeat remain visible once and retain original timestamps', () => {
  const p = { ...base(), offset: .22 };
  p.lyrics = [{ id: 'pickup', text: '首拍之前的歌词', start: 0, end: 1.5, source: 'manual', locked: true },
              { id: 'next', text: '第二小节', start: 2.22, end: 4, source: 'manual', locked: true }];
  const snapshot = JSON.stringify(p.lyrics);
  assert.deepEqual(lyricsForBar(p, 1).map(l => l.id), ['pickup']);
  assert.deepEqual(lyricsForBar(p, 2).map(l => l.id), ['next']);
  const html = exportHtml(p);
  assert.equal(html.split('首拍之前的歌词').length - 1, 1);
  assert.match(html, /class="lyric" style="left:0%;[^>]+data-time="0" data-start="0" data-end="1.5"/);
  assert.equal(JSON.stringify(p.lyrics), snapshot);
});
test('TAB remains playable, respects valid locked fingering, and leaves out-of-range notes unassigned', () => {
  const notes = [note('low', 27, 0), { ...note('locked', 40, 1), string: 2, fret: 2, locked: true }, note('next', 41, 1.5), note('high', 64, 2)];
  const assigned = assignTab(notes);
  assert.equal(assigned[0].string, undefined); assert.equal(assigned[3].string, undefined);
  assert.equal(assigned[1].string, 2); assert.equal(assigned[1].fret, 2);
  for (const item of assigned.filter(item => item.string)) { assert.equal([43, 38, 33, 28][item.string! - 1] + item.fret!, item.midi); assert.ok(item.fret! >= 0 && item.fret! <= 20); }
  assert.equal(notes[2].string, undefined);
});
test('whole project transposition retains original key, recalculates fingering, and does not mutate', () => {
  const p = base(); p.notes = [{ ...note('e', 28, 0), string: 4, fret: 0, locked: true }];
  p.chords = [{ id: 'c', bar: 1, beat: 1, label: 'C/E', source: 'manual', confidence: 1, locked: true }];
  const transposed = transposeProject(p, 2);
  assert.equal(transposed.key, 'D Major'); assert.equal(transposed.originalKey, 'C Major');
  assert.equal(transposed.chords[0].label, 'D/F#'); assert.equal(transposed.notes[0].midi, 30); assert.equal(transposed.notes[0].fret, 2);
  assert.equal(p.notes[0].midi, 28); assert.equal(transposed.revision, p.revision);
});
test('transposition rejects MIDI overflow atomically without modifying the source project', () => {
  const high = base(); high.notes = [note('top', 127, 0)];
  const low = base(); low.notes = [note('bottom', 0, 0)];
  assert.throws(() => transposeProject(high, 1), RangeError);
  assert.throws(() => transposeProject(low, -1), RangeError);
  assert.equal(high.notes[0].midi, 127); assert.equal(high.key, 'C Major');
  assert.equal(transposeProject(high, -1).notes[0].midi, 126);
});
test('transposition preserves a playable manual string choice and recomputes only impossible positions', () => {
  const p = base(); p.notes = [{ ...note('manual', 40, 0), string: 4, fret: 12, locked: true }];
  const shifted = transposeProject(p, 1);
  assert.equal(shifted.notes[0].midi, 41); assert.equal(shifted.notes[0].string, 4); assert.equal(shifted.notes[0].fret, 13);
  const octaveUp = transposeProject(p, 12);
  assert.notEqual(octaveUp.notes[0].string, 4);
  assert.equal([43, 38, 33, 28][octaveUp.notes[0].string! - 1] + octaveUp.notes[0].fret!, 52);
  const unchanged = transposeProject(p, 0);
  assert.equal(unchanged.notes[0].string, 4); assert.equal(unchanged.notes[0].fret, 12);
});
test('LRC invalid second fields are ignored and empty timed cues end the previous phrase', () => {
  assert.deepEqual(parseLrc('[00:99.00]invalid\n[bad]invalid', 200), []);
  const lyrics = parseLrc('[00:01.00]valid\n[00:04.00]\n[00:99.00]invalid', 200);
  assert.equal(lyrics.length, 1); assert.equal(lyrics[0].start, 1); assert.equal(lyrics[0].end, 4);
});
test('portable HTML escapes content, preserves fractional chord placement, and attaches audio locally', () => {
  const p = { ...base(), title: '<script>alert(1)</script>' }; p.chords = [{ id: 'c', bar: 1, beat: 3.5, label: 'G7', source: 'manual', confidence: 1, locked: true }];
  p.stems = [{ id: 's', name: 'Original', available: true, peaks: [], url: 'https://invalid.example/audio.mp3' }];
  const html = exportHtml(p);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('left:62.5%')); assert.ok(html.includes('type="file"')); assert.ok(!html.includes(p.stems[0].url));
  assert.ok(html.includes('data-beat="3.5" data-time="1.25"'));
  assert.ok(html.includes('data-beats="4"')); assert.ok(html.includes('function measureChords()'));
  assert.ok(html.includes("'--chord-anchor'")); assert.ok(html.includes('document.fonts.ready.then(measureChart)'));
  assert.ok(html.includes("window.addEventListener('beforeprint',measureChart)"));
});
test('default HTML includes only lyrics and harmonic changes, preserving source events and optional number export', () => {
  const p = base();
  p.chords = [{ id: 'first-C', bar: 1, beat: 1, label: 'C', source: 'analysis', confidence: .8, locked: false }, { id: 'hidden-C', bar: 1, beat: 2, label: 'C', source: 'analysis', confidence: .8, locked: false }, { id: 'actual-G', bar: 1, beat: 3.625, label: 'G7', source: 'analysis', confidence: .8, locked: false }, { id: 'manual-G', bar: 2, beat: 1.25, label: 'G7', source: 'manual', confidence: 1, locked: true }];
  p.notes = [note('bass-note', 36, 0)];
  p.lyrics = [{ id: 'lyric', text: 'Only lyric and chords', start: 0, end: 2, source: 'manual', locked: true }];
  p.markers = [{ id: 'automatic-fill', time: .5, label: 'FILL', text: 'Automatic fill cue', source: 'analysis' }, { id: 'manual-break', time: 1, label: 'BREAK', text: 'Manual break cue', source: 'manual' }];
  const snapshot = JSON.stringify(p), html = exportHtml(p);
  assert.equal((html.match(/class="chord"/g) || []).length, 3);
  assert.ok(!html.includes('data-id="hidden-C"'));
  assert.ok(html.includes('data-id="actual-G" data-label="G7" data-beat="3.625" data-time="1.3125"'));
  assert.ok(html.includes('Only lyric and chords'));
  assert.ok(!html.includes('class="marker"')); assert.ok(!html.includes('Automatic fill cue')); assert.ok(!html.includes('Manual break cue'));
  assert.ok(!html.includes('class="tab"')); assert.ok(!html.includes('root-hint')); assert.ok(!html.includes('class="portable-number"'));
  const numbered = exportNumberHtml(p, 'chart');
  assert.ok(numbered.includes('class="portable-number"')); assert.ok(numbered.includes('data-id="bass-note"'));
  assert.equal(JSON.stringify(p), snapshot);
});
test('HTML sequential lyric fragments share a timed lane and preserve original endpoints', () => {
  const p = base();
  p.lyrics = [{ id: 'a', text: 'first', start: 0, end: 0.5, source: 'manual', locked: true }, { id: 'b', text: 'second', start: 1, end: 3, source: 'manual', locked: true }];
  const html = exportHtml(p);
  assert.ok(html.includes('style="left:0%;width:25%;top:0px" data-lane="0" data-time="0" data-start="0" data-end="0.5"'));
  assert.ok(html.includes('style="left:50%;width:50%;top:0px" data-lane="0" data-time="1" data-start="1" data-end="3"'));
  assert.equal((html.match(/>second<\/button>/g) || []).length, 1);
});
test('HTML simultaneous lyric fragments occupy separate lanes', () => {
  const p = base();
  p.lyrics = [{ id: 'a', text: 'first', start: 0, end: 1, source: 'manual', locked: true }, { id: 'b', text: 'parallel', start: 0, end: 1, source: 'manual', locked: true }];
  const html = exportHtml(p);
  assert.ok(html.includes('data-lane="0" data-time="0"'));
  assert.ok(html.includes('data-lane="1" data-time="0"'));
});
test('display sections cover every bar exactly once after gaps, deletion, overlaps and out-of-range sections', () => {
  const section = (id: string, startBar: number, endBar: number) => ({ id, name: id, startBar, endBar, color: '#abc' });
  const cases = [
    { sections: [section('middle', 2, 3)], expected: [['未分段', 1, 1], ['middle', 2, 3], ['未分段', 4, 4]] },
    { sections: [], expected: [['未分段', 1, 4]] },
    { sections: [section('after', 9, 12), section('before', -4, -1), section('head', -2, 2), section('tail', 2, 5)], expected: [['head', 1, 2], ['tail', 3, 4]] },
    { sections: [section('after1', 8, 9), section('after2', 10, 11), section('reversed', 3, 2)], expected: [['未分段', 1, 4]] },
  ];
  for (const item of cases) {
    const p = { ...base(), sections: item.sections };
    const snapshot = JSON.stringify(p.sections);
    const displayed = displaySections(p);
    assert.deepEqual(displayed.map(s => [s.name, s.startBar, s.endBar]), item.expected);
    assert.deepEqual(displayed.flatMap(s => Array.from({ length: s.endBar - s.startBar + 1 }, (_, i) => s.startBar + i)), [1, 2, 3, 4]);
    assert.equal(JSON.stringify(p.sections), snapshot, 'display ranges must not rewrite persisted sections');
  }
});
test('all three HTML modes retain the unassigned audio range after deleting every section', () => {
  const p = base();
  for (const mode of ['chart', 'tab', 'structure'] as const) {
    const html = exportHtml(p, mode);
    assert.ok(html.includes('未分段'));
    if (mode === 'structure') assert.ok(html.includes('1–4 小节 · 4 小节'));
    else assert.equal((html.match(/<article class="bar"/g) || []).length, 4);
  }
  assert.deepEqual(p.sections, []);
});


test('copy section chords keeps fractional beats, replaces destination only and locks unique copies', () => {
  const source={id:'s',name:'Verse',startBar:1,endBar:2,color:'#aaa'};
  const p=base(); p.chords=[{id:'a',bar:1,beat:1.5,label:'Cmaj7',source:'analysis',locked:false,confidence:.8},{id:'b',bar:2,beat:3,label:'G7',source:'manual',locked:true,confidence:1},{id:'c',bar:3,beat:1,label:'Dm7',source:'manual',locked:true,confidence:1}];
  p.notes=[note('n',36,5)]; p.lyrics=[{id:'l',text:'Original',start:5,end:6,source:'manual',locked:true}];
  const snapshot=structuredClone(p),copied=copySectionChords(p,source,3);
  assert.deepEqual(p,snapshot); assert.equal(copied.chords.length,4);
  assert.deepEqual(copied.chords.slice(2).map(c=>[c.bar,c.beat,c.label,c.locked,c.source]),[[3,1.5,'Cmaj7',true,'manual'],[4,3,'G7',true,'manual']]);
  assert.equal(new Set(copied.chords.map(c=>c.id)).size,4); assert.deepEqual(copied.notes,p.notes); assert.deepEqual(copied.lyrics,p.lyrics);
  assert.throws(()=>copySectionChords(p,source,4)); assert.throws(()=>copySectionChords(p,source,1.5));
});
