/**
 * PlayerSurface — the sole holder of the HTMLVideoElement ref in the app.
 *
 * Why a single owner? See store/playback.ts header: the pre-A4 layout had
 * three things (videoRef, trim refs, playheadLocal) writing into the same
 * cycle, which produced a closed-loop seek storm during scrubbing. A4
 * inverts the dependency: this component is the only one allowed to touch
 * `video.currentTime` / `video.play()`. Everything else dispatches a
 * command through the store and reads back a publish snapshot.
 *
 * Two-way wiring with the store:
 *
 *   Reads (command channel):
 *     - `pendingSeek` (nonce + ms). When nonce changes, we apply the seek
 *       exactly once and call `consumeSeek(nonce)` to clear it.
 *     - `isPlaying`. When it flips, we call `video.play()` or
 *       `video.pause()` to mirror it onto the element. We do NOT publish
 *       a play() error back through the store — the active surface stays
 *       paused if play() rejects (autoplay policy, missing src, etc).
 *
 *   Writes (publish channel):
 *     - `setCurrentTimeMs` from onTimeUpdate (~30Hz). Per the slice
 *       contract this MUST NOT call enqueueSeek, ever.
 *     - `setDuration` from onLoadedMetadata.
 *     - `setIsPlaying(true|false)` from onPlay / onPause native events.
 *       This means if the autoplay-policy denies a play() call we issued
 *       in response to `isPlaying=true`, the failed pause event lands
 *       here and corrects the store back to `false` — no UI drift.
 *
 * Why we keep fastSeek + rAF batching here (not in the store):
 *   - `enqueueSeek` is idempotent and supplies a nonce-per-call, so multiple
 *     scrub events at >60Hz could each bump the nonce. The scrubber emits
 *     pointermove at native rate; coalescing into a single seek-per-frame
 *     here keeps the <video> element from thrashing.
 *   - Large-delta seeks use `fastSeek` when available (keyframe-only,
 *     instant) for the same UX reason the pre-A4 code did. Smaller seeks
 *     use precise `currentTime` so trim handles land exactly on the chosen
 *     boundary.
 *
 * onError is bubbled out via a callback rather than another store slice
 * because the error string is presentation-coupled (we sometimes preface
 * with the video's own error_message from the project state). When that
 * presentation moves into ReviewPanel in A4-6 we may inline it.
 */
import {useEffect, useRef} from 'react';

import {useStore} from '../../store';

export interface PlayerSurfaceProps {
  streamUrl: string;
  /**
   * Called when the underlying <video> emits an `error` event. The parent
   * decides what user-facing message to display; we pass the empty
   * default so this prop is always callable.
   */
  onError: (message: string) => void;
  /** Called once the metadata loads (duration becomes known). */
  onLoadedMetadata?: () => void;
  className?: string;
}

const SEEK_PRECISION_S = 0.02;

export function PlayerSurface({
  streamUrl,
  onError,
  onLoadedMetadata,
  className,
}: PlayerSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Track the last seek nonce we have applied so a strict-mode double
  // effect run doesn't seek twice for the same command.
  const lastAppliedNonceRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const pendingSeek = useStore((s) => s.pendingSeek);
  const isPlaying = useStore((s) => s.isPlaying);
  const playbackRate = useStore((s) => s.playbackRate);
  const setCurrentTimeMs = useStore((s) => s.setCurrentTimeMs);
  const setDuration = useStore((s) => s.setDuration);
  const setIsPlaying = useStore((s) => s.setIsPlaying);
  const consumeSeek = useStore((s) => s.consumeSeek);

  // Command: apply a pending seek. We coalesce repeated seeks into a
  // single rAF tick to avoid pummeling the video element during scrub.
  useEffect(() => {
    if (!pendingSeek) return;
    const {nonce, timeMs} = pendingSeek;
    if (nonce === lastAppliedNonceRef.current) return;

    // Tracks any one-shot `loadedmetadata` listener so a superseded seek
    // can remove it before a newer-nonce seek attaches its own (M2 fix).
    let metadataCleanup: (() => void) | null = null;

    const apply = () => {
      rafRef.current = null;
      const video = videoRef.current;
      if (!video) {
        // No element mounted yet. Leave the nonce un-consumed; the effect
        // will re-run when the element mounts and pendingSeek is still set.
        return;
      }
      const targetSeconds = timeMs / 1000;
      // If the element hasn't loaded metadata yet, Safari throws on
      // currentTime assignment. Defer to a one-shot loadedmetadata
      // listener so the seek lands the moment the element is ready.
      if (video.readyState < 1) {
        const onLoaded = () => {
          video.removeEventListener('loadedmetadata', onLoaded);
          metadataCleanup = null;
          try {
            video.currentTime = targetSeconds;
          } catch {
            // Last resort: drop the seek so we don't deadlock.
          }
          lastAppliedNonceRef.current = nonce;
          consumeSeek(nonce);
        };
        video.addEventListener('loadedmetadata', onLoaded);
        metadataCleanup = () => video.removeEventListener('loadedmetadata', onLoaded);
        return;
      }
      if (Math.abs(video.currentTime - targetSeconds) > SEEK_PRECISION_S) {
        const delta = Math.abs(targetSeconds - video.currentTime);
        if (delta > 2 && typeof video.fastSeek === 'function') {
          video.fastSeek(targetSeconds);
        } else {
          try {
            video.currentTime = targetSeconds;
          } catch {
            // Fall through — element is too far gone, mark consumed.
          }
        }
      }
      lastAppliedNonceRef.current = nonce;
      consumeSeek(nonce);
    };

    // If a rAF is already queued, the latest pendingSeek will simply be
    // applied when it runs (we close over `timeMs`/`nonce` so we use the
    // fresh values via the effect re-run when pendingSeek changes).
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(apply);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // M2 fix: a newer-nonce seek (or unmount / streamUrl change) supersedes
      // any one-shot loadedmetadata listener parked by the previous nonce —
      // without this cleanup the stale targetSeconds would land on the
      // newer video and consume the newer nonce as if it were itself.
      if (metadataCleanup) {
        metadataCleanup();
        metadataCleanup = null;
      }
    };
  }, [pendingSeek, consumeSeek]);

  // Command: mirror isPlaying onto the <video> element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      if (video.paused) {
        void video.play().catch(() => {
          // Autoplay rejected, missing src, etc. Roll the store back
          // so the UI doesn't show "playing" indefinitely.
          setIsPlaying(false);
        });
      }
    } else {
      if (!video.paused) {
        video.pause();
      }
    }
  }, [isPlaying, setIsPlaying]);

  // Command: mirror playbackRate onto the <video> element. Re-runs on
  // streamUrl change too because loading a fresh src resets the element's
  // playbackRate to 1, and the store may still carry a non-1 rate the user set
  // before the swap (though setVideoId resets it to 1 in the normal flow).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.playbackRate !== playbackRate) {
      video.playbackRate = playbackRate;
    }
  }, [playbackRate, streamUrl]);

  // Reset our nonce tracker whenever the src changes — the <video> at
  // streamUrl B has no relationship to seek commands meant for A.
  useEffect(() => {
    lastAppliedNonceRef.current = 0;
  }, [streamUrl]);

  return (
    <video
      key={streamUrl}
      ref={videoRef}
      src={streamUrl}
      className={className ?? 'w-full h-full object-contain bg-black'}
      controls={false}
      preload="auto"
      onTimeUpdate={(event) => {
        // Publish channel only — never enqueueSeek from here.
        const seconds = event.currentTarget.currentTime;
        setCurrentTimeMs(seconds * 1000);
      }}
      onLoadedMetadata={(event) => {
        const seconds = event.currentTarget.duration;
        if (Number.isFinite(seconds)) {
          setDuration(seconds * 1000);
        }
        onLoadedMetadata?.();
      }}
      onPlay={() => setIsPlaying(true)}
      onPause={() => setIsPlaying(false)}
      onError={() => onError('视频加载失败，请确认源文件仍存在。')}
    />
  );
}
