import test from 'node:test';
import assert from 'node:assert/strict';
import { topEvents,topEventTime,topEventAt,topEventLabel,copySectionTop } from './top-track';
import { mergeAnalysisView } from './analysis-view';
import { transposeProject,type Project } from './music';
const base=():Project=>({id:'test',title:'原创贝斯',artist:'',duration:16,key:'C',originalKey:'C',bpm:120,meter:'4/4',offset:0,beatTimes:[],sections:[],lyrics:[],chords:[{id:'old',bar:1,beat:1,label:'Am7',source:'manual',locked:true,confidence:1}],bassEvents:[{id:'a',start:1,end:2,pitchClass:9,source:'analysis',locked:false,confidence:.8},{id:'b',start:3,end:4,pitchClass:0,source:'analysis',locked:false,confidence:.9}],topTrack:'bass',manualFills:[],notes:[],markers:[],stems:[],analysis:{state:'idle',stage:'',progress:0,warnings:[]},revision:1,updatedAt:'',isDemo:false});
test('bass top retains silence and pickup audio times, while legacy harmony remains selectable',()=>{
 const p=base();p.offset=1.5;
 assert.equal(topEventTime(p,topEvents(p)[0]),1);assert.equal(topEventAt(p,2.5),undefined);
 assert.equal(topEvents(p)[0].label,'A');assert.equal(topEventLabel(p,topEvents(p)[0],true),'6');
 assert.equal(topEvents({...p,topTrack:'chords'})[0].label,'Am7');
 const shifted=transposeProject(p,2);assert.equal(shifted.bassEvents![0].pitchClass,11);assert.equal(shifted.bassEvents![0].start,1);assert.deepEqual(shifted.manualFills,p.manualFills);
});
test('copy top section maps timing through variable grid and replaces just the target interval',()=>{
 const p=base();p.beatTimes=[0,.5,1,1.5,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
 let id=0;const next=copySectionTop(p,{id:'s',name:'段落',startBar:1,endBar:1,color:'#aaa'},2,()=>`copy-${id++}`);
 const copy=next.bassEvents!.find(e=>e.id.startsWith('copy-'))!;assert.equal(copy.start,4);assert.equal(copy.end,6);assert.equal(copy.pitchClass,9);assert.equal(copy.locked,true);assert.deepEqual(next.chords,p.chords);
});
test('finished analysis preserves unsaved edits/deletions but replaces untouched previous candidates',()=>{
 const before=base(),local=structuredClone(before),incoming=structuredClone(before);
 local.title='人工修改曲名';local.artist='Adele / 王菲';
 local.bassEvents=[{...local.bassEvents![0],pitchClass:7,source:'manual',locked:true}];local.lyrics=[{id:'l',text:'正在编辑',start:1,end:3,locked:true,source:'manual'}];
 incoming.bassEvents=[{id:'new',start:0,end:8,pitchClass:2,confidence:.7,source:'analysis',locked:false}];incoming.revision=2;
 const merged=mergeAnalysisView(local,incoming,before);
 assert.equal(merged.title,local.title);assert.equal(merged.artist,local.artist);
 assert.equal(merged.revision,2);assert.deepEqual(merged.lyrics,local.lyrics);assert.equal(merged.bassEvents!.find(e=>e.id==='a')?.pitchClass,7);
 assert.ok(merged.bassEvents!.filter(e=>e.id!=='a').every(e=>e.end<=1||e.start>=2));
 assert.ok(merged.bassEvents!.every(e=>e.end<=3||e.start>=4));assert.ok(merged.bassEvents!.some(e=>e.start===4&&e.end===8));
});
