import type { CSSProperties } from 'react';
import type { PlacedGuitarChord } from './guitar-chords';

/** One guitar symbol above a lyric character. Candidates say 待校对 and are not accepted. */
export function GuitarChordMarkButton({ mark, left, top, onEdit }: { mark: PlacedGuitarChord; left: string; top: number; onEdit: (id: string) => void }) {
  const candidate = mark.status === 'candidate';
  return <button
    type="button"
    className={'guitar-chord-mark no-print' + (candidate ? ' is-candidate' : mark.status === 'manual' ? ' is-manual' : ' is-confirmed')}
    data-guitar-chord-id={mark.id}
    data-lyric-id={mark.lyricId}
    data-char-offset={mark.charOffset}
    data-lyric-token={mark.token}
    data-status={mark.status}
    data-accepted={candidate ? 'false' : 'true'}
    aria-label={candidate ? `${mark.symbol} 待校对，尚未人工核对` : `${mark.symbol} ${mark.label}`}
    title={candidate ? `${mark.symbol} · 待校对候选，尚未人工核对` : `${mark.symbol} · ${mark.label}吉他和弦`}
    style={{ left, top, '--mark-ratio': String(mark.leftRatio) } as CSSProperties}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); onEdit(mark.id); }}
  >
    <span className="guitar-chord-symbol">{mark.symbol}</span>
    {candidate && <small>待校对</small>}
  </button>;
}
