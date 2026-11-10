import type { CSSProperties } from 'react';
import type { Project, ScoreStyle } from './music';

export const DEFAULT_SCORE_STYLE: Required<ScoreStyle> = {
  lyricFontSize: 20,
  lyricPrintSize: 18,
  topPrintSize: 22,
  fillPrintSize: 16,
  printBarsPerRow: 4,
  printPreset: 'large',
  colors: { lyrics: '#1D1D1F', top: '#1D4ED8', fill: '#167047', mark: '#C62828' },
  printColor: true,
  printOrientation: 'landscape',
};

/** Validate saved style before it reaches CSS or a portable document. */
export function readScoreStyle(project: Pick<Project, 'scoreStyle'>): Required<ScoreStyle> {
  const value = project.scoreStyle;
  const print = value?.printPreset ? value : DEFAULT_SCORE_STYLE;
  const number = (candidate: unknown, fallback: number, min: number, max: number) => typeof candidate === 'number' && Number.isFinite(candidate) ? Math.min(max, Math.max(min, candidate)) : fallback;
  const color = (candidate: unknown, fallback: string) => typeof candidate === 'string' && /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
  return {
    lyricFontSize: number(value?.lyricFontSize, DEFAULT_SCORE_STYLE.lyricFontSize, 14, 32),
    lyricPrintSize: number(print.lyricPrintSize, 18, 12, 30),
    topPrintSize: number(print.topPrintSize, 22, 16, 36),
    fillPrintSize: number(print.fillPrintSize, 16, 12, 24),
    printBarsPerRow: print.printBarsPerRow === 2 ? 2 : 4,
    printPreset: print.printPreset === 'custom' ? 'custom' : 'large',
    colors: {
      lyrics: color(value?.colors?.lyrics, DEFAULT_SCORE_STYLE.colors.lyrics),
      top: color(value?.colors?.top, DEFAULT_SCORE_STYLE.colors.top),
      fill: color(value?.colors?.fill, DEFAULT_SCORE_STYLE.colors.fill),
      mark: color(value?.colors?.mark, DEFAULT_SCORE_STYLE.colors.mark),
    },
    printColor: value?.printColor !== false,
    printOrientation: print.printOrientation === 'portrait' ? 'portrait' : 'landscape',
  };
}

export function scoreStyleVariables(project: Pick<Project, 'scoreStyle'>): CSSProperties & Record<string, string> {
  const style = readScoreStyle(project);
  return {
    '--lyric-font': `${style.lyricFontSize}px`,
    '--lyric-print-font': `${style.lyricPrintSize}pt`,
    '--top-print-font': `${style.topPrintSize}pt`,
    '--fill-print-font': `${style.fillPrintSize}pt`,
    '--score-lyrics': style.colors.lyrics,
    '--score-top': style.colors.top,
    '--score-fill': style.colors.fill,
    '--score-mark': style.colors.mark,
    '--score-page-width': style.printOrientation === 'landscape' ? '273mm' : '186mm',
  };
}

/** Fix the physical page before JS measures anchored notation for printing. */
export function scorePageCss(project: Pick<Project, 'scoreStyle'>): string {
  return `@page{size:A4 ${readScoreStyle(project).printOrientation};margin:12mm}`;
}
