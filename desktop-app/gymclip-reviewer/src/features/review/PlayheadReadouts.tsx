/**
 * Playhead readout leaf components (PR4 — render-storm).
 *
 * These are the *only* parts of the review surface that must re-render at the
 * renderer's ~30Hz timeupdate cadence: the in-player overlay progress bar +
 * its clock, and the trim-row "播放" clock. By owning their own
 * `currentTimeMs` subscription here, ReviewPanel no longer has to subscribe to
 * currentTimeMs itself — so the heavy panel body (player box, segment
 * switcher, action buttons, keyboard cheat-sheet) stops re-rendering on every
 * timeupdate. Only these tiny DOM nodes update.
 *
 * They take the *window* bounds as props (those change at most on clip switch
 * / window scroll, not per frame) and pull the live playhead from the store.
 */
import {memo} from 'react';

import {formatClock, formatDuration} from '../../lib/format';
import {useStore} from '../../store';

export interface PlayerOverlayReadoutProps {
  /** Visible clip window start in seconds (low-frequency prop). */
  clipWindowStart: number;
  /** Visible clip window end in seconds (low-frequency prop). */
  clipWindowEnd: number;
}

/**
 * In-player hover overlay: the white progress bar + "current / total" clock.
 * Subscribes to currentTimeMs so it (and only it) tracks playback.
 */
export const PlayerOverlayReadout = memo(function PlayerOverlayReadout({
  clipWindowStart,
  clipWindowEnd,
}: PlayerOverlayReadoutProps) {
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const playhead = currentTimeMs / 1000;
  const clipWindowDuration = Math.max(0.0001, clipWindowEnd - clipWindowStart);
  const playheadLocal = Math.max(0, Math.min(clipWindowDuration, playhead - clipWindowStart));
  const playheadPercent = (playheadLocal / clipWindowDuration) * 100;

  return (
    <>
      <div className="flex-1 h-1.5 bg-white/30 rounded-full overflow-hidden">
        <div
          className="h-full bg-white rounded-full transition-all duration-75"
          style={{width: `${playheadPercent}%`}}
        />
      </div>
      <span className="text-sm font-mono text-white drop-shadow-md">
        {formatClock(playheadLocal)} / {formatDuration(clipWindowDuration)}
      </span>
    </>
  );
});

/**
 * Trim-row "播放" clock readout. Subscribes to currentTimeMs in isolation so
 * the surrounding trim row (play button, start/end clocks, duration) stays
 * static during playback.
 */
export const PlayheadClock = memo(function PlayheadClock() {
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  return <>{formatClock(currentTimeMs / 1000)}</>;
});
