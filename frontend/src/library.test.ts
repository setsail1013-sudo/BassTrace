import { test } from 'node:test';
import assert from 'node:assert/strict';
import { librarySongs, songIdentity, adjacentBarTime, folderSongs } from './library';
import type { Project } from './music';
const song=(id:string,title:string,artist=''):Project=>({id,title,artist,duration:10,key:'C',originalKey:'C',bpm:120,meter:'4/4',offset:0,beatTimes:[],sections:[],chords:[],lyrics:[],notes:[],markers:[],stems:[],analysis:{state:'idle',stage:'',progress:0,warnings:[]},updatedAt:'',revision:1,isDemo:false});
test('folder membership is independent of playlists and can be combined with search and sorting',()=>{
  const songs=[song('a','A'),song('b','B'),song('c','C')],index={folders:[{id:'f',name:'演出'}],assignments:{a:'f',b:'f',gone:'f'}};
  assert.deepEqual(folderSongs(songs,index,null),songs);
  assert.deepEqual(folderSongs(songs,index,'unfiled').map(s=>s.id),['c']);
  assert.deepEqual(folderSongs(songs,index,'f').map(s=>s.id),['a','b']);
  assert.deepEqual(librarySongs(folderSongs(songs,index,'f'),'title','B').map(s=>s.id),['b']);
  assert.deepEqual(librarySongs(songs,'title','',{id:'p',name:'歌单',projectIds:['a','c']}).map(s=>s.id),['a','c']);
});
test('library defaults to title A-Z, handles filename artists and never mutates project order',()=>{
  const list=[song('b','B song','周杰伦'),song('a','阿杜 - A song'),song('c','C song')];
  assert.deepEqual(librarySongs(list,'title').map(p=>p.id),['a','b','c']);
  assert.deepEqual(librarySongs(list,'artist').map(p=>p.id),['a','b','c']);
  assert.deepEqual(list.map(p=>p.id),['b','a','c']);
  assert.equal(songIdentity(list[1]).artist,'阿杜');
  assert.equal(songIdentity(song('x','歌曲 - 现场版','歌手')).title,'歌曲 - 现场版');
  assert.equal(librarySongs(list,'title','阿杜').length,1);
  assert.deepEqual(librarySongs([song('z','周末'),song('a','Apple'),song('l','恋人'),song('b','Beyond')],'title').map(p=>p.id),['a','b','l','z']);
  assert.deepEqual(librarySongs(list,'title','',{id:'p',name:'演出',projectIds:['b','gone']}).map(p=>p.id),['b']);
});
test('bar navigation uses current grid, pickup, 6/8 and song boundaries',()=>{
  const p=song('p','song');assert.equal(adjacentBarTime(p,4.6,-1),2);assert.equal(adjacentBarTime(p,4.6,1),6);
  assert.equal(adjacentBarTime(p,0,-1),0);assert.equal(adjacentBarTime(p,9,1),10);
  p.offset=1;assert.equal(adjacentBarTime(p,.2,1),1);assert.equal(adjacentBarTime(p,.2,-1),0);
  p.offset=0;p.meter='6/8';p.beatTimes=[0,.2,.4,.6,.8,1,1.2,1.5,1.8,2.1,2.4,2.7,3,3.4,3.8,4.2,4.6,5,5.4];
  assert.equal(adjacentBarTime(p,1.8,-1),0);assert.equal(adjacentBarTime(p,1.8,1),3);
});
