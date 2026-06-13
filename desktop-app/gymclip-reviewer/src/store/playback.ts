/**
 * Playback slice — single source of truth for the <video> element wiring.
 *
 * The "dangerous triangle" pre-A4:
 *   <video>  <-->  trimStartRef / trimEndRef  <-->  playheadLocal
 * Every loop edge wrote into something a sibling read, and onTimeUpdate
 * could trigger a seek which re-fired onTimeUpdate — closed-loop hell.
 *
 * The fix is to invert the dependency: the renderer (PlayerSurface) is the
 * sole holder of the HTMLVideoElement ref. UI components never poke
 * `videoRef.current.currentTime`. They issue *commands* through this store
 * and read *snapshots* the renderer publishes back.
 *
 * Two distinct channels live here:
 *
 *   1. Publish channel — `currentTimeMs`, `duration`. The
 *      renderer pushes onTimeUpdate / onLoadedMetadata into these. UI
 *      subscribes for read-only display (timeline scrubber, segment list,
 *      clock readouts). Writers MUST NOT enqueue a seek in response to
 *      these — that's the loop we are dismantling.
 *
 *   2. Command channel — `pendingSeek` + `isPlaying`. UI dispatches a seek
 *      with `enqueueSeek(timeMs)` which bumps a monotonically increasing
 *      nonce. PlayerSurface watches `pendingSeek`; when nonce changes it
 *      sets `video.currentTime = timeMs` exactly once, then calls
 *      `consumeSeek(nonce)` to clear the pending command. Idempotent under
 *      strict-mode double-effect: consuming a non-matching nonce is a no-op.
 *
 * Invariants enforced inside actions (NOT at the call site):
 *   - `enqueueSeek(ms)` ignores NaN / undefined; if `duration > 0` it
 *     clamps to [0, duration].
 *   - `consumeSeek(n)` only clears `pendingSeek` if it still matches `n`
 *     (avoids losing a fresh seek the user issued while we were finishing
 *     the previous one).
 *   - `setCurrentTimeMs` deliberately does NOT enqueue a seek. This is the
 *     one rule that breaks the closed loop; do not "fix" it later.
 *
 * Why milliseconds instead of seconds? The trim slice stores ms so segments
 * compare cleanly (no floating-point start === segment.start drift), and
 * keeping both slices in the same unit avoids a quiet conversion at every
 * boundary. Conversion to <video>'s float-seconds happens *only* inside
 * PlayerSurface where the unit lives.
 */
import type { StateCreator } from 'zustand';

export interface PlaybackPendingSeek {
  /** Monotonically increasing nonce, set by `enqueueSeek`. */
  nonce: number;
  /** Target time in milliseconds, already clamped to [0, duration] if known. */
  timeMs: number;
}

export interface PlaybackState {
  /** Total media duration in ms. 0 until `onLoadedMetadata` fires. */
  duration: number;
  /** True iff the renderer believes the <video> is actively playing. */
  isPlaying: boolean;
  /** Latest currentTime published by the renderer in ms. */
  currentTimeMs: number;
  /** Pending seek command, or null if the renderer is caught up. */
  pendingSeek: PlaybackPendingSeek | null;
  /**
   * Desired playback speed multiplier (1 = normal). UI dispatches changes via
   * `setPlaybackRate`; PlayerSurface mirrors it onto `video.playbackRate` the
   * same way it mirrors `isPlaying`. This is a command-channel field: UI writes
   * it, the renderer applies it — UI never touches `video.playbackRate` directly.
   */
  playbackRate: number;
}

export interface PlaybackActions {
  setDuration: (ms: number) => void;
  setIsPlaying: (playing: boolean) => void;
  /**
   * Set the desired playback speed. Clamps to a sane range and ignores
   * non-finite input. PlayerSurface watches `playbackRate` and applies it to
   * the <video> element. The rate is preserved across pause/play *and* across
   * video switches: once a review speed is chosen it sticks until changed, so
   * consecutive clips stay at the same slow-mo without re-setting it.
   */
  setPlaybackRate: (rate: number) => void;
  /**
   * Renderer-only publisher. UI components MUST treat this as read-only
   * (subscribe via selector) — never call it from a click handler.
   * Calling this does NOT trigger a seek; that is the invariant.
   */
  setCurrentTimeMs: (ms: number) => void;
  /**
   * Dispatch a seek command. Bumps the nonce so PlayerSurface re-runs
   * its seek effect even if the target ms is unchanged (intentional —
   * "jump to trim start" must work even when we are already at trim start).
   * Returns the issued nonce for callers that want to await consumption.
   */
  enqueueSeek: (timeMs: number) => number;
  /**
   * Renderer signals it has applied the seek for `nonce`. We clear
   * `pendingSeek` only if it still carries the same nonce; a newer enqueue
   * in flight wins.
   */
  consumeSeek: (nonce: number) => void;
}

export type PlaybackSlice = PlaybackState & PlaybackActions;

export const createPlaybackSlice: StateCreator<PlaybackSlice, [], [], PlaybackSlice> = (set, get) => ({
  duration: 0,
  isPlaying: false,
  currentTimeMs: 0,
  pendingSeek: null,
  playbackRate: 1,
  setDuration: (ms) => set({ duration: Math.max(0, ms) }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setPlaybackRate: (rate) => {
    if (!Number.isFinite(rate)) return;
    // Clamp to the range the UI exposes; defends against a bad caller without
    // coupling the store to the exact preset ladder (which lives in App).
    const clamped = Math.min(4, Math.max(0.25, rate));
    if (get().playbackRate === clamped) return;
    set({ playbackRate: clamped });
  },
  setCurrentTimeMs: (ms) => {
    // Guard against the renderer pushing NaN during src swap.
    if (!Number.isFinite(ms)) return;
    const clamped = Math.max(0, ms);
    // Skip set() if unchanged — avoids spurious re-renders on the
    // ~30Hz timeupdate cadence.
    if (get().currentTimeMs === clamped) return;
    set({ currentTimeMs: clamped });
  },
  enqueueSeek: (timeMs) => {
    if (!Number.isFinite(timeMs)) return get().pendingSeek?.nonce ?? 0;
    const { duration, pendingSeek } = get();
    const upperBound = duration > 0 ? duration : Number.POSITIVE_INFINITY;
    const clamped = Math.min(upperBound, Math.max(0, timeMs));
    const nonce = (pendingSeek?.nonce ?? 0) + 1;
    set({ pendingSeek: { nonce, timeMs: clamped } });
    return nonce;
  },
  consumeSeek: (nonce) =>
    set((state) => {
      if (state.pendingSeek == null) return state;
      if (state.pendingSeek.nonce !== nonce) return state;
      return { pendingSeek: null };
    }),
});
