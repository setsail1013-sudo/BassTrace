import test from 'node:test';
import assert from 'node:assert/strict';
import { addLyricAnchor,cleanLyricAnchors,lyricFragments,lyricMarks,removeLyricMark } from './lyric-marks';
import { splitLyric,mergeLyricPrevious } from './tracks';
import { exportThreeTrackHtml } from './three-track-export';
import { featureRunning,keyLabel } from './project-features';
import type {Project} from './music';

function fixture():Project{return {id:'qa',title:'测试',artist:'',duration:16,key:'C',originalKey:'C',bpm:120,meter:'4/4',offset:0,beatTimes:[],sections:[{id:'s',name:'主歌',startBar:1,endBar:8,color:'#ffffff'}],chords:[],bassEvents:[{id:'e',start:2,end:4,pitchClass:2,source:'analysis',confidence:.8,locked:false}],topTrack:'bass',lyrics:[{id:'l',text:'晚风轻轻吹过',start:0,end:8,source:'manual',locked:true}],stems:[],notes:[],markers:[],analysis:{state:'idle',stage:'',progress:0,warnings:[]},revision:1,updatedAt:'',isDemo:false};}
test('plain LRC never invents word timing; manual marks target exact text and event without moving music',()=>{
 const p=fixture();assert.deepEqual(lyricMarks(p,p.lyrics[0]),[]);
 const next=addLyricAnchor(p,'l',2,4,'e');assert.equal(lyricFragments(next,p.lyrics[0]).find(f=>f.mark)?.text,'轻轻');
 assert.deepEqual(next.lyrics,p.lyrics);assert.deepEqual(next.bassEvents,p.bassEvents);
 assert.equal(lyricMarks({...next,topTrack:'chords'},p.lyrics[0]).length,0);
 assert.equal(cleanLyricAnchors({...next,bassEvents:[]}).lyricAnchors?.length,0);
 assert.equal(cleanLyricAnchors({...next,lyrics:[{...p.lyrics[0],text:'新的歌词'}]}).lyricAnchors?.length,0);
});
test('split and merge migrate anchors, including selections spanning the split',()=>{
 const p=addLyricAnchor(fixture(),'l',1,5,'e'),split=splitLyric(p,'l',3,'right');
 assert.equal(split.lyricAnchors?.length,2);assert.deepEqual(split.lyricAnchors?.map(a=>a.text),['风轻','轻吹']);
 const merged=mergeLyricPrevious(split,'right');assert.equal(merged.lyrics[0].text,p.lyrics[0].text);
 assert.equal(lyricMarks(merged,merged.lyrics[0]).map(m=>merged.lyrics[0].text.slice(m.start,m.end)).join(''),'风轻轻吹');
});
test('word timestamps require matching text and confidence; punctuation and Unicode are preserved',()=>{
 const p=fixture();p.lyricAlignment={state:'complete',stage:'',progress:100,lines:[],warnings:[],error:null,detectedSegments:[{id:'d',text:p.lyrics[0].text,start:0,end:8,confidence:.9,words:[{text:'晚风',start:0,end:2,confidence:.9},{text:'轻轻',start:2,end:4,confidence:.9},{text:'吹过',start:4,end:8,confidence:.9}]}]};
 assert.equal(lyricFragments(p,p.lyrics[0]).find(f=>f.mark)?.text,'轻轻');
 const cleared=removeLyricMark(p,'l',2,4,'e');assert.equal(lyricMarks(cleared,cleared.lyrics[0]).length,0);
 p.lyricAlignment.detectedSegments[0].words[1].confidence=.1;assert.equal(lyricMarks(p,p.lyrics[0]).length,0);
 p.lyrics[0].text='A🎵中文';assert.equal(addLyricAnchor(p,'l',2,4,'e'),p);assert.notEqual(addLyricAnchor(p,'l',1,3,'e'),p);
});
test('HTML/PDF share escaped color marks and unknown keys never masquerade as C',()=>{
 const p=addLyricAnchor(fixture(),'l',1,3,'e'),html=exportThreeTrackHtml(p);
 assert.match(html,/class="lyric-change-mark" data-time="2">风轻<\/span>/);assert.ok(html.includes('text-underline-offset:3px'));
 assert.equal(keyLabel(p),'历史调性待确认');assert.ok(!html.includes('调性：C'));
 p.keyAnalysis={state:'complete',stage:'',progress:100,warnings:[],detectedKey:'D',candidates:[{key:'D',score:.8}],confirmed:false};p.key='D';assert.equal(keyLabel(p),'D · 候选');assert.equal(featureRunning(p),false);
 p.backingAnalysis={state:'running',stage:'',progress:1,warnings:[]};assert.equal(featureRunning(p),true);
});
