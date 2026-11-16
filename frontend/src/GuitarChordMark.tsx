import type { CSSProperties } from 'react';
import type { PlacedGuitarChord } from './guitar-chords';

/** One guitar symbol above a lyric character. Pending marks say 待校对 and are not accepted accuracy. */
export function GuitarChordMarkButton({ mark, left, top, onEdit }: { mark: PlacedGuitarChord; left: string; top: number; onEdit: (id: string) => void }) {
  const pending = mark.proof === 'pending';
  return <button
    type="button"
    className={'guitar-chord-mark no-print' + (pending ? ' is-pending' : ' is-confirmed')}
    data-guitar-chord-id={mark.id}
    data-lyric-id={mark.lyricId}
    data-char-offset={mark.charOffset}
    data-lyric-token={mark.token}
    data-proof={mark.proof}
    data-accepted={pending ? 'false' : 'true'}
    aria-label={pending ? `${mark.symbol} 待校对，对齐尚未确认` : `${mark.symbol} 已校对`}
    title={pending ? `${mark.symbol} · 待校对候选，对齐还没有确认` : `${mark.symbol} · 已校对吉他和弦`}
    style={{ left, top, '--mark-ratio': String(mark.leftRatio) } as CSSProperties}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); onEdit(mark.id); }}
  >
    <span className="guitar-chord-symbol">{mark.symbol}</span>
    {pending && <small>待校对</small>}
  </button>;
}
