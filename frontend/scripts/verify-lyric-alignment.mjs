import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { default: LyricAlignment, lyricAlignmentRequest } = await server.ssrLoadModule('/src/LyricAlignment.tsx');
  const demo = JSON.parse(await readFile('../backend/data/projects/demo/project.json', 'utf8'));
  const lyrics = [
    { id: 'user-1', text: '用户提供的正确歌词', start: 12.5, end: 16, source: 'manual', locked: true },
    { id: 'user-2', text: '第二句保持原文', start: 20, end: 24, source: 'manual', locked: false },
  ];
  const project = { ...demo, lyrics, lyricsOriginal: lyrics.map(item => item.text).join('\n'), lyricAlignment: undefined };
  const report = { state: 'complete', stage: '已完成', progress: 100, lines: [], detectedSegments: [], warnings: [], error: null };
  const line = { id: 'candidate-1', lyricId: 'user-1', text: '候选结构不能覆盖用户原文', detectedText: '用户提供的错误歌词', start: 12.7, end: 16.2, status: 'matched', confidence: 0.75, diff: [{ kind: 'replace', original: '正确', detected: '错误' }] };
  const render = p => renderToStaticMarkup(createElement(LyricAlignment, { p, onAlign: async () => {}, onSeek: () => {}, onEditLyric: () => {}, onAccept: () => {} }));
  let html = render(project);
  assert.match(html, /用户提供的正确歌词/);
  assert.match(html, /待对齐 <b>2<\/b>/);
  assert.doesNotMatch(html, /置信度 /);
  assert.doesNotMatch(html, /采用候选时间/);
  const rawOriginal = '\n  [ar:测试歌手]\r\n[00:12.50] 用户提供的正确歌词  \r\n\n';
  assert.equal(lyricAlignmentRequest(rawOriginal, { mode: 'align' }).originalText, rawOriginal);
  assert.equal(lyricAlignmentRequest(rawOriginal, { mode: 'align', lyricId: 'user-1' }).originalText, rawOriginal);
  assert.equal(lyricAlignmentRequest(rawOriginal, { mode: 'recognize' }).originalText, undefined);
  html = render({ ...project, lyricsOriginal: rawOriginal });
  assert.ok(html.includes(rawOriginal));
  console.log('PASS 无 AI 结果明确待对齐，对齐请求保留原文空白、换行和标签');

  html = render({ ...project, lyricAlignment: { ...report, lines: [line] } });
  assert.match(html, /用户提供的正确歌词/);
  assert.match(html, /用户提供的错误歌词/);
  assert.doesNotMatch(html, /候选结构不能覆盖用户原文/);
  assert.match(html, /待核对 <b>1<\/b>/);
  assert.match(html, /置信度 75%/);
  assert.match(html, /重新对齐第 1 句/);
  console.log('PASS AI 错词单独展示，用户原文保持主列且提示核对');

  assert.match(html, /人工时间已保留/);
  assert.match(html, /改用候选时间/);
  assert.match(html, /00:12.50/);
  assert.match(html, /00:12.70/);
  console.log('PASS 人工时间和候选时间分别显示，采用候选需要用户动作');

  html = render({ ...project, lyricAlignment: { ...report, state: 'error', error: '本机未安装 faster-whisper' } });
  assert.match(html, /role="alert"/);
  assert.match(html, /本机未安装 faster-whisper/);
  assert.match(html, /第二句保持原文/);
  console.log('PASS 模型失败显示具体原因且用户歌词保留');

  html = render({ ...project, lyricAlignment: { ...report, lines: [{ ...line, start: null, end: null }] } });
  assert.doesNotMatch(html, /改用候选时间/);
  assert.match(html, /尚未确定时间/);
  console.log('PASS 无候选时间时不提供采用按钮，不将 null 当成零秒');

  html = render({ ...project, lyricAlignment: { ...report, state: 'running', stage: '正在识别人声', progress: 42 } });
  assert.match(html, /正在识别人声/);
  assert.match(html, /<progress max="100" value="42"/);
  assert.match(html, /disabled=""[^>]*><svg[^>]*.*?识别音频歌词/s);
  console.log('PASS 运行状态显示实际进度并防止重复任务');
  console.log('6 项歌词对齐显示验证通过。');
} finally {
  await server.close();
}
