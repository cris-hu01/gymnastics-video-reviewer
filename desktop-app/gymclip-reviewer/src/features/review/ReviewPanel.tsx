/**
 * ReviewPanel — the entire middle review surface.
 *
 * What lives here:
 *   - Clip info strip (athlete name / country / pipeline badges).
 *   - <PlayerSurface /> (videoRef owner) inside the aspect-ratio box.
 *   - In-player hover overlay with play/pause toggle + progress bar.
 *   - <TimelineSurface /> with <TrimHandles /> in its render slot.
 *   - Segment switcher (when the active clip has multiple segments).
 *   - Trim row: play button + start/playhead/end clocks + total duration.
 *   - Keyboard cheat-sheet (Space / Arrows / A D J L / B C N).
 *   - Action buttons: split / extract / delete / keep.
 *
 * What stays in App.tsx (and is wired in via props):
 *   - All the business handlers (handleSplitActiveClip, handleStatusChange,
 *     flushActiveSegmentEdits, …). They touch project state, jobs state,
 *     error / success messages, multiple stores — moving them down here
 *     would require dragging half the App-level closure with them and
 *     give no real isolation benefit pre-v1.4.
 *   - The clip / video derived data (activeClip, activeVideo, clipWindow*).
 *     Pre-computed in App's useMemos and passed through.
 *
 * Design choice: many props rather than a "context provider" pattern.
 *   - The store already carries the cross-cutting playback / trim signals,
 *     so this component reads those directly via useStore selectors.
 *   - Everything else is App-level orchestration; passing it as a single
 *     bag of props makes the contract explicit and is easier to grep
 *     than a context whose membership grows silently.
 */
import {AlertCircle, Check, CheckCircle2, Pause, Play, Trash2} from 'lucide-react';
import type {PointerEvent as ReactPointerEvent, ReactNode} from 'react';

import {StatusBadge} from '../../components/StatusBadge';
import {formatClock, pipelineToneClass} from '../../lib/format';
import {useStore} from '../../store';
import type {CandidateClip, ClipSegment, ClipStatus, ProjectState} from '../../types';

import {PlayerOverlayReadout, PlayheadClock} from './PlayheadReadouts';
import {PlayerSurface} from './PlayerSurface';
import {TimelineSurface} from './TimelineSurface';
import {TrimHandles} from './TrimHandles';

type ProjectVideo = ProjectState['videos'][number];
type PipelineTone = 'neutral' | 'muted' | 'success' | 'warning' | 'danger';
type ClipPipelineBadgeItem = {
  key: 'export' | 'oss' | 'platform';
  text: string;
  tone: PipelineTone;
};

export interface ReviewPanelProps {
  activeClip: CandidateClip | null;
  activeVideo: ProjectVideo | null;
  streamUrl: string;
  activeClipSegments: ClipSegment[];
  activeSegment: ClipSegment | null;
  activeClipDisplayName: string;
  activeClipDisplayCountry: string;
  activeClipPipelineBadges: ClipPipelineBadgeItem[];
  videoClips: CandidateClip[];
  clipWindowStart: number;
  clipWindowEnd: number;
  clipWindowVersion: number;
  trimStart: number;
  trimEnd: number;
  isSavingTrim: boolean;
  trimJustSaved: boolean;
  activeClipLockedByExport: boolean;
  videoPlaybackError: string | null;
  setVideoPlaybackError: (msg: string | null) => void;
  /* Review-only handlers (all stay in App). */
  togglePlayPause: () => void;
  beginScrub: () => void;
  endScrub: () => void;
  syncVideoTime: (timeSec: number, options?: {force?: boolean}) => void;
  handleTrimDragStart: (
    edge: 'start' | 'end',
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  selectActiveSegment: (segmentId: string) => void;
  handleSplitActiveClip: () => void | Promise<void>;
  handleExtractActiveSegment: () => void | Promise<void>;
  handleDeleteActiveSegment: () => void | Promise<void>;
  handleStatusChange: (clipId: string, status: ClipStatus) => void | Promise<void>;
}

const KEYBOARD_HINTS: Array<{keys: string[]; label: string}> = [
  {keys: ['Space'], label: '播放'},
  {keys: ['←', '→'], label: '快进退'},
  {keys: ['⇧←', '⇧→'], label: '逐帧'},
  {keys: ['↑', '↓'], label: '切换'},
  {keys: ['[', ']'], label: '变速'},
  {keys: ['A', 'D'], label: '左边界'},
  {keys: ['J', 'L'], label: '右边界'},
  {keys: ['I', 'O'], label: '入/出点'},
  {keys: ['B'], label: '拆分'},
  {keys: ['C'], label: '删除选区'},
  {keys: ['N'], label: '独立'},
  {keys: ['/'], label: '搜卡片'},
  {keys: ['1-9'], label: '绑卡片'},
  {keys: ['Enter'], label: '保留'},
  {keys: ['Del'], label: '丢弃'},
  {keys: ['⌘Z'], label: '撤销'},
];

export function ReviewPanel(props: ReviewPanelProps): ReactNode {
  const {
    activeClip,
    activeVideo,
    streamUrl,
    activeClipSegments,
    activeSegment,
    activeClipDisplayName,
    activeClipDisplayCountry,
    activeClipPipelineBadges,
    videoClips,
    clipWindowStart,
    clipWindowEnd,
    clipWindowVersion,
    trimStart,
    trimEnd,
    isSavingTrim,
    trimJustSaved,
    activeClipLockedByExport,
    videoPlaybackError,
    setVideoPlaybackError,
    togglePlayPause,
    beginScrub,
    endScrub,
    syncVideoTime,
    handleTrimDragStart,
    selectActiveSegment,
    handleSplitActiveClip,
    handleExtractActiveSegment,
    handleDeleteActiveSegment,
    handleStatusChange,
  } = props;

  // PR4 (render-storm): ReviewPanel subscribes to `isPlaying` ONLY — it flips
  // a couple of times per session, so the panel body re-rendering on it is
  // cheap. The live playhead (currentTimeMs, ~30Hz during playback) is NOT
  // subscribed here; it is owned by the two leaf readouts (PlayerOverlayReadout
  // / PlayheadClock) below. That keeps the heavy panel chrome (player box,
  // segment switcher, action buttons, cheat-sheet) static during playback —
  // only the tiny clock/progress DOM nodes update each frame.
  const isPlaying = useStore((s) => s.isPlaying);
  // Playback speed changes only a handful of times per session ([ / ] keys),
  // so subscribing it on the panel body is as cheap as `isPlaying` above.
  const playbackRate = useStore((s) => s.playbackRate);

  // PR4: the render props below (onScrubMove / renderActiveSegmentHandles) are
  // deliberately inline. Memoizing them would be inert: TimelineSurface is not
  // wrapped in React.memo, so it re-renders whenever ReviewPanel does
  // regardless of prop identity — and even if it were memo'd, the props' App
  // sources (syncVideoTime, handleTrimDragStart) are plain function
  // declarations re-created every App render, so a useCallback keyed on them
  // would change identity every render anyway. TimelineSurface also owns its
  // own currentTimeMs subscription, so it already re-renders ~30Hz during
  // playback on its own; a stable parent prop wouldn't change that. Stabilizing
  // these for real would require useCallback-ing the entire transitive
  // trim-drag closure in App (updateTrimRange → startTrimScroll → … over
  // activeClip/activeSegment/clipWindow*), a missed-dependency stale-closure
  // risk that isn't worth the ~couple-renders-per-session it would save.

  if (!activeClip || !activeVideo) {
    return (
      <section className="flex-1 bg-gray-50/30 flex flex-col min-w-0">
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
          <AlertCircle size={48} className="mb-4 opacity-20" />
          <p className="font-medium">
            {activeVideo ? '请在中间选择一个候选片段进行审核' : '请先导入原视频或已有片段'}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex-1 bg-gray-50/30 flex flex-col min-w-0">
      <div className="flex-1 p-8 flex flex-col min-h-0">
        <div className="flex-1 min-h-0 w-full flex items-center justify-center">
          <div className="w-full max-h-full max-w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-xl border border-gray-200/50 relative group">
            <PlayerSurface
              streamUrl={streamUrl}
              onError={() =>
                setVideoPlaybackError(
                  activeVideo.error_message || '视频加载失败，请确认源文件仍存在。',
                )
              }
            />

            {videoPlaybackError && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/75 px-6 text-center">
                <div>
                  <AlertCircle size={36} className="mx-auto mb-3 text-white/80" />
                  <p className="text-sm font-medium text-white">{videoPlaybackError}</p>
                </div>
              </div>
            )}

            <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-6 pointer-events-none">
              <div className="flex items-center gap-4">
                <button
                  data-testid="player-play-toggle"
                  onClick={togglePlayPause}
                  className="w-12 h-12 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white backdrop-blur-md transition-colors pointer-events-auto"
                >
                  {isPlaying ? <Pause size={24} /> : <Play size={24} className="ml-1" />}
                </button>
                <PlayerOverlayReadout
                  clipWindowStart={clipWindowStart}
                  clipWindowEnd={clipWindowEnd}
                />
              </div>
            </div>

            <div className="absolute top-4 right-4">
              <StatusBadge status={activeClip.status} size="lg" />
            </div>
          </div>
        </div>

        <div className="w-full mt-6 flex items-end justify-between px-2">
          <div>
            <div className="flex items-center gap-3 mb-1.5">
              <h2 className="text-2xl font-bold text-gray-900 tracking-tight">{activeClipDisplayName}</h2>
              <span className="px-2 py-0.5 rounded-md bg-gray-100 text-gray-600 text-sm font-mono font-medium border border-gray-200">
                {activeClipDisplayCountry}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              <span>片段 #{videoClips.findIndex((clip) => clip.id === activeClip.id) + 1}</span>
              {activeClipPipelineBadges.map((item) => (
                <span
                  key={item.key}
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${pipelineToneClass(item.tone)}`}
                >
                  {item.text}
                </span>
              ))}
              {isSavingTrim && <span className="text-red-500">保存中...</span>}
              {!isSavingTrim && (
                <span
                  className={`text-emerald-600 transition-opacity duration-500 ${trimJustSaved ? 'opacity-100' : 'opacity-0'}`}
                  aria-hidden={!trimJustSaved}
                >
                  已保存 ✓
                </span>
              )}
              {activeClipLockedByExport && (
                <span className="text-amber-600">当前片段在导出批次中，只读</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="h-auto pt-6 pb-6 px-8 border-t border-gray-200 bg-white flex flex-col shrink-0 shadow-[0_-4px_20px_rgba(0,0,0,0.02)] z-10 overflow-hidden">
        <TimelineSurface
          activeVideoId={activeVideo.id}
          activeClipId={activeClip.id}
          clipWindowStart={clipWindowStart}
          clipWindowEnd={clipWindowEnd}
          clipWindowVersion={clipWindowVersion}
          segments={activeClipSegments}
          activeSegmentId={activeSegment?.id ?? null}
          trimStart={trimStart}
          trimEnd={trimEnd}
          activeClipLockedByExport={activeClipLockedByExport}
          onScrubStart={beginScrub}
          onScrubMove={(t) => syncVideoTime(t, {force: false})}
          onScrubEnd={endScrub}
          renderActiveSegmentHandles={() => (
            <TrimHandles onDragStart={handleTrimDragStart} />
          )}
        />

        {activeClipSegments.length > 1 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {activeClipSegments.map((segment, index) => (
              <button
                key={segment.id}
                type="button"
                onClick={() => selectActiveSegment(segment.id)}
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                  activeSegment?.id === segment.id
                    ? 'bg-red-50 border-red-200 text-red-700'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                选区 {String.fromCharCode(65 + index)}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-4">
            <button
              data-testid="player-play-toggle-trim"
              type="button"
              onClick={togglePlayPause}
              className="w-10 h-10 flex items-center justify-center rounded-full bg-red-500 hover:bg-red-600 text-white shadow-md transition-colors"
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
            </button>
            <div className="flex gap-6 text-xs text-gray-500 font-mono">
              <span>
                起点 <span className="text-gray-800 font-semibold">{formatClock(trimStart)}</span>
              </span>
              <span>
                播放 <span className="text-red-600 font-semibold"><PlayheadClock /></span>
              </span>
              <span>
                终点 <span className="text-gray-800 font-semibold">{formatClock(trimEnd)}</span>
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span
              className={`font-mono font-semibold ${playbackRate !== 1 ? 'text-red-600' : 'text-gray-400'}`}
              title="播放倍速（[ 减速 / ] 加速）"
            >
              {playbackRate}×
            </span>
            <span>时长 {formatClock(Math.max(0, trimEnd - trimStart))}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-start justify-end gap-x-4 gap-y-1 mb-4 text-[10px] text-gray-400">
          {KEYBOARD_HINTS.map(({keys, label}) => (
            <span key={label} className="flex flex-col items-center gap-0.5">
              <span className="flex gap-0.5">
                {keys.map((k) => (
                  <kbd
                    key={k}
                    className="bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5 text-gray-500 font-sans font-medium shadow-sm text-[11px] leading-tight"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
              <span>{label}</span>
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2.5">
          <button
            onClick={() => void handleSplitActiveClip()}
            disabled={activeClipLockedByExport}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-1.5 transition-all shadow-sm bg-white hover:bg-gray-50 text-gray-700 border border-gray-200"
          >
            <CheckCircle2 size={16} />
            拆分选区
          </button>
          <button
            onClick={() => void handleExtractActiveSegment()}
            disabled={activeClipLockedByExport || activeClipSegments.length <= 1}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-1.5 transition-all shadow-sm bg-white hover:bg-gray-50 text-gray-700 border border-gray-200"
          >
            <CheckCircle2 size={16} />
            独立片段
          </button>
          <button
            onClick={() => void handleDeleteActiveSegment()}
            disabled={activeClipLockedByExport || activeClipSegments.length <= 1}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-1.5 transition-all shadow-sm bg-white hover:bg-red-50 hover:text-red-600 hover:border-red-200 text-gray-600 border border-gray-200"
          >
            <Trash2 size={16} />
            删除选区
          </button>
          <button
            onClick={() => void handleStatusChange(activeClip.id, 'kept')}
            disabled={activeClipLockedByExport}
            className={`px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-1.5 transition-all shadow-sm ${
              activeClip.status === 'kept'
                ? 'bg-gray-900 text-white border border-gray-900 shadow-md'
                : 'bg-gray-800 hover:bg-gray-900 text-white border border-gray-800'
            }`}
          >
            <Check size={16} />
            保留片段
          </button>
        </div>
      </div>
    </section>
  );
}
