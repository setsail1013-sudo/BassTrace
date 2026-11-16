import { useState } from 'react';
import type { Project } from './music';

export function HomePage({ p, preparedLyrics, projects, booting, onAudio, onLyrics, onAnalyze, onOpen, onScore, onRestore, onBatch }: {
  p: Project | null;
  preparedLyrics?: number;
  projects: Project[];
  booting?: boolean;
  onAudio: (file?: File, source?: 'original' | 'uploaded_bass') => void;
  onLyrics: () => void;
  onAnalyze: () => void;
  onOpen: (id: string) => void;
  onScore: () => void;
  onRestore: () => void;
  onBatch: () => void;
}) {
  const [source, setSource] = useState<'original' | 'uploaded_bass'>('original');
  const [dragging, setDragging] = useState(false);
  return <div
    className={'home-folio' + (dragging ? ' dragging' : '')}
    onDragOver={event => { event.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={event => { event.preventDefault(); setDragging(false); onAudio(event.dataTransfer.files[0], source); }}
  >
    <h1 className="ped-title">BassTrace</h1>
    <p className="ped-sub">本地备曲工作台 · 文件保存在你的电脑</p>
    <div className="home-links">
      <label className="text-link">导入音乐文件<input type="file" accept=".mp3,.wav,.flac,.m4a" hidden onChange={event => onAudio(event.target.files?.[0], source)} /></label>
      <button type="button" className="text-link" onClick={onBatch}>批量导入</button>
      <button type="button" className="text-link" onClick={onRestore}>恢复曲库备份</button>
      {p && <button type="button" className="text-link" onClick={onLyrics}>导入歌词{preparedLyrics ? ` · 已准备 ${preparedLyrics} 段` : p.lyrics.length ? ` · ${p.lyrics.length} 段` : ''}</button>}
      {p && <button type="button" className="text-link" onClick={onAnalyze}>分析当前歌曲</button>}
      {p && <button type="button" className="text-link" onClick={onScore}>打开当前曲谱</button>}
    </div>
    <label className="home-source">导入音频类型
      <select aria-label="导入音频类型" value={source} onChange={event => setSource(event.target.value as 'original' | 'uploaded_bass')}>
        <option value="original">完整原曲</option>
        <option value="uploaded_bass">已经分离的独立贝斯轨</option>
      </select>
    </label>
    {projects.length > 0 && <section className="recent-projects" aria-label="最近工程">
      <h2>最近工程</h2>
      {projects.slice(0, 8).map(item => <button key={item.id} type="button" className="recent-row" onClick={() => onOpen(item.id)}>
        <span>{item.title}</span>
        <small>{item.isDemo ? '原创演示' : item.artist || '本地音频'} · {item.bpm} BPM</small>
      </button>)}
    </section>}
    {booting && <p className="ped-sub">正在打开你的备曲工作台…</p>}
    {!booting && !projects.length && <p className="ped-sub">曲库是空的。把音频拖到这张纸上，或使用上面的导入与恢复。</p>}
  </div>;
}
