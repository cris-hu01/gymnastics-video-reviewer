/**
 * Trim slice — selection bounds for the active segment, decoupled from the
 * <video> element.
 *
 * Pre-A4 layout (the thing this slice replaces):
 *   trimStart / trimEnd  →  useState<number> in App.tsx
 *   trimStartRef / trimEndRef →  useRef mirrors used by RAF callbacks
 *   trimDraggingRef → useRef boolean toggled during pointer drag
 *   activeSegmentId → useState<string | null>
 *
 * The reason all four travelled together is that the timeline scrubber,
 * the trim handles, the playback effect, and the auto-save effect each
 * needed to read at least three of them on every frame. Pulling them into
 * one slice removes the "ref + state" double-bookkeeping pattern: actions
 * write once, every consumer reads from the same source.
 *
 * Why store ms (not seconds)?
 *   - Matches the playback slice. A single unit boundary at the <video>
 *     element keeps unit bugs contained.
 *   - Integer-ish comparisons against `segment.start * 1000` no longer
 *     suffer the 0.099999/0.100000 float drift that haunted the pre-A4
 *     `Math.abs(trimStart - segment.start) < 0.01` guards.
 *
 * Invariants enforced inside actions (intentionally NOT at call sites —
 * call sites must be safe even with sloppy input):
 *   - `startMs >= 0`
 *   - `endMs > startMs` (always at least 1ms wide; matches the old
 *     `Math.max(trimStartLocal + CLIP_STEP, trimEnd ...)` guard)
 *   - `updateStart(ms)` clamps `ms` to `[0, endMs - MIN_GAP_MS]`
 *   - `updateEnd(ms)`   clamps `ms` to `[startMs + MIN_GAP_MS, +∞)`
 *
 * `setActiveClip(clipId, startMs, endMs)` is the atomic boundary swap used
 * when the user navigates between clips/segments. It must set all three at
 * once so subscribers never observe a stale clipId paired with the previous
 * clip's bounds.
 *
 * `draggingHandle` exists so the auto-save effect (in App / ReviewPanel)
 * can skip writing to the backend while the user is still dragging — same
 * role as the old `trimDraggingRef`, but readable from any component
 * without prop drilling.
 *
 * TODO(v1.3.1): updateStart / updateEnd / setRange are documented above
 * but currently have NO callers — App.tsx still uses local useState for
 * trimStart/trimEnd (legacy `setTrimStart` / `setTrimEnd` via `updateTrimRange`
 * around App.tsx:1605). Only `setActiveClip` (called from
 * `setActiveSegmentId` wrapper) writes the slice's `startMs`/`endMs`,
 * meaning the slice's bounds drift out of sync with the legacy useState.
 * Wiring is intentionally deferred — runtime correctness is preserved
 * because every reader still goes through the legacy useState. The slice
 * is in place ready for the migration. See Review A finding M1.
 */
import type { StateCreator } from 'zustand';

/** Minimum allowed gap between start and end, in milliseconds. */
export const MIN_TRIM_GAP_MS = 1;

export type TrimHandle = 'start' | 'end';

export interface TrimState {
  /** id of the clip whose segment bounds these refer to. */
  clipId: string | null;
  /** id of the segment within the clip; mirrors the old activeSegmentId. */
  segmentId: string | null;
  /** Trim start in ms. */
  startMs: number;
  /** Trim end in ms. Guaranteed `> startMs` by the slice actions. */
  endMs: number;
  /** Which handle the user is currently dragging, or null. */
  draggingHandle: TrimHandle | null;
}

export interface TrimActions {
  /**
   * Atomic swap: set clipId/segmentId and bounds in one update. Use this
   * when the user navigates to a different clip or segment so subscribers
   * never observe a (clipId, bounds) mismatch.
   */
  setActiveClip: (params: {
    clipId: string | null;
    segmentId: string | null;
    startMs: number;
    endMs: number;
  }) => void;
  beginDrag: (handle: TrimHandle) => void;
  endDrag: () => void;
  /** Clamp + apply a new start. Maintains `endMs > startMs` invariant. */
  updateStart: (ms: number) => void;
  /** Clamp + apply a new end. Maintains `endMs > startMs` invariant. */
  updateEnd: (ms: number) => void;
  /**
   * Move both bounds together — used by keyboard shortcuts that nudge
   * the whole window. Maintains relative width.
   */
  setRange: (startMs: number, endMs: number) => void;
  /** Resets to empty state — used when no clip is loaded. */
  clearTrim: () => void;
}

export type TrimSlice = TrimState & TrimActions;

const sanitize = (ms: number): number => (Number.isFinite(ms) ? Math.max(0, ms) : 0);

export const createTrimSlice: StateCreator<TrimSlice, [], [], TrimSlice> = (set) => ({
  clipId: null,
  segmentId: null,
  startMs: 0,
  endMs: 0,
  draggingHandle: null,
  setActiveClip: ({ clipId, segmentId, startMs, endMs }) =>
    set(() => {
      const s = sanitize(startMs);
      // Always preserve start < end. If callers pass nonsense (e.g. a
      // segment with end<start from a corrupted state.json) we widen end
      // to start+MIN_GAP rather than silently corrupting.
      const e = Math.max(sanitize(endMs), s + MIN_TRIM_GAP_MS);
      return { clipId, segmentId, startMs: s, endMs: e, draggingHandle: null };
    }),
  beginDrag: (handle) => set({ draggingHandle: handle }),
  endDrag: () => set({ draggingHandle: null }),
  updateStart: (ms) =>
    set((state) => {
      const upperBound = state.endMs - MIN_TRIM_GAP_MS;
      const clamped = Math.min(upperBound, sanitize(ms));
      if (clamped === state.startMs) return state;
      return { startMs: clamped };
    }),
  updateEnd: (ms) =>
    set((state) => {
      const lowerBound = state.startMs + MIN_TRIM_GAP_MS;
      const clamped = Math.max(lowerBound, sanitize(ms));
      if (clamped === state.endMs) return state;
      return { endMs: clamped };
    }),
  setRange: (startMs, endMs) =>
    set(() => {
      const s = sanitize(startMs);
      const e = Math.max(sanitize(endMs), s + MIN_TRIM_GAP_MS);
      return { startMs: s, endMs: e };
    }),
  clearTrim: () =>
    set({
      clipId: null,
      segmentId: null,
      startMs: 0,
      endMs: 0,
      draggingHandle: null,
    }),
});
