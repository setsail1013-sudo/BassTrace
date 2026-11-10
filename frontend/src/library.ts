import { barCount, positionToTime, timeToPosition, type Project } from './music';
export interface Playlist {id:string;name:string;projectIds:string[]}
export interface SongFolder {id:string;name:string}
export interface FolderIndex {folders:SongFolder[];assignments:Record<string,string>}
export interface LibraryScope {projectIds?:string[];folderId?:string;playlistId?:string}
export function folderSongs(projects:Project[],index:FolderIndex,selected:string|null){return selected===null?projects:projects.filter(p=>selected==='unfiled'?!index.assignments[p.id]:index.assignments[p.id]===selected);}
export type LibrarySort='title'|'artist';
const collator=new Intl.Collator('zh-Hans-CN-u-co-pinyin',{numeric:true,sensitivity:'base'});
// ICU's Chinese collation puts all Han names before Latin names. Bucket both
// scripts by their initial first so a Z-initial Chinese song cannot precede A.
const initials=[...'ABCDEFGHJKLMNOPQRSTWXYZ'];
const boundaries=[...'阿八嚓搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝'];
export function alphabetGroup(value:string){
  const first=[...value.trim().normalize('NFKD').replace(/\p{M}/gu,'')][0]??'';
  if(/[a-z]/i.test(first))return first.toUpperCase();
  if(/[0-9]/.test(first))return '0–9';
  if(/\p{Script=Han}/u.test(first)){for(let i=boundaries.length-1;i>=0;i--)if(collator.compare(first,boundaries[i])>=0)return initials[i];return 'A';}
  return '#';
}
function compareName(a:string,b:string){const x=alphabetGroup(a),y=alphabetGroup(b);return (x===y?0:x==='#'?1:y==='#'?-1:x.localeCompare(y))||collator.compare(a,b);}
export function songIdentity(p:Pick<Project,'title'|'artist'>){
  const pair=p.title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return {artist:p.artist.trim()||pair?.[1].trim()||'',title:pair&&(!p.artist.trim()||p.artist.trim()===pair[1].trim())?pair[2].trim():p.title};
}
export function librarySongs(projects:Project[],sort:LibrarySort,query='',playlist?:Playlist){
  const needle=query.trim().toLocaleLowerCase(),ids=playlist?new Set(playlist.projectIds):null;
  return projects.filter(p=>(!ids||ids.has(p.id))&&(!needle||`${p.title} ${songIdentity(p).artist}`.toLocaleLowerCase().includes(needle))).slice().sort((a,b)=>{
    const x=songIdentity(a),y=songIdentity(b);
    return (sort==='artist'?(x.artist&&y.artist?compareName(x.artist,y.artist):x.artist?-1:y.artist?1:0):0)||compareName(x.title,y.title)||compareName(x.artist,y.artist)||a.id.localeCompare(b.id);
  });
}
export function adjacentBarTime(p:Project,time:number,direction:-1|1){
  const at=timeToPosition(p,Math.max(0,Math.min(p.duration,time))),bar=at.bar;
  if(bar<1)return direction<0?0:Math.min(p.duration,positionToTime(p,1,1));
  if(direction<0&&bar<=1)return 0;
  if(direction>0&&bar>=barCount(p))return p.duration;
  return Math.max(0,Math.min(p.duration,positionToTime(p,bar+direction,1)));
}
