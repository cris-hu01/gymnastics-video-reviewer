import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Upload} from 'lucide-react';

import {
  addVideoAsCandidate,
  bindClipPlatformRecord,
  cancelDetectVideo,
  deleteProjectVideo,
  deleteClipSegment,
  detectProjectVideo,
  exportProject,
  extractClipSegment,
  fetchJobs,
  fetchProject,
  getVideoStreamUrl,
  restoreCandidateClips,
  retryClipStage,
  splitClipSegment,
  updateClip,
} from './api';
import type {
  AppJob,
  CandidateClip,
  ClipSegment,
  ClipStatus,
  PlatformRecord,
  ProjectState,
} from './types';
import {
  categoryLabel,
  extractOutputDirectoryLabel,
  firstDisplayText,
  formatClock,
  formatDuration,
  formatNotificationCount,
  formatNotificationResultSummary,
  formatNotificationTargetCount,
  formatScopeFolderLabel,
  formatSportItemLabel,
  getExportQueueStatusLabel,
  hashString,
  pipelineToneClass,
  statusLabel,
  truncateNotificationText,
  videoStatusClass,
  videoStatusLabel,
} from './lib/format';
import {
  bindingTheme,
  coerceRecordSex,
  deriveSexFromSelectionKeys,
  deriveSexFromSportItemId,
  deriveSexFromText,
  getClipDisplayCountry,
  getClipDisplayName,
  getClipFailureStage,
  getClipPipelineBadges,
  getClipRuntimeStatusText,
  getClipSearchText,
  getClipUploadItem,
  getJobTargetClipIds,
  getJobUploadItems,
  getResolvedPlatformRecordSex,
  isClipExportSelectable,
} from './lib/filters';
import {
  cloneCandidateClips,
  clipEffectiveDuration,
  deriveDisplayedScore,
  firstEditableSegment,
  firstNonEmptyScore,
  getUploadOnlySourceMode,
  normalizeSegments,
  orderedSegments,
  parseNumericScore,
  toUploadItem,
} from './lib/clip-math';
import {
  EXPORT_OPERATION_DETAILS,
} from './lib/utils';
import { useStore } from './store';
import { StatusBadge } from './components/StatusBadge';
import { TriStateCheckboxButton } from './components/TriStateCheckboxButton';
import { useVideoImport, VideoImportPanel } from './features/import';
import type { ImportMode } from './features/import';
import { useExportJobs, ExportDialog } from './features/export';
import { useLocalCard } from './features/local-card';
import { useVideoListPanel, VideoListPanel } from './features/video-list';
import { usePlatformMatchPanel, PlatformMatchPanel } from './features/platform-match';
import { ClipListPanel } from './features/clip-list';
import { ReviewPanel } from './features/review';
import { AppHeader } from './features/app-header';
import { describeJobProgress, describeVideoProgress, jobPercent } from './lib/progress';

type FilterStatus = ClipStatus | 'all';

type ClipUndoSnapshot = {
  candidateClips: CandidateClip[];
  activeClipId: string | null;
  activeSegmentId: string | null;
};

type ActiveSegmentEditSnapshot = {
  clip: CandidateClip;
  segment: ClipSegment;
  playheadValue: number;
};

type ToastKind = 'success' | 'error';
type AppToast = {
  id: number;
  kind: ToastKind;
  message: string;
};

const SPORT_ITEM_LABELS: Record<number, string> = {
  0: '自由体操',
  1: '鞍马',
  2: '吊环',
  3: '跳马',
  4: '双杠',
  5: '单杠',
  6: '高低杠',
  7: '平衡木',
};

const SEX_LABELS: Record<number, string> = {
  1: '男子',
  2: '女子',
};

const CLIP_STEP = 0.2;
const MIN_SEGMENT_DURATION = 0.5;
// Single-frame step for Shift+←/→. The frontend has no per-video fps (the
// backend reads CAP_PROP_FPS during detection but does not surface it in the
// video metadata), so we fall back to a 30fps frame duration as specified.
const FALLBACK_FPS = 30;
const FRAME_DURATION = 1 / FALLBACK_FPS;
// Playback-speed ladder cycled by [ and ]. 1× is the default; [ steps slower,
// ] steps faster, clamped at the ends (no wrap-around).
const PLAYBACK_RATE_PRESETS = [0.5, 1, 1.5, 2] as const;
const EXPORT_LOCKED_CLIP_MESSAGE = '该片段在当前导出批次中，导出完成前不可编辑';
const EXPORT_LOCKED_RESTORE_MESSAGE = '当前有导出任务进行中，暂不支持撤销结构编辑';

/**
 * Content digest for the silent jobs poll's short-circuit (PR4 render-storm).
 *
 * Returns a stable string capturing everything the UI derives from a job:
 * its id, status, and the full `progress` payload (jobPercent /
 * describeJobProgress read many fields out of progress — completed, total,
 * stage, completed_steps, total_steps, operation, …). If two consecutive
 * polls produce the same digest, nothing the UI cares about changed and we
 * can skip setJobs (and the full-App re-render it triggers).
 *
 * progress is included verbatim via JSON.stringify because that is precisely
 * where live detection/export progress is published — leaving it out would
 * make the short-circuit swallow real progress updates. The jobs list is
 * small (a handful of active pipelines), so stringifying per tick is cheap.
 */
function jobsSignature(jobs: AppJob[]): string {
  return jobs
    .map((job) => `${job.id}:${job.status}:${JSON.stringify(job.progress)}`)
    .join('|');
}
export default function App() {
  const desktopBridge = window.gymclipDesktop;
  // A3: project state migrated to zustand (see store/project.ts). The hook form
  // is used here so renders that depend on the snapshot stay subscribed; mutation
  // paths use the store actions directly (still stable across renders).
  const project = useStore((s) => s.project);
  const setProject = useStore((s) => s.setProject);
  const patchProject = useStore((s) => s.patchProject);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<AppToast | null>(null);
  const [isToastVisible, setIsToastVisible] = useState(false);
  // A3: jobs migrated to zustand (see store/jobs.ts). Subscribed once here so
  // the existing useExportJobs hook (which receives the array as a prop) keeps
  // working unchanged; setters come straight from the store.
  const jobs = useStore((s) => s.jobs);
  const setJobs = useStore((s) => s.setJobs);
  const upsertJob = useStore((s) => s.upsertJob);
  const upsertJobs = useStore((s) => s.upsertJobs);

  // A3: activeVideoId / activeClipId migrated to zustand store (see store/active.ts).
  // Subscribe via selectors to keep referential equality with the prior useState
  // behavior; setters come from the store directly so they're stable across renders.
  const activeVideoId = useStore((s) => s.activeVideoId);
  const activeClipId = useStore((s) => s.activeClipId);
  const setActiveVideoId = useStore((s) => s.setActiveVideoId);
  const setActiveClipId = useStore((s) => s.setActiveClipId);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [isDragging, setIsDragging] = useState(false);
  // A3-4: video-list-local UI state extracted into useVideoListPanel.
  // collapsedVideoFolderIds / isVideoSidebarCollapsed / videoContextMenu still
  // live here because they're consumed by effects in this file (folder cleanup,
  // context-menu auto-close); the panel reads them via the `local` prop.
  const videoListLocal = useVideoListPanel();
  const {
    collapsedVideoFolderIds,
    setCollapsedVideoFolderIds,
    setIsVideoSidebarCollapsed,
    videoContextMenu,
    setVideoContextMenu,
  } = videoListLocal;

  const importApi = useVideoImport({
    desktopBridge,
    onProjectUpdate: setProject,
    onActiveVideoId: setActiveVideoId,
    setErrorMessage,
    setSuccessMessage,
  });
  const {
    isImporting,
    importMode,
    showImportModal,
    openImportSourcePicker,
    handleImportFiles,
    fileInputRef,
    directClipFileInputRef,
  } = importApi;

  const [supportsSecureStorage, setSupportsSecureStorage] = useState(false);
  const [isPersistingApiKey, setIsPersistingApiKey] = useState(false);
  const apiKeyPersistenceReadyRef = useRef(false);
  const exportApi = useExportJobs({
    desktopBridge,
    jobs,
    setErrorMessage,
    setSuccessMessage,
    apiKeyPersistenceReadyRef,
    supportsSecureStorage,
  });
  const {
    showExport,
    setShowExport,
    outputDir,
    setOutputDir,
    savedOutputDir,
    exportMode,
    exportOperation,
    uploadParallelFiles,
    uploadPartThreads,
    ossAccessKeyId,
    ossAccessKeySecret,
    exportSummary,
    setExportSummary,
    hasOssCredentials,
    hasSavedOutputDir,
    persistDefaultOutputDirectory,
  } = exportApi;

  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [rememberApiKey, setRememberApiKey] = useState(false);
  const selectedVideoIds = useStore((s) => s.selectedVideoIds);
  const selectedClipIds = useStore((s) => s.selectedClipIds);
  const [isBatchDetecting, setIsBatchDetecting] = useState(false);
  const [collapsedClipGroupIds, setCollapsedClipGroupIds] = useState<string[]>([]);
  // collapsedVideoFolderIds + isVideoSidebarCollapsed migrated to useVideoListPanel above.
  // A3-5: right-panel filter state migrated to usePlatformMatchPanel. Kept
  // at App level because App-level memos (videoScopedPlatformRecords etc.)
  // and useLocalCard still read the same tuple; the panel sees it via
  // the `local` prop.
  const platformMatchLocal = usePlatformMatchPanel();
  const {
    scoreSearchQuery,
    setScoreSearchQuery,
    scoreApparatusFilter,
    setScoreApparatusFilter,
    scoreSexFilter,
    setScoreSexFilter,
    scoreCountryFilter,
    setScoreCountryFilter,
    openScoreFilter,
    setOpenScoreFilter,
  } = platformMatchLocal;

  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  // A4-5: activeSegmentId now lives in the trim slice as `segmentId`. The
  // local wrapper `setActiveSegmentId` (defined below) writes through the
  // slice's atomic `setActiveClip` so segmentId + bounds + clipId update
  // in a single commit — no subscriber will ever see a (segmentId from
  // clip A, bounds from clip B) mismatch.
  const activeSegmentId = useStore((s) => s.segmentId);
  // PR4 (render-storm): App.tsx deliberately does NOT subscribe to
  // `currentTimeMs`. The renderer publishes that snapshot at ~30Hz during
  // playback; an App-level `useStore(s => s.currentTimeMs)` selector turned
  // every timeupdate into a full App re-render (and re-ran every useMemo).
  // The only live consumers of the playhead are leaf components that own
  // their own subscription (ReviewPanel's overlay clock/progress bar,
  // TimelineSurface's playhead bar) plus three imperative read sites
  // (the auto-pause subscriber, updateTrimRange's nextPlayhead, seekRelative)
  // which read `useStore.getState().currentTimeMs` on demand. `isPlaying`
  // *is* subscribed below — it flips at most a couple of times per playback
  // session, so it does not contribute to the storm.
  const isPlaying = useStore((s) => s.isPlaying);
  const setIsPlayingStore = useStore((s) => s.setIsPlaying);
  const enqueueSeekStore = useStore((s) => s.enqueueSeek);
  // No App-level `playbackRate` subscription on purpose: App reads the live
  // value via getState() inside stepPlaybackRate, and the on-screen indicator
  // lives in ReviewPanel. Subscribing here would re-render App on every [ / ]
  // press, against the PR4 render-storm budget.
  const setPlaybackRateStore = useStore((s) => s.setPlaybackRate);
  const [isSavingTrim, setIsSavingTrim] = useState(false);
  const [trimJustSaved, setTrimJustSaved] = useState(false);
  const [videoPlaybackError, setVideoPlaybackError] = useState<string | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  // A4-3: timelineThumbnails / isLoadingThumbnails moved into TimelineSurface
  // along with the debounced fetch effect. The component watches the trim
  // slice's draggingHandle to suppress refetches mid-drag.

  // A4-2: videoRef removed — PlayerSurface is now the sole owner. The
  // remaining refs below still belong to App.tsx (trim drag state,
  // scrub windowing, undo stack). They will move out in A4-3/A4-4.
  const skipTrimSyncRef = useRef(true);
  const isScrubbingRef = useRef(false);
  const resumeAfterScrubRef = useRef(false);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);
  const trimAutoSaveTimerRef = useRef<number | null>(null);
  const trimSavedIndicatorTimerRef = useRef<number | null>(null);
  const trimScrollRafRef = useRef<number | null>(null);
  const trimPointerXRef = useRef(0);
  const trimRectRef = useRef<DOMRect | null>(null);
  const trimDraggingRef = useRef(false);
  const trimSavePromiseRef = useRef<Promise<ActiveSegmentEditSnapshot | null> | null>(null);
  // Serializes the "flush pending trim → switch active clip" sequence. While a
  // switch is in flight (flush awaiting + setActiveClipId not yet committed),
  // re-entrant switch requests (rapid ↑/↑, click during flush) are ignored so
  // they can't compute a stale nextClip off an un-updated activeClipId or reuse
  // an in-flight flush promise and silently drop a fresh edit.
  const isSwitchingRef = useRef(false);
  const toastIdRef = useRef(0);
  const clipUndoStackRef = useRef<ClipUndoSnapshot[]>([]);
  // PR4 (render-storm): polling guards.
  //
  // The silent workspace poll (250ms while exporting / 1s otherwise) used to
  // call setProject/setJobs unconditionally every tick. Even when the backend
  // data was byte-for-byte unchanged, that produced a fresh object reference →
  // a full App re-render + every useMemo recomputed, several times a second.
  //
  // - projectWriteSeqRef: monotonic counter bumped on EVERY project write,
  //   whether from a poll or a user-initiated PATCH (via setProjectState). A
  //   poll captures the seq before its await; if anything wrote during the
  //   await, the poll's (now potentially stale) response is discarded. This is
  //   the TimelineSurface fetchSeqRef pattern, widened to cover direct writes
  //   so a slow poll can't clobber a fresh PATCH.
  // - projectPollInFlightRef / jobsPollInFlightRef: skip starting a new poll
  //   fetch while one is still outstanding (prevents pile-up under a slow
  //   backend).
  // - lastProjectSignatureRef / lastJobsSignatureRef: content short-circuit.
  //   We only set state when the meaningful content changed (project.updated_at
  //   for the project; an (id,status,progress) digest for jobs).
  const projectWriteSeqRef = useRef(0);
  const projectPollInFlightRef = useRef(false);
  const jobsPollInFlightRef = useRef(false);
  const lastProjectSignatureRef = useRef<string | null>(null);
  const lastJobsSignatureRef = useRef<string | null>(null);

  /**
   * A4-5 helper: every site that used to call `setActiveSegmentId(id)`
   * now routes through this wrapper, which commits the new segmentId
   * (and matching bounds, when we can resolve them) atomically via the
   * trim slice. Falls back to looking up the segment in the current
   * `activeClip` so the call site never has to thread bounds through.
   *
   * Why not just call `setSegmentId` directly: a bare segmentId update
   * would briefly leave the slice's startMs/endMs pointing at the
   * previous segment, defeating the whole point of the atomic action.
   */
  const setActiveSegmentId = (segmentId: string | null) => {
    const clipId = useStore.getState().activeClipId;
    if (!segmentId) {
      // Null id means "no segment loaded" — reset every trim signal so
      // downstream subscribers (e.g. TimelineSurface's segment list) see
      // a clean cleared state.
      useStore.getState().clearTrim();
      return;
    }
    if (!activeClip) {
      // Can't resolve bounds without a clip; commit the segmentId alone
      // and leave bounds at their current values. Real bounds will arrive
      // when the clip finishes loading and the clip-change useEffect runs.
      useStore.getState().setActiveClip({
        clipId,
        segmentId,
        startMs: trimStart * 1000,
        endMs: Math.max((trimStart + 0.001) * 1000, trimEnd * 1000),
      });
      return;
    }
    const segment = orderedSegments(activeClip).find((s) => s.id === segmentId);
    if (segment) {
      useStore.getState().setActiveClip({
        clipId,
        segmentId,
        startMs: segment.start * 1000,
        endMs: Math.max((segment.start + 0.001) * 1000, segment.end * 1000),
      });
    } else {
      // Defensive: id didn't match any current segment (race with a
      // structure edit). Keep the segmentId so subsequent effects can
      // converge, leave bounds alone.
      useStore.getState().setActiveClip({
        clipId,
        segmentId,
        startMs: trimStart * 1000,
        endMs: Math.max((trimStart + 0.001) * 1000, trimEnd * 1000),
      });
    }
  };

  const videos = project?.videos ?? [];
  const platformScopes = project?.platform_scopes ?? [];
  const clips = project?.candidate_clips ?? [];
  const platformRecords = project?.platform_records ?? [];
  const videoById = useMemo(
    () => new Map(videos.map((video) => [video.id, video])),
    [videos],
  );
  const platformScopeById = useMemo(
    () => new Map(platformScopes.map((scope) => [scope.id, scope])),
    [platformScopes],
  );
  const videoOrderById = useMemo(
    () => new Map(videos.map((video, index) => [video.id, index])),
    [videos],
  );
  const folderOrderById = useMemo(() => {
    const next = new Map<string, number>();
    videos.forEach((video, index) => {
      const folderId = video.source_kind === 'direct_clip'
        ? `scope:${video.platform_scope_id}`
        : `video:${video.id}`;
      if (!next.has(folderId)) {
        next.set(folderId, index);
      }
    });
    return next;
  }, [videos]);
  const platformRecordById = useMemo(
    () => new Map(platformRecords.map((entry) => [entry.id, entry])),
    [platformRecords],
  );
  const activeVideo = useMemo(
    () => videos.find((video) => video.id === activeVideoId) ?? null,
    [videos, activeVideoId],
  );

  const clipOrderById = useMemo(() => {
    const map = new Map<string, number>();
    clips.forEach((clip, index) => map.set(clip.id, index));
    return map;
  }, [clips]);

  const videoClips = useMemo(
    () => clips.filter((clip) => clip.video_id === activeVideoId),
    [clips, activeVideoId],
  );

  const filteredClips = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return clips
      .filter((clip) => {
        const matchesStatus = filterStatus === 'all' || clip.status === filterStatus;
        const clipVideo = videoById.get(clip.video_id) ?? null;
        const linkedRecord = clip.linked_platform_record_id
          ? platformRecordById.get(clip.linked_platform_record_id) ?? null
          : null;
        const matchesQuery = !query || getClipSearchText(clip, linkedRecord, clipVideo).includes(query);
        return matchesStatus && matchesQuery;
      })
      .sort((a, b) => {
        const videoA = videoById.get(a.video_id) ?? null;
        const videoB = videoById.get(b.video_id) ?? null;
        const folderA = videoA?.source_kind === 'direct_clip' ? `scope:${videoA.platform_scope_id}` : `video:${a.video_id}`;
        const folderB = videoB?.source_kind === 'direct_clip' ? `scope:${videoB.platform_scope_id}` : `video:${b.video_id}`;
        const folderOrderA = folderOrderById.get(folderA) ?? Number.MAX_SAFE_INTEGER;
        const folderOrderB = folderOrderById.get(folderB) ?? Number.MAX_SAFE_INTEGER;
        if (folderOrderA !== folderOrderB) {
          return folderOrderA - folderOrderB;
        }
        const videoIndexA = videoOrderById.get(a.video_id) ?? Number.MAX_SAFE_INTEGER;
        const videoIndexB = videoOrderById.get(b.video_id) ?? Number.MAX_SAFE_INTEGER;
        if (videoIndexA !== videoIndexB) {
          return videoIndexA - videoIndexB;
        }
        return (clipOrderById.get(a.id) ?? 0) - (clipOrderById.get(b.id) ?? 0);
      });
  }, [clips, clipOrderById, filterStatus, folderOrderById, platformRecordById, searchQuery, videoById, videoOrderById]);
  const groupedFilteredClips = useMemo(() => {
    const groups: Array<{
      id: string;
      title: string;
      scopeId: string;
      video: ProjectState['videos'][number];
      clips: CandidateClip[];
      isDirectClipGroup: boolean;
    }> = [];
    const groupById = new Map<string, (typeof groups)[number]>();

    filteredClips.forEach((clip) => {
      const video = videoById.get(clip.video_id);
      if (!video) return;
      if (video.source_kind === 'direct_clip') {
        const scope = platformScopeById.get(video.platform_scope_id) ?? null;
        const groupId = `scope:${video.platform_scope_id}`;
        let group = groupById.get(groupId);
        if (!group) {
          group = {
            id: groupId,
            title: formatScopeFolderLabel(scope),
            scopeId: video.platform_scope_id,
            video,
            clips: [],
            isDirectClipGroup: true,
          };
          groupById.set(groupId, group);
          groups.push(group);
        }
        group.clips.push(clip);
        return;
      }

      const groupId = `video:${video.id}`;
      let group = groupById.get(groupId);
      if (!group) {
        group = {
          id: groupId,
          title: video.file_name,
          scopeId: video.platform_scope_id,
          video,
          clips: [],
          isDirectClipGroup: false,
        };
        groupById.set(groupId, group);
        groups.push(group);
      }
      group.clips.push(clip);
    });

    return groups
      .map((group) => ({
        ...group,
        clips: [...group.clips],
      }))
      .filter((group) => group.clips.length > 0);
  }, [filteredClips, platformScopeById, videoById]);
  const videoFolders = useMemo(() => {
    const folders: Array<{
      id: string;
      title: string;
      scopeId: string;
      isDirectClipGroup: boolean;
      videos: ProjectState['videos'][number][];
    }> = [];
    const folderById = new Map<string, (typeof folders)[number]>();
    videos.forEach((video) => {
      const folderId = video.source_kind === 'direct_clip'
        ? `scope:${video.platform_scope_id}`
        : `video:${video.id}`;
      let folder = folderById.get(folderId);
      if (!folder) {
        folder = {
          id: folderId,
          title: video.source_kind === 'direct_clip'
            ? formatScopeFolderLabel(platformScopeById.get(video.platform_scope_id) ?? null)
            : video.file_name,
          scopeId: video.platform_scope_id,
          isDirectClipGroup: video.source_kind === 'direct_clip',
          videos: [],
        };
        folderById.set(folderId, folder);
        folders.push(folder);
      }
      folder.videos.push(video);
    });
    return folders;
  }, [platformScopeById, videos]);

  const activeClip = useMemo(
    () => clips.find((clip) => clip.id === activeClipId) ?? null,
    [clips, activeClipId],
  );
  const clipOrdinalById = useMemo(() => {
    const nextMap = new Map<string, number>();
    videoFolders.forEach((folder) => {
      if (folder.isDirectClipGroup) {
        let ordinal = 1;
        folder.videos.forEach((video) => {
          clips
            .filter((clip) => clip.video_id === video.id)
            .sort((a, b) => a.candidate_start - b.candidate_start || a.candidate_end - b.candidate_end)
            .forEach((clip) => {
              nextMap.set(clip.id, ordinal);
              ordinal += 1;
            });
        });
        return;
      }
      const video = folder.videos[0];
      clips
        .filter((clip) => clip.video_id === video.id)
        .sort((a, b) => a.candidate_start - b.candidate_start || a.candidate_end - b.candidate_end)
        .forEach((clip, index) => {
          nextMap.set(clip.id, index + 1);
        });
    });
    return nextMap;
  }, [videoFolders, clips]);
  const activeClipPlatformRecord = useMemo(
    () =>
      activeClip?.linked_platform_record_id
        ? platformRecordById.get(activeClip.linked_platform_record_id) ?? null
        : null,
    [activeClip, platformRecordById],
  );
  const activeClipSegments = useMemo(
    () => (activeClip ? orderedSegments(activeClip) : []),
    [activeClip],
  );
  const activeSegment = useMemo(
    () => activeClipSegments.find((segment) => segment.id === activeSegmentId) ?? activeClipSegments[0] ?? null,
    [activeClipSegments, activeSegmentId],
  );

  // selectedClipIds is already a Set in the zustand store; keep the alias for call-site stability.
  const selectedClipIdSet = selectedClipIds;
  const exportTargetClipIds = useMemo(
    () =>
      clips
        .filter((clip) => selectedClipIdSet.has(clip.id) && isClipExportSelectable(clip.status))
        .map((clip) => clip.id),
    [clips, selectedClipIdSet],
  );
  const exportTargetClips = useMemo(
    () => clips.filter((clip) => exportTargetClipIds.includes(clip.id)),
    [clips, exportTargetClipIds],
  );
  const exportTargetClipsCount = exportTargetClipIds.length;
  const exportTargetBoundCount = useMemo(
    () =>
      clips.filter(
        (clip) =>
          exportTargetClipIds.includes(clip.id) &&
          isClipExportSelectable(clip.status) &&
          Boolean(clip.linked_platform_record_id),
      ).length,
    [clips, exportTargetClipIds],
  );
  const exportTargetLocalBoundCount = useMemo(
    () =>
      clips.filter((clip) => {
        if (!exportTargetClipIds.includes(clip.id)) return false;
        if (!isClipExportSelectable(clip.status)) return false;
        if (!clip.linked_platform_record_id) return false;
        const record = platformRecordById.get(clip.linked_platform_record_id);
        return Boolean(record?.is_local);
      }).length,
    [clips, exportTargetClipIds, platformRecordById],
  );
  const uploadOnlyInvalidClips = useMemo(
    () =>
      exportTargetClips.filter(
        (clip) => {
          const clipVideo = videoById.get(clip.video_id) ?? null;
          const record = clip.linked_platform_record_id
            ? platformRecordById.get(clip.linked_platform_record_id) ?? null
            : null;
          if (record?.is_local) return false;
          return getUploadOnlySourceMode(clip, clipVideo) === 'invalid' || !clip.linked_platform_record_id;
        },
      ),
    [exportTargetClips, videoById, platformRecordById],
  );
  const uploadOnlySourceSummary = useMemo(() => {
    let exportedFileCount = 0;
    let directSourceCount = 0;
    exportTargetClips.forEach((clip) => {
      const clipVideo = videoById.get(clip.video_id) ?? null;
      const mode = getUploadOnlySourceMode(clip, clipVideo);
      if (mode === 'exported_file') exportedFileCount += 1;
      if (mode === 'direct_source') directSourceCount += 1;
    });
    return {
      exportedFileCount,
      directSourceCount,
    };
  }, [exportTargetClips, videoById]);
  const requiresUploadCredentials =
    exportOperation !== 'export_only' && exportTargetBoundCount - exportTargetLocalBoundCount > 0;

  const streamUrl = activeVideo ? getVideoStreamUrl(activeVideo.id) : '';
  const initialClipWindow = useMemo(() => {
    if (!activeClip) return {start: 0, end: CLIP_STEP};
    const baseStart = Math.min(activeClip.candidate_start, activeClip.review_start);
    const baseEnd = Math.max(activeClip.candidate_end, activeClip.review_end, baseStart + CLIP_STEP);
    const EXTEND = 30;
    const videoDuration = activeVideo?.duration ?? baseEnd + EXTEND;
    return {
      start: Math.max(0, baseStart - EXTEND),
      end: Math.min(videoDuration, baseEnd + EXTEND),
    };
  }, [activeClip?.id, activeVideo?.duration]);
  const [clipWindowOverride, setClipWindowOverride] = useState<{start: number; end: number} | null>(null);
  const [clipWindowVersion, setClipWindowVersion] = useState(0);
  useEffect(() => { setClipWindowOverride(null); }, [activeClip?.id]);
  const clipWindowStart = (clipWindowOverride ?? initialClipWindow).start;
  const clipWindowEnd = (clipWindowOverride ?? initialClipWindow).end;
  const clipWindowDuration = Math.max(CLIP_STEP, clipWindowEnd - clipWindowStart);
  // A4-3: trim* / playhead-local-to-window calculations live inside
  // TimelineSurface. The in-player overlay's playhead percent/clock now
  // live inside ReviewPanel (PR4) — App no longer computes any
  // playhead-derived value, which is what lets it drop the currentTimeMs
  // subscription above.
  const activeJobs = useMemo(
    () => jobs.filter((job) => job.status === 'queued' || job.status === 'running'),
    [jobs],
  );
  const detectJobsByVideoId = useMemo(
    () =>
      new Map(
        activeJobs
          .filter((job) => job.kind === 'detect' && typeof job.video_id === 'string')
          .map((job) => [job.video_id as string, job]),
      ),
    [activeJobs],
  );
  const activeDetectJob = useMemo(
    () => (activeVideoId ? detectJobsByVideoId.get(activeVideoId) ?? null : null),
    [detectJobsByVideoId, activeVideoId],
  );
  const activeExportJob = useMemo(
    () => activeJobs.find((job) => job.kind === 'export') ?? null,
    [activeJobs],
  );
  const lockedExportClipIds = useMemo(
    () => getJobTargetClipIds(activeExportJob),
    [activeExportJob],
  );
  const lockedExportClipIdSet = useMemo(
    () => new Set(lockedExportClipIds),
    [lockedExportClipIds],
  );
  const activeClipDisplayName = useMemo(
    () => (
      activeClip
        ? getClipDisplayName(activeClip, activeClipPlatformRecord, videoById.get(activeClip.video_id) ?? null)
        : '未识别运动员'
    ),
    [activeClip, activeClipPlatformRecord, videoById],
  );
  const activeClipDisplayCountry = useMemo(
    () => (activeClip ? getClipDisplayCountry(activeClip, activeClipPlatformRecord) : '--'),
    [activeClip, activeClipPlatformRecord],
  );
  const activeClipPipelineBadges = useMemo(
    () => (
      activeClip
        ? getClipPipelineBadges(activeClip, {
          linkedRecord: activeClipPlatformRecord,
          activeExportJob,
          lockedExportClipIdSet,
        })
        : []
    ),
    [activeClip, activeClipPlatformRecord, activeExportJob, lockedExportClipIdSet],
  );
  const activeClipLockedByExport = useMemo(
    () => (activeClip ? lockedExportClipIdSet.has(activeClip.id) : false),
    [activeClip, lockedExportClipIdSet],
  );

  function isClipLockedByExport(clipId: string | null | undefined): boolean {
    return Boolean(clipId && lockedExportClipIdSet.has(clipId));
  }

  function guardClipMutation(
    clipId: string | null | undefined,
    message: string = EXPORT_LOCKED_CLIP_MESSAGE,
  ): boolean {
    if (!isClipLockedByExport(clipId)) return false;
    setErrorMessage(message);
    return true;
  }

  function guardRestoreClipStructure(): boolean {
    if (!activeExportJob) return false;
    setErrorMessage(EXPORT_LOCKED_RESTORE_MESSAGE);
    return true;
  }

  // selectedVideoIds is already a Set in the zustand store; keep the alias for call-site stability.
  const selectedVideoIdSet = selectedVideoIds;
  const selectedVideos = useMemo(
    () => videos.filter((video) => selectedVideoIdSet.has(video.id)),
    [videos, selectedVideoIdSet],
  );
  const selectedStartableVideos = useMemo(
    () =>
      selectedVideos.filter((video) => video.status === 'queued' && !detectJobsByVideoId.has(video.id)),
    [selectedVideos, detectJobsByVideoId],
  );
  const selectedCancellableVideos = useMemo(
    () =>
      selectedVideos.filter((video) => {
        const detectJob = detectJobsByVideoId.get(video.id);
        return Boolean(
          detectJob && String(detectJob.progress.stage || '') !== 'cancel_requested',
        );
      }),
    [selectedVideos, detectJobsByVideoId],
  );
  const selectedDeletableVideos = useMemo(
    () =>
      selectedVideos.filter((video) => {
        const detectJob = detectJobsByVideoId.get(video.id);
        return !(
          video.status === 'detecting' ||
          (detectJob && detectJob.status === 'running')
        );
      }),
    [selectedVideos, detectJobsByVideoId],
  );
  const activeDetectCancelRequested = activeDetectJob
    ? String(activeDetectJob.progress.stage || '') === 'cancel_requested'
    : false;
  const shouldUseSelectedVideosForDetect = selectedVideoIds.size > 0;
  const startDetectCount = shouldUseSelectedVideosForDetect ? selectedStartableVideos.length : 0;
  const hasAnyFullVideo = videos.some((video) => video.source_kind === 'full_video');
  const shouldShowDetectControls = Boolean(activeDetectJob) || hasAnyFullVideo;
  const activePlatformScopeId = activeVideo?.platform_scope_id ?? null;
  const activePlatformScope = useMemo(
    () => (activePlatformScopeId ? platformScopeById.get(activePlatformScopeId) ?? null : null),
    [activePlatformScopeId, platformScopeById],
  );
  const videoScopedPlatformRecords = useMemo(() => {
    if (!activePlatformScopeId) return [] as PlatformRecord[];
    return platformRecords.filter((entry) => entry.platform_scope_id === activePlatformScopeId);
  }, [activePlatformScopeId, platformRecords]);
  const filteredPlatformRecords = useMemo(() => {
    const query = scoreSearchQuery.trim().toLowerCase();
    return videoScopedPlatformRecords.filter((entry) => {
      if (entry.is_local) return false;
      const entryVideo = videoById.get(entry.video_id) ?? null;
      const resolvedSex = getResolvedPlatformRecordSex(entry, entryVideo);
      const matchesQuery =
        !query ||
        entry.english_name.toLowerCase().includes(query) ||
        entry.user_name.toLowerCase().includes(query) ||
        entry.country.toLowerCase().includes(query);
      const matchesApparatus =
        scoreApparatusFilter === 'all' || String(entry.sport_item_id ?? '') === scoreApparatusFilter;
      const matchesSex = scoreSexFilter === 'all' || String(resolvedSex ?? '') === scoreSexFilter;
      const matchesCountry =
        scoreCountryFilter === 'all' || entry.country === scoreCountryFilter;
      return matchesQuery && matchesApparatus && matchesSex && matchesCountry;
    });
  }, [videoScopedPlatformRecords, scoreSearchQuery, scoreApparatusFilter, scoreSexFilter, scoreCountryFilter, videoById]);
  const localCardApi = useLocalCard({
    activeVideoId,
    videoScopedPlatformRecords,
    platformRecords,
    scoreSearchQuery,
    scoreApparatusFilter,
    onProjectUpdate: setProject,
    setErrorMessage,
    setSuccessMessage,
    syncScoreApparatusFilter: (sportItemId) => {
      if (scoreApparatusFilter !== 'all' && scoreApparatusFilter !== String(sportItemId)) {
        setScoreApparatusFilter(String(sportItemId));
      }
    },
  });
  const {localPlatformRecords} = localCardApi;
  const groupedPlatformRecords = useMemo(() => {
    const groups: Array<{
      matchName: string;
      venues: Array<{venue: string; records: PlatformRecord[]}>;
    }> = [];
    const matchGroups = new Map<string, Map<string, PlatformRecord[]>>();
    filteredPlatformRecords.forEach((record) => {
      const matchName = record.match_name || '未命名比赛';
      const venue = record.venue || '未命名场次';
      if (!matchGroups.has(matchName)) {
        matchGroups.set(matchName, new Map());
      }
      const venueMap = matchGroups.get(matchName)!;
      const venueRecords = venueMap.get(venue) ?? [];
      venueRecords.push(record);
      venueMap.set(venue, venueRecords);
    });
    matchGroups.forEach((venueMap, matchName) => {
      groups.push({
        matchName,
        venues: Array.from(venueMap.entries()).map(([venue, records]) => ({
          venue,
          records,
        })),
      });
    });
    return groups;
  }, [filteredPlatformRecords]);
  const activeScopeSummary = useMemo(() => {
    if (!activePlatformScope) {
      return {
        matchText: activeVideo?.match_name || '未选择赛事',
        venueText: (activeVideo?.venues?.length ? activeVideo.venues.join(' / ') : activeVideo?.venue) || '未选择场次',
      };
    }
    const matchNames = Array.from(
      new Set(activePlatformScope.query_groups.map((query) => query.match_name).filter((value) => value.trim().length > 0)),
    );
    const venues = Array.from(
      new Set(activePlatformScope.query_groups.flatMap((query) => query.venues).filter((value) => value.trim().length > 0)),
    );
    return {
      matchText: matchNames.length > 0 ? matchNames.join(' / ') : activeVideo?.match_name || '未选择赛事',
      venueText: venues.length > 0 ? venues.join(' / ') : (activeVideo?.venues?.length ? activeVideo.venues.join(' / ') : activeVideo?.venue) || '未选择场次',
    };
  }, [activePlatformScope, activeVideo]);
  const scoreApparatusOptions = useMemo(
    () =>
      Array.from<number>(
        new Set(videoScopedPlatformRecords.map((entry) => entry.sport_item_id).filter((value): value is number => value != null)),
      ).map((sportItemId) => ({
        value: String(sportItemId),
        label: SPORT_ITEM_LABELS[sportItemId] ?? formatSportItemLabel(sportItemId),
      })),
    [videoScopedPlatformRecords],
  );
  const scoreSexOptions = useMemo(
    () =>
      Array.from<number>(
        new Set(
          videoScopedPlatformRecords
            .map((entry) => getResolvedPlatformRecordSex(entry, videoById.get(entry.video_id) ?? null))
            .filter((value): value is number => value != null),
        ),
      ).map((sex) => ({
        value: String(sex),
        label: SEX_LABELS[sex] ?? `性别 ${sex}`,
      })),
    [videoScopedPlatformRecords, videoById],
  );
  const scoreCountryOptions = useMemo(
    () =>
      Array.from(new Set(videoScopedPlatformRecords.map((entry) => entry.country).filter((value) => value.trim().length > 0)))
        .sort()
        .map((country) => ({
          value: country,
          label: country,
        })),
    [videoScopedPlatformRecords],
  );

  async function refreshProject(options?: {silent?: boolean}) {
    // Silent polls coalesce: if a fetch is already outstanding, skip this tick
    // rather than stacking another round-trip on a slow backend.
    if (options?.silent && projectPollInFlightRef.current) return;
    if (!options?.silent) {
      setIsLoading(true);
    }
    if (options?.silent) projectPollInFlightRef.current = true;
    // Snapshot the write-seq before awaiting. If any project write (poll or
    // a user-initiated PATCH via setProjectState) lands while we're in flight,
    // this captured value will be stale and we discard our response.
    const seqAtStart = projectWriteSeqRef.current;
    try {
      const nextProject = await fetchProject();
      // Drop the response if a fresher write happened during the await — a
      // slow silent poll must never clobber a fresh PATCH. (Non-silent loads
      // are explicit user intent and always apply.)
      if (options?.silent && projectWriteSeqRef.current !== seqAtStart) {
        return;
      }
      // Content short-circuit: only commit when the project actually changed.
      // project.updated_at is bumped by every backend mutation (state.touch(),
      // including the detection/export checkpoints that flip video.status and
      // video.detection_progress), so an unchanged timestamp means an
      // unchanged tree — skipping setProject here avoids a needless full-App
      // re-render + useMemo storm on each idle poll tick.
      if (options?.silent && lastProjectSignatureRef.current === nextProject.updated_at) {
        setErrorMessage(null);
        return;
      }
      lastProjectSignatureRef.current = nextProject.updated_at;
      // Bump the write-seq so a concurrently-awaiting poll discards itself.
      projectWriteSeqRef.current += 1;
      setProject(nextProject);
      setErrorMessage(null);
    } catch (error) {
      if (!options?.silent) {
        setErrorMessage(error instanceof Error ? error.message : '无法读取项目状态');
      }
    } finally {
      if (options?.silent) projectPollInFlightRef.current = false;
      if (!options?.silent) {
        setIsLoading(false);
      }
    }
  }

  async function refreshJobs(options?: {silent?: boolean}) {
    if (options?.silent && jobsPollInFlightRef.current) return;
    if (options?.silent) jobsPollInFlightRef.current = true;
    try {
      const response = await fetchJobs();
      // Content short-circuit: jobs are the authoritative backend list, so we
      // always replace from a successful fetch — but only if the meaningful
      // content (per-job id/status/progress) changed. Live detection/export
      // progress lives in job.progress (the per-frame ticks flow through the
      // jobs resource, NOT project.updated_at), so progress MUST be part of
      // the signature or real progress updates would be swallowed.
      const signature = jobsSignature(response.jobs);
      if (options?.silent && lastJobsSignatureRef.current === signature) {
        return;
      }
      lastJobsSignatureRef.current = signature;
      setJobs(response.jobs);
    } catch (error) {
      if (!options?.silent) {
        setErrorMessage(error instanceof Error ? error.message : '无法读取任务状态');
      }
    } finally {
      if (options?.silent) jobsPollInFlightRef.current = false;
    }
  }

  async function refreshWorkspace(options?: {silent?: boolean}) {
    await Promise.all([
      refreshProject(options),
      refreshJobs(options),
    ]);
  }

  useEffect(() => {
    void refreshWorkspace();
  }, []);

  // Load API key (and prime secure-storage gate); other export-related load is in useExportJobs
  useEffect(() => {
    if (!desktopBridge?.isDesktop) {
      apiKeyPersistenceReadyRef.current = true;
      return;
    }

    let cancelled = false;
    void desktopBridge
      .loadApiKey()
      .then((response) => {
        if (cancelled) return;
        setSupportsSecureStorage(response.supported);
        if (response.apiKey) {
          setApiKey(response.apiKey);
          setRememberApiKey(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setSupportsSecureStorage(false);
      })
      .finally(() => {
        if (!cancelled) {
          apiKeyPersistenceReadyRef.current = true;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [desktopBridge]);

  // Debounce-persist API key
  useEffect(() => {
    if (!desktopBridge?.isDesktop) return;
    if (!apiKeyPersistenceReadyRef.current) return;
    if (!supportsSecureStorage) return;

    const timer = window.setTimeout(async () => {
      setIsPersistingApiKey(true);
      try {
        if (rememberApiKey && apiKey.trim()) {
          await desktopBridge.saveApiKey(apiKey.trim());
        } else {
          await desktopBridge.clearApiKey();
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '保存 API Key 失败');
      } finally {
        setIsPersistingApiKey(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [desktopBridge, supportsSecureStorage, rememberApiKey, apiKey]);

  useEffect(() => {
    if (!successMessage) return;
    enqueueToast('success', successMessage);
    setSuccessMessage(null);
    setErrorMessage(null);
  }, [successMessage]);

  useEffect(() => {
    if (!errorMessage) return;
    enqueueToast('error', errorMessage);
    setErrorMessage(null);
    setSuccessMessage(null);
  }, [errorMessage]);

  useEffect(() => {
    if (!toast) {
      setIsToastVisible(false);
      return;
    }

    setIsToastVisible(false);
    const showFrame = window.requestAnimationFrame(() => {
      setIsToastVisible(true);
    });
    const displayDuration = toast.kind === 'error' ? 6000 : 3500;
    const hideTimer = window.setTimeout(() => {
      setIsToastVisible(false);
    }, displayDuration);
    const clearTimer = window.setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, displayDuration + 180);

    return () => {
      window.cancelAnimationFrame(showFrame);
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
    };
  }, [toast]);

  useEffect(() => {
    if (!videoContextMenu) return;
    const close = () => setVideoContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [videoContextMenu]);

  useEffect(() => {
    if (activeJobs.length === 0 && !videos.some((video) => video.status === 'detecting')) return;
    const hasActiveExportJob = activeJobs.some((job) => job.kind === 'export');
    const timer = window.setInterval(() => {
      void refreshWorkspace({silent: true});
    }, hasActiveExportJob ? 250 : 1000);
    return () => window.clearInterval(timer);
  }, [activeJobs, videos]);

  useEffect(() => {
    if (!videos.length) {
      setActiveVideoId(null);
      return;
    }
    if (!activeVideoId || !videos.some((video) => video.id === activeVideoId)) {
      setActiveVideoId(videos[0].id);
    }
  }, [videos, activeVideoId]);

  useEffect(() => {
    const validVideoIds = new Set(videos.map((video) => video.id));
    const current = useStore.getState().selectedVideoIds;
    const next = new Set<string>();
    current.forEach((videoId) => {
      if (validVideoIds.has(videoId)) next.add(videoId);
    });
    if (next.size !== current.size) {
      useStore.getState().setSelectedVideoIds(next);
    }
  }, [videos]);

  useEffect(() => {
    const validClipIds = new Set(
      clips
        .filter((clip) => isClipExportSelectable(clip.status))
        .map((clip) => clip.id),
    );
    const current = useStore.getState().selectedClipIds;
    const next = new Set<string>();
    current.forEach((clipId) => {
      if (validClipIds.has(clipId)) next.add(clipId);
    });
    if (next.size !== current.size) {
      useStore.getState().setSelectedClipIds(next);
    }
  }, [clips]);

  useEffect(() => {
    if (!filteredClips.length) {
      setActiveClipId(null);
      return;
    }
    if (!activeClipId || !filteredClips.some((clip) => clip.id === activeClipId)) {
      setActiveClipId(filteredClips[0].id);
    }
  }, [filteredClips, videoClips, activeClipId]);

  useEffect(() => {
    if (!activeClip) return;
    if (activeClip.video_id !== activeVideoId) {
      setActiveVideoId(activeClip.video_id);
    }
  }, [activeClip, activeVideoId]);

  useEffect(() => {
    const validGroupIds = new Set(groupedFilteredClips.map((group) => group.id));
    setCollapsedClipGroupIds((current) => current.filter((groupId) => validGroupIds.has(groupId)));
  }, [groupedFilteredClips]);

  useEffect(() => {
    if (!activeClipId) return;
    const activeClipValue = clips.find((clip) => clip.id === activeClipId);
    if (!activeClipValue) return;
    const clipVideo = videoById.get(activeClipValue.video_id);
    const activeGroupId =
      clipVideo?.source_kind === 'direct_clip'
        ? `scope:${clipVideo.platform_scope_id}`
        : `video:${activeClipValue.video_id}`;
    setCollapsedClipGroupIds((current) => current.filter((groupId) => groupId !== activeGroupId));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClipId]);

  useEffect(() => {
    const validFolderIds = new Set(videoFolders.map((folder) => folder.id));
    setCollapsedVideoFolderIds((current) => current.filter((folderId) => validFolderIds.has(folderId)));
  }, [videoFolders]);

  useEffect(() => {
    if (!activeClip) return;
    setIsVideoSidebarCollapsed(true);
  }, [activeClip?.id]);

  useEffect(() => {
    setScoreSearchQuery('');
    setScoreApparatusFilter('all');
    setScoreSexFilter('all');
    setScoreCountryFilter('all');
    setOpenScoreFilter(null);
  }, [activePlatformScopeId]);

  useEffect(() => {
    if (!openScoreFilter) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-score-filter-root]')) {
        return;
      }
      setOpenScoreFilter(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenScoreFilter(null);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openScoreFilter]);

  useEffect(() => {
    if (!activeClip) {
      setTrimStart(0);
      setTrimEnd(0);
      trimStartRef.current = 0;
      trimEndRef.current = 0;
      setActiveSegmentId(null);
      enqueueSeekStore(0);
      return;
    }
    const nextSegment = firstEditableSegment(activeClip);
    skipTrimSyncRef.current = true;
    setActiveSegmentId(nextSegment?.id ?? null);
    const rawStart = nextSegment?.start ?? activeClip.review_start;
    const rawEnd = nextSegment?.end ?? activeClip.review_end;
    const videoDuration = activeVideo?.duration ?? null;
    const s = Math.max(0, videoDuration != null ? Math.min(rawStart, videoDuration) : rawStart);
    const e = Math.max(s, videoDuration != null ? Math.min(rawEnd, videoDuration) : rawEnd);
    setTrimStart(s);
    setTrimEnd(e);
    trimStartRef.current = s;
    trimEndRef.current = e;
    // Park playhead at the segment start. PlayerSurface translates this
    // into a video.currentTime write once metadata is ready.
    enqueueSeekStore(s * 1000);
    setIsPlayingStore(false);
  }, [activeClip?.id, activeVideo?.duration]);

  useEffect(() => {
    if (!activeClip) return;
    if (activeClipSegments.length === 0) {
      setActiveSegmentId(null);
      return;
    }
    if (!activeSegmentId || !activeClipSegments.some((segment) => segment.id === activeSegmentId)) {
      setActiveSegmentId(activeClipSegments[0].id);
    }
  }, [activeClip?.id, activeClipSegments, activeSegmentId]);

  useEffect(() => {
    if (!activeClip || !activeSegment) return;
    skipTrimSyncRef.current = true;
    const videoDuration = activeVideo?.duration ?? null;
    const clampedStart = Math.max(
      0,
      videoDuration != null ? Math.min(activeSegment.start, videoDuration) : activeSegment.start,
    );
    const clampedEnd = Math.max(
      clampedStart,
      videoDuration != null ? Math.min(activeSegment.end, videoDuration) : activeSegment.end,
    );
    setTrimStart(clampedStart);
    setTrimEnd(clampedEnd);
    trimStartRef.current = clampedStart;
    trimEndRef.current = clampedEnd;
    // Clamp playhead into the new segment if it currently sits outside.
    // Read the live snapshot from the store (not the render-time `playhead`
    // closure) so we don't queue a seek to a stale position when this
    // effect runs again before the publish channel catches up.
    const currentMs = useStore.getState().currentTimeMs;
    const currentS = currentMs / 1000;
    const clampedS = Math.min(Math.max(currentS, clampedStart), clampedEnd);
    if (clampedS !== currentS) {
      enqueueSeekStore(clampedS * 1000);
    }
  }, [activeClip?.id, activeSegment?.id, activeSegment?.start, activeSegment?.end]);

  useEffect(() => {
    setVideoPlaybackError(null);
  }, [streamUrl, activeVideoId]);

  // A4-3: thumbnail fetch + suppression effect moved into TimelineSurface.

  useEffect(() => {
    return () => {
      if (trimAutoSaveTimerRef.current != null) {
        window.clearTimeout(trimAutoSaveTimerRef.current);
      }
      if (trimSavedIndicatorTimerRef.current != null) {
        window.clearTimeout(trimSavedIndicatorTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isScrubbing) return;
    const handlePointerRelease = () => endScrub();
    window.addEventListener('mouseup', handlePointerRelease);
    window.addEventListener('touchend', handlePointerRelease);
    return () => {
      window.removeEventListener('mouseup', handlePointerRelease);
      window.removeEventListener('touchend', handlePointerRelease);
    };
  }, [isScrubbing]);

  useEffect(() => {
    if (!activeClip || !activeSegment) return;
    if (isScrubbing) return;
    if (activeClipLockedByExport) {
      clearPendingTrimAutoSave();
      return;
    }
    if (skipTrimSyncRef.current) {
      skipTrimSyncRef.current = false;
      return;
    }
    if (Math.abs(trimStart - activeSegment.start) < 0.01 && Math.abs(trimEnd - activeSegment.end) < 0.01) {
      return;
    }
    clearPendingTrimAutoSave();
    trimAutoSaveTimerRef.current = window.setTimeout(() => {
      trimAutoSaveTimerRef.current = null;
      void flushActiveSegmentEdits().catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : '保存裁剪范围失败');
      });
    }, 800);
    return () => clearPendingTrimAutoSave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimStart, trimEnd, activeSegment?.id, activeSegment?.start, activeSegment?.end, isScrubbing, activeClipLockedByExport]);

  // A4-2: <video> element listeners (timeupdate / loadedmetadata / play /
  // pause) now live in PlayerSurface. The auto-pause-at-trim-end behavior
  // formerly inlined in the timeupdate handler is reimplemented here as a
  // store subscriber so it survives the renderer extraction.
  //
  // PR4 (render-storm): previously this effect listed `playhead` (a
  // currentTimeMs-derived value) in its deps, which forced App to subscribe
  // to currentTimeMs and re-render the whole tree ~30Hz. We now subscribe to
  // the store *imperatively* — the listener fires on every store commit but
  // only acts when currentTimeMs actually advanced past trimEnd, and it never
  // triggers a React re-render of App. The effect re-subscribes only when
  // activeClip / isPlaying / trimEnd change (all low-frequency), so the
  // `trimEnd` captured in the closure is always the live value (no ref
  // staleness). Behavior is identical to the old version: we pause exactly
  // when the published currentTime crosses trimEnd, within one publish tick.
  useEffect(() => {
    if (!activeClip || !isPlaying) return;
    // Edge case: we may already be at/past trimEnd at subscribe time (e.g.
    // user hit Space with the playhead parked on the end boundary and the
    // toggle's "rewind to trimStart" guard didn't fire). Catch it eagerly so
    // we don't depend on a future timeupdate that might never come.
    if (useStore.getState().currentTimeMs / 1000 >= trimEnd) {
      setIsPlayingStore(false);
      return;
    }
    const unsubscribe = useStore.subscribe((state, prev) => {
      // Only react to playhead advances; ignore unrelated store commits.
      if (state.currentTimeMs === prev.currentTimeMs) return;
      if (state.currentTimeMs / 1000 >= trimEnd) {
        setIsPlayingStore(false);
      }
    });
    return unsubscribe;
  }, [activeClip, isPlaying, trimEnd, setIsPlayingStore]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!activeClip || !activeVideo) return;
      if (showExport) return;
      if (showImportModal) return;
      // Right-click menu's own effect only handles Escape and doesn't
      // stopPropagation, so global hotkeys would otherwise pass through it.
      if (videoContextMenu) return;
      const activeElement = document.activeElement;
      const isUndoShortcut = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
      if (
        (activeElement instanceof HTMLInputElement && activeElement.type !== 'range') ||
        activeElement instanceof HTMLSelectElement ||
        activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (isUndoShortcut) {
        event.preventDefault();
        if (activeExportJob) {
          setErrorMessage(EXPORT_LOCKED_RESTORE_MESSAGE);
          return;
        }
        void handleUndoClipStructure();
        return;
      }

      // Frame-step: Shift+←/→ nudges the playhead by a single frame. Handled
      // before the plain-arrow block below so the Shift variant wins over the
      // ±1s seek bound to bare ArrowLeft/ArrowRight.
      if (event.shiftKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
        event.preventDefault();
        seekRelative(event.code === 'ArrowLeft' ? -FRAME_DURATION : FRAME_DURATION);
        return;
      }

      // The keys below (/, [, ], 1-9) must not hijack OS/app chords like
      // Cmd+[ (back) or Cmd+1 (tab switch). Skip them when a command/control/
      // alt modifier is held; plain presses fall through to their handlers.
      const hasCommandModifier = event.metaKey || event.ctrlKey || event.altKey;

      // Focus the score-search box for fuzzy lookup (剪辑软件 "/" 习惯). After
      // focus the input's own typing is protected by the activeElement early
      // return at the top of this handler, so subsequent keystrokes type
      // normally instead of triggering shortcuts.
      if (event.key === '/' && !hasCommandModifier && !event.shiftKey) {
        event.preventDefault();
        const searchInput = document.getElementById('score-search-input');
        if (searchInput instanceof HTMLInputElement) {
          searchInput.focus();
          searchInput.select();
        }
        return;
      }

      // Playback speed ladder: [ slower, ] faster (no wrap, clamped at ends).
      if ((event.key === '[' || event.key === ']') && !hasCommandModifier) {
        event.preventDefault();
        stepPlaybackRate(event.key === '[' ? -1 : 1);
        return;
      }

      // Number keys 1-9 bind the Nth currently-visible AND bindable platform
      // score card to the active clip. The list is filteredPlatformRecords
      // (search/filter-applied order = what the user sees), minus cards already
      // bound to a *different* clip — those are skipped and don't occupy a
      // number, mirroring the card button's `disabled` rule and the panel's
      // hotkey badge. This is what makes vault same-name pairs selectable as
      // 1/2 after a name search.
      if (/^[1-9]$/.test(event.key) && !hasCommandModifier && !event.shiftKey) {
        event.preventDefault();
        if (activeClipLockedByExport) {
          setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
          return;
        }
        const bindableRecords = filteredPlatformRecords.filter(
          (record) =>
            record.linked_clip_ids.length === 0 || record.linked_clip_ids.includes(activeClip.id),
        );
        const index = Number(event.key) - 1;
        const target = bindableRecords[index];
        if (!target) {
          // Fewer than N bindable cards visible — ignore silently.
          return;
        }
        // Toggle: pressing the number of the already-bound card unbinds it,
        // matching the click behaviour on the card itself.
        const alreadyBound = activeClip.linked_platform_record_id === target.id;
        void handleBindScoreCard(alreadyBound ? null : target.id);
        return;
      }

      if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code) || event.key.toLowerCase() === 'enter') {
        event.preventDefault();
        if (event.key.toLowerCase() === 'enter') {
          event.stopPropagation();
        }
      }

      switch (event.key.toLowerCase()) {
        case ' ':
          togglePlayPause();
          break;
        case 'enter':
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          if (activeElement instanceof HTMLButtonElement) {
            activeElement.blur();
          }
          void handleStatusChange(activeClip.id, 'kept');
          break;
        case 'delete':
        case 'backspace':
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          void handleStatusChange(activeClip.id, 'deleted');
          break;
        case 'arrowleft':
          seekRelative(-1);
          break;
        case 'arrowright':
          seekRelative(1);
          break;
        case 'arrowup':
          selectClipByOffset(-1);
          break;
        case 'arrowdown':
          selectClipByOffset(1);
          break;
        case 'a':
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          updateTrimRange(trimStart - CLIP_STEP, trimEnd, 'start');
          break;
        case 'd':
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          updateTrimRange(trimStart + CLIP_STEP, trimEnd, 'start');
          break;
        case 'j':
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          updateTrimRange(trimStart, trimEnd - CLIP_STEP, 'end');
          break;
        case 'l':
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          updateTrimRange(trimStart, trimEnd + CLIP_STEP, 'end');
          break;
        case 'i': {
          // In point: set selection START to the current playhead (剪辑 In).
          // updateTrimRange clamps start to end - CLIP_STEP, so an in-point at
          // or past the end is absorbed instead of producing an invalid window.
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          const playheadS = useStore.getState().currentTimeMs / 1000;
          updateTrimRange(playheadS, trimEnd, 'start');
          break;
        }
        case 'o': {
          // Out point: set selection END to the current playhead (剪辑 Out).
          // updateTrimRange clamps end to start + CLIP_STEP, absorbing an
          // out-point at or before the start.
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          const playheadS = useStore.getState().currentTimeMs / 1000;
          updateTrimRange(trimStart, playheadS, 'end');
          break;
        }
        case 'b':
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          void handleSplitActiveClip();
          break;
        case 'c':
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          void handleDeleteActiveSegment();
          break;
        case 'n':
          if (activeClipLockedByExport) {
            setErrorMessage(EXPORT_LOCKED_CLIP_MESSAGE);
            break;
          }
          void handleExtractActiveSegment();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeClip, activeVideo, showExport, showImportModal, videoContextMenu, trimStart, trimEnd, activeSegment, project, activeClipId, activeSegmentId, activeClipLockedByExport, activeExportJob, filteredPlatformRecords]);

  function setProjectState(nextProject: ProjectState) {
    // PR4: every direct (user-initiated PATCH) write bumps the same write-seq
    // the silent poll snapshots, so a slow poll that resolves *after* this
    // write will see a changed seq and discard its now-stale response instead
    // of clobbering it. We also refresh the project signature to this write's
    // updated_at: this keeps the poll's content short-circuit honest — a later
    // poll carrying an OLDER updated_at (already superseded) is skipped, while
    // any genuinely newer backend change still has a different timestamp and
    // gets applied.
    projectWriteSeqRef.current += 1;
    lastProjectSignatureRef.current = nextProject.updated_at;
    setProject(nextProject);
  }

  function createClipUndoSnapshot(): ClipUndoSnapshot | null {
    if (!project) return null;
    return {
      candidateClips: cloneCandidateClips(project.candidate_clips),
      activeClipId,
      activeSegmentId,
    };
  }

  function pushClipUndoSnapshot(): ClipUndoSnapshot | null {
    const snapshot = createClipUndoSnapshot();
    if (!snapshot) return null;
    clipUndoStackRef.current.push(snapshot);
    if (clipUndoStackRef.current.length > 50) {
      clipUndoStackRef.current.shift();
    }
    return snapshot;
  }

  function discardClipUndoSnapshot(snapshot: ClipUndoSnapshot | null) {
    if (!snapshot) return;
    if (clipUndoStackRef.current[clipUndoStackRef.current.length - 1] === snapshot) {
      clipUndoStackRef.current.pop();
    }
  }

  function clearPendingTrimAutoSave() {
    if (trimAutoSaveTimerRef.current != null) {
      window.clearTimeout(trimAutoSaveTimerRef.current);
      trimAutoSaveTimerRef.current = null;
    }
  }

  function showTrimSavedIndicator() {
    setTrimJustSaved(true);
    if (trimSavedIndicatorTimerRef.current != null) {
      window.clearTimeout(trimSavedIndicatorTimerRef.current);
    }
    trimSavedIndicatorTimerRef.current = window.setTimeout(() => {
      trimSavedIndicatorTimerRef.current = null;
      setTrimJustSaved(false);
    }, 1000);
  }

  async function handleUndoClipStructure() {
    if (guardRestoreClipStructure()) return;
    const snapshot = clipUndoStackRef.current.pop();
    if (!snapshot) {
      setErrorMessage('没有可撤销的结构编辑');
      return;
    }
    // Undo restores a different clip structure (a switch-away). Flush any
    // pending trim edit through the same serializer first, so an in-flight
    // 800ms debounce isn't dropped by the upcoming activeClip change. Bail only
    // on re-entrancy; a flush failure still lets undo proceed (must-fix 2), and
    // we keep its "unsaved trim" notice visible instead of wiping it (R3 #2).
    const {proceed, flushFailed} = await flushTrimBeforeSwitch();
    if (!proceed) return; // re-entrant: guard owned elsewhere, don't release

    try {
      const response = await restoreCandidateClips(snapshot.candidateClips);
      setProjectState(response.project);
      setActiveClipId(snapshot.activeClipId);
      setActiveSegmentId(snapshot.activeSegmentId);
      const restoredClip = snapshot.activeClipId
        ? response.project.candidate_clips.find((clip) => clip.id === snapshot.activeClipId) ?? null
        : null;
      setActiveVideoId(restoredClip?.video_id ?? activeVideoId);
      // Toast is single-slot and the success effect itself clears errorMessage,
      // so when the trim flush failed we surface the "unsaved trim" notice and
      // skip the success toast (the dropped edit is the more important signal —
      // R3 #2). Otherwise show the normal undo-success toast.
      if (flushFailed) {
        setErrorMessage('裁剪范围未保存（保存失败），已撤销结构编辑');
      } else {
        setErrorMessage(null);
        setSuccessMessage('已撤销上一步结构编辑');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '撤销失败');
    } finally {
      releaseSwitchGuard();
    }
  }

  function markVideosQueued(videoIds: string[]) {
    if (videoIds.length === 0) return;
    const videoIdSet = new Set(videoIds);
    patchProject((current) => {
      if (!current) return undefined;
      return {
        ...current,
        videos: current.videos.map((video) =>
          videoIdSet.has(video.id)
            ? {
                ...video,
                status: 'queued',
                detection_progress: {
                  ...video.detection_progress,
                  stage: 'queued',
                  message: '等待检测任务开始',
                  completed: 0,
                  total: 0,
                },
              }
            : video,
        ),
      };
    });
  }

  function toggleVideoSelection(videoId: string) {
    useStore.getState().toggleSelectedVideoId(videoId);
  }

  function toggleClipSelection(clipId: string) {
    useStore.getState().toggleSelectedClipId(clipId);
  }

  function setClipSelectionBatch(clipIds: string[], shouldSelect: boolean) {
    if (clipIds.length === 0) return;
    const current = useStore.getState().selectedClipIds;
    const next = new Set(current);
    clipIds.forEach((clipId) => {
      if (shouldSelect) {
        next.add(clipId);
      } else {
        next.delete(clipId);
      }
    });
    useStore.getState().setSelectedClipIds(next);
  }

  function getClipGroupSelectionState(clipIds: string[]): 'checked' | 'indeterminate' | 'unchecked' {
    if (clipIds.length === 0) return 'unchecked';
    const selectedCount = clipIds.filter((clipId) => selectedClipIdSet.has(clipId)).length;
    if (selectedCount === 0) return 'unchecked';
    if (selectedCount === clipIds.length) return 'checked';
    return 'indeterminate';
  }

  function toggleSelectAllClipsInGroup(clipIds: string[]) {
    if (clipIds.length === 0) return;
    const selectionState = getClipGroupSelectionState(clipIds);
    setClipSelectionBatch(clipIds, selectionState !== 'checked');
  }

  /**
   * Gate every "switch the active clip" entry point (Enter/Delete mark, ↑/↓
   * step, click another card, undo) through this serializer.
   *
   * Acquires the switch guard and flushes any pending trim edit. The caller
   * decides what to do from `proceed`:
   *   - `proceed === false` → a switch is already in flight; this call did NOT
   *     acquire the guard. The caller MUST abort its switch and MUST NOT release
   *     the guard (it belongs to the other in-flight switch). (must-fix 1)
   *   - `proceed === true` → this call acquired the guard. The caller MUST run
   *     its switch and then release the guard via `releaseSwitchGuard()` in a
   *     `finally`, so the guard stays held until `setActiveClipId` is committed
   *     — covering the whole critical section, not just the flush (R3 #1).
   *
   * Switching is prioritized over trim saving (must-fix 2): if the flush throws
   * we DON'T block the switch — we post a non-blocking notice and return
   * `proceed: true` with `flushFailed: true`. The caller keeps that notice
   * visible (must not let a later `setErrorMessage(null)` wipe it — R3 #2).
   */
  async function flushTrimBeforeSwitch(): Promise<{proceed: boolean; flushFailed: boolean}> {
    if (isSwitchingRef.current) return {proceed: false, flushFailed: false};
    isSwitchingRef.current = true;
    try {
      await flushActiveSegmentEdits();
      return {proceed: true, flushFailed: false};
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      setErrorMessage(`裁剪范围未保存（${reason}），已切换片段`);
      return {proceed: true, flushFailed: true};
    }
    // NOTE: no finally-release here. The guard is released by the caller AFTER
    // it commits the switch (releaseSwitchGuard), so the guard's lifetime spans
    // the whole flush→switch critical section. If the flush itself rejects we
    // still return proceed:true above, so the caller's finally always releases.
  }

  function releaseSwitchGuard() {
    isSwitchingRef.current = false;
  }

  async function handleClipCardClick(clip: CandidateClip, event: React.MouseEvent<HTMLButtonElement>) {
    if ((event.metaKey || event.ctrlKey) && isClipExportSelectable(clip.status)) {
      event.preventDefault();
      event.stopPropagation();
      toggleClipSelection(clip.id);
      return;
    }
    // Clicking another clip card switches the active clip; flush the pending
    // trim edit first so the 800ms debounce isn't cancelled by the auto-save
    // effect cleanup. Skip when clicking the already-active clip (no switch).
    if (activeClip && clip.id !== activeClip.id) {
      const {proceed} = await flushTrimBeforeSwitch();
      if (!proceed) return; // re-entrant: guard owned elsewhere, don't release
      try {
        setActiveVideoId(clip.video_id);
        setActiveClipId(clip.id);
      } finally {
        releaseSwitchGuard();
      }
      return;
    }
    setActiveVideoId(clip.video_id);
    setActiveClipId(clip.id);
  }

  function clearVideoSelection() {
    useStore.getState().clearSelectedVideoIds();
  }

  function toggleClipGroup(videoId: string) {
    setCollapsedClipGroupIds((current) =>
      current.includes(videoId)
        ? current.filter((id) => id !== videoId)
        : [...current, videoId],
    );
  }

  function toggleVideoFolder(folderId: string) {
    setCollapsedVideoFolderIds((current) =>
      current.includes(folderId)
        ? current.filter((id) => id !== folderId)
        : [...current, folderId],
    );
  }

  function getVideoFolderSelectionState(videoIds: string[]): 'checked' | 'indeterminate' | 'unchecked' {
    if (videoIds.length === 0) return 'unchecked';
    const selectedCount = videoIds.filter((videoId) => selectedVideoIdSet.has(videoId)).length;
    if (selectedCount === 0) return 'unchecked';
    if (selectedCount === videoIds.length) return 'checked';
    return 'indeterminate';
  }

  function toggleSelectAllVideosInFolder(videoIds: string[]) {
    if (videoIds.length === 0) return;
    const selectionState = getVideoFolderSelectionState(videoIds);
    const current = useStore.getState().selectedVideoIds;
    const next = new Set(current);
    videoIds.forEach((videoId) => {
      if (selectionState === 'checked') {
        next.delete(videoId);
      } else {
        next.add(videoId);
      }
    });
    useStore.getState().setSelectedVideoIds(next);
  }

  function toggleSelectAllVideos() {
    if (selectedVideoIds.size === videos.length) {
      clearVideoSelection();
      return;
    }
    useStore.getState().setSelectedVideoIds(new Set(videos.map((video) => video.id)));
  }

  function updateTrimRange(nextStart: number, nextEnd: number, syncTarget: 'start' | 'end' | null = null, skipSeek = false) {
    if (!activeClip || !activeSegment) return;
    const videoDuration = activeVideo?.duration ?? clipWindowEnd;
    const safeStart = Math.max(0, Math.min(nextStart, nextEnd - CLIP_STEP));
    const safeEnd = Math.max(safeStart + CLIP_STEP, Math.min(nextEnd, videoDuration));

    const nextTrimStart = Math.floor(safeStart * 100) / 100;
    const nextTrimEnd = Math.floor(safeEnd * 100) / 100;
    setTrimStart(nextTrimStart);
    setTrimEnd(nextTrimEnd);
    trimStartRef.current = nextTrimStart;
    trimEndRef.current = nextTrimEnd;

    if (skipSeek) {
      // Trim-drag path (startTrimScroll's rAF tick): do NOT enqueue a seek
      // every animation frame. A per-frame pendingSeek change makes
      // PlayerSurface's seek-apply effect cleanup cancel its pending apply rAF
      // before it can execute — starving the seek so the preview stayed frozen
      // on the playhead until release. The trim drag now dispatches its seek
      // from the pointermove handler (pointer cadence, gappy like the playhead
      // scrubber) plus one exact seek on release.
      return;
    }
    if (syncTarget === 'start' || syncTarget === 'end') {
      const boundaryTime = syncTarget === 'start' ? nextTrimStart : nextTrimEnd;
      syncVideoTime(boundaryTime, {force: false});
    } else {
      // PR4: read the live playhead from the publish channel instead of a
      // render-time `playhead` closure. updateTrimRange runs synchronously
      // from user gestures, so getState() returns the exact current position
      // (more accurate than a possibly-stale React closure, and it lets App
      // drop its currentTimeMs subscription). We clamp it into the new trim
      // window exactly as before.
      const currentPlayhead = useStore.getState().currentTimeMs / 1000;
      const nextPlayhead = Math.min(Math.max(currentPlayhead, nextTrimStart), nextTrimEnd);
      syncVideoTime(nextPlayhead, {force: !isScrubbingRef.current});
    }
  }

  function selectActiveSegment(segmentId: string) {
    if (!activeClip) return;
    const segment = activeClipSegments.find((item) => item.id === segmentId);
    if (!segment) return;
    skipTrimSyncRef.current = true;
    setActiveSegmentId(segment.id);
    setTrimStart(segment.start);
    setTrimEnd(segment.end);
    syncVideoTime(segment.start, {force: true});
    setErrorMessage(null);
  }

  function seekRelative(offset: number) {
    if (!activeClip) return;
    // Read the live position from the publish channel rather than a stale
    // React closure — keyboard repeats can fire faster than React commits.
    const currentS = useStore.getState().currentTimeMs / 1000;
    const nextTime = Math.max(trimStart, Math.min(trimEnd, currentS + offset));
    syncVideoTime(nextTime, {force: true});
  }

  // Step the playback-speed ladder by one notch. `direction` -1 = slower
  // ([), +1 = faster (]). Clamps at the ends (no wrap). Reads the live store
  // rate so rapid key repeats compose correctly even before React commits.
  function stepPlaybackRate(direction: -1 | 1) {
    if (!activeClip) return;
    const current = useStore.getState().playbackRate;
    // Find the nearest ladder index to the current rate, then move from there.
    let idx = PLAYBACK_RATE_PRESETS.indexOf(current as (typeof PLAYBACK_RATE_PRESETS)[number]);
    if (idx === -1) {
      idx = PLAYBACK_RATE_PRESETS.reduce(
        (best, rate, i) =>
          Math.abs(rate - current) < Math.abs(PLAYBACK_RATE_PRESETS[best] - current) ? i : best,
        0,
      );
    }
    const nextIdx = Math.min(PLAYBACK_RATE_PRESETS.length - 1, Math.max(0, idx + direction));
    setPlaybackRateStore(PLAYBACK_RATE_PRESETS[nextIdx]);
  }

  async function selectClipByOffset(offset: -1 | 1) {
    // Re-entrancy guard FIRST: a rapid second ↑/↓ arriving while the previous
    // switch's flush is still in flight must be ignored here, before we read
    // activeClipId (still un-updated) and compute a stale nextClip that would
    // only jump one grid. (flushTrimBeforeSwitch would also return proceed:false
    // here, but bailing early avoids computing a stale candidate at all.)
    if (isSwitchingRef.current) return;
    const idx = filteredClips.findIndex((clip) => clip.id === activeClipId);
    if (idx < 0) {
      if (filteredClips[0]) {
        setActiveClipId(filteredClips[0].id);
      }
      return;
    }
    const nextClip = filteredClips[idx + offset];
    if (!nextClip) return;
    // Flush the pending trim edit before ↑/↓ moves the active clip away, so the
    // 800ms debounce isn't cancelled mid-flight by the auto-save effect cleanup.
    const {proceed} = await flushTrimBeforeSwitch();
    if (!proceed) return; // re-entrant: guard owned elsewhere, don't release
    try {
      setActiveClipId(nextClip.id);
    } finally {
      releaseSwitchGuard();
    }
  }

  function togglePlayPause() {
    // Mirror the play/pause intent through the store. PlayerSurface
    // applies it to the underlying <video> element.
    const {isPlaying: storeIsPlaying, currentTimeMs} = useStore.getState();
    if (!storeIsPlaying) {
      const currentS = currentTimeMs / 1000;
      if (currentS < trimStart || currentS >= trimEnd) {
        enqueueSeekStore(trimStart * 1000);
      }
      setIsPlayingStore(true);
    } else {
      setIsPlayingStore(false);
    }
  }

  function syncVideoTime(nextTime: number, _options?: {force?: boolean}) {
    // A4-2: rAF batching + fastSeek + safety-timer logic now lives inside
    // PlayerSurface (it is the videoRef owner). Here we just dispatch a
    // seek command through the store; the renderer coalesces back-to-back
    // commands into a single per-frame seek and uses fastSeek for big
    // deltas, preserving the pre-A4 scrub UX.
    //
    // The `force` flag previously bypassed the rAF coalescer; PlayerSurface
    // already cancels any queued rAF when a new pendingSeek arrives, so
    // every `enqueueSeek` call effectively "wins" — `force` is now a no-op
    // but we keep the parameter so existing call sites compile unchanged.
    const safeTime = Number(nextTime.toFixed(2));
    enqueueSeekStore(safeTime * 1000);
  }

  function beginScrub() {
    isScrubbingRef.current = true;
    setIsScrubbing(true);
    // Remember whether we were playing so endScrub can resume. PlayerSurface
    // is the only thing touching <video>; we route the pause through the
    // store so the renderer applies it.
    const wasPlaying = useStore.getState().isPlaying;
    resumeAfterScrubRef.current = wasPlaying;
    if (wasPlaying) {
      setIsPlayingStore(false);
    }
  }

  function endScrub() {
    isScrubbingRef.current = false;
    setIsScrubbing(false);

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLInputElement && activeElement.type === 'range') {
      activeElement.blur();
    }

    if (resumeAfterScrubRef.current) {
      resumeAfterScrubRef.current = false;
      setIsPlayingStore(true);
    }
  }

  function startTrimScroll(edge: 'left' | 'right') {
    trimDraggingRef.current = true;
    // A4-3: wire the trim slice's draggingHandle flag so TimelineSurface
    // (and, in A4-4, TrimHandles) can react via a React-tracked signal
    // instead of the ref. Pre-A4 the ref-only flag was OK because the
    // thumbnail fetch effect was a few lines above its setter; now they
    // live in different components.
    useStore.getState().beginDrag(edge === 'left' ? 'start' : 'end');
    const tick = () => {
      const rect = trimRectRef.current;
      if (!rect || rect.width === 0) {
        trimScrollRafRef.current = requestAnimationFrame(tick);
        return;
      }

      const x = trimPointerXRef.current;
      const fraction = (x - rect.left) / rect.width;

      const EDGE_ZONE = 0.1;
      const MAX_SPEED = 2;
      let scrollSpeed = 0;

      if (fraction < 0) {
        scrollSpeed = -MAX_SPEED;
      } else if (fraction < EDGE_ZONE) {
        scrollSpeed = -MAX_SPEED * ((EDGE_ZONE - fraction) / EDGE_ZONE);
      } else if (fraction > 1) {
        scrollSpeed = MAX_SPEED;
      } else if (fraction > 1 - EDGE_ZONE) {
        scrollSpeed = MAX_SPEED * ((fraction - (1 - EDGE_ZONE)) / EDGE_ZONE);
      }

      if (scrollSpeed !== 0) {
        const dt = scrollSpeed / 60;
        setClipWindowOverride((prev) => {
          const cur = prev ?? initialClipWindow;
          const videoDur = activeVideo?.duration ?? cur.end;
          const shift = edge === 'left'
            ? Math.max(-cur.start, dt < 0 ? dt : 0)
            : Math.min(videoDur - cur.end, dt > 0 ? dt : 0);
          if (edge === 'left' && dt < 0) {
            return {start: Math.max(0, cur.start + dt), end: cur.end};
          }
          if (edge === 'right' && dt > 0) {
            return {start: cur.start, end: Math.min(videoDur, cur.end + dt)};
          }
          if (dt < 0) {
            return {start: Math.max(0, cur.start + dt), end: cur.end};
          }
          return {start: cur.start, end: Math.min(videoDur, cur.end + dt)};
        });
      }

      const clampedF = Math.max(0, Math.min(1, fraction));
      const t = clipWindowStart + clampedF * clipWindowDuration;
      if (edge === 'left') {
        updateTrimRange(t, trimEndRef.current, 'start', true);
      } else {
        updateTrimRange(trimStartRef.current, t, 'end', true);
      }

      trimScrollRafRef.current = requestAnimationFrame(tick);
    };

    trimScrollRafRef.current = requestAnimationFrame(tick);
  }

  function stopTrimScroll() {
    if (trimScrollRafRef.current != null) {
      cancelAnimationFrame(trimScrollRafRef.current);
      trimScrollRafRef.current = null;
    }
    if (trimDraggingRef.current) {
      trimDraggingRef.current = false;
      // Clear the store-side flag so TimelineSurface re-enables thumbnail
      // fetching. The clipWindowVersion bump kicks the fetch right away.
      useStore.getState().endDrag();
      setClipWindowVersion((v) => v + 1);
    }
  }

  /**
   * A4-4: TrimHandles dispatches both edges through this single entry
   * point. We install the document-level pointer listeners here (rather
   * than inside TrimHandles) so the auto-scroll loop in startTrimScroll
   * can keep reading App-owned refs (`trimRectRef`, `trimPointerXRef`)
   * without prop drilling them into the handle component.
   */
  function handleTrimDragStart(
    edge: 'start' | 'end',
    event: React.PointerEvent<HTMLDivElement>,
  ) {
    event.stopPropagation();
    event.preventDefault();
    const containerEl = event.currentTarget.closest('[data-timeline-container]') as HTMLElement | null;
    if (!containerEl) return;
    trimRectRef.current = containerEl.getBoundingClientRect();
    trimPointerXRef.current = event.clientX;
    beginScrub();
    startTrimScroll(edge === 'start' ? 'left' : 'right');
    const onMove = (ev: PointerEvent) => {
      trimPointerXRef.current = ev.clientX;
      trimRectRef.current = containerEl.getBoundingClientRect();
      // Dispatch the preview seek HERE — at pointermove cadence, which is gappy
      // and not rAF-locked (exactly like the playhead scrubber) — instead of
      // from the per-frame rAF tick, whose every-frame enqueue starved
      // PlayerSurface's apply. trimStart/EndRef hold the latest clamped boundary
      // the tick just computed, so we seek to where the handle actually is.
      syncVideoTime(edge === 'start' ? trimStartRef.current : trimEndRef.current, {force: false});
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      stopTrimScroll();
      // Land the preview exactly on the final boundary. The per-frame tick
      // suppresses seeks and the last pointermove seek can trail the final
      // boundary by up to ~1 frame, so snap to the exact trim edge on release.
      syncVideoTime(edge === 'start' ? trimStartRef.current : trimEndRef.current, {force: false});
      endScrub();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    // pointercancel (e.g. the OS steals the pointer mid-drag) must run the
    // same cleanup as pointerup, otherwise the drag state leaks.
    document.addEventListener('pointercancel', onUp);
  }

  async function handleBindScoreCard(platformRecordId: string | null) {
    if (!activeClip) return;
    if (guardClipMutation(activeClip.id)) return;
    try {
      const response = await bindClipPlatformRecord(activeClip.id, platformRecordId);
      setProjectState(response.project);
      setErrorMessage(null);
      setSuccessMessage(platformRecordId ? '已绑定平台成绩卡片' : '已解绑平台成绩卡片');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '绑定平台成绩卡片失败');
    }
  }

  async function handleDetectActiveVideo() {
    if (!activeVideo) return;
    if (activeDetectJob) return;
    setSuccessMessage(null);
    markVideosQueued([activeVideo.id]);
    try {
      const response = await detectProjectVideo(activeVideo.id, apiKey || undefined);
      setProjectState(response.project);
      upsertJob(response.job);
      setErrorMessage(null);
      setSuccessMessage('检测任务已加入后台队列');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '检测失败');
    } finally {
      void refreshJobs({silent: true});
    }
  }

  async function handleDetectSelectedVideos() {
    if (isBatchDetecting) return;
    if (selectedStartableVideos.length === 0) {
      setErrorMessage('所选视频中没有可开始检测的任务');
      return;
    }
    if (!window.confirm(`确认开始检测已选中的 ${selectedStartableVideos.length} 个视频吗？`)) {
      return;
    }

    const targetVideos = [...selectedStartableVideos];
    const queuedJobs: AppJob[] = [];
    const failedVideos: string[] = [];

    setIsBatchDetecting(true);
    setSuccessMessage(null);
    markVideosQueued(targetVideos.map((video) => video.id));

    try {
      for (const video of targetVideos) {
        try {
          const response = await detectProjectVideo(video.id, apiKey || undefined);
          queuedJobs.push(response.job);
          setProjectState(response.project);
        } catch (error) {
          failedVideos.push(
            `${video.file_name}${error instanceof Error && error.message ? `（${error.message}）` : ''}`,
          );
        }
      }

      if (queuedJobs.length > 0) {
        upsertJobs(queuedJobs);
        const currentSelected = useStore.getState().selectedVideoIds;
        const nextSelected = new Set<string>();
        currentSelected.forEach((videoId) => {
          if (!queuedJobs.some((job) => job.video_id === videoId)) {
            nextSelected.add(videoId);
          }
        });
        useStore.getState().setSelectedVideoIds(nextSelected);
      }

      if (failedVideos.length > 0) {
        const successPrefix = queuedJobs.length > 0 ? `${queuedJobs.length} 个视频已加入后台队列，将按顺序自动开始；` : '';
        setErrorMessage(`${successPrefix}${failedVideos.length} 个视频开始检测失败：${failedVideos.join('、')}`);
      } else {
        setErrorMessage(null);
        setSuccessMessage(`已将 ${queuedJobs.length} 个视频加入后台队列，将按顺序自动开始`);
      }
    } finally {
      setIsBatchDetecting(false);
      void refreshWorkspace({silent: true});
    }
  }

  async function handleDetectPrimaryAction() {
    if (!shouldUseSelectedVideosForDetect) {
      setErrorMessage('请先在左侧勾选至少一个视频');
      return;
    }
    await handleDetectSelectedVideos();
  }

  async function handleCancelSelectedVideos() {
    if (selectedCancellableVideos.length === 0) {
      setErrorMessage('所选视频中没有可取消的检测任务');
      return;
    }
    if (!window.confirm(`确认取消所选 ${selectedCancellableVideos.length} 个视频的检测任务吗？`)) {
      return;
    }

    const failedVideos: string[] = [];

    try {
      for (const video of selectedCancellableVideos) {
        try {
          const response = await cancelDetectVideo(video.id);
          setProjectState(response.project);
        } catch (error) {
          failedVideos.push(
            `${video.file_name}${error instanceof Error && error.message ? `（${error.message}）` : ''}`,
          );
        }
      }

      if (failedVideos.length > 0) {
        const successCount = selectedCancellableVideos.length - failedVideos.length;
        const successPrefix = successCount > 0 ? `${successCount} 个视频已取消；` : '';
        setErrorMessage(`${successPrefix}${failedVideos.length} 个视频取消失败：${failedVideos.join('、')}`);
      } else {
        setErrorMessage(null);
        setSuccessMessage(`已取消 ${selectedCancellableVideos.length} 个视频的检测任务`);
      }
    } finally {
      void refreshWorkspace({silent: true});
    }
  }

  async function handleDeleteSelectedVideos() {
    if (selectedDeletableVideos.length === 0) {
      setErrorMessage('所选视频中没有可删除的任务');
      return;
    }
    if (
      !window.confirm(
        `确认删除所选 ${selectedDeletableVideos.length} 个视频任务吗？这会移除对应源文件记录和候选片段，但不会删除已导出的片段。`,
      )
    ) {
      return;
    }

    const failedVideos: string[] = [];
    let latestProject: ProjectState | null = null;

    try {
      for (const video of selectedDeletableVideos) {
        try {
          latestProject = await deleteProjectVideo(video.id);
          setProjectState(latestProject);
        } catch (error) {
          failedVideos.push(
            `${video.file_name}${error instanceof Error && error.message ? `（${error.message}）` : ''}`,
          );
        }
      }

      if (latestProject && activeVideoId && !latestProject.videos.some((video) => video.id === activeVideoId)) {
        const nextVideo = latestProject.videos[0] ?? null;
        setActiveVideoId(nextVideo?.id ?? null);
        const nextClip = latestProject.candidate_clips.find((clip) => clip.video_id === nextVideo?.id) ?? null;
        setActiveClipId(nextClip?.id ?? null);
      }

      if (failedVideos.length > 0) {
        const successCount = selectedDeletableVideos.length - failedVideos.length;
        const successPrefix = successCount > 0 ? `${successCount} 个视频已删除；` : '';
        setErrorMessage(`${successPrefix}${failedVideos.length} 个视频删除失败：${failedVideos.join('、')}`);
      } else {
        setErrorMessage(null);
        setSuccessMessage(`已删除 ${selectedDeletableVideos.length} 个视频任务`);
      }
    } finally {
      void refreshWorkspace({silent: true});
    }
  }

  async function handleCancelDetect(videoId: string) {
    const targetVideo = videos.find((video) => video.id === videoId);
    if (!targetVideo) return;
    if (!window.confirm(`确认取消视频“${targetVideo.file_name}”的检测任务吗？`)) {
      return;
    }

    try {
      const response = await cancelDetectVideo(videoId);
      setProjectState(response.project);
      setErrorMessage(null);
      setSuccessMessage(response.message);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '取消检测失败');
    } finally {
      void refreshJobs({silent: true});
    }
  }

  function handleClearSavedApiKey() {
    setApiKey('');
    setRememberApiKey(false);
    setSuccessMessage('已清除本地保存的 API Key');
  }

  async function handleDeleteVideo(videoId: string) {
    const targetVideo = videos.find((video) => video.id === videoId);
    if (!targetVideo) return;
    if (
      !window.confirm(
        `确认删除视频任务“${targetVideo.file_name}”吗？这会移除该视频的上传源文件和候选片段，但不会删除已经导出的片段。`,
      )
    ) {
      return;
    }

    try {
      const nextProject = await deleteProjectVideo(videoId);
      setProjectState(nextProject);
      setErrorMessage(null);
      setSuccessMessage(`已删除视频任务：${targetVideo.file_name}`);

      if (activeVideoId === videoId) {
        const nextVideo = nextProject.videos[0] ?? null;
        setActiveVideoId(nextVideo?.id ?? null);
        const nextClip = nextProject.candidate_clips.find((clip) => clip.video_id === nextVideo?.id) ?? null;
        setActiveClipId(nextClip?.id ?? null);
      }
      void refreshJobs({silent: true});
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '删除视频任务失败');
    }
  }

  async function handleAddVideoAsCandidate(videoId: string) {
    const targetVideo = videos.find((video) => video.id === videoId);
    if (!targetVideo) return;
    try {
      const nextProject = await addVideoAsCandidate(videoId);
      setProjectState(nextProject);
      setErrorMessage(null);
      setSuccessMessage(`已把整段视频「${targetVideo.file_name}」加为候选片段`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '把整段视频加为候选片段失败');
    }
  }

  async function handleStatusChange(clipId: string, status: ClipStatus) {
    if (guardClipMutation(clipId)) return;
    // Flush any pending trim edit before marking+switching away (Enter/Delete
    // on the active clip would otherwise trigger the auto-save effect cleanup
    // and silently drop the in-flight 800ms debounce). Only when this targets
    // the active clip; no-op when nothing is pending.
    //
    // proceed===false ONLY for re-entrancy (a switch already in flight) — bail
    // so we don't double-mark/double-switch racing the first press (must-fix 1).
    // proceed stays true on flush failure: the mark — the primary action the
    // user pressed Enter for — still runs and is never swallowed by a trim-save
    // error (must-fix 2). flushFailed tells us to KEEP the "unsaved trim" notice
    // visible, i.e. NOT wipe it with setErrorMessage(null) below (R3 #2).
    let flushFailed = false;
    let acquiredGuard = false;
    if (activeClip?.id === clipId) {
      const result = await flushTrimBeforeSwitch();
      if (!result.proceed) return; // re-entrant: guard owned elsewhere
      acquiredGuard = true;
      flushFailed = result.flushFailed;
    }
    const currentIndex = filteredClips.findIndex((clip) => clip.id === clipId);
    const nextClipId = filteredClips[currentIndex + 1]?.id ?? filteredClips[currentIndex - 1]?.id ?? null;

    try {
      const response = await updateClip(clipId, {status});
      setProjectState(response.project);
      if (nextClipId) {
        setActiveClipId(nextClipId);
      }
      // Preserve the "裁剪范围未保存…" notice when the trim flush failed; only
      // clear stale errors when nothing needed surfacing (R3 #2).
      if (!flushFailed) {
        setErrorMessage(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '更新片段状态失败');
    } finally {
      if (acquiredGuard) releaseSwitchGuard();
    }
  }

  async function flushActiveSegmentEdits(): Promise<ActiveSegmentEditSnapshot | null> {
    clearPendingTrimAutoSave();
    if (!activeClip || !activeSegment) return null;
    if (trimSavePromiseRef.current) {
      return trimSavePromiseRef.current;
    }
    // Use the renderer's published snapshot rather than reaching into the
    // <video> element directly (A4-2: videoRef now lives in PlayerSurface).
    const livePlayhead = Number((useStore.getState().currentTimeMs / 1000).toFixed(3));
    if (Math.abs(trimStart - activeSegment.start) < 0.01 && Math.abs(trimEnd - activeSegment.end) < 0.01) {
      return {
        clip: activeClip,
        segment: activeSegment,
        playheadValue: livePlayhead,
      };
    }
    if (guardClipMutation(activeClip.id)) {
      throw new Error(EXPORT_LOCKED_CLIP_MESSAGE);
    }
    const promise: Promise<ActiveSegmentEditSnapshot | null> = (async () => {
      setIsSavingTrim(true);
      try {
        const nextSegments = normalizeSegments(
          activeClip,
          activeClipSegments.map((segment) =>
            segment.id === activeSegment.id
              ? {
                  ...segment,
                  start: trimStart,
                  end: trimEnd,
                }
              : segment,
          ),
        );
        const response = await updateClip(activeClip.id, {
          segments: nextSegments,
        });
        setProjectState(response.project);
        const nextClip =
          response.project.candidate_clips.find((clip) => clip.id === activeClip.id) ?? activeClip;
        const nextSegment =
          orderedSegments(nextClip).find((segment) => segment.id === activeSegment.id)
          ?? firstEditableSegment(nextClip)
          ?? activeSegment;
        setActiveSegmentId(nextSegment.id);
        setErrorMessage(null);
        showTrimSavedIndicator();
        return {
          clip: nextClip,
          segment: nextSegment,
          playheadValue: livePlayhead,
        };
      } finally {
        setIsSavingTrim(false);
      }
    })();
    trimSavePromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      if (trimSavePromiseRef.current === promise) {
        trimSavePromiseRef.current = null;
      }
    }
  }

  async function handleSplitActiveClip() {
    if (!activeClip || !activeVideo || !activeSegment) return;
    if (guardClipMutation(activeClip.id)) return;
    const undoSnapshot = pushClipUndoSnapshot();
    try {
      const latest = await flushActiveSegmentEdits();
      if (!latest) {
        discardClipUndoSnapshot(undoSnapshot);
        return;
      }
      const splitPoint = Number(Math.min(
        Math.max(latest.playheadValue, latest.segment.start + 0.001),
        latest.segment.end - 0.001,
      ).toFixed(3));
      if (splitPoint - latest.segment.start < MIN_SEGMENT_DURATION || latest.segment.end - splitPoint < MIN_SEGMENT_DURATION) {
        throw new Error('拆分后前后至少各保留 0.5 秒');
      }
      const response = await splitClipSegment(latest.clip.id, latest.segment.id, splitPoint);
      setProjectState(response.project);
      setActiveVideoId(activeVideo.id);
      setActiveClipId(latest.clip.id);
      const splitClip = response.project.candidate_clips.find((clip) => clip.id === latest.clip.id) ?? null;
      const nextSegment =
        splitClip
          ? orderedSegments(splitClip).find((segment) => Math.abs(segment.start - splitPoint) < 0.01)
            ?? orderedSegments(splitClip).find((segment) => segment.start >= splitPoint - 0.01)
            ?? orderedSegments(splitClip)[orderedSegments(splitClip).length - 1]
          : null;
      setActiveSegmentId(nextSegment?.id ?? null);
      enqueueSeekStore(splitPoint * 1000);
      setErrorMessage(null);
      setSuccessMessage('已按播放头拆分当前选区');
    } catch (error) {
      discardClipUndoSnapshot(undoSnapshot);
      setErrorMessage(error instanceof Error ? error.message : '拆分选区失败');
    }
  }

  async function handleDeleteActiveSegment() {
    if (!activeClip || !activeVideo || !activeSegment) return;
    if (guardClipMutation(activeClip.id)) return;
    if (activeClipSegments.length <= 1) {
      setErrorMessage('候选片段至少保留一个选区');
      return;
    }
    const undoSnapshot = pushClipUndoSnapshot();
    try {
      const latest = await flushActiveSegmentEdits();
      if (!latest) {
        discardClipUndoSnapshot(undoSnapshot);
        return;
      }
      const response = await deleteClipSegment(latest.clip.id, latest.segment.id);
      setProjectState(response.project);
      setActiveVideoId(activeVideo.id);
      if (response.deleted_clip) {
        const nextClip = filteredClips.find((clip) => clip.id !== activeClip.id && clip.video_id === activeVideo.id)
          ?? filteredClips.find((clip) => clip.id !== activeClip.id)
          ?? null;
        setActiveClipId(nextClip?.id ?? null);
      } else {
        setActiveClipId(response.surviving_clip_id ?? activeClip.id);
      }
      setErrorMessage(null);
      setSuccessMessage('已删除当前选区');
    } catch (error) {
      discardClipUndoSnapshot(undoSnapshot);
      setErrorMessage(error instanceof Error ? error.message : '删除选区失败');
    }
  }

  async function handleExtractActiveSegment() {
    if (!activeClip || !activeVideo || !activeSegment) return;
    if (guardClipMutation(activeClip.id)) return;
    if (activeClipSegments.length <= 1) {
      setErrorMessage('当前候选片段只有一个选区，无需独立');
      return;
    }
    const undoSnapshot = pushClipUndoSnapshot();
    try {
      const latest = await flushActiveSegmentEdits();
      if (!latest) {
        discardClipUndoSnapshot(undoSnapshot);
        return;
      }
      const response = await extractClipSegment(latest.clip.id, latest.segment.id);
      setProjectState(response.project);
      setActiveVideoId(activeVideo.id);
      setActiveClipId(response.new_clip_id);
      setErrorMessage(null);
      setSuccessMessage('已将当前选区独立成新的候选片段');
    } catch (error) {
      discardClipUndoSnapshot(undoSnapshot);
      setErrorMessage(error instanceof Error ? error.message : '独立选区失败');
    }
  }

  async function handleExport() {
    if (activeExportJob) return;
    if (exportTargetClipIds.length === 0) {
      setErrorMessage('请先选择要导出的片段');
      return;
    }
    const trimmedOutputDir = outputDir.trim();
    if (exportOperation !== 'upload_only' && !trimmedOutputDir) {
      setErrorMessage('请先输入或选择默认导出目录');
      return;
    }
    if (exportOperation === 'upload_only' && uploadOnlyInvalidClips.length > 0) {
      const firstInvalidClip = uploadOnlyInvalidClips[0];
      const linkedRecord = firstInvalidClip.linked_platform_record_id
        ? platformRecordById.get(firstInvalidClip.linked_platform_record_id) ?? null
        : null;
      const clipVideo = videoById.get(firstInvalidClip.video_id) ?? null;
      setErrorMessage(
        `片段“${getClipDisplayName(firstInvalidClip, linkedRecord, clipVideo)}”未导出且不满足原片直传条件，或未绑定平台卡片，无法仅上传`,
      );
      return;
    }
    if (requiresUploadCredentials && !hasOssCredentials) {
      setErrorMessage('当前模式包含上传，且所选片段中有已绑定平台卡片，请先配置 OSS 凭证');
      return;
    }
    if (uploadParallelFiles < 1 || uploadPartThreads < 1) {
      setErrorMessage('上传并发参数必须大于等于 1');
      return;
    }
    try {
      setShowExport(false);
      setExportSummary(null);
      setErrorMessage(null);
      setSuccessMessage(`${EXPORT_OPERATION_DETAILS[exportOperation].label}任务准备中...`);
      if (activeClip && activeSegment) {
        await flushActiveSegmentEdits().catch(() => undefined);
      }
      void persistDefaultOutputDirectory(trimmedOutputDir);
      const response = await exportProject({
        output_dir: exportOperation === 'upload_only' ? savedOutputDir || trimmedOutputDir || '.' : trimmedOutputDir,
        clip_ids: exportTargetClipIds,
        export_mode: exportMode,
        operation: exportOperation,
        oss_access_key_id: ossAccessKeyId.trim() || undefined,
        oss_access_key_secret: ossAccessKeySecret.trim() || undefined,
        upload_parallel_files: uploadParallelFiles,
        upload_part_threads: uploadPartThreads,
      });
      setProjectState(response.project);
      upsertJob(response.job);
      setSuccessMessage(`${EXPORT_OPERATION_DETAILS[exportOperation].label}任务已在后台开始/排队，可在主页进度条查看`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '导出失败');
    } finally {
      void refreshJobs({silent: true});
    }
  }

  async function handlePickExportDirectory() {
    if (!desktopBridge?.isDesktop) return;

    try {
      const selectedDirectory = await desktopBridge.selectDirectory(outputDir.trim() || savedOutputDir || undefined);
      if (!selectedDirectory) {
        return;
      }
      setOutputDir(selectedDirectory);
      await persistDefaultOutputDirectory(selectedDirectory);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '选择导出目录失败');
    }
  }

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    await handleImportFiles(event.dataTransfer.files);
  };

  // A4-6: render helpers extracted to lib/progress.ts (pure functions).
  const renderVideoProgress = (video: ProjectState['videos'][number]) =>
    describeVideoProgress(video, activeJobs);
  const renderJobProgress = (job: AppJob) => describeJobProgress(job);
  const renderJobPercent = (job: AppJob) => jobPercent(job);

  function enqueueToast(kind: ToastKind, message: string) {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;
    toastIdRef.current += 1;
    setToast({
      id: toastIdRef.current,
      kind,
      message: trimmedMessage,
    });
  }

  return (
    <div
      className="h-screen w-full flex flex-col bg-white text-gray-900 font-sans overflow-hidden"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <AppHeader
        desktopBridge={desktopBridge}
        toast={toast}
        isToastVisible={isToastVisible}
        showApiKey={showApiKey}
        setShowApiKey={setShowApiKey}
        apiKey={apiKey}
        setApiKey={setApiKey}
        rememberApiKey={rememberApiKey}
        setRememberApiKey={setRememberApiKey}
        supportsSecureStorage={supportsSecureStorage}
        isPersistingApiKey={isPersistingApiKey}
        handleClearSavedApiKey={handleClearSavedApiKey}
        importApi={importApi}
        activeVideo={activeVideo}
        activeDetectJob={activeDetectJob}
        activeDetectCancelRequested={activeDetectCancelRequested}
        shouldShowDetectControls={shouldShowDetectControls}
        startDetectCount={startDetectCount}
        isBatchDetecting={isBatchDetecting}
        shouldUseSelectedVideosForDetect={shouldUseSelectedVideosForDetect}
        handleCancelDetect={(videoId) => void handleCancelDetect(videoId)}
        handleDetectPrimaryAction={() => void handleDetectPrimaryAction()}
        exportApi={exportApi}
        hasOssCredentials={hasOssCredentials}
        activeExportJob={activeExportJob}
      />

      {activeJobs.length > 0 && (
        <div className="border-b border-gray-200 bg-gray-50 px-4 py-2">
          <div className="flex flex-wrap gap-3">
            {activeJobs.map((job) => (
              <div key={job.id} className="min-w-72 flex-1 rounded-2xl border border-gray-200 bg-white px-4 py-2 shadow-sm">
                <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-red-500 transition-all duration-300"
                    style={{width: `${renderJobPercent(job)}%`}}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs text-gray-600">
                  <span className="truncate">{renderJobProgress(job)}</span>
                  <div
                    className="shrink-0 font-semibold text-red-500"
                  >
                    {job.status === 'queued' ? '排队中' : '进行中'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <main className="flex-1 flex overflow-hidden">
        <VideoListPanel
          local={videoListLocal}
          isLoading={isLoading}
          videos={videos}
          videoFolders={videoFolders}
          detectJobsByVideoId={detectJobsByVideoId}
          selectedCancellableVideos={selectedCancellableVideos}
          selectedDeletableVideos={selectedDeletableVideos}
          toggleSelectAllVideos={toggleSelectAllVideos}
          toggleVideoFolder={toggleVideoFolder}
          getVideoFolderSelectionState={getVideoFolderSelectionState}
          toggleSelectAllVideosInFolder={toggleSelectAllVideosInFolder}
          toggleVideoSelection={toggleVideoSelection}
          onCancelSelectedVideos={() => void handleCancelSelectedVideos()}
          onDeleteSelectedVideos={() => void handleDeleteSelectedVideos()}
          onCancelDetect={(videoId) => void handleCancelDetect(videoId)}
          onDeleteVideo={(videoId) => void handleDeleteVideo(videoId)}
          renderVideoProgress={renderVideoProgress}
        />

        <ClipListPanel
          clips={clips}
          filteredClips={filteredClips}
          groupedFilteredClips={groupedFilteredClips}
          collapsedClipGroupIds={collapsedClipGroupIds}
          activeClipId={activeClipId}
          selectedClipIds={selectedClipIdSet}
          exportTargetClipsCount={exportTargetClipsCount}
          videoById={videoById}
          platformRecordById={platformRecordById}
          clipOrdinalById={clipOrdinalById}
          activeExportJob={activeExportJob}
          lockedExportClipIdSet={lockedExportClipIdSet}
          savedOutputDir={savedOutputDir}
          ossAccessKeyId={ossAccessKeyId}
          ossAccessKeySecret={ossAccessKeySecret}
          searchQuery={searchQuery}
          filterStatus={filterStatus}
          onSearchQuery={setSearchQuery}
          onFilterStatus={setFilterStatus}
          toggleClipGroup={toggleClipGroup}
          getClipGroupSelectionState={getClipGroupSelectionState}
          toggleSelectAllClipsInGroup={toggleSelectAllClipsInGroup}
          handleClipCardClick={handleClipCardClick}
          onProjectFromRetry={setProjectState}
        />

        <ReviewPanel
          activeClip={activeClip}
          activeVideo={activeVideo}
          streamUrl={streamUrl}
          activeClipSegments={activeClipSegments}
          activeSegment={activeSegment}
          activeClipDisplayName={activeClipDisplayName}
          activeClipDisplayCountry={activeClipDisplayCountry}
          activeClipPipelineBadges={activeClipPipelineBadges}
          videoClips={videoClips}
          clipWindowStart={clipWindowStart}
          clipWindowEnd={clipWindowEnd}
          clipWindowVersion={clipWindowVersion}
          trimStart={trimStart}
          trimEnd={trimEnd}
          isSavingTrim={isSavingTrim}
          trimJustSaved={trimJustSaved}
          activeClipLockedByExport={activeClipLockedByExport}
          videoPlaybackError={videoPlaybackError}
          setVideoPlaybackError={setVideoPlaybackError}
          togglePlayPause={togglePlayPause}
          beginScrub={beginScrub}
          endScrub={endScrub}
          syncVideoTime={syncVideoTime}
          handleTrimDragStart={handleTrimDragStart}
          selectActiveSegment={selectActiveSegment}
          handleSplitActiveClip={handleSplitActiveClip}
          handleExtractActiveSegment={handleExtractActiveSegment}
          handleDeleteActiveSegment={handleDeleteActiveSegment}
          handleStatusChange={handleStatusChange}
        />

        <PlatformMatchPanel
          local={platformMatchLocal}
          activeClip={activeClip}
          activeVideo={activeVideo}
          activeClipLockedByExport={activeClipLockedByExport}
          activeScopeSummary={activeScopeSummary}
          videoScopedPlatformRecords={videoScopedPlatformRecords}
          filteredPlatformRecords={filteredPlatformRecords}
          groupedPlatformRecords={groupedPlatformRecords}
          scoreApparatusOptions={scoreApparatusOptions}
          scoreSexOptions={scoreSexOptions}
          scoreCountryOptions={scoreCountryOptions}
          clipOrdinalById={clipOrdinalById}
          localCardApi={localCardApi}
          localPlatformRecords={localCardApi.localPlatformRecords}
          onBindScoreCard={(recordId) => void handleBindScoreCard(recordId)}
        />
      </main>

      {isDragging && (
        <div className="fixed inset-0 z-50 bg-white/80 backdrop-blur-xl flex items-center justify-center p-8">
          <div className="w-full h-full border-4 border-dashed border-red-400 rounded-[2.5rem] flex flex-col items-center justify-center bg-red-50/50 pointer-events-none shadow-inner">
            <div className="w-24 h-24 rounded-full bg-red-100 flex items-center justify-center mb-6 animate-bounce shadow-sm">
              <Upload size={48} className="text-red-500" />
            </div>
            <h2 className="text-4xl font-bold text-gray-900 mb-4 tracking-tight">松手即可导入视频</h2>
            <p className="text-gray-500 text-lg font-medium">支持拖拽多个 MP4, MOV, MKV, AVI 文件</p>
          </div>
        </div>
      )}

      <VideoImportPanel api={importApi} />


      <ExportDialog
        api={exportApi}
        desktopBridge={desktopBridge}
        isPersistingApiKey={isPersistingApiKey}
        exportTargetClipsCount={exportTargetClipsCount}
        exportTargetBoundCount={exportTargetBoundCount}
        exportTargetLocalBoundCount={exportTargetLocalBoundCount}
        uploadOnlyInvalidClips={uploadOnlyInvalidClips}
        uploadOnlySourceSummary={uploadOnlySourceSummary}
        activeExportJob={activeExportJob}
        renderJobProgress={renderJobProgress}
        renderJobPercent={renderJobPercent}
        onExport={() => void handleExport()}
        onPickExportDirectory={() => void handlePickExportDirectory()}
      />
      {videoContextMenu && (
        <div
          className="fixed z-50 min-w-[200px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
          style={{left: videoContextMenu.x, top: videoContextMenu.y}}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
            onClick={() => {
              const targetId = videoContextMenu.videoId;
              setVideoContextMenu(null);
              void handleAddVideoAsCandidate(targetId);
            }}
          >
            把整段加为候选片段
          </button>
        </div>
      )}
    </div>
  );
}
