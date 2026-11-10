export function batchFixture(){
  const event={source:'manual',locked:true,confidence:1};
  const group=(id,start,count)=>({id,notes:Array.from({length:count},(_,i)=>({id:`${id}-${i}`,digit:i%7+1,start:start+i*.5,end:start+(i+1)*.5,lines:0,octave:0}))});
  return {id:'516978a1-4465-4d0e-8676-5b0b5bc0eb44',title:'大字三轨排练谱',artist:'原创验收素材',duration:48,bpm:120,meter:'4/4',offset:0,beatTimes:[],key:'C',originalKey:'C',revision:1,updatedAt:'',isDemo:false,topTrack:'bass',
    sections:[{id:'verse',name:'主歌',startBar:1,endBar:8,color:'#aaa'},{id:'chorus',name:'副歌',startBar:9,endBar:24,color:'#aaa'}],
    chords:[{id:'c',bar:1,beat:1,label:'Cmaj7',...event}],bassEvents:Array.from({length:24},(_,i)=>({id:`bass-${i}`,start:i*2,end:(i+1)*2,pitchClass:[0,9,5,7][i%4],...event})),
    lyrics:[{id:'lyric-a',text:'晚风轻轻吹过安静的街道',start:1,end:5,order:0,...event},{id:'lyric-b',text:'我们的旋律随着节拍向前奔跑',start:9,end:14,order:1,...event},{id:'lyric-c',text:'每一个音符都清晰可见',start:17,end:24,order:2,...event}],
    manualFills:[group('first',0,4),group('second',8,4),group('third',16,4)],notes:[],markers:[],
    analysis:{state:'idle',stage:'',progress:0,warnings:[]},lyricAlignment:{state:'idle',stage:'',progress:0,detectedSegments:[],lines:[],warnings:[],error:null},
    stems:[{id:'original',name:'原曲',url:'/media/qa/original.wav',available:true,peaks:[.1,.2,.4,.2]}]};
}
export function testWav(){const wav=Buffer.alloc(44+8000*48*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);for(let i=0;i<8000*48;i++)wav.writeInt16LE(Math.round(2000*Math.sin(2*Math.PI*110*i/8000)),44+i*2);return wav;}
