import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, Clock3, ExternalLink, FileText, Loader2, Pencil, Play, RefreshCw, Sparkles } from 'lucide-react';
import type { Lyric, Project } from './music';
import './lyric-alignment.css';
import { useCommands } from './commands';

interface AlignmentDiff { kind: 'equal' | 'replace' | 'insert' | 'delete'; original: string; detected: string }
interface AlignmentLine {
  id: string; lyricId?: string; text: string; detectedText: string;
  start: number | null; end: number | null; status: 'matched' | 'pending' | 'manual';
  confidence: number; diff: AlignmentDiff[];
}
interface DetectedSegment {
  id: string; text: string; start: number; end: number; confidence: number;
  words: { text: string; start: number; end: number; confidence: number }[];
}
interface AlignmentReport {
  state: 'idle' | 'running' | 'complete' | 'error'; stage: string; progress: number;
  detectedSegments: DetectedSegment[]; lines: AlignmentLine[]; warnings: string[]; error: string | null;
}
export interface LyricAlignmentOptions {
  lyricId?: string; model?: string; language?: string;
  mode?: 'recognize' | 'align'; originalText?: string;
}
export interface LyricAlignmentProps {
  p: Project & { lyricsOriginal?: string; lyricAlignment?: AlignmentReport };
  onAlign: (options: LyricAlignmentOptions) => Promise<void>;
  onSeek: (seconds: number) => void;
  onEditLyric: (id: string) => void;
  onAccept?: (lineId: string) => void;
}
interface ComparisonRow { id: string; lyric?: Lyric; line?: AlignmentLine; text: string }

export function lyricAlignmentRequest(originalText: string, options: LyricAlignmentOptions): LyricAlignmentOptions {
  return { ...options, ...(options.mode === 'align' ? { originalText } : {}) };
}

function timestamp(value: number): string {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(safe / 60), seconds = (safe % 60).toFixed(2).padStart(5, '0');
  return `${String(minutes).padStart(2, '0')}:${seconds}`;
}
function validTime(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function hasDifference(line?: AlignmentLine): boolean {
  return !!line?.diff?.some(part => part.kind !== 'equal');
}
function confidence(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100)}%`;
}

/** User text stays authoritative; recognition and timing remain visible candidates. */
export default function LyricAlignment({ p, onAlign, onSeek, onEditLyric, onAccept }: LyricAlignmentProps) {
  const [model, setModel] = useState('');
  const [language, setLanguage] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState('');
  const report = p.lyricAlignment;
  const working = requesting || report?.state === 'running';
  const originalText = p.lyricsOriginal?.trim() ? p.lyricsOriginal : p.lyrics.map(lyric => lyric.text).join('\n');
  const hasText = !!originalText.trim();
  const hasVocals = p.stems.some(stem => stem.id === 'vocals' && stem.available);
  const rows = useMemo<ComparisonRow[]>(() => {
    const lines = report?.lines || [];
    const linked = new Map(lines.filter(line => line.lyricId).map(line => [line.lyricId!, line]));
    const lyricIds = new Set(p.lyrics.map(lyric => lyric.id));
    return [
      ...p.lyrics.map(lyric => ({ id: lyric.id, lyric, line: linked.get(lyric.id), text: lyric.text })),
      ...lines.filter(line => !line.lyricId || !lyricIds.has(line.lyricId)).map(line => ({ id: line.id, line, text: line.text })),
    ];
  }, [p.lyrics, report?.lines]);
  const totals = useMemo(() => ({
    matched: rows.filter(row => row.line?.status === 'matched' && !hasDifference(row.line)).length,
    review: rows.filter(row => row.line?.status === 'matched' && hasDifference(row.line)).length,
    manual: rows.filter(row => row.line?.status === 'manual').length,
    pending: rows.filter(row => !row.line || row.line.status === 'pending').length,
  }), [rows]);
  useEffect(() => { setRequestError(''); setRequesting(false); }, [p.id]);

  async function run(mode: 'recognize' | 'align', lyricId?: string) {
    if (working) return;
    setRequestError(''); setRequesting(true);
    try {
      await onAlign(lyricAlignmentRequest(originalText, { mode, ...(lyricId ? { lyricId } : {}), ...(model ? { model } : {}), ...(language ? { language } : {}) }));
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : '歌词处理未能完成，请检查本机模型状态后重试。');
    } finally { setRequesting(false); }
  }

  useCommands([
    { id: 'alignment.recognize', label: '识别人声音轨的歌词', group: '歌词校正', enabled: !working && hasVocals, run: () => void run('recognize') },
    { id: 'alignment.align', label: '按歌词原文自动对齐', group: '歌词校正', enabled: !working && hasText && hasVocals, run: () => void run('align') },
    { id: 'alignment.settings', label: '打开歌词识别设置', group: '歌词校正', run: () => { const parent = document.querySelector<HTMLDetailsElement>('.alignment-details'), settings = document.querySelector<HTMLDetailsElement>('.la-advanced'); if (parent) parent.open = true; if (settings) { settings.open = true; settings.querySelector('select')?.focus(); settings.scrollIntoView({ block: 'nearest' }); } } },
    ...rows.flatMap((row, i) => [
      ...(row.lyric ? [
        { id: `alignment.edit.${row.id}`, label: `校正第 ${i + 1} 句原文与时间：${row.text.slice(0, 24)}`, group: '歌词校正', run: () => onEditLyric(row.lyric!.id) },
        { id: `alignment.redo.${row.id}`, label: `重新对齐第 ${i + 1} 句：${row.text.slice(0, 24)}`, group: '歌词校正', enabled: !working && hasVocals, run: () => void run('align', row.lyric!.id) },
      ] : []),
      ...(row.line && onAccept ? [{ id: `alignment.accept.${row.id}`, label: `采用第 ${i + 1} 句候选时间：${row.text.slice(0, 24)}`, group: '歌词校正', enabled: !working && validTime(row.line.start) && validTime(row.line.end) && row.line.end > row.line.start, run: () => onAccept(row.line!.id) }] : []),
    ]),
  ]);

  return <section className="lyric-alignment no-print" aria-label="歌词原文与 AI 对齐">
    <header className="la-heading">
      <div><span className="la-kicker"><Sparkles size={12} /> 歌词校对</span><h2>原文与音频，逐句核对</h2><p>保留你的歌词，单独显示识别文本和候选时间。</p></div>
      <div className="la-actions">
        <button type="button" className="la-button la-secondary" disabled={working || !hasVocals} onClick={() => void run('recognize')}><RefreshCw size={13} /> 识别音频歌词</button>
        <button type="button" className="la-button la-primary" disabled={working || !hasText || !hasVocals} onClick={() => void run('align')}>
          {working ? <Loader2 size={13} className="la-spinner" /> : <Sparkles size={13} />} {working ? '正在处理' : '按原文对齐'}
        </button>
      </div>
    </header>

    <div className="la-summary" aria-label="歌词对齐统计">
      <span><i className="la-status-dot matched" /> 已匹配 <b>{totals.matched}</b></span>
      <span><i className="la-status-dot review" /> 待核对 <b>{totals.review}</b></span>
      <span><i className="la-status-dot pending" /> 待对齐 <b>{totals.pending}</b></span>
      <span><i className="la-status-dot manual" /> 人工确认 <b>{totals.manual}</b></span>
    </div>

    {working && <div className="la-progress" role="status"><span>{report?.stage || '正在启动本机歌词任务…'}</span><progress max="100" value={Math.min(100, Math.max(0, report?.progress || 0))} /></div>}
    {(requestError || report?.state === 'error') && <div className="la-message la-error" role="alert"><AlertCircle size={15} /><span>{requestError || report?.error || '歌词分析失败，请检查模型与人声音轨后重试。'}<small>当前歌词和人工校正结果仍保留。</small></span></div>}
    {!hasVocals ? <p className="la-note">贝斯单轨没有人声，无法自动识别歌词。请导入 LRC，或粘贴 TXT 后试听并手动修正时间。</p> : !report || report.state === 'idle' ? <p className="la-note">尚未获得 AI 对齐结果。普通文本需要识别与核对；LRC 已有逐句时间，可直接导入。</p> : null}
    {(report?.warnings || []).map((warning, index) => <p className="la-message la-warning" key={index}><AlertCircle size={13} />{warning}</p>)}

    <details className="la-advanced"><summary>识别设置</summary><div className="la-settings">
      <label>模型<select value={model} disabled={working} onChange={event => setModel(event.target.value)}><option value="">使用已配置模型</option><option value="tiny">tiny</option><option value="base">base</option><option value="small">small</option><option value="medium">medium</option><option value="large-v3">large-v3</option></select></label>
      <label>歌词语言<select value={language} disabled={working} onChange={event => setLanguage(event.target.value)}><option value="">自动判断</option><option value="zh">中文</option><option value="en">英文</option><option value="ja">日文</option></select></label>
      <p>使用本机已配置模型。模型缺失、未准备人声音轨或识别失败时，会显示具体原因。</p>
    </div></details>

    <div className="la-comparison">
      <div className="la-column-head"><span>你的歌词原文</span><span>AI 识别与候选时间</span><span>校对</span></div>
      {rows.length === 0 ? <div className="la-empty"><FileText size={22} /><strong>先导入或粘贴歌词</strong><p>也可以先识别音频，查看模型听到的歌词。</p></div> : <div className="la-rows">{rows.map((row, index) => {
        const line = row.line;
        const differs = hasDifference(line);
        const state = !line || line.status === 'pending' ? 'pending' : line.status === 'manual' ? 'manual' : differs ? 'review' : 'matched';
        const label = { pending: '待对齐', manual: '人工确认', review: '待核对', matched: '已匹配' }[state];
        const canAccept = line && validTime(line.start) && validTime(line.end) && line.end > line.start;
        return <div className={`la-row la-row-${state}`} key={row.id}>
          <div className="la-original"><div className="la-row-meta"><span className="la-line-number">{String(index + 1).padStart(2, '0')}</span>{row.lyric && <button className="la-time" type="button" title="播放工程中此句的时间位置" onClick={() => onSeek(row.lyric!.start)}><Play size={10} />{timestamp(row.lyric.start)}</button>}{row.lyric?.locked && <span className="la-preserved">人工时间已保留</span>}</div><p>{row.text || '（空歌词）'}</p></div>
          <div className="la-detected">
            {line?.detectedText ? <><p className={differs ? 'la-difference-text' : ''}>{line.detectedText}</p><div className="la-candidate">{validTime(line.start) ? <button type="button" className="la-time" onClick={() => onSeek(line.start!)} title="试听 AI 候选时间"><Play size={10} />{timestamp(line.start)}{validTime(line.end) ? `–${timestamp(line.end)}` : ''}</button> : <span>尚未确定时间</span>}<span>置信度 {confidence(line.confidence)}</span></div>{differs && <details className="la-diff-detail"><summary>查看文本差异</summary><div>{line.diff.filter(part => part.kind !== 'equal').map((part, i) => <p key={i}><span>{part.original || '（无）'}</span><span aria-label="替换为">→</span><span>{part.detected || '（未识别）'}</span></p>)}</div></details>}</> : <p className="la-pending-text">{state === 'manual' ? '尚无 AI 候选，保留人工时间' : '尚无识别结果，等待对齐'}</p>}
          </div>
          <div className="la-row-actions"><span className={`la-status ${state}`}>{state === 'matched' || state === 'manual' ? <Check size={11} /> : <Clock3 size={11} />}{label}</span>
            {onAccept && canAccept && <button type="button" className="la-small-action" disabled={working} onClick={() => onAccept(line.id)}>{row.lyric?.locked ? '改用候选时间' : '采用候选时间'}</button>}
            <div className="la-icon-actions">{row.lyric && <><button type="button" disabled={working} onClick={() => void run('align', row.lyric!.id)} title="重新识别并对齐此句" aria-label={`重新对齐第 ${index + 1} 句`}><RefreshCw size={13} /></button><button type="button" onClick={() => onEditLyric(row.lyric!.id)} title="手动校正原文与时间" aria-label={`手动校正第 ${index + 1} 句`}><Pencil size={13} /></button></>}</div>
          </div>
        </div>;
      })}</div>}
    </div>

    {!!report?.detectedSegments?.length && <details className="la-source-details"><summary>音频识别原始片段 · {report.detectedSegments.length} 段</summary><div className="la-segment-list">{report.detectedSegments.map(segment => <div key={segment.id}><button type="button" className="la-time" onClick={() => onSeek(segment.start)}><Play size={10} />{timestamp(segment.start)}</button><p>{segment.text}</p></div>)}</div></details>}
    {!!p.lyricsOriginal && <details className="la-source-details"><summary>查看已导入的歌词原文</summary><pre>{p.lyricsOriginal}</pre></details>}
    <details className="la-help"><summary>LRC 时间歌词是什么？在哪里获取？</summary><div><p>LRC 是每句前面带时间标签的歌词。<code>[00:12.50]第一句歌词</code> 表示从音频第 12.5 秒开始显示这一句，通常不是逐字时间。</p><p>可以导入已有的 <code>.lrc</code> 文件，或粘贴带时间标签的内容。从网易云复制的普通歌词走 TXT 粘贴与校对；仅改文件扩展名不会增加时间。本版本暂不通过网易云歌曲链接自动取词。</p><p>可到 <a href="https://lrclib.net/" target="_blank" rel="noreferrer">LRCLIB 歌词库 <ExternalLink size={11} /></a> 查找，或使用其 <a href="https://github.com/tranxuanthang/lrcget/releases" target="_blank" rel="noreferrer">LRCGET 客户端 <ExternalLink size={11} /></a> 下载已有同步歌词。匹配后试听检查歌曲版本和时间偏移。</p></div></details>
  </section>;
}
