import test from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from './music';
import { addManualFill, deleteFillNote, setFillDigit, setFillOctave, scoreRows } from './tracks';
import { setFillTechnique, layoutFillConnections } from './fill-techniques';
import { fillLayoutGroups, fillLayoutRows, layoutCompactFills } from './fill-layout';

const base = (): Project => ({ id: 'techniques', title: '技巧验证', artist: '', duration: 60, bpm: 120, meter: '4/4', originalKey: 'C', key: 'C', offset: 0, beatTimes: [], sections: [], chords: [], lyrics: [], manualFills: [], notes: [], markers: [], stems: [], analysis: { state: 'idle', stage: '', progress: 0, warnings: [] }, revision: 1, updatedAt: '', isDemo: false });
const notes = (p: Project) => p.manualFills![0].notes;
const sample = () => addManualFill(base(), 0, '1123', 'g', ['a','b','c','d']);
const toggle = (p: Project, id: string, kind: Parameters<typeof setFillTechnique>[3]) => setFillTechnique(p, 'g', id, kind);

test('techniques store exact endpoints and leave audio times and other tracks untouched', () => {
  const p = sample(), before = JSON.stringify(p);
  const changed = toggle(toggle(toggle(p, 'a', 'cut'), 'a', 'accent'), 'a', 'tie');
  assert.deepEqual(notes(changed)[0].notation, { cut: true, accent: true, connection: { kind: 'tie', targetNoteId: 'b' } });
  assert.deepEqual(notes(changed).map(n => [n.start,n.end,n.digit,n.lines,n.octave]), notes(p).map(n => [n.start,n.end,n.digit,n.lines,n.octave]));
  assert.equal(changed.chords, p.chords); assert.equal(changed.lyrics, p.lyrics); assert.equal(JSON.stringify(p), before);
  assert.equal(notes(toggle(changed,'a','tie'))[0].notation?.connection, null);
});

test('connections reject final notes, rests and incompatible ties', () => {
  const p = sample();
  assert.throws(() => toggle(p,'d','hammer'), /下一个/);
  assert.throws(() => toggle(p,'b','tie'), /相同/);
  const rest = setFillDigit(p,'g','b',0);
  assert.throws(() => toggle(rest,'a','slideUp'), /休止/);
  assert.throws(() => toggle(rest,'b','accent'), /休止/);
  const spaced = { ...p, manualFills: [{ ...p.manualFills![0], notes: notes(p).map(n => n.id === 'b' ? { ...n, start: .6 } : n) }] };
  assert.throws(() => toggle(spaced,'a','tie'), /相邻/);
});

test('delete/rest/dead remove incoming and outgoing links without reconnecting', () => {
  const p = toggle(toggle(sample(),'a','hammer'),'b','pull');
  const removed = deleteFillNote(p,'g','b');
  assert.equal(notes(removed)[0].notation?.connection, null);
  assert.deepEqual(notes(removed).map(n=>n.id), ['a','c','d']);
  for (const changed of [setFillDigit(p,'g','b',0),toggle(p,'b','dead')]) {
    assert.equal(notes(changed)[0].notation?.connection, null);
    assert.equal(notes(changed)[1].notation?.connection, null);
  }
});

test('pitch changes clear invalid ties but preserve unrelated flags', () => {
  const p = toggle(toggle(sample(),'a','accent'),'a','tie');
  const changed = setFillOctave(p,'g','b',1);
  assert.equal(notes(changed)[0].notation?.accent,true);
  assert.equal(notes(changed)[0].notation?.connection,null);
});

test('all connection kinds can replace one outgoing link then toggle off', () => {
  let p = sample();
  for (const kind of ['slideUp','slideDown','hammer','pull','tie'] as const) {
    p = toggle(p,'a',kind);
    assert.equal(notes(p)[0].notation?.connection?.kind,kind);
  }
  assert.equal(notes(toggle(p,'a','tie'))[0].notation?.connection,null);
});

test('connectors split at compact wrap and keep original endpoints/times', () => {
  let p = addManualFill(base(),0,'1'.repeat(16),'g',Array.from({length:16},(_,i)=>`n${i}`));
  p = { ...p, chords:[{id:'c',bar:1,beat:1,label:'C',source:'manual',confidence:1,locked:true},{id:'f',bar:1,beat:2,label:'F',source:'manual',confidence:1,locked:true}] };
  const before = JSON.stringify(p), layout = layoutCompactFills(fillLayoutRows(p,scoreRows(p,4),320),fillLayoutGroups(p),20,12);
  const index = layout.items.findIndex((n,i,all)=>i<all.length-1 && n.top !== all[i+1].top);
  assert.ok(index >= 0);
  p = toggle(p,layout.items[index].id,'hammer');
  const links = layoutFillConnections(layout.items,p.manualFills!);
  assert.equal(links.length,2); assert.equal(links[0].continuesTo,true); assert.equal(links[1].continuesFrom,true);
  assert.ok(links.every(l=>l.label==='H' && !l.path.includes('NaN')));
  assert.deepEqual(notes(p).map(n=>[n.start,n.end]),JSON.parse(before).manualFills[0].notes.map((n:{start:number;end:number})=>[n.start,n.end]));
});

test('cross-score-row connection uses both final rows; embedded function is self-contained', () => {
  const p = toggle(sample(),'a','slideDown');
  const placements = [{id:'a',group:'g',row:1,left:290,top:4,width:14,fontSize:18,compact:true,rangeLeft:0,rangeRight:320},{id:'b',group:'g',row:5,left:0,top:4,width:14,fontSize:18,compact:true,rangeLeft:0,rangeRight:320}];
  const embedded = new Function(`return (${layoutFillConnections.toString()})`)() as typeof layoutFillConnections;
  const links = embedded(placements,p.manualFills!);
  assert.deepEqual(links.map(l=>l.row),[1,5]); assert.ok(links[0].continuesTo && links[1].continuesFrom);
  assert.deepEqual(links,layoutFillConnections(placements,p.manualFills!));
});

test('bass silence uses current bar rather than previous note interval for fills', () => {
  const p = addManualFill({ ...base(),topTrack:'bass',bassEvents:[{id:'bass',start:0,end:.5,pitchClass:0,source:'analysis',confidence:1,locked:false}] },3,'12','g',['a','b']);
  const group = fillLayoutGroups(p)[0];
  assert.equal(group.start,4); assert.equal(group.end,8);
});
