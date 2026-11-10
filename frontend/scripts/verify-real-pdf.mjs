import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve('../backend/data/projects');
const candidates=[];
for(const id of await fs.readdir(root)){try{const filename=path.join(root,id,'project.json'),raw=await fs.readFile(filename),project=JSON.parse(raw);if(id!=='demo')candidates.push({filename,raw,project});}catch{}}
candidates.sort((a,b)=>(b.project.lyrics?.length??0)-(a.project.lyrics?.length??0));
const {filename,raw,project}=candidates[0];const hash=data=>createHash('sha256').update(data).digest('hex');
const snapshot=structuredClone(project);snapshot.title+=' · 导出核对副本';
const response=await fetch(`http://127.0.0.1:8001/api/projects/${project.id}/export/pdf`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:snapshot,mode:'chart'})});
if(!response.ok)throw Error(await response.text());
const buffer=Buffer.from(await response.arrayBuffer());await fs.mkdir('../output/pdf',{recursive:true});await fs.writeFile('../output/pdf/user-song-check.pdf',buffer);
if(hash(raw)!==hash(await fs.readFile(filename)))throw Error('Source project changed');
const report={title:project.title,lyrics:project.lyrics.length,fills:(project.manualFills??[]).reduce((n,g)=>n+g.notes.length,0),sourceUnchanged:true,bytes:buffer.length};
await fs.writeFile('../docs/verification/real-pdf-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
