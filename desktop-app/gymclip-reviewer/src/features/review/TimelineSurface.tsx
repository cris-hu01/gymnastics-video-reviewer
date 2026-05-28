/**
 * TimelineSurface — the scrubber strip below the player.
 *
 * Renders three layers stacked inside one container:
 *   1. Thumbnails: 12 evenly-spaced frames fetched on demand for the
 *      current clip window. Debounced 250ms to swallow rapid window
 *      shifts (e.g. while the user drags a trim handle past the edge,
 *      which auto-extends the window in A4-4).
 *   2. Segment ranges: one translucent band per segment in the clip, with
 *      the active segment highlighted in red. The active segment's band
 *      is also where trim handles attach — TimelineSurface itself does
 *      NOT render those handles. Parent supplies them via the
 *      `renderActiveSegmentHandles` slot so A4-4's TrimHandles can drop
 *      in without restructuring this file.
 *   3. Playhead: a 0.5px-wide vertical bar driven by the playback slice's
 *      `currentTimeMs` publish channel.
 *
 * Scrubbing:
 *   - PointerDown anywhere on the container (except on a child carrying
 *     `data-handle-edge`) starts a scrub. The same listener handles
 *     pointer movement and release.
 *   - We dispatch seek commands via `onScrubMove(timeSec)` so the parent
 *     (App / ReviewPanel) keeps the option of layering its own logic
 *     (e.g. pausing the video while scrubbing). The actual seek is
 *     routed through the store inside the parent's `syncVideoTime`.
 *
 * Why we keep the `data-timeline-container` data attribute:
 *   The trim handles (still in App.tsx pre-A4-4, in TrimHandles post-A4-4)
 *   use `closest('[data-timeline-container]')` to read the rect for their
 *   pointer-to-time math. Keeping the attribute name unchanged means the
 *   handles work whether they live here or in the parent.
 *
 * Thumbnail fetch suppression:
 *   While the user drags a trim handle, the clip window may rapidly
 *   shift in auto-scroll mode (A4-4). Re-fetching 12 frames on every
 *   tick would saturate the renderer. We watch the trim slice's
 *   `draggingHandle` flag and skip fetches while it's non-null, mirroring
 *   the pre-A4 `trimDraggingRef.current` guard.
 */
import {useEffect, useRef, useState, type ReactNode} from 'react';

import {fetchVideoThumbnails} from '../../api';
import {useStore} from '../../store';
import type {ClipSegment, ThumbnailFrame} from '../../types';

export interface TimelineSurfaceProps {
  /**
   * Video id whose thumbnails we should fetch. Null disables the strip
   * (e.g. when no clip is loaded).
   */
  activeVideoId: string | null;
  /** Clip id (re-fetch trigger; the backend caches per-video). */
  activeClipId: string | null;
  /** Start of the visible window in seconds. */
  clipWindowStart: number;
  /** End of the visible window in seconds. */
  clipWindowEnd: number;
  /** Manual version bump from parent to force a thumbnail refetch. */
  clipWindowVersion: number;
  /** Segments to draw on the strip. */
  segments: ClipSegment[];
  activeSegmentId: string | null;
  /** Active segment's trim bounds in seconds (from App-level state). */
  trimStart: number;
  trimEnd: number;
  /** Disable handle rendering while the clip is in an export batch. */
  activeClipLockedByExport: boolean;
  /**
   * Render slot for trim handles. We use a render prop so A4-4 can swap
   * in <TrimHandles /> without touching the timeline layout.
   */
  renderActiveSegmentHandles?: () => ReactNode;
  /** Called on pointerdown inside the scrubber (not on a handle). */
  onScrubStart: () => void;
  /** Called for every pointer position (down + move) in seconds. */
  onScrubMove: (timeSec: number) => void;
  /** Called on pointerup / pointercancel. */
  onScrubEnd: () => void;
}

export function TimelineSurface({
  activeVideoId,
  activeClipId,
  clipWindowStart,
  clipWindowEnd,
  clipWindowVersion,
  segments,
  activeSegmentId,
  trimStart,
  trimEnd,
  activeClipLockedByExport,
  renderActiveSegmentHandles,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: TimelineSurfaceProps) {
  const clipWindowDuration = Math.max(0.0001, clipWindowEnd - clipWindowStart);
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  // While the user drags a trim handle, the parent's window-auto-scroll
  // logic will shift clipWindowStart/end rapidly. Skip thumbnail refetch
  // for the duration of the drag.
  const draggingHandle = useStore((s) => s.draggingHandle);

  const [thumbnails, setThumbnails] = useState<ThumbnailFrame[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Track the most recent fetch so out-of-order responses can be
  // discarded if the user scrubs away mid-fetch.
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    if (!activeVideoId || !activeClipId) {
      setThumbnails([]);
      return;
    }
    if (draggingHandle != null) return;

    let cancelled = false;
    const mySeq = ++fetchSeqRef.current;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setIsLoading(true);
      void fetchVideoThumbnails(activeVideoId, {
        start: clipWindowStart,
        end: clipWindowEnd,
        count: 12,
      })
        .then((response) => {
          if (cancelled || mySeq !== fetchSeqRef.current) return;
          setThumbnails(response.thumbnails);
        })
        .catch(() => {
          if (cancelled || mySeq !== fetchSeqRef.current) return;
          setThumbnails([]);
        })
        .finally(() => {
          if (cancelled || mySeq !== fetchSeqRef.current) return;
          setIsLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeVideoId, activeClipId, clipWindowStart, clipWindowEnd, clipWindowVersion, draggingHandle]);

  const playheadLocal = Math.max(
    0,
    Math.min(clipWindowDuration, currentTimeMs / 1000 - clipWindowStart),
  );
  const playheadPercent = (playheadLocal / clipWindowDuration) * 100;

  return (
    <div className="mb-4 relative">
      <div
        className="w-full h-16 bg-gray-100 rounded-xl border border-gray-200/80 overflow-hidden relative shadow-inner select-none"
        ref={(el) => {
          if (el) el.dataset.timelineContainer = 'true';
        }}
        onPointerDown={(e) => {
          // Ignore pointerdown that originates on a trim handle — those
          // run their own pointer dance and we don't want to seek the
          // playhead into the handle's start position by accident.
          if ((e.target as HTMLElement).dataset.handleEdge) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const time = clipWindowStart + fraction * clipWindowDuration;
          onScrubStart();
          onScrubMove(time);

          const onMove = (ev: PointerEvent) => {
            const f = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
            const t = clipWindowStart + f * clipWindowDuration;
            onScrubMove(t);
          };
          const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            onScrubEnd();
          };
          document.addEventListener('pointermove', onMove);
          document.addEventListener('pointerup', onUp);
          e.preventDefault();
        }}
      >
        <div className="absolute inset-0 flex pointer-events-none">
          {thumbnails.length > 0 ? (
            thumbnails.map((frame) => (
              <img
                key={`${frame.url}-${frame.time_seconds}`}
                src={frame.url}
                alt=""
                className="h-full min-w-0 flex-1 object-cover"
                draggable={false}
              />
            ))
          ) : (
            <div className="flex w-full items-center justify-center text-xs text-gray-400">
              {isLoading ? '生成缩略图中...' : '暂无缩略图'}
            </div>
          )}
        </div>
        <div className="absolute inset-0 bg-black/10 pointer-events-none" />
        {segments.map((segment) => {
          const isCurrent = activeSegmentId === segment.id;
          const displayStart = isCurrent ? trimStart : segment.start;
          const displayEnd = isCurrent ? trimEnd : segment.end;
          const left = ((displayStart - clipWindowStart) / clipWindowDuration) * 100;
          const right = 100 - ((displayEnd - clipWindowStart) / clipWindowDuration) * 100;
          return (
            <div
              key={segment.id}
              className={`absolute top-0 bottom-0 pointer-events-none ${
                isCurrent
                  ? 'bg-red-500/20 border-y-2 border-red-500 z-20'
                  : 'bg-white/30 border-y-2 border-white/80 z-10'
              }`}
              style={{left: `${left}%`, right: `${right}%`}}
            >
              {isCurrent && !activeClipLockedByExport && renderActiveSegmentHandles?.()}
            </div>
          );
        })}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)] z-30 pointer-events-none"
          style={{left: `${playheadPercent}%`}}
        />
      </div>
    </div>
  );
}
