import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  FileVideo,
  Filter,
  FolderOpen,
  Key,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';

import {
  addVideoAsCandidate,
  bindClipPlatformRecord,
  cancelDetectVideo,
  createLocalCard,
  deleteLocalCard,
  deleteProjectVideo,
  deleteClipSegment,
  detectProjectVideo,
  exportProject,
  extractClipSegment,
  fetchJobs,
  fetchProject,
  fetchVideoThumbnails,
  getVideoStreamUrl,
  restoreCandidateClips,
  retryClipStage,
  splitClipSegment,
  updateClip,
  updateLocalCard,
} from './api';
import type {
  AppJob,
  CandidateClip,
  ClipSegment,
  ClipStatus,
  PlatformRecord,
  ProjectState,
  ThumbnailFrame,
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
  formatScoreValue,
  formatSpeed,
  formatSportItemLabel,
  getExportQueueStatusLabel,
  hashString,
  pipelineToneClass,
  primaryScoreValue,
  scoreFormulaLabel,
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
  computeLocalCardAutoTotal,
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
  emptyLocalCardForm,
  localCardRecordToForm,
  stripFileExtension,
} from './lib/utils';
import type {
  ExportJobSummary,
  ExportOperation,
  LocalCardFormState,
} from './lib/utils';
import { useStore } from './store';
import { StatusBadge } from './components/StatusBadge';
import { TriStateCheckboxButton } from './components/TriStateCheckboxButton';
import { ScoreFilterDropdown } from './components/ScoreFilterDropdown';
import type { ScoreFilterMenu } from './components/ScoreFilterDropdown';
import { LocalCardInlineForm } from './components/LocalCardInlineForm';
import { useVideoImport, VideoImportPanel } from './features/import';
import type { ImportMode } from './features/import';
import { useExportJobs, ExportDialog } from './features/export';

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

type PipelineTone = 'neutral' | 'muted' | 'success' | 'warning' | 'danger';
type ClipPipelineBadgeItem = {
  key: 'export' | 'oss' | 'platform';
  text: string;
  tone: PipelineTone;
};
type ExportUploadItem = {
  clip_id: string;
  file_name: string;
  stage: string;
  bytes_sent: number;
  total_bytes: number;
  percent: number;
  speed_bps: number;
  error_message: string | null;
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
const EXPORT_LOCKED_CLIP_MESSAGE = '该片段在当前导出批次中，导出完成前不可编辑';
const EXPORT_LOCKED_RESTORE_MESSAGE = '当前有导出任务进行中，暂不支持撤销结构编辑';
export default function App() {
  const desktopBridge = window.gymclipDesktop;
  const [project, setProject] = useState<ProjectState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<AppToast | null>(null);
  const [isToastVisible, setIsToastVisible] = useState(false);
  const [jobs, setJobs] = useState<AppJob[]>([]);

  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [isDragging, setIsDragging] = useState(false);
  const [videoContextMenu, setVideoContextMenu] = useState<{x: number; y: number; videoId: string} | null>(null);

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
  const [collapsedVideoFolderIds, setCollapsedVideoFolderIds] = useState<string[]>([]);
  const [isVideoSidebarCollapsed, setIsVideoSidebarCollapsed] = useState(false);
  const [scoreSearchQuery, setScoreSearchQuery] = useState('');
  const [scoreApparatusFilter, setScoreApparatusFilter] = useState('all');
  const [scoreSexFilter, setScoreSexFilter] = useState('all');
  const [scoreCountryFilter, setScoreCountryFilter] = useState('all');
  const [openScoreFilter, setOpenScoreFilter] = useState<ScoreFilterMenu | null>(null);
  const [localCardDraft, setLocalCardDraft] = useState<LocalCardFormState | null>(null);
  const [editingLocalCardId, setEditingLocalCardId] = useState<string | null>(null);
  const [editingLocalCardForm, setEditingLocalCardForm] = useState<LocalCardFormState | null>(null);
  const [localCardSaving, setLocalCardSaving] = useState(false);

  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSavingTrim, setIsSavingTrim] = useState(false);
  const [videoPlaybackError, setVideoPlaybackError] = useState<string | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [timelineThumbnails, setTimelineThumbnails] = useState<ThumbnailFrame[]>([]);
  const [isLoadingThumbnails, setIsLoadingThumbnails] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const skipTrimSyncRef = useRef(true);
  const isScrubbingRef = useRef(false);
  const resumeAfterScrubRef = useRef(false);
  const scrubRafRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const isSeekingRef = useRef(false);
  const seekSafetyTimerRef = useRef<number | null>(null);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);
  const trimAutoSaveTimerRef = useRef<number | null>(null);
  const trimScrollRafRef = useRef<number | null>(null);
  const trimPointerXRef = useRef(0);
  const trimRectRef = useRef<DOMRect | null>(null);
  const trimDraggingRef = useRef(false);
  const trimSavePromiseRef = useRef<Promise<ActiveSegmentEditSnapshot | null> | null>(null);
  const toastIdRef = useRef(0);
  const clipUndoStackRef = useRef<ClipUndoSnapshot[]>([]);

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
  const trimStartLocal = Math.max(0, trimStart - clipWindowStart);
  const trimEndLocal = Math.max(trimStartLocal + CLIP_STEP, trimEnd - clipWindowStart);
  const playheadLocal = Math.max(0, Math.min(clipWindowDuration, playhead - clipWindowStart));
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
  const localPlatformRecords = useMemo(() => {
    const query = scoreSearchQuery.trim().toLowerCase();
    return videoScopedPlatformRecords.filter((entry) => {
      if (!entry.is_local) return false;
      const matchesApparatus =
        scoreApparatusFilter === 'all' ||
        String(entry.sport_item_id ?? '') === scoreApparatusFilter;
      if (!matchesApparatus) return false;
      if (!query) return true;
      return (
        entry.user_name.toLowerCase().includes(query) ||
        entry.english_name.toLowerCase().includes(query) ||
        entry.country.toLowerCase().includes(query)
      );
    });
  }, [videoScopedPlatformRecords, scoreSearchQuery, scoreApparatusFilter]);
  const localCardNameSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const sorted = [...platformRecords]
      .filter((r) => r.is_local && r.user_name.trim())
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    const result: string[] = [];
    for (const record of sorted) {
      if (seen.has(record.user_name)) continue;
      seen.add(record.user_name);
      result.push(record.user_name);
    }
    return result;
  }, [platformRecords]);
  const lastUsedLocalSportItemId = useMemo(() => {
    const recent = [...platformRecords]
      .filter((r) => r.is_local && r.sport_item_id != null)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
    return recent ? String(recent.sport_item_id) : '';
  }, [platformRecords]);
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
    if (!options?.silent) {
      setIsLoading(true);
    }
    try {
      const nextProject = await fetchProject();
      setProject(nextProject);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '无法读取项目状态');
    } finally {
      if (!options?.silent) {
        setIsLoading(false);
      }
    }
  }

  async function refreshJobs(options?: {silent?: boolean}) {
    try {
      const response = await fetchJobs();
      setJobs(response.jobs);
    } catch (error) {
      if (!options?.silent) {
        setErrorMessage(error instanceof Error ? error.message : '无法读取任务状态');
      }
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
      setPlayhead(0);
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
    setPlayhead(s);
    setIsPlaying(false);
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
    setPlayhead((current) => Math.min(Math.max(current, clampedStart), clampedEnd));
  }, [activeClip?.id, activeSegment?.id, activeSegment?.start, activeSegment?.end]);

  useEffect(() => {
    setVideoPlaybackError(null);
  }, [streamUrl, activeVideoId]);

  useEffect(() => {
    if (!activeVideo || !activeClip) {
      setTimelineThumbnails([]);
      return;
    }
    if (trimDraggingRef.current) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setIsLoadingThumbnails(true);
      void fetchVideoThumbnails(activeVideo.id, {
        start: clipWindowStart,
        end: clipWindowEnd,
        count: 12,
      })
        .then((response) => {
          if (cancelled) return;
          setTimelineThumbnails(response.thumbnails);
        })
        .catch(() => {
          if (cancelled) return;
          setTimelineThumbnails([]);
        })
        .finally(() => {
          if (cancelled) return;
          setIsLoadingThumbnails(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeVideo?.id, activeClip?.id, clipWindowStart, clipWindowEnd, clipWindowVersion]);

  useEffect(() => {
    return () => {
      if (scrubRafRef.current != null) {
        cancelAnimationFrame(scrubRafRef.current);
      }
      if (seekSafetyTimerRef.current != null) {
        window.clearTimeout(seekSafetyTimerRef.current);
      }
      if (trimAutoSaveTimerRef.current != null) {
        window.clearTimeout(trimAutoSaveTimerRef.current);
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip) return;

    const syncPosition = () => {
      const nextTime = Math.max(activeClip.review_start, 0);
      video.currentTime = nextTime;
      setPlayhead(nextTime);
    };

    if (video.readyState >= 1) {
      syncPosition();
    }
  }, [activeClip?.id, streamUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip) return;

    const onTimeUpdate = () => {
      const current = video.currentTime;
      setPlayhead(current);
      if (current >= trimEnd) {
        video.pause();
        setIsPlaying(false);
      }
    };

    const onLoadedMetadata = () => {
      const target = Math.max(activeClip.review_start, 0);
      video.currentTime = target;
      setPlayhead(target);
    };

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, [activeClip, trimEnd, streamUrl]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!activeClip || !activeVideo) return;
      if (showExport) return;
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
  }, [activeClip, activeVideo, showExport, trimStart, trimEnd, activeSegment, project, activeClipId, activeSegmentId, activeClipLockedByExport, activeExportJob]);

  function setProjectState(nextProject: ProjectState) {
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

  async function handleUndoClipStructure() {
    if (guardRestoreClipStructure()) return;
    const snapshot = clipUndoStackRef.current.pop();
    if (!snapshot) {
      setErrorMessage('没有可撤销的结构编辑');
      return;
    }

    try {
      const response = await restoreCandidateClips(snapshot.candidateClips);
      setProjectState(response.project);
      setActiveClipId(snapshot.activeClipId);
      setActiveSegmentId(snapshot.activeSegmentId);
      const restoredClip = snapshot.activeClipId
        ? response.project.candidate_clips.find((clip) => clip.id === snapshot.activeClipId) ?? null
        : null;
      setActiveVideoId(restoredClip?.video_id ?? activeVideoId);
      setErrorMessage(null);
      setSuccessMessage('已撤销上一步结构编辑');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '撤销失败');
    }
  }

  function markVideosQueued(videoIds: string[]) {
    if (videoIds.length === 0) return;
    const videoIdSet = new Set(videoIds);
    setProject((current) => {
      if (!current) return current;
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

  function handleClipCardClick(clip: CandidateClip, event: React.MouseEvent<HTMLButtonElement>) {
    if ((event.metaKey || event.ctrlKey) && isClipExportSelectable(clip.status)) {
      event.preventDefault();
      event.stopPropagation();
      toggleClipSelection(clip.id);
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

  function updateTrimRange(nextStart: number, nextEnd: number, syncTarget: 'start' | 'end' | null = null) {
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

    if (syncTarget === 'start' || syncTarget === 'end') {
      const boundaryTime = syncTarget === 'start' ? nextTrimStart : nextTrimEnd;
      syncVideoTime(boundaryTime, {force: false});
    } else {
      const nextPlayhead = Math.min(Math.max(playhead, nextTrimStart), nextTrimEnd);
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
    const video = videoRef.current;
    if (!video || !activeClip) return;
    const nextTime = Math.max(trimStart, Math.min(trimEnd, video.currentTime + offset));
    syncVideoTime(nextTime, {force: true});
  }

  function selectClipByOffset(offset: -1 | 1) {
    const idx = filteredClips.findIndex((clip) => clip.id === activeClipId);
    if (idx < 0) {
      if (filteredClips[0]) {
        setActiveClipId(filteredClips[0].id);
      }
      return;
    }
    const nextClip = filteredClips[idx + offset];
    if (nextClip) {
      setActiveClipId(nextClip.id);
    }
  }

  function togglePlayPause() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (video.currentTime < trimStart || video.currentTime >= trimEnd) {
        video.currentTime = trimStart;
      }
      void video.play();
    } else {
      video.pause();
    }
  }

  function syncVideoTime(nextTime: number, options?: {force?: boolean}) {
    const safeTime = Number(nextTime.toFixed(2));
    pendingSeekRef.current = safeTime;

    // During scrubbing, defer setPlayhead to rAF to reduce React re-renders
    if (!isScrubbingRef.current) {
      setPlayhead(safeTime);
    }

    const video = videoRef.current;
    if (!video) return;

    const applySeek = () => {
      if (pendingSeekRef.current == null || isSeekingRef.current) return;
      const target = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (Math.abs(video.currentTime - target) > 0.02) {
        isSeekingRef.current = true;

        // Clear any previous safety timer
        if (seekSafetyTimerRef.current != null) {
          window.clearTimeout(seekSafetyTimerRef.current);
        }

        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          if (seekSafetyTimerRef.current != null) {
            window.clearTimeout(seekSafetyTimerRef.current);
            seekSafetyTimerRef.current = null;
          }
          isSeekingRef.current = false;
          // If a new target accumulated while seeking, apply it immediately
          if (pendingSeekRef.current != null) {
            applySeek();
          }
        };
        video.addEventListener('seeked', onSeeked);

        // Safety timeout in case seeked never fires
        seekSafetyTimerRef.current = window.setTimeout(() => {
          video.removeEventListener('seeked', onSeeked);
          seekSafetyTimerRef.current = null;
          isSeekingRef.current = false;
          if (pendingSeekRef.current != null) {
            applySeek();
          }
        }, 300);

        // Fast scrub: use fastSeek for large jumps (keyframe-only, instant)
        const delta = Math.abs(target - video.currentTime);
        if (delta > 2 && typeof video.fastSeek === 'function') {
          video.fastSeek(target);
        } else {
          video.currentTime = target;
        }
      }
    };

    if (options?.force) {
      if (scrubRafRef.current != null) {
        cancelAnimationFrame(scrubRafRef.current);
        scrubRafRef.current = null;
      }
      isSeekingRef.current = false;
      if (seekSafetyTimerRef.current != null) {
        window.clearTimeout(seekSafetyTimerRef.current);
        seekSafetyTimerRef.current = null;
      }
      pendingSeekRef.current = safeTime;
      setPlayhead(safeTime);
      // Force seek always uses precise currentTime
      if (Math.abs(video.currentTime - safeTime) > 0.02) {
        video.currentTime = safeTime;
      }
      return;
    }

    if (scrubRafRef.current != null) {
      return;
    }

    scrubRafRef.current = requestAnimationFrame(() => {
      scrubRafRef.current = null;
      if (pendingSeekRef.current != null) {
        setPlayhead(pendingSeekRef.current);
      }
      applySeek();
    });
  }

  function beginScrub() {
    const video = videoRef.current;
    isScrubbingRef.current = true;
    setIsScrubbing(true);
    resumeAfterScrubRef.current = Boolean(video && !video.paused);
    if (video && !video.paused) {
      video.pause();
    }
  }

  function endScrub() {
    isScrubbingRef.current = false;
    setIsScrubbing(false);
    if (scrubRafRef.current != null) {
      cancelAnimationFrame(scrubRafRef.current);
      scrubRafRef.current = null;
    }
    isSeekingRef.current = false;
    if (seekSafetyTimerRef.current != null) {
      window.clearTimeout(seekSafetyTimerRef.current);
      seekSafetyTimerRef.current = null;
    }
    if (pendingSeekRef.current != null) {
      syncVideoTime(pendingSeekRef.current, {force: true});
    }

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLInputElement && activeElement.type === 'range') {
      activeElement.blur();
    }

    const video = videoRef.current;
    if (video && resumeAfterScrubRef.current) {
      resumeAfterScrubRef.current = false;
      void video.play().catch(() => undefined);
    } else {
      resumeAfterScrubRef.current = false;
    }
  }

  function startTrimScroll(edge: 'left' | 'right') {
    trimDraggingRef.current = true;
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
        updateTrimRange(t, trimEndRef.current, 'start');
      } else {
        updateTrimRange(trimStartRef.current, t, 'end');
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
      setClipWindowVersion((v) => v + 1);
    }
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

  function validateLocalCardForm(form: LocalCardFormState): string | null {
    if (!form.user_name.trim()) return '姓名不能为空';
    if (!form.sport_item_id.trim()) return '请选择项目';
    return null;
  }

  function buildLocalCardPayload(form: LocalCardFormState) {
    const total = form.total_overridden && form.total_score.trim() !== ''
      ? form.total_score.trim()
      : computeLocalCardAutoTotal(form);
    return {
      user_name: form.user_name.trim(),
      english_name: form.english_name.trim() || undefined,
      country: form.country.trim() || undefined,
      sport_item_id: Number(form.sport_item_id),
      difficulty_score: form.difficulty_score.trim() || '0',
      execution_score: form.execution_score.trim() || '0',
      bonus_score: form.bonus_score.trim() || '0',
      penalty_score: form.penalty_score.trim() || '0',
      total_score: total,
    };
  }

  async function handleSaveLocalCardDraft() {
    if (!activeVideo || !localCardDraft || localCardSaving) return;
    const validation = validateLocalCardForm(localCardDraft);
    if (validation) {
      setErrorMessage(validation);
      return;
    }
    setLocalCardSaving(true);
    try {
      const response = await createLocalCard(activeVideo.id, buildLocalCardPayload(localCardDraft));
      setProjectState(response.project);
      setLocalCardDraft(null);
      const newSportItemId = response.record.sport_item_id;
      if (newSportItemId != null && scoreApparatusFilter !== 'all' && scoreApparatusFilter !== String(newSportItemId)) {
        setScoreApparatusFilter(String(newSportItemId));
      }
      setErrorMessage(null);
      setSuccessMessage('已创建本地补录卡片');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '创建本地补录卡片失败');
    } finally {
      setLocalCardSaving(false);
    }
  }

  async function handleSaveLocalCardEdit(recordId: string) {
    if (!activeVideo || !editingLocalCardForm || localCardSaving) return;
    const validation = validateLocalCardForm(editingLocalCardForm);
    if (validation) {
      setErrorMessage(validation);
      return;
    }
    setLocalCardSaving(true);
    try {
      const response = await updateLocalCard(activeVideo.id, recordId, buildLocalCardPayload(editingLocalCardForm));
      setProjectState(response.project);
      setEditingLocalCardId(null);
      setEditingLocalCardForm(null);
      setErrorMessage(null);
      setSuccessMessage('已更新本地补录卡片');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '更新本地补录卡片失败');
    } finally {
      setLocalCardSaving(false);
    }
  }

  async function handleDeleteLocalCardClick(recordId: string) {
    if (!activeVideo || localCardSaving) return;
    if (!window.confirm('删除本地补录卡片?已绑定的片段将自动解绑。')) return;
    setLocalCardSaving(true);
    try {
      const response = await deleteLocalCard(activeVideo.id, recordId);
      setProjectState(response.project);
      if (editingLocalCardId === recordId) {
        setEditingLocalCardId(null);
        setEditingLocalCardForm(null);
      }
      setErrorMessage(null);
      setSuccessMessage('已删除本地补录卡片');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '删除本地补录卡片失败');
    } finally {
      setLocalCardSaving(false);
    }
  }

  function startEditingLocalCard(record: PlatformRecord) {
    setLocalCardDraft(null);
    setEditingLocalCardId(record.id);
    setEditingLocalCardForm(localCardRecordToForm(record));
  }

  async function handleDetectActiveVideo() {
    if (!activeVideo) return;
    if (activeDetectJob) return;
    setSuccessMessage(null);
    markVideosQueued([activeVideo.id]);
    try {
      const response = await detectProjectVideo(activeVideo.id, apiKey || undefined);
      setProjectState(response.project);
      setJobs((current) => [response.job, ...current.filter((job) => job.id !== response.job.id)]);
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
        setJobs((current) => [
          ...queuedJobs,
          ...current.filter((job) => !queuedJobs.some((queuedJob) => queuedJob.id === job.id)),
        ]);
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
    const currentIndex = filteredClips.findIndex((clip) => clip.id === clipId);
    const nextClipId = filteredClips[currentIndex + 1]?.id ?? filteredClips[currentIndex - 1]?.id ?? null;

    try {
      const response = await updateClip(clipId, {status});
      setProjectState(response.project);
      if (nextClipId) {
        setActiveClipId(nextClipId);
      }
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '更新片段状态失败');
    }
  }

  async function flushActiveSegmentEdits(): Promise<ActiveSegmentEditSnapshot | null> {
    clearPendingTrimAutoSave();
    if (!activeClip || !activeSegment) return null;
    if (trimSavePromiseRef.current) {
      return trimSavePromiseRef.current;
    }
    const livePlayhead = Number((videoRef.current?.currentTime ?? playhead).toFixed(3));
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
      setPlayhead(splitPoint);
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
      setJobs((current) => [response.job, ...current.filter((job) => job.id !== response.job.id)]);
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

  const trimStartPercent = clipWindowDuration > 0 ? (trimStartLocal / clipWindowDuration) * 100 : 0;
  const trimEndPercent = clipWindowDuration > 0 ? (trimEndLocal / clipWindowDuration) * 100 : 0;
  const playheadPercent = clipWindowDuration > 0 ? (playheadLocal / clipWindowDuration) * 100 : 0;

  function renderVideoProgress(video: ProjectState['videos'][number]) {
    const progress = video.detection_progress || {};
    const stage = String(progress.stage || '');
    const completed = Number(progress.completed || 0);
    const total = Number(progress.total || 0);
    const message = String(progress.message || '');
    const detectJob = activeJobs.find((job) => job.kind === 'detect' && job.video_id === video.id) ?? null;

    if (video.source_kind === 'direct_clip') {
      if (video.status === 'error' && video.error_message) {
        return video.error_message;
      }
      if (video.status === 'done') {
        return '已有片段处理完成';
      }
      return message || '已有片段已导入，可直接绑定或导出';
    }

    if (detectJob?.status === 'queued') {
      return String(detectJob.progress.message || '等待检测任务开始');
    }

    if (video.status === 'detecting') {
      if (total > 0) {
        return `${completed}/${total} ${message || '检测中'}`;
      }
      if (Number(progress.precheck_passed || 0) > 0) {
        return `${Number(progress.precheck_passed || 0)} 已通过预检查`;
      }
      return message || '检测中...';
    }

    if (stage === 'cancel_requested') {
      return message || '正在取消检测...';
    }

    if (stage === 'cancelled') {
      return message || '检测已取消';
    }

    if (stage === 'interrupted') {
      return message || '检测任务已中断，请重新开始';
    }

    if (stage === 'completed') {
      const finalCount = progress.final_count;
      if (typeof finalCount === 'number') {
        if (finalCount === 0) {
          return '检测完成，未识别到候选片段';
        }
        return `检测完成，得到 ${finalCount} 个候选`;
      }
      return '检测完成';
    }

    if (video.status === 'error' && video.error_message) {
      return video.error_message;
    }

    return `${video.reviewed_candidates}/${video.total_candidates} 已审`;
  }

  function renderJobProgress(job: AppJob) {
    const completed = Number(job.progress.completed || 0);
    const total = Number(job.progress.total || 0);
    const message = String(job.progress.message || '');
    const stage = String(job.progress.stage || '');

    if (job.status === 'failed') {
      return job.error_message || '任务失败';
    }
    if (job.status === 'cancelled') {
      return message || '任务已取消';
    }
    if (job.kind === 'export') {
      const aggregateUploadSpeed = Number((job.progress as Record<string, unknown>).aggregate_upload_speed_bps || 0);
      const activeUploadCount = Number((job.progress as Record<string, unknown>).active_upload_count || 0);
      const localExported = Number((job.progress as Record<string, unknown>).local_exported || 0);
      const uploaded = Number((job.progress as Record<string, unknown>).uploaded || 0);
      const synced = Number((job.progress as Record<string, unknown>).synced || 0);
      const operation = String((job.progress as Record<string, unknown>).operation || 'export_and_upload') as ExportOperation;
      if (operation === 'upload_only') {
        const summary = [`上传 ${uploaded}/${total || uploaded}`, `回写 ${synced}`];
        const detail = [
          activeUploadCount > 0 ? `${activeUploadCount} 个文件并行` : '',
          aggregateUploadSpeed > 0 ? formatSpeed(aggregateUploadSpeed) : '',
          message,
        ]
          .filter(Boolean)
          .join(' · ');
        return `${summary.join(' · ')}${detail ? ` · ${detail}` : ''}`.trim();
      }
      if (operation === 'export_only') {
        return `导出 ${localExported}/${total || localExported}${message ? ` · ${message}` : ''}`.trim();
      }
      const detail = [
        activeUploadCount > 0 ? `${activeUploadCount} 个文件并行` : '',
        aggregateUploadSpeed > 0 ? formatSpeed(aggregateUploadSpeed) : '',
        message,
      ]
        .filter(Boolean)
        .join(' · ');
      return `导出 ${localExported}/${total || localExported} · 上传 ${uploaded} · 回写 ${synced}${detail ? ` · ${detail}` : ''}`.trim();
    }
    if (job.kind === 'detect') {
      const currentName = String((job.progress as Record<string, unknown>).current_name || '');
      const stageLabel =
        stage === 'extracting'
          ? '正在采样视频帧'
          : stage === 'start'
            ? '准备开始检测'
            : stage === 'precheck_complete'
              ? '预检查完成'
              : stage === 'detecting'
                ? `AI 检测中${currentName ? `: ${currentName}` : ''}`
                : stage === 'completed'
                  ? '检测完成'
                  : stage === 'cancel_requested'
                    ? '正在取消检测...'
                    : stage === 'cancelled'
                      ? '检测已取消'
                      : '';
      const label = stageLabel || (message && message !== '等待检测任务开始' ? message : '') ||
        (job.status === 'queued' ? '已排队，准备抽帧' : '准备开始检测');
      if (total > 0) {
        return `${completed}/${total} ${label}`.trim();
      }
      return label;
    }
    if (total > 0) {
      return `${completed}/${total} ${message}`.trim();
    }
    return message || (job.status === 'queued' ? '等待开始' : '处理中');
  }

  function renderJobPercent(job: AppJob) {
    const completed = Number(job.progress.completed || 0);
    const total = Number(job.progress.total || 0);
    const stage = String(job.progress.stage || '');
    const completedSteps = Number((job.progress as Record<string, unknown>).completed_steps || 0);
    const totalSteps = Number((job.progress as Record<string, unknown>).total_steps || 0);
    if (job.kind === 'export' && totalSteps > 0) {
      return Math.max(0, Math.min(100, Math.round((completedSteps / totalSteps) * 100)));
    }
    if (total <= 0) return 0;
    if (job.kind === 'export') {
      const operation = String(job.progress.operation || 'export_and_upload') as ExportOperation;
      const stepsPerClip = Number(
        job.progress.steps_per_clip
          || (operation === 'export_only' ? 1 : operation === 'upload_only' ? 2 : 3),
      );
      const totalSteps = Math.max(1, total * stepsPerClip);
      let currentStep = completed * stepsPerClip;
      if (stage === 'completed') {
        currentStep = totalSteps;
      } else if (operation === 'export_only') {
        if (stage === 'local_export') currentStep = completed * stepsPerClip + 1;
      } else if (operation === 'upload_only') {
        if (stage === 'oss_upload') currentStep = completed * stepsPerClip + 1;
        else if (stage === 'platform_callback') currentStep = completed * stepsPerClip + 2;
      } else {
        if (stage === 'local_export') currentStep = completed * stepsPerClip + 1;
        else if (stage === 'oss_upload') currentStep = completed * stepsPerClip + 2;
        else if (stage === 'platform_callback') currentStep = completed * stepsPerClip + 3;
      }
      return Math.max(0, Math.min(100, Math.round((currentStep / totalSteps) * 100)));
    }
    return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
  }

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
      <header className="h-14 border-b border-gray-200 bg-white/80 backdrop-blur-xl flex items-center justify-between px-4 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-red-500 flex items-center justify-center text-white font-bold shadow-sm">
            G
          </div>
          <h1 className="text-gray-900 font-semibold tracking-tight">GymClip Reviewer</h1>
          {toast && (
            <div className="pointer-events-none ml-1 flex items-center self-stretch">
              <div
                className={`max-w-[22rem] rounded-[1.05rem] border px-3 py-1.5 shadow-[0_8px_22px_rgba(15,23,42,0.09)] ring-1 ring-white/70 backdrop-blur-xl transition-all duration-200 ease-out ${
                  toast.kind === 'error'
                    ? 'border-red-200/90 bg-gradient-to-r from-red-50/95 via-white to-red-50/65 text-red-700'
                    : 'border-green-200/90 bg-gradient-to-r from-green-50/95 via-white to-green-50/65 text-green-700'
                } ${isToastVisible ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'}`}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                      toast.kind === 'error'
                        ? 'border-red-200 bg-red-100/90 text-red-600'
                        : 'border-green-200 bg-green-100/90 text-green-600'
                    }`}
                  >
                    {toast.kind === 'error' ? <AlertCircle size={14} strokeWidth={2.25} /> : <CheckCircle2 size={14} strokeWidth={2.25} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`truncate text-[13px] font-medium tracking-[0.01em] ${
                        toast.kind === 'error' ? 'text-red-700' : 'text-green-700'
                      }`}
                    >
                      {toast.message}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="h-10 flex items-center bg-gray-100 rounded-lg px-1.5">
            <button
              onClick={() => setShowApiKey((prev) => !prev)}
              className={`h-8 w-8 flex items-center justify-center rounded-md transition-colors ${showApiKey ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-900'}`}
              title="配置 AI Key"
            >
              <Key size={16} />
            </button>
            <div className={`h-full overflow-hidden transition-all duration-300 ease-in-out flex items-center ${showApiKey ? 'w-[26rem] opacity-100 ml-1.5' : 'w-0 opacity-0'}`}>
              <input
                type="password"
                placeholder="输入 AI API Key..."
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="h-8 bg-transparent border-none focus:outline-none text-sm px-2 w-full text-gray-700 placeholder:text-gray-400"
              />
              {desktopBridge?.isDesktop && (
                <label className={`h-8 flex items-center gap-1.5 px-2 text-xs whitespace-nowrap ${supportsSecureStorage ? 'text-gray-600' : 'text-gray-400'}`}>
                  <input
                    type="checkbox"
                    checked={rememberApiKey}
                    disabled={!supportsSecureStorage}
                    onChange={(event) => setRememberApiKey(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-gray-300"
                  />
                  记住
                </label>
              )}
              {desktopBridge?.isDesktop && apiKey && (
                <button
                  onClick={handleClearSavedApiKey}
                  className="h-8 w-8 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 transition-colors"
                  title="清除已保存的 API Key"
                >
                  <XCircle size={14} />
                </button>
              )}
              {desktopBridge?.isDesktop && supportsSecureStorage && (
                <span className="h-8 flex items-center px-2 text-[11px] text-gray-400 whitespace-nowrap">
                  {isPersistingApiKey ? '保存中...' : rememberApiKey ? '已安全保存' : '仅本次使用'}
                </span>
              )}
            </div>
          </div>

          <div className="w-px h-6 bg-gray-300 mx-1"></div>

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.mkv,.avi,.flv,.wmv"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) {
                void handleImportFiles(event.target.files, 'full_video');
              }
              event.target.value = '';
            }}
          />

          <input
            ref={directClipFileInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.mkv,.avi,.flv,.wmv"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) {
                void handleImportFiles(event.target.files, 'direct_clip');
              }
              event.target.value = '';
            }}
          />

          <button
            onClick={() => void openImportSourcePicker('full_video')}
            className="w-32 h-10 px-3 py-1.5 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium flex items-center justify-center gap-2 whitespace-nowrap transition-colors disabled:opacity-50"
            disabled={isImporting}
          >
            <Upload size={16} />
            {isImporting && importMode === 'full_video' ? '导入中...' : '导入原视频'}
          </button>
          <button
            onClick={() => void openImportSourcePicker('direct_clip')}
            className="w-36 h-10 px-3 py-1.5 text-sm rounded-lg bg-white hover:bg-gray-50 text-gray-700 font-medium flex items-center justify-center gap-2 whitespace-nowrap transition-colors border border-gray-200 disabled:opacity-50"
            disabled={isImporting}
          >
            <FileVideo size={16} />
            {isImporting && importMode === 'direct_clip' ? '导入中...' : '导入已有片段'}
          </button>
          {activeDetectJob ? (
            <button
              onClick={() => activeVideo && void handleCancelDetect(activeVideo.id)}
              className="px-3 py-1.5 text-sm rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 font-medium flex items-center gap-2 border border-amber-200 shadow-sm transition-colors disabled:opacity-50"
              disabled={!activeVideo || activeDetectCancelRequested}
            >
              <XCircle size={16} />
              {activeDetectCancelRequested
                ? '取消中...'
                : activeDetectJob.status === 'queued'
                  ? '取消排队'
                  : '取消检测'}
            </button>
          ) : shouldShowDetectControls ? (
            <button
              onClick={() => void handleDetectPrimaryAction()}
              className="w-32 h-10 px-3 py-1.5 text-sm rounded-lg bg-gray-900 hover:bg-black text-white font-medium flex items-center justify-center gap-2 whitespace-nowrap shadow-sm transition-colors disabled:opacity-50"
              disabled={startDetectCount === 0 || isBatchDetecting}
            >
              <CheckCircle2 size={16} />
              {isBatchDetecting
                ? '加入队列中...'
                : shouldUseSelectedVideosForDetect && startDetectCount > 0
                  ? `开始检测 (${startDetectCount})`
                  : '开始检测'}
            </button>
          ) : (
            <div className="w-32 h-10 px-3 py-1.5 text-sm rounded-lg bg-gray-100 text-gray-500 font-medium flex items-center justify-center whitespace-nowrap">
              无需检测
            </div>
          )}
          <button
            onClick={() => {
              exportApi.setExportOperation('export_and_upload');
              exportApi.setIsOssCredentialsExpanded(!hasOssCredentials);
              exportApi.setIsUploadSettingsExpanded(false);
              setShowExport(true);
            }}
            className="w-32 h-10 px-3 py-1.5 text-sm rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-2 whitespace-nowrap shadow-sm transition-colors disabled:opacity-50"
            disabled={Boolean(activeExportJob)}
          >
            <Download size={16} />
            {activeExportJob ? '导出中...' : '导出片段'}
          </button>
        </div>
      </header>

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
        <aside className={`${isVideoSidebarCollapsed ? 'w-14' : 'w-72'} border-r border-gray-200 bg-gray-50/50 flex flex-col shrink-0 transition-all duration-300`}>
          <div className={`border-b border-gray-200 ${isVideoSidebarCollapsed ? 'p-2' : 'p-4 space-y-3'}`}>
            <div className="flex items-center justify-between gap-3">
              {!isVideoSidebarCollapsed ? (
                <>
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">视频任务 ({videos.length})</h2>
                  <div className="flex items-center gap-2">
                    {selectedVideoIds.size > 0 && (
                      <span className="text-[11px] font-medium text-gray-500">已选 {selectedVideoIds.size}</span>
                    )}
                    <button
                      onClick={() => setIsVideoSidebarCollapsed(true)}
                      className="rounded-lg p-1 text-gray-400 hover:bg-white hover:text-gray-700"
                      title="收起视频栏"
                    >
                      <ChevronLeft size={16} />
                    </button>
                  </div>
                </>
              ) : (
                <button
                  onClick={() => setIsVideoSidebarCollapsed(false)}
                  className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg bg-white text-gray-500 shadow-sm hover:text-gray-900"
                  title="展开视频栏"
                >
                  <ChevronRight size={16} />
                </button>
              )}
            </div>
            {!isVideoSidebarCollapsed && videos.length > 0 && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={toggleSelectAllVideos}
                  className="min-w-0 flex-1 px-2 py-1 text-[11px] rounded-lg bg-white border border-gray-200 text-gray-600 hover:border-gray-300 hover:text-gray-900 transition-colors disabled:opacity-50"
                  disabled={videos.length === 0}
                >
                  {selectedVideoIds.size === videos.length ? '取消全选' : '全选'}
                </button>
                <button
                  onClick={() => void handleCancelSelectedVideos()}
                  className="min-w-0 flex-1 px-2 py-1 text-[11px] rounded-lg bg-white border border-gray-200 text-amber-700 hover:border-amber-200 hover:bg-amber-50 transition-colors disabled:opacity-50"
                  disabled={selectedCancellableVideos.length === 0}
                >
                  批量取消
                </button>
                <button
                  onClick={() => void handleDeleteSelectedVideos()}
                  className="min-w-0 flex-1 px-2 py-1 text-[11px] rounded-lg bg-white border border-gray-200 text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors disabled:opacity-50"
                  disabled={selectedDeletableVideos.length === 0}
                >
                  批量删除
                </button>
              </div>
            )}
          </div>
          <div className={`flex-1 overflow-y-auto ${isVideoSidebarCollapsed ? 'p-2' : 'p-3 space-y-2'}`}>
            {isLoading && !isVideoSidebarCollapsed && <p className="text-sm text-gray-400 px-2">加载项目中...</p>}
            {!isLoading && videos.length === 0 && !isVideoSidebarCollapsed && (
              <div className="text-sm text-gray-400 px-2 py-4">拖拽视频到窗口，或点击顶部“导入视频”。</div>
            )}
            {videoFolders.map((folder) => {
              const folderVideoIds = folder.videos.map((video) => video.id);
              const folderSelectionState = getVideoFolderSelectionState(folderVideoIds);
              const isFolderCollapsed = collapsedVideoFolderIds.includes(folder.id);
              const hasActiveVideo = folder.videos.some((video) => video.id === activeVideoId);

              if (isVideoSidebarCollapsed) {
                const firstVideo = folder.videos[0];
                return (
                  <button
                    key={folder.id}
                    onClick={() => {
                      setActiveVideoId(firstVideo?.id ?? null);
                      setIsVideoSidebarCollapsed(false);
                    }}
                    className={`mb-2 flex h-10 w-10 items-center justify-center rounded-xl border ${
                      hasActiveVideo ? 'bg-white border-gray-300 shadow-sm text-gray-900' : 'border-transparent text-gray-500 hover:bg-white'
                    }`}
                    title={folder.title}
                  >
                    <FileVideo size={16} />
                  </button>
                );
              }

              return (
                <div key={folder.id} className="rounded-xl border border-gray-200 overflow-hidden bg-white">
                  <div className={`w-full px-2.5 py-1.5 flex items-center justify-between gap-2 ${hasActiveVideo ? 'bg-gray-100' : 'bg-gray-50'}`}>
                    <div className="min-w-0 flex flex-1 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleVideoFolder(folder.id)}
                        className="flex items-center justify-center rounded p-0.5 text-gray-400 transition-colors hover:bg-white hover:text-gray-700"
                        title={isFolderCollapsed ? '展开文件夹' : '收起文件夹'}
                      >
                        {isFolderCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                      </button>
                      <TriStateCheckboxButton
                        state={folderSelectionState}
                        disabled={folderVideoIds.length === 0}
                        onClick={() => toggleSelectAllVideosInFolder(folderVideoIds)}
                        title="全选当前文件夹"
                      />
                      <button
                        type="button"
                        onClick={() => toggleVideoFolder(folder.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="text-sm font-medium text-gray-700 truncate">{folder.title}</span>
                      </button>
                    </div>
                    <span className="text-[10px] font-medium text-gray-500 shrink-0">{folder.videos.length} 个</span>
                  </div>
                  {!isFolderCollapsed && (
                    <div className="p-2 space-y-2 border-t border-gray-100">
                      {folder.videos.map((video) => {
                        const videoDetectJob = detectJobsByVideoId.get(video.id) ?? null;
                        const isCancellingVideoDetect =
                          videoDetectJob != null && String(videoDetectJob.progress.stage || '') === 'cancel_requested';
                        const isSelected = selectedVideoIdSet.has(video.id);
                        return (
                          <div
                            key={video.id}
                            onClick={() => setActiveVideoId(video.id)}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setVideoContextMenu({x: event.clientX, y: event.clientY, videoId: video.id});
                            }}
                            className={`w-full cursor-pointer text-left p-3 rounded-xl border transition-all ${
                              activeVideoId === video.id
                                ? 'bg-white border-gray-200 shadow-sm'
                                : 'border-transparent hover:bg-gray-100/80'
                            } ${isSelected ? 'ring-1 ring-gray-300' : ''}`}
                          >
                            <div className="flex items-start gap-3">
                              <label
                                className="mt-0.5 flex items-center cursor-pointer"
                                title="选择该视频"
                              >
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) => {
                                    event.stopPropagation();
                                    toggleVideoSelection(video.id);
                                  }}
                                  className="h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                                />
                              </label>
                              <div className={`mt-0.5 ${videoStatusClass(video.status, video.source_kind)}`}>
                                <FileVideo size={18} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-2">
                                  <p className={`text-sm truncate ${activeVideoId === video.id ? 'text-gray-900 font-semibold' : 'text-gray-700 font-medium'}`}>
                                    {video.file_name}
                                  </p>
                                  <div className="flex shrink-0 items-center gap-1">
                                    {videoDetectJob && (
                                      <button
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void handleCancelDetect(video.id);
                                        }}
                                        disabled={isCancellingVideoDetect}
                                        className="rounded-lg p-1 text-amber-600 hover:bg-amber-50 disabled:opacity-40 disabled:hover:bg-transparent"
                                        title={isCancellingVideoDetect ? '正在取消检测' : videoDetectJob.status === 'queued' ? '取消排队检测' : '取消当前检测'}
                                      >
                                        <XCircle size={14} />
                                      </button>
                                    )}
                                    <button
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void handleDeleteVideo(video.id);
                                      }}
                                      disabled={video.status === 'detecting'}
                                      className="rounded-lg p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400"
                                      title={video.status === 'detecting' ? '检测中无法删除' : '删除视频任务'}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
                                  <span className="flex items-center gap-1">
                                    <Clock size={12} /> {formatDuration(video.duration)}
                                  </span>
                                  <span>{videoStatusLabel(video)}</span>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-400">
                                  {video.category && (
                                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{categoryLabel(video.category)}</span>
                                  )}
                                  {video.venue && (
                                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{video.venue}</span>
                                  )}
                                  {video.sport_item_ids.map((id) => (
                                    <span key={`${video.id}-${id}`} className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">
                                      {formatSportItemLabel(id, video.sex)}
                                    </span>
                                  ))}
                                  {video.team_country && (
                                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{video.team_country}</span>
                                  )}
                                </div>
                                <div className={`mt-1 text-xs ${video.status === 'detecting' ? 'text-orange-500' : video.status === 'error' ? 'text-red-500' : 'text-gray-400'}`}>
                                  {renderVideoProgress(video)}
                                </div>
                                {video.error_message && <div className="mt-1 text-xs text-red-500 truncate">{video.error_message}</div>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        <section className="w-96 border-r border-gray-200 bg-white flex flex-col shrink-0">
          <div className="p-4 border-b border-gray-200 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">候选片段</h2>
              <div className="flex items-center gap-2 text-xs text-gray-500 font-medium">
                {exportTargetClipsCount > 0 && <span>已选 {exportTargetClipsCount}</span>}
                <span>{filteredClips.length} 个结果</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="搜索运动员..."
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  className="w-full bg-gray-100 border-transparent rounded-lg py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:bg-white focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all"
                />
              </div>
              <button className="p-1.5 rounded-lg bg-gray-100 text-gray-600 transition-colors cursor-default">
                <Filter size={16} />
              </button>
            </div>

            <div className="flex p-1 bg-gray-100/80 rounded-lg">
              {(['all', 'pending', 'kept', 'deleted', 'exported'] as const).map((status) => (
                <button
                  key={status}
                  onClick={() => setFilterStatus(status)}
                  className={`flex-1 text-xs py-1.5 rounded-md capitalize font-medium transition-all ${
                    filterStatus === status
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {status === 'all' ? '全部' : statusLabel(status)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {clips.length === 0 && (
              <div className="text-sm text-gray-400 px-2 py-4">导入原视频并完成检测，或直接导入已有片段后，候选片段会显示在这里。</div>
            )}
            {clips.length > 0 && filteredClips.length === 0 && (
              <div className="text-sm text-gray-400 px-2 py-4">当前筛选条件下没有候选片段。</div>
            )}
            {groupedFilteredClips.map(({id, title, video, clips: groupedClips}) => {
              const isCollapsed = collapsedClipGroupIds.includes(id);
              const hasActiveClip = groupedClips.some((clip) => clip.id === activeClipId);
              const groupExportableClipIds = groupedClips
                .filter((clip) => isClipExportSelectable(clip.status))
                .map((clip) => clip.id);
              const groupSelectionState = getClipGroupSelectionState(groupExportableClipIds);

              return (
                <div key={id} className="rounded-xl border border-gray-200 overflow-hidden bg-white">
                  <div
                    className={`w-full px-2.5 py-1.5 flex items-center justify-between gap-2 transition-colors ${
                      hasActiveClip ? 'bg-gray-100' : 'bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    <div className="min-w-0 flex flex-1 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleClipGroup(id)}
                        className="flex items-center justify-center rounded p-0.5 text-gray-400 transition-colors hover:bg-white hover:text-gray-700"
                        title={isCollapsed ? '展开分组' : '收起分组'}
                      >
                        {isCollapsed ? <ChevronDown size={14} className="shrink-0" /> : <ChevronUp size={14} className="shrink-0" />}
                      </button>
                      <TriStateCheckboxButton
                        state={groupSelectionState}
                        disabled={groupExportableClipIds.length === 0}
                        onClick={() => toggleSelectAllClipsInGroup(groupExportableClipIds)}
                        title={groupExportableClipIds.length === 0 ? '当前分组没有可导出的片段' : '全选当前分组可导出的片段'}
                      />
                      <button
                        type="button"
                        onClick={() => toggleClipGroup(id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="text-sm font-medium text-gray-700 truncate">{title}</span>
                      </button>
                    </div>
                    <span className="text-[10px] font-medium text-gray-500 shrink-0">{groupedClips.length} 个</span>
                  </div>

                  {!isCollapsed && (
                    <div className="p-2 space-y-2 border-t border-gray-100">
                      {groupedClips.map((clip) => (
                        (() => {
                          const clipVideo = videoById.get(clip.video_id) ?? null;
                          const linkedRecord = clip.linked_platform_record_id
                            ? platformRecordById.get(clip.linked_platform_record_id) ?? null
                            : null;
                          const theme = linkedRecord ? bindingTheme(linkedRecord.id) : null;
                          const displayName = getClipDisplayName(clip, linkedRecord, clipVideo);
                          const displayCountry = getClipDisplayCountry(clip, linkedRecord);
                          const linkedLabel = linkedRecord
                            ? firstDisplayText(
                              displayName === linkedRecord.english_name ? linkedRecord.user_name : linkedRecord.english_name,
                              linkedRecord.user_name,
                            ) || '已绑定卡片'
                            : null;
                          const isExportSelected = selectedClipIdSet.has(clip.id);
                          const runtimeStatusText = getClipRuntimeStatusText(clip, activeExportJob, lockedExportClipIdSet);

                          return (
                            <button
                              key={clip.id}
                              onClick={(event) => handleClipCardClick(clip, event)}
                              className={`relative w-full text-left p-2.5 rounded-xl border transition-all flex gap-3 ${
                                activeClipId === clip.id
                                  ? 'bg-red-50/60 border-red-200 shadow-sm ring-1 ring-red-100'
                                  : isExportSelected
                                    ? 'bg-red-50/40 border-red-100 shadow-sm hover:bg-red-50/50'
                                    : 'border-transparent hover:bg-gray-50'
                              }`}
                            >
                              {linkedRecord && theme && (
                                <span
                                  className="absolute left-1 top-2 bottom-2 w-1 rounded-full"
                                  style={{backgroundColor: theme.accent}}
                                />
                              )}

                              <div className="relative w-24 h-14 rounded-lg bg-gray-100 shrink-0 overflow-hidden border border-gray-200/50 flex items-center justify-center">
                                <FileVideo size={20} className="text-gray-300" />
                                <div className="absolute bottom-1 right-1 bg-black/60 backdrop-blur-md px-1.5 py-0.5 rounded text-[10px] font-mono text-white font-medium">
                                  {formatDuration(clipEffectiveDuration(clip))}
                                </div>
                              </div>

                              <div className="flex-1 min-w-0 py-0.5 flex flex-col justify-between">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className={`text-sm truncate ${activeClipId === clip.id ? 'text-gray-900 font-semibold' : 'text-gray-700 font-medium'}`}>
                                      {displayName}
                                    </p>
                                    {!linkedRecord && clipVideo?.source_kind === 'direct_clip' && (
                                      <div className="mt-1 text-[11px] text-gray-400 truncate">{clipVideo.file_name}</div>
                                    )}
                                    {linkedLabel && theme && (
                                      <div
                                        className="mt-1 inline-flex max-w-full items-center gap-1.5 text-[11px] font-medium"
                                        style={{
                                          color: theme.text,
                                        }}
                                      >
                                        <span
                                          className="h-2 w-2 rounded-full shrink-0"
                                          style={{backgroundColor: theme.accent}}
                                        />
                                        <span className="truncate">{linkedLabel}</span>
                                      </div>
                                    )}
                                  </div>
                                  <span className="text-xs font-mono text-gray-400 shrink-0">{displayCountry}</span>
                                </div>

                                <div className="flex items-center justify-between mt-1 gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-xs text-gray-500 font-mono">{formatClock(clip.review_start)}</span>
                                    {linkedRecord && theme && (
                                      <span
                                        className="truncate text-[11px] font-medium"
                                        style={{
                                          color: theme.text,
                                        }}
                                      >
                                        片段#{clipOrdinalById.get(clip.id) ?? '--'}
                                      </span>
                                    )}
                                  </div>
                                  {(() => {
                                    const uploadItem = getClipUploadItem(activeExportJob, clip.id);
                                    const activeJobClipId = String(activeExportJob?.progress.clip_id || '');
                                    const activeStage = activeJobClipId === clip.id ? String(activeExportJob?.progress.stage || '') : '';
                                    const failureStage = getClipFailureStage(clip);

                                    if (failureStage) {
                                      const failLabels: Record<string, string> = {export: '导出失败', oss: 'OSS失败', platform: '回写失败'};
                                      return (
                                        <span className="inline-flex items-center gap-0.5">
                                          <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('danger')}`}>
                                            {failLabels[failureStage] ?? '失败'}
                                          </span>
                                          <button
                                            type="button"
                                            className="p-0.5 rounded hover:bg-gray-100 text-red-500"
                                            title="重试"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              void retryClipStage(clip.id, failureStage as 'export' | 'oss' | 'platform', {
                                                output_dir: savedOutputDir || undefined,
                                                oss_access_key_id: ossAccessKeyId.trim() || undefined,
                                                oss_access_key_secret: ossAccessKeySecret.trim() || undefined,
                                              }).then((res) => {
                                                if (res.project) setProjectState(res.project);
                                              }).catch(() => undefined);
                                            }}
                                          >
                                            <RefreshCw size={12} />
                                          </button>
                                        </span>
                                      );
                                    }

                                    if (activeStage === 'local_export') {
                                      return <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}>导出中</span>;
                                    }
                                    if (uploadItem?.stage === 'oss_upload' || activeStage === 'oss_upload') {
                                      const pct = uploadItem && uploadItem.percent > 0 ? ` ${Math.round(uploadItem.percent)}%` : '';
                                      return <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}>OSS上传中{pct}</span>;
                                    }
                                    if (uploadItem?.stage === 'platform_callback' || activeStage === 'platform_callback') {
                                      return <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}>回写中</span>;
                                    }

                                    if (clip.platform_sync_status === 'synced') {
                                      return <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('success')}`}>已回写</span>;
                                    }
                                    if (clip.uploaded_url || clip.platform_sync_status === 'uploading_done') {
                                      if (uploadItem?.stage === 'queued' || lockedExportClipIdSet.has(clip.id)) {
                                        return <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}>回写队列中</span>;
                                      }
                                      return <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('success')}`}>已上传</span>;
                                    }
                                    if (clip.exported_path) {
                                      if (uploadItem?.stage === 'queued' || lockedExportClipIdSet.has(clip.id)) {
                                        return <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}>上传队列中</span>;
                                      }
                                      return <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('success')}`}>已导出</span>;
                                    }
                                    if (lockedExportClipIdSet.has(clip.id)) {
                                      return <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}>导出队列中</span>;
                                    }

                                    return <StatusBadge status={clip.status} />;
                                  })()}
                                </div>
                                {runtimeStatusText && (
                                  <div className="mt-1 text-[11px] text-amber-600 truncate">{runtimeStatusText}</div>
                                )}
                              </div>
                            </button>
                          );
                        })()
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="flex-1 bg-gray-50/30 flex flex-col min-w-0">
          {activeClip && activeVideo ? (
            <>
              <div className="flex-1 p-8 flex flex-col min-h-0">
                <div className="flex-1 min-h-0 w-full flex items-center justify-center">
                  <div className="w-full max-h-full max-w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-xl border border-gray-200/50 relative group">
                    <video
                      key={streamUrl}
                      ref={videoRef}
                      src={streamUrl}
                      className="w-full h-full object-contain bg-black"
                      controls={false}
                      preload="auto"
                      onError={() => setVideoPlaybackError(activeVideo.error_message || '视频加载失败，请确认源文件仍存在。')}
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
                          onClick={togglePlayPause}
                          className="w-12 h-12 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white backdrop-blur-md transition-colors pointer-events-auto"
                        >
                          {isPlaying ? <Pause size={24} /> : <Play size={24} className="ml-1" />}
                        </button>
                        <div className="flex-1 h-1.5 bg-white/30 rounded-full overflow-hidden">
                          <div className="h-full bg-white rounded-full transition-all duration-75" style={{width: `${playheadPercent}%`}}></div>
                        </div>
                        <span className="text-sm font-mono text-white drop-shadow-md">
                          {formatClock(playheadLocal)} / {formatDuration(clipWindowDuration)}
                        </span>
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
                      {isSavingTrim && (
                        <span className="text-red-500">保存中...</span>
                      )}
                      {activeClipLockedByExport && (
                        <span className="text-amber-600">当前片段在导出批次中，只读</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="h-auto pt-6 pb-6 px-8 border-t border-gray-200 bg-white flex flex-col shrink-0 shadow-[0_-4px_20px_rgba(0,0,0,0.02)] z-10 overflow-hidden">
                <div className="mb-4 relative">
                  <div
                    className="w-full h-16 bg-gray-100 rounded-xl border border-gray-200/80 overflow-hidden relative shadow-inner select-none"
                    ref={(el) => { if (el) el.dataset.timelineContainer = 'true'; }}
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).dataset.handleEdge) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                      const time = clipWindowStart + fraction * clipWindowDuration;
                      beginScrub();
                      syncVideoTime(time, {force: false});

                      const onMove = (ev: PointerEvent) => {
                        const f = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
                        const t = clipWindowStart + f * clipWindowDuration;
                        syncVideoTime(t, {force: false});
                      };
                      const onUp = () => {
                        document.removeEventListener('pointermove', onMove);
                        document.removeEventListener('pointerup', onUp);
                        endScrub();
                      };
                      document.addEventListener('pointermove', onMove);
                      document.addEventListener('pointerup', onUp);
                      e.preventDefault();
                    }}
                  >
                    <div className="absolute inset-0 flex pointer-events-none">
                      {timelineThumbnails.length > 0 ? (
                        timelineThumbnails.map((frame) => (
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
                          {isLoadingThumbnails ? '生成缩略图中...' : '暂无缩略图'}
                        </div>
                      )}
                    </div>
                    <div className="absolute inset-0 bg-black/10 pointer-events-none" />
                    {activeClipSegments.map((segment) => {
                      const isCurrent = activeSegment?.id === segment.id;
                      const displayStart = isCurrent ? trimStart : segment.start;
                      const displayEnd = isCurrent ? trimEnd : segment.end;
                      const left = clipWindowDuration > 0 ? ((displayStart - clipWindowStart) / clipWindowDuration) * 100 : 0;
                      const right = clipWindowDuration > 0 ? 100 - (((displayEnd - clipWindowStart) / clipWindowDuration) * 100) : 0;
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
                          {isCurrent && !activeClipLockedByExport && (
                            <>
                              <div
                                data-handle-edge="left"
                                className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-ew-resize z-40 pointer-events-auto group/handle"
                                title="拖动调整起点"
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  const containerEl = e.currentTarget.closest('[data-timeline-container]') as HTMLElement;
                                  if (!containerEl) return;
                                  trimRectRef.current = containerEl.getBoundingClientRect();
                                  trimPointerXRef.current = e.clientX;
                                  beginScrub();
                                  startTrimScroll('left');
                                  const onMove = (ev: PointerEvent) => {
                                    trimPointerXRef.current = ev.clientX;
                                    trimRectRef.current = containerEl.getBoundingClientRect();
                                  };
                                  const onUp = () => {
                                    document.removeEventListener('pointermove', onMove);
                                    document.removeEventListener('pointerup', onUp);
                                    stopTrimScroll();
                                    endScrub();
                                  };
                                  document.addEventListener('pointermove', onMove);
                                  document.addEventListener('pointerup', onUp);
                                }}
                              >
                                <div className="absolute inset-y-0 left-1 w-1 rounded-full bg-red-500/50 group-hover/handle:bg-red-500 group-hover/handle:w-1.5 group-hover/handle:left-0.5 transition-all" />
                              </div>
                              <div
                                data-handle-edge="right"
                                className="absolute -right-1.5 top-0 bottom-0 w-3 cursor-ew-resize z-40 pointer-events-auto group/handle"
                                title="拖动调整终点"
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  const containerEl = e.currentTarget.closest('[data-timeline-container]') as HTMLElement;
                                  if (!containerEl) return;
                                  trimRectRef.current = containerEl.getBoundingClientRect();
                                  trimPointerXRef.current = e.clientX;
                                  beginScrub();
                                  startTrimScroll('right');
                                  const onMove = (ev: PointerEvent) => {
                                    trimPointerXRef.current = ev.clientX;
                                    trimRectRef.current = containerEl.getBoundingClientRect();
                                  };
                                  const onUp = () => {
                                    document.removeEventListener('pointermove', onMove);
                                    document.removeEventListener('pointerup', onUp);
                                    stopTrimScroll();
                                    endScrub();
                                  };
                                  document.addEventListener('pointermove', onMove);
                                  document.addEventListener('pointerup', onUp);
                                }}
                              >
                                <div className="absolute inset-y-0 right-1 w-1 rounded-full bg-red-500/50 group-hover/handle:bg-red-500 group-hover/handle:w-1.5 group-hover/handle:right-0.5 transition-all" />
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)] z-30 pointer-events-none"
                      style={{left: `${playheadPercent}%`}}
                    />
                  </div>
                </div>

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
                      type="button"
                      onClick={() => {
                        const video = videoRef.current;
                        if (!video) return;
                        if (video.paused) {
                          void video.play().catch(() => undefined);
                        } else {
                          video.pause();
                        }
                      }}
                      className="w-10 h-10 flex items-center justify-center rounded-full bg-red-500 hover:bg-red-600 text-white shadow-md transition-colors"
                    >
                      {isPlaying ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
                    </button>
                    <div className="flex gap-6 text-xs text-gray-500 font-mono">
                      <span>起点 <span className="text-gray-800 font-semibold">{formatClock(trimStart)}</span></span>
                      <span>播放 <span className="text-red-600 font-semibold">{formatClock(playhead)}</span></span>
                      <span>终点 <span className="text-gray-800 font-semibold">{formatClock(trimEnd)}</span></span>
                    </div>
                  </div>
                  <div className="text-xs text-gray-400">
                    时长 {formatClock(Math.max(0, trimEnd - trimStart))}
                  </div>
                </div>

                <div className="flex flex-wrap items-start justify-end gap-x-4 gap-y-1 mb-4 text-[10px] text-gray-400">
                  {[
                    {keys: ['Space'], label: '播放'},
                    {keys: ['←', '→'], label: '快进退'},
                    {keys: ['↑', '↓'], label: '切换'},
                    {keys: ['A', 'D'], label: '左边界'},
                    {keys: ['J', 'L'], label: '右边界'},
                    {keys: ['B'], label: '拆分'},
                    {keys: ['C'], label: '删除'},
                    {keys: ['N'], label: '独立'},
                  ].map(({keys, label}) => (
                    <span key={label} className="flex flex-col items-center gap-0.5">
                      <span className="flex gap-0.5">
                        {keys.map((k) => (
                          <kbd key={k} className="bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5 text-gray-500 font-sans font-medium shadow-sm text-[11px] leading-tight">{k}</kbd>
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
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
              <AlertCircle size={48} className="mb-4 opacity-20" />
              <p className="font-medium">
                {activeVideo ? '请在中间选择一个候选片段进行审核' : '请先导入原视频或已有片段'}
              </p>
            </div>
          )}
        </section>

        <aside className={`${activeClip ? 'w-[19rem] border-l border-gray-200' : 'w-0'} bg-white flex flex-col shrink-0 overflow-hidden transition-all duration-300`}>
          {activeClip && (
            <>
              <div className="p-4 border-b border-gray-200 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">成绩卡片</h2>
                    <div className="mt-1 text-sm font-medium text-gray-900">
                      {activeVideo ? `${activeScopeSummary.matchText} · ${activeScopeSummary.venueText}` : '未选择视频'}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {activeVideo ? `${categoryLabel(activeVideo.category)} · ${activeVideo.file_name}` : '平台成绩卡片'}
                    </div>
                  </div>
                  {activeVideo && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingLocalCardId(null);
                        setEditingLocalCardForm(null);
                        setLocalCardDraft((current) =>
                          current ?? {...emptyLocalCardForm(), sport_item_id: lastUsedLocalSportItemId},
                        );
                      }}
                      disabled={localCardDraft != null}
                      title="新增本地补录卡片"
                      className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                    >
                      + 本地补录
                    </button>
                  )}
                </div>

                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    placeholder="搜索姓名或国家..."
                    value={scoreSearchQuery}
                    onChange={(event) => setScoreSearchQuery(event.target.value)}
                    className="w-full bg-gray-100 border-transparent rounded-lg py-2 pl-9 pr-3 text-sm focus:outline-none focus:bg-white focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all"
                  />
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  <ScoreFilterDropdown
                    id="apparatus"
                    placeholder="项目"
                    allLabel="全部项目"
                    value={scoreApparatusFilter}
                    options={scoreApparatusOptions}
                    openFilter={openScoreFilter}
                    onToggle={setOpenScoreFilter}
                    onChange={setScoreApparatusFilter}
                  />
                  <ScoreFilterDropdown
                    id="sex"
                    placeholder="性别"
                    allLabel="全部性别"
                    value={scoreSexFilter}
                    options={scoreSexOptions}
                    openFilter={openScoreFilter}
                    onToggle={setOpenScoreFilter}
                    onChange={setScoreSexFilter}
                  />
                  <ScoreFilterDropdown
                    id="country"
                    placeholder="国家"
                    allLabel="全部国家"
                    value={scoreCountryFilter}
                    options={scoreCountryOptions}
                    openFilter={openScoreFilter}
                    onToggle={setOpenScoreFilter}
                    onChange={setScoreCountryFilter}
                  />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-gray-50/40">
                {!activeVideo && (
                  <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-500">
                    当前没有选中视频。
                  </div>
                )}
                {activeVideo && videoScopedPlatformRecords.length === 0 && !localCardDraft && (
                  <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-500">
                    当前视频上下文没有查到平台成绩卡片。请检查导入时选择的比赛、场次和项目；或点击右上角「+ 本地补录」手动添加。
                  </div>
                )}
                {activeVideo && videoScopedPlatformRecords.length > 0 && filteredPlatformRecords.length === 0 && localPlatformRecords.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-500">
                    当前筛选条件下没有命中的成绩卡片。
                  </div>
                )}
                {localCardDraft && activeVideo && (
                  <LocalCardInlineForm
                    form={localCardDraft}
                    setForm={(updater) => setLocalCardDraft((prev) => (prev ? updater(prev) : prev))}
                    onSave={() => void handleSaveLocalCardDraft()}
                    onCancel={() => setLocalCardDraft(null)}
                    saving={localCardSaving}
                    title="新建本地补录卡片"
                    nameSuggestions={localCardNameSuggestions}
                  />
                )}
                {activeVideo && localPlatformRecords.length > 0 && (
                  <div className="space-y-2">
                    <div className="px-1 text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                      本地补录
                    </div>
                    {localPlatformRecords.map((entry) => {
                      const isActive = activeClip.linked_platform_record_id === entry.id;
                      const isBound = entry.linked_clip_ids.length > 0;
                      const isBoundElsewhere = isBound && !entry.linked_clip_ids.includes(activeClip.id);
                      const theme = bindingTheme(entry.id);
                      const linkedClipLabels = entry.linked_clip_ids
                        .map((clipId) => clipOrdinalById.get(clipId))
                        .filter((value): value is number => value != null)
                        .map((value) => `#${value}`);
                      const bindingLabel = isActive
                        ? `片段${linkedClipLabels[0] ?? `#${clipOrdinalById.get(activeClip.id) ?? '--'}`}`
                        : isBoundElsewhere
                          ? `片段${linkedClipLabels[0]}`
                          : null;

                      if (editingLocalCardId === entry.id && editingLocalCardForm) {
                        return (
                          <React.Fragment key={entry.id}>
                            <LocalCardInlineForm
                              form={editingLocalCardForm}
                              setForm={(updater) => setEditingLocalCardForm((prev) => (prev ? updater(prev) : prev))}
                              onSave={() => void handleSaveLocalCardEdit(entry.id)}
                              onCancel={() => {
                                setEditingLocalCardId(null);
                                setEditingLocalCardForm(null);
                              }}
                              saving={localCardSaving}
                              title="编辑本地补录卡片"
                              onDelete={() => void handleDeleteLocalCardClick(entry.id)}
                              nameSuggestions={localCardNameSuggestions}
                            />
                          </React.Fragment>
                        );
                      }

                      return (
                        <button
                          key={entry.id}
                          type="button"
                          disabled={isBoundElsewhere || activeClipLockedByExport}
                          onClick={(event) => {
                            event.currentTarget.blur();
                            if (isBoundElsewhere || activeClipLockedByExport) return;
                            void handleBindScoreCard(isActive ? null : entry.id);
                          }}
                          className={`relative w-full rounded-2xl border border-amber-200 bg-amber-50/40 px-3 py-2.5 text-left transition-all shadow-[0_6px_18px_rgba(15,23,42,0.05)] ${
                            isActive
                              ? 'hover:border-amber-300'
                              : isBoundElsewhere || activeClipLockedByExport
                                ? 'cursor-not-allowed opacity-90'
                                : 'hover:border-amber-300 hover:shadow-[0_10px_24px_rgba(15,23,42,0.08)]'
                          }`}
                        >
                          {(isActive || isBound) && (
                            <span
                              className="absolute left-1 top-2 bottom-2 w-1 rounded-full"
                              style={{backgroundColor: theme.accent}}
                            />
                          )}
                          <div className="absolute right-2 top-2 flex items-center gap-1">
                            <span className="rounded-full bg-amber-200/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                              本地补录
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(event) => {
                                event.stopPropagation();
                                event.preventDefault();
                                startEditingLocalCard(entry);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.stopPropagation();
                                  event.preventDefault();
                                  startEditingLocalCard(entry);
                                }
                              }}
                              className="cursor-pointer rounded-md border border-amber-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-100"
                            >
                              编辑
                            </span>
                          </div>
                          <div className="flex items-start justify-between gap-3 pr-20">
                            <div className="min-w-0">
                              <p className="text-[15px] font-semibold leading-5 text-gray-900 truncate">
                                {entry.english_name || entry.user_name || '未命名'}
                              </p>
                              {entry.user_name && (
                                <div className="mt-0.5 text-[11px] text-gray-500 truncate">{entry.user_name}</div>
                              )}
                              <div className="mt-1 text-[11px] text-gray-500 truncate">
                                {(entry.country || '--')} · {(entry.sport_item_label || '--')}
                              </div>
                              <div className="mt-2 text-[11px] font-semibold text-black whitespace-nowrap overflow-hidden text-ellipsis">
                                {scoreFormulaLabel(entry)}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-xl font-bold text-black">{primaryScoreValue(entry)}</div>
                              {bindingLabel && (
                                <div
                                  className="mt-1 text-[11px] font-medium"
                                  style={{color: theme.text}}
                                >
                                  {bindingLabel}
                                </div>
                              )}
                            </div>
                          </div>
                          {!isBound && (
                            <div className="mt-2 text-[11px] text-gray-400">
                              {activeClipLockedByExport ? '导出批次中，只读' : '可绑定'}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {groupedPlatformRecords.map((matchGroup) => (
                  <div key={matchGroup.matchName} className="space-y-2">
                    <div className="px-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                      {matchGroup.matchName}
                    </div>
                    {matchGroup.venues.map((venueGroup) => (
                      <div key={`${matchGroup.matchName}-${venueGroup.venue}`} className="space-y-2">
                        <div className="px-1 text-[11px] text-gray-400">{venueGroup.venue}</div>
                        {venueGroup.records.map((entry) => {
                          const isActive = activeClip.linked_platform_record_id === entry.id;
                          const isBound = entry.linked_clip_ids.length > 0;
                          const isBoundElsewhere = isBound && !entry.linked_clip_ids.includes(activeClip.id);
                          const theme = bindingTheme(entry.id);
                          const linkedClipLabels = entry.linked_clip_ids
                            .map((clipId) => clipOrdinalById.get(clipId))
                            .filter((value): value is number => value != null)
                            .map((value) => `#${value}`);
                          const displayVenue = entry.category === 'EF' ? '' : (entry.venue || activeVideo?.venue || '');
                          const bindingLabel = isActive
                            ? `片段${linkedClipLabels[0] ?? `#${clipOrdinalById.get(activeClip.id) ?? '--'}`}`
                            : isBoundElsewhere
                              ? `片段${linkedClipLabels[0]}`
                              : null;

                          return (
                            <button
                              key={entry.id}
                              type="button"
                              disabled={isBoundElsewhere || activeClipLockedByExport}
                              onClick={(event) => {
                                event.currentTarget.blur();
                                if (isBoundElsewhere || activeClipLockedByExport) return;
                                void handleBindScoreCard(isActive ? null : entry.id);
                              }}
                              className={`relative w-full rounded-2xl border border-gray-200/80 bg-white px-3 py-2.5 text-left transition-all shadow-[0_6px_18px_rgba(15,23,42,0.05)] ${
                                isActive
                                  ? 'hover:border-gray-200'
                                  : isBoundElsewhere || activeClipLockedByExport
                                    ? 'cursor-not-allowed opacity-90'
                                    : 'hover:border-gray-200 hover:shadow-[0_10px_24px_rgba(15,23,42,0.08)]'
                              }`}
                            >
                              {(isActive || isBound) && (
                                <span
                                  className="absolute left-1 top-2 bottom-2 w-1 rounded-full"
                                  style={{backgroundColor: theme.accent}}
                                />
                              )}
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-[15px] font-semibold leading-5 text-gray-900 truncate">
                                    {entry.english_name || entry.user_name || '未命名'}
                                  </p>
                                  {entry.user_name && (
                                    <div className="mt-0.5 text-[11px] text-gray-500 truncate">{entry.user_name}</div>
                                  )}
                                  <div className="mt-1 text-[11px] text-gray-500 truncate">
                                    {(entry.country || '--')} · {(entry.sport_item_label || '--')}
                                  </div>
                                  {displayVenue && (
                                    <div className="mt-0.5 text-[11px] text-gray-400 truncate">{displayVenue}</div>
                                  )}
                                  <div className="mt-2 text-[11px] font-semibold text-black whitespace-nowrap overflow-hidden text-ellipsis">
                                    {scoreFormulaLabel(entry)}
                                  </div>
                                </div>
                                <div className="shrink-0 text-right">
                                  <div className="text-xl font-bold text-black">{primaryScoreValue(entry)}</div>
                                  {entry.vault_attempt != null && (
                                    <div className="text-[11px] text-gray-500">第 {entry.vault_attempt} 跳</div>
                                  )}
                                  {entry.single_score && (
                                    <div className="text-[11px] text-gray-500">单跳 {formatScoreValue(entry.single_score)}</div>
                                  )}
                                  {bindingLabel && (
                                    <div
                                      className="mt-1 text-[11px] font-medium"
                                      style={{color: theme.text}}
                                    >
                                      {bindingLabel}
                                    </div>
                                  )}
                                </div>
                              </div>
                              {!isBound && (
                                <div className="mt-2 text-[11px] text-gray-400">
                                  {activeClipLockedByExport ? '导出批次中，只读' : '可绑定'}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
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
