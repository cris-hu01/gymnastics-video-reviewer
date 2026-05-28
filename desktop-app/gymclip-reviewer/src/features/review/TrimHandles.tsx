/**
 * TrimHandles — the two ew-resize grippers that sit on the active
 * segment's left and right edges.
 *
 * Why split this out from TimelineSurface:
 *   TimelineSurface is a pure render of the playhead + segment ranges
 *   and stays inert most of the time. The handles, by contrast, install
 *   document-level pointermove/pointerup listeners and run an
 *   rAF-driven auto-scroll loop when the pointer crosses the window
 *   edge. Keeping them in their own component means TimelineSurface
 *   never re-renders just because the user is hovering a handle.
 *
 * Communication contract:
 *   - The component itself only owns the visual JSX + pointerdown
 *     dispatch. The actual drag math (clip-window auto-scroll, trim
 *     range update, post-drag autosave) lives in App / ReviewPanel.
 *   - The parent supplies one callback per edge — `onDragStart('start'
 *     | 'end', initialEvent)` — and the rest of the drag is handled
 *     there. We pass the original PointerEvent through so the parent
 *     can read clientX / closest('[data-timeline-container]') without
 *     us having to re-look up the rect.
 *   - The trim slice's `beginDrag(edge)` / `endDrag()` actions are
 *     called from inside the parent (in startTrimScroll/stopTrimScroll)
 *     so the React-tracked flag stays in lockstep with the imperative
 *     `trimDraggingRef` until the latter is retired in A4-5.
 *
 * Preserved test ids:
 *   `trim-handle-start` and `trim-handle-end` — D-phase Playwright tests
 *   rely on these values. The DOM nodes can move but the strings cannot.
 */
import type {PointerEvent as ReactPointerEvent} from 'react';

import type {TrimHandle} from '../../store/trim';

export interface TrimHandlesProps {
  /**
   * Called on pointerdown for either edge. The parent installs the
   * document-level move/up listeners (kept in App so it can read its
   * own clip-window-override state without prop drilling that state
   * back down). Receives the original event so the parent can grab
   * clientX and the closest timeline container.
   */
  onDragStart: (edge: TrimHandle, event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function TrimHandles({onDragStart}: TrimHandlesProps) {
  return (
    <>
      <div
        data-handle-edge="left"
        data-testid="trim-handle-start"
        className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-ew-resize z-40 pointer-events-auto group/handle"
        title="拖动调整起点"
        onPointerDown={(e) => onDragStart('start', e)}
      >
        <div className="absolute inset-y-0 left-1 w-1 rounded-full bg-red-500/50 group-hover/handle:bg-red-500 group-hover/handle:w-1.5 group-hover/handle:left-0.5 transition-all" />
      </div>
      <div
        data-handle-edge="right"
        data-testid="trim-handle-end"
        className="absolute -right-1.5 top-0 bottom-0 w-3 cursor-ew-resize z-40 pointer-events-auto group/handle"
        title="拖动调整终点"
        onPointerDown={(e) => onDragStart('end', e)}
      >
        <div className="absolute inset-y-0 right-1 w-1 rounded-full bg-red-500/50 group-hover/handle:bg-red-500 group-hover/handle:w-1.5 group-hover/handle:right-0.5 transition-all" />
      </div>
    </>
  );
}
