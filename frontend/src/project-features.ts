import type { Project } from './music';

export function featureRunning(p:Project):boolean {
  return [p.analysis,p.lyricAlignment,p.keyAnalysis,p.harmonyAnalysis,p.backingAnalysis].some(task=>task?.state==='running');
}
export function keyLabel(p:Project,original=false):string {
  const info=p.keyAnalysis;
  if(info?.confirmed||info?.detectedKey)return (original?p.originalKey:p.key)+(info.confirmed?'':' · 候选');
  if(p.isDemo)return original?p.originalKey:p.key;
  return info===undefined||info===null?'历史调性待确认':'未识别';
}
