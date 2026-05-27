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
  Minus,
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
  fetchPlatformFrequencies,
  fetchPlatformMatches,
  fetchPlatformRecords,
  fetchJobs,
  fetchProject,
  fetchVideoThumbnails,
  getVideoStreamUrl,
  importDirectClipFiles,
  importProjectFiles,
  previewScopePlatformRecords,
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
  PlatformCategory,
  PlatformFrequency,
  PlatformMatch,
  PlatformRecord,
  PlatformScope,
  PlatformScopeQuery,
  ProjectState,
  SourceKind,
  ThumbnailFrame,
  VideoStatus,
} from './types';

type FilterStatus = ClipStatus | 'all';
type ExportMode = 'standard' | 'fast';
type ExportOperation = 'export_only' | 'upload_only' | 'export_and_upload';
type ImportMode = 'full_video' | 'direct_clip';
type DesktopImportSource = {
  path: string;
  name: string;
  size: number;
};

type PendingImportVideo = {
  clientFileId: string;
  file: File | null;
  path: string | null;
  name: string;
  sizeBytes: number;
  matchId: string | null;
  selectedFrequencies: PlatformFrequency[];
  manualSportKeys: string[];
};

type PendingDirectClipFile = {
  clientFileId: string;
  file: File | null;
  path: string | null;
  name: string;
  sizeBytes: number;
};

type LocalCardFormState = {
  user_name: string;
  english_name: string;
  country: string;
  sport_item_id: string;
  difficulty_score: string;
  execution_score: string;
  bonus_score: string;
  penalty_score: string;
  total_score: string;
  total_overridden: boolean;
};

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

type ApparatusOption = {
  id: number;
  label: string;
};

type ScoreFilterMenu = 'apparatus' | 'sex' | 'country';
type ScoreFilterOption = {
  value: string;
  label: string;
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
type DesktopNotificationPayload = {
  title: string;
  subtitle?: string;
  body?: string;
};
type ExportJobSummary = {
  operation: ExportOperation;
  attempted: number;
  exported: number;
  failed: number;
  uploaded: number;
  synced: number;
  output_directory: string;
};
type ToastKind = 'success' | 'error';
type AppToast = {
  id: number;
  kind: ToastKind;
  message: string;
};

const MAG_OPTIONS: ApparatusOption[] = [
  {id: 0, label: 'FX'},
  {id: 1, label: 'PH'},
  {id: 2, label: 'SR'},
  {id: 3, label: 'VT'},
  {id: 4, label: 'PB'},
  {id: 5, label: 'HB'},
];

const WAG_OPTIONS: ApparatusOption[] = [
  {id: 3, label: 'VT'},
  {id: 6, label: 'UB'},
  {id: 7, label: 'BB'},
  {id: 0, label: 'FX'},
];

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

const CATEGORY_OPTIONS: Array<{value: PlatformCategory; label: string}> = [
  {value: 'EF', label: '单项决赛'},
  {value: 'AA', label: '全能'},
  {value: 'TF', label: '团体'},
  {value: 'QF', label: '资格赛'},
];

const SEX_LABELS: Record<number, string> = {
  1: '男子',
  2: '女子',
};

type VenueDerivedSelection = {
  sex: number | null;
  sportItemId: number | null;
};

const CLIP_STEP = 0.2;
const MIN_SEGMENT_DURATION = 0.5;
const DEFAULT_EXPORT_DIRECTORY_STORAGE_KEY = 'gymclip-default-output-dir';
const UPLOAD_PARALLEL_FILES_STORAGE_KEY = 'gymclip-upload-parallel-files';
const UPLOAD_PART_THREADS_STORAGE_KEY = 'gymclip-upload-part-threads';
const EXPORT_LOCKED_CLIP_MESSAGE = '该片段在当前导出批次中，导出完成前不可编辑';
const EXPORT_LOCKED_RESTORE_MESSAGE = '当前有导出任务进行中，暂不支持撤销结构编辑';
const EXPORT_MODE_DETAILS: Record<ExportMode, {label: string; description: string}> = {
  standard: {
    label: '标准',
    description: '兼容性优先，默认模式。适合大多数导出场景。',
  },
  fast: {
    label: '快速',
    description: '更快导出，但压缩效率更低，文件通常更大。',
  },
};
const EXPORT_OPERATION_DETAILS: Record<ExportOperation, {label: string; description: string}> = {
  export_only: {
    label: '仅导出',
    description: '只执行本地导出，不上传 OSS，也不回写平台。',
  },
  upload_only: {
    label: '仅上传',
    description: '使用已有本地导出文件上传 OSS，并在成功后继续回写平台。',
  },
  export_and_upload: {
    label: '导出+上传',
    description: '默认模式：先本地导出，再上传 OSS，并对已绑定片段回写平台。',
  },
};

function normalizeJobCount(value: unknown): number {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function summarizeExportJob(job: AppJob, fallbackOutputDir: string): ExportJobSummary {
  const operation = String(job.progress.operation || 'export_and_upload') as ExportOperation;
  return {
    operation,
    attempted: normalizeJobCount(job.result.attempted),
    exported: normalizeJobCount(job.result.exported),
    failed: normalizeJobCount(job.result.failed),
    uploaded: normalizeJobCount(job.result.uploaded),
    synced: normalizeJobCount(job.result.synced),
    output_directory: String(job.result.output_directory || fallbackOutputDir || ''),
  };
}

function formatNotificationCount(label: string, completed: number, total: number): string {
  if (total > 0) {
    return `${label}：${completed}/${total}`;
  }
  return `${label}：${completed}`;
}

function truncateNotificationText(value: string, maxLength = 96): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatNotificationTargetCount(count: number): string {
  return `目标片段：${count}`;
}

function formatNotificationResultSummary(summary: ExportJobSummary): string {
  if (summary.failed > 0) {
    return `部分完成，失败 ${summary.failed}`;
  }
  return '全部完成';
}

function extractOutputDirectoryLabel(outputDirectory: string): string {
  const trimmed = outputDirectory.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  const folderName = segments[segments.length - 1] || trimmed;
  return truncateNotificationText(folderName, 28);
}

function buildExportCompletedNotification(summary: ExportJobSummary): DesktopNotificationPayload {
  const title = summary.failed > 0
    ? `${EXPORT_OPERATION_DETAILS[summary.operation].label}完成（部分失败）`
    : `${EXPORT_OPERATION_DETAILS[summary.operation].label}完成`;
  const outputDirectoryLabel = extractOutputDirectoryLabel(summary.output_directory);
  const lines = [
    summary.operation !== 'upload_only' && outputDirectoryLabel ? `输出目录：${outputDirectoryLabel}` : '',
    summary.operation !== 'upload_only' ? formatNotificationCount('本地导出', summary.exported, summary.attempted) : '',
    summary.operation !== 'export_only' ? formatNotificationCount('OSS 上传', summary.uploaded, summary.attempted) : '',
    summary.operation !== 'export_only' ? `平台回写：${summary.synced}` : '',
    `失败：${summary.failed}`,
  ].filter(Boolean);
  return {
    title,
    subtitle: `${formatNotificationTargetCount(summary.attempted)} · ${formatNotificationResultSummary(summary)}`,
    body: lines.join('\n'),
  };
}

function buildExportFailedNotification(job: AppJob, fallbackOutputDir: string): DesktopNotificationPayload {
  const summary = summarizeExportJob(job, fallbackOutputDir);
  const errorMessage = truncateNotificationText(job.error_message || '任务执行失败');
  const outputDirectoryLabel = extractOutputDirectoryLabel(summary.output_directory);
  const lines = [
    summary.operation !== 'upload_only' && outputDirectoryLabel ? `输出目录：${outputDirectoryLabel}` : '',
    summary.operation !== 'upload_only' ? formatNotificationCount('已导出', summary.exported, summary.attempted) : '',
    summary.operation !== 'export_only' ? formatNotificationCount('已上传', summary.uploaded, summary.attempted) : '',
    summary.operation !== 'export_only' ? `已回写：${summary.synced}` : '',
    summary.failed > 0 ? `失败：${summary.failed}` : '',
    `原因：${errorMessage}`,
  ].filter(Boolean);
  return {
    title: `${EXPORT_OPERATION_DETAILS[summary.operation].label}失败`,
    subtitle: `${formatNotificationTargetCount(summary.attempted)} · 已中断`,
    body: lines.join('\n'),
  };
}

function loadBrowserDefaultExportDirectory(): string {
  try {
    return window.localStorage.getItem(DEFAULT_EXPORT_DIRECTORY_STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

function saveBrowserDefaultExportDirectory(nextPath: string): void {
  try {
    const trimmed = nextPath.trim();
    if (trimmed) {
      window.localStorage.setItem(DEFAULT_EXPORT_DIRECTORY_STORAGE_KEY, trimmed);
    } else {
      window.localStorage.removeItem(DEFAULT_EXPORT_DIRECTORY_STORAGE_KEY);
    }
  } catch {
    // ignore localStorage failures in browser preview
  }
}

function loadBrowserUploadSettings(): {uploadParallelFiles: number; uploadPartThreads: number} {
  try {
    const uploadParallelFiles = Number(window.localStorage.getItem(UPLOAD_PARALLEL_FILES_STORAGE_KEY) || 2);
    const uploadPartThreads = Number(window.localStorage.getItem(UPLOAD_PART_THREADS_STORAGE_KEY) || 4);
    return {
      uploadParallelFiles: Number.isFinite(uploadParallelFiles) && uploadParallelFiles > 0 ? uploadParallelFiles : 2,
      uploadPartThreads: Number.isFinite(uploadPartThreads) && uploadPartThreads > 0 ? uploadPartThreads : 4,
    };
  } catch {
    return {uploadParallelFiles: 2, uploadPartThreads: 4};
  }
}

function saveBrowserUploadSettings(uploadParallelFiles: number, uploadPartThreads: number): void {
  try {
    window.localStorage.setItem(UPLOAD_PARALLEL_FILES_STORAGE_KEY, String(Math.max(1, uploadParallelFiles)));
    window.localStorage.setItem(UPLOAD_PART_THREADS_STORAGE_KEY, String(Math.max(1, uploadPartThreads)));
  } catch {
    // ignore localStorage failures in browser preview
  }
}

function firstDisplayText(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return '';
}

function formatDuration(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '--:--';
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatBytes(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Math.max(0, value);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatSpeed(value?: number | null): string {
  if (value == null || Number.isNaN(value) || value <= 0) return '--';
  return `${formatBytes(value)}/s`;
}

function formatClock(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '--:--:--';
  const totalSeconds = Math.max(0, value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function toUploadItem(value: unknown): ExportUploadItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const clipId = String(item.clip_id || '').trim();
  const fileName = String(item.file_name || '').trim();
  if (!clipId || !fileName) return null;
  return {
    clip_id: clipId,
    file_name: fileName,
    stage: String(item.stage || '').trim(),
    bytes_sent: Number(item.bytes_sent || 0),
    total_bytes: Number(item.total_bytes || 0),
    percent: Number(item.percent || 0),
    speed_bps: Number(item.speed_bps || 0),
    error_message: item.error_message == null ? null : String(item.error_message),
  };
}

function getJobUploadItems(job: AppJob | null): ExportUploadItem[] {
  if (!job) return [];
  const rawItems = (job.progress as Record<string, unknown>).upload_items;
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((item) => toUploadItem(item))
    .filter((item): item is ExportUploadItem => item != null);
}

function getClipUploadItem(job: AppJob | null, clipId: string): ExportUploadItem | null {
  return getJobUploadItems(job).find((item) => item.clip_id === clipId) ?? null;
}

function getJobTargetClipIds(job: AppJob | null): string[] {
  if (!job) return [];
  const rawTargetClipIds = (job.progress as Record<string, unknown>).target_clip_ids;
  if (!Array.isArray(rawTargetClipIds)) return [];
  return rawTargetClipIds
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0);
}

function getExportQueueStatusLabel(job: AppJob | null): string {
  const operation = String(job?.progress.operation || 'export_and_upload') as ExportOperation;
  return operation === 'upload_only' ? '上传队列中' : '导出队列中';
}

function statusLabel(status: ClipStatus | VideoStatus): string {
  switch (status) {
    case 'pending':
      return '待审';
    case 'kept':
      return '保留';
    case 'deleted':
      return '已删';
    case 'exported':
      return '已导出';
    case 'queued':
      return '待处理';
    case 'detecting':
      return '检测中';
    case 'no_candidates':
      return '无候选';
    case 'ready_for_review':
      return '待审核';
    case 'reviewing':
      return '审核中';
    case 'done':
      return '已完成';
    case 'error':
      return '异常';
    default:
      return status;
  }
}

function clipBadgeClass(status: ClipStatus): string {
  switch (status) {
    case 'kept':
      return 'bg-green-50 text-green-700 border-green-200';
    case 'deleted':
      return 'bg-red-50 text-red-700 border-red-200';
    case 'exported':
      return 'bg-sky-50 text-sky-700 border-sky-200';
    case 'pending':
    default:
      return 'bg-amber-50 text-amber-700 border-amber-200';
  }
}

function videoStatusClass(status: VideoStatus, sourceKind: SourceKind = 'full_video'): string {
  if (sourceKind === 'direct_clip') {
    switch (status) {
      case 'error':
        return 'text-red-500';
      case 'done':
      case 'reviewing':
        return 'text-green-600';
      default:
        return 'text-sky-500';
    }
  }
  switch (status) {
    case 'detecting':
      return 'text-orange-500';
    case 'error':
      return 'text-red-500';
    case 'no_candidates':
      return 'text-slate-500';
    case 'done':
      return 'text-green-600';
    default:
      return 'text-red-500';
  }
}

function videoStatusLabel(video: ProjectState['videos'][number]): string {
  if (video.source_kind === 'direct_clip') {
    if (video.status === 'error') return '异常';
    if (video.status === 'done') return '已完成';
    return '已就绪';
  }
  return statusLabel(video.status);
}

function categoryLabel(value: string | null | undefined): string {
  if (!value) return '未选择';
  return CATEGORY_OPTIONS.find((item) => item.value === value)?.label ?? value;
}

function compactJoin(values: string[], maxVisible: number = 2): string {
  const filtered = values.filter((value) => value.trim().length > 0);
  if (filtered.length <= maxVisible) {
    return filtered.join(' / ');
  }
  return `${filtered.slice(0, maxVisible).join(' / ')} 等 ${filtered.length} 项`;
}

function formatScopeFolderLabel(scope: PlatformScope | null): string {
  if (!scope) return '已有片段';
  const matchNames = Array.from(
    new Set(scope.query_groups.map((query) => query.match_name).filter((value) => value.trim().length > 0)),
  );
  const venues = Array.from(
    new Set(scope.query_groups.flatMap((query) => query.venues).filter((value) => value.trim().length > 0)),
  );
  const matchText = matchNames.length > 0 ? compactJoin(matchNames, 1) : '已有片段';
  const venueText = venues.length > 0 ? compactJoin(venues, 2) : '';
  return venueText ? `${matchText} · ${venueText}` : matchText;
}

function normalizeCategory(value: string | null | undefined): PlatformCategory | '' {
  if (value === 'EF' || value === 'AA' || value === 'TF' || value === 'QF') {
    return value;
  }
  return '';
}

function formatSportItemLabel(id: number | null | undefined, sex?: number | null): string {
  if (id == null) return '--';
  const base = SPORT_ITEM_LABELS[id] ?? String(id);
  if (sex === 1) return `男子${base}`;
  if (sex === 2) return `女子${base}`;
  return base;
}

function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function createPendingImportVideo(file: File | DesktopImportSource): PendingImportVideo {
  const isBrowserFile = file instanceof File;
  return {
    clientFileId: `import_${crypto.randomUUID()}`,
    file: isBrowserFile ? file : null,
    path: isBrowserFile ? null : file.path,
    name: isBrowserFile ? file.name : file.name,
    sizeBytes: isBrowserFile ? file.size : file.size,
    matchId: null,
    selectedFrequencies: [],
    manualSportKeys: [],
  };
}

function createPendingDirectClipFile(file: File | DesktopImportSource): PendingDirectClipFile {
  const isBrowserFile = file instanceof File;
  return {
    clientFileId: `clip_${crypto.randomUUID()}`,
    file: isBrowserFile ? file : null,
    path: isBrowserFile ? null : file.path,
    name: isBrowserFile ? file.name : file.name,
    sizeBytes: isBrowserFile ? file.size : file.size,
  };
}

function isDesktopImportSource(entry: File | DesktopImportSource): entry is DesktopImportSource {
  return !(entry instanceof File);
}

function sportKey(sex: number, sportItemId: number): string {
  return `${sex}:${sportItemId}`;
}

function parseSportKey(value: string): {sex: number; sportItemId: number} | null {
  const [rawSex, rawSportItemId] = value.split(':');
  const sex = Number(rawSex);
  const sportItemId = Number(rawSportItemId);
  if (![1, 2].includes(sex) || Number.isNaN(sportItemId)) return null;
  return {sex, sportItemId};
}

function toggleSportKey(current: string[], next: string): string[] {
  return current.includes(next)
    ? current.filter((item) => item !== next)
    : [...current, next];
}

function normalizeVenueText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, '');
}

function deriveSelectionFromVenue(venue: string): VenueDerivedSelection {
  const normalized = normalizeVenueText(venue);
  const sex = normalized.includes('男子') ? 1 : normalized.includes('女子') ? 2 : null;
  const mapping: Array<{sportItemId: number; labels: string[]}> = [
    {sportItemId: 0, labels: ['自由体操', '自由操']},
    {sportItemId: 1, labels: ['鞍马']},
    {sportItemId: 2, labels: ['吊环']},
    {sportItemId: 3, labels: ['跳马']},
    {sportItemId: 4, labels: ['双杠']},
    {sportItemId: 5, labels: ['单杠']},
    {sportItemId: 6, labels: ['高低杠', '高低双杠']},
    {sportItemId: 7, labels: ['平衡木']},
  ];
  for (const item of mapping) {
    if (item.labels.some((label) => normalized.includes(label))) {
      return {sex, sportItemId: item.sportItemId};
    }
  }
  return {sex, sportItemId: null};
}

function firstNonEmptyScore(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function parseNumericScore(value: unknown): number | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const direct = Number(text);
  if (Number.isFinite(direct)) return direct;
  const match = text.match(/[+-]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatScoreValue(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return '--';
  const numeric = parseNumericScore(text);
  if (!Number.isFinite(numeric)) return '--';
  return numeric.toFixed(3);
}

function deriveDisplayedScore(record: PlatformRecord): string {
  if (record.sport_item_id === 3) {
    const singleScore = parseNumericScore(record.single_score);
    if (singleScore != null) return singleScore.toFixed(3);
    const difficulty = parseNumericScore(record.difficulty_score);
    const execution = parseNumericScore(record.execution_score);
    if (difficulty != null && execution != null) {
      const bonus = parseNumericScore(record.bonus_score) ?? 0;
      const penalty = parseNumericScore(record.penalty_score) ?? 0;
      return (difficulty + execution + bonus + penalty).toFixed(3);
    }
    return '--';
  }
  const totalScore = parseNumericScore(record.total_score);
  if (totalScore != null) return totalScore.toFixed(3);
  const singleScore = parseNumericScore(record.single_score);
  if (singleScore != null) return singleScore.toFixed(3);
  return '--';
}

function formatScoreExpression(values: string[]): string {
  return values.reduce((result, value, index) => {
    if (index === 0) return value;
    return /^[+-]/.test(value) ? `${result}${value}` : `${result}+${value}`;
  }, '');
}

function isZeroScore(value: string): boolean {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric === 0;
}

function scoreFormulaLabel(record: PlatformRecord): string {
  const rawRecord = (record.raw_record ?? {}) as Record<string, unknown>;
  const d = firstNonEmptyScore(record.difficulty_score, rawRecord.difficultyScore, rawRecord.difficulty_score) ?? '0';
  const e = firstNonEmptyScore(record.execution_score, rawRecord.executionScore, rawRecord.execution_score) ?? '0';
  const b = firstNonEmptyScore(record.bonus_score, rawRecord.bscore, rawRecord.bonusScore, rawRecord.bonus_score) ?? '0';
  const p = firstNonEmptyScore(record.penalty_score, rawRecord.penaltyScore, rawRecord.penalty_score) ?? '0';
  const total = deriveDisplayedScore(record);
  const parts = [d, e];
  if (!isZeroScore(b)) {
    parts.push(b);
  }
  if (!isZeroScore(p)) {
    parts.push(p);
  }
  return `${formatScoreExpression(parts.map((value) => formatScoreValue(value)))}=${formatScoreValue(total)}`;
}

function primaryScoreValue(record: PlatformRecord): string {
  return deriveDisplayedScore(record);
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function bindingTheme(recordId: string) {
  const hue = hashString(recordId) % 360;
  return {
    accent: `hsl(${hue} 72% 46%)`,
    accentSoft: `hsla(${hue}, 85%, 94%, 1)`,
    accentStrong: `hsla(${hue}, 90%, 90%, 1)`,
    border: `hsla(${hue}, 62%, 72%, 1)`,
    text: `hsl(${hue} 55% 32%)`,
  };
}

function orderedSegments(clip: CandidateClip): ClipSegment[] {
  return [...clip.segments].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}

function clipEffectiveDuration(clip: CandidateClip): number {
  return orderedSegments(clip).reduce((total, segment) => total + Math.max(0, segment.end - segment.start), 0);
}

function isClipExportSelectable(status: ClipStatus): boolean {
  return status === 'kept' || status === 'exported';
}

function isDirectSourceUploadEligible(
  clip: CandidateClip,
  video?: ProjectState['videos'][number] | null,
): boolean {
  if (!video || video.source_kind !== 'direct_clip' || video.duration == null) return false;
  const segments = orderedSegments(clip);
  if (segments.length !== 1) return false;
  const tolerance = 0.05;
  const duration = Number(video.duration);
  return (
    Math.abs(segments[0].start - 0) <= tolerance
    && Math.abs(segments[0].end - duration) <= tolerance
    && Math.abs(clip.review_start - 0) <= tolerance
    && Math.abs(clip.review_end - duration) <= tolerance
    && Math.abs(clip.candidate_start - 0) <= tolerance
    && Math.abs(clip.candidate_end - duration) <= tolerance
  );
}

function getUploadOnlySourceMode(
  clip: CandidateClip,
  video?: ProjectState['videos'][number] | null,
): 'exported_file' | 'direct_source' | 'invalid' {
  if (clip.exported_path) return 'exported_file';
  if (isDirectSourceUploadEligible(clip, video)) return 'direct_source';
  return 'invalid';
}

function getClipDisplayName(
  clip: CandidateClip,
  linkedRecord?: PlatformRecord | null,
  video?: ProjectState['videos'][number] | null,
): string {
  return firstDisplayText(
    linkedRecord?.english_name,
    linkedRecord?.user_name,
    clip.athlete_name,
    video?.source_kind === 'direct_clip' ? stripFileExtension(video.file_name) : '',
  ) || '未识别';
}

function getClipDisplayCountry(clip: CandidateClip, linkedRecord?: PlatformRecord | null): string {
  return firstDisplayText(linkedRecord?.country, clip.country) || '--';
}

function coerceRecordSex(value: unknown): number | null {
  if (value === 1 || value === 2) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '1' || trimmed === '男' || trimmed === '男子' || trimmed.toUpperCase() === 'M') return 1;
    if (trimmed === '2' || trimmed === '女' || trimmed === '女子' || trimmed.toUpperCase() === 'W') return 2;
  }
  return null;
}

function deriveSexFromText(...values: Array<string | null | undefined>): number | null {
  const merged = values.join('');
  if (merged.includes('男子') || merged.includes('男')) return 1;
  if (merged.includes('女子') || merged.includes('女')) return 2;
  return null;
}

function deriveSexFromSelectionKeys(selectionKeys: string[], sportItemId: number | null | undefined): number | null {
  if (sportItemId == null) return null;
  const matched = new Set<number>();
  selectionKeys.forEach((key) => {
    const parsed = parseSportKey(key);
    if (!parsed || parsed.sportItemId !== sportItemId) return;
    matched.add(parsed.sex);
  });
  if (matched.size === 1) return Array.from(matched)[0];
  return null;
}

function deriveSexFromSportItemId(sportItemId: number | null | undefined): number | null {
  if (sportItemId == null) return null;
  if ([1, 2, 4, 5].includes(sportItemId)) return 1;
  if ([6, 7].includes(sportItemId)) return 2;
  return null;
}

function getResolvedPlatformRecordSex(
  record: PlatformRecord,
  video?: ProjectState['videos'][number] | null,
): number | null {
  const explicitSex = coerceRecordSex(record.sex) ?? coerceRecordSex(record.raw_record?.sex) ?? coerceRecordSex(video?.sex);
  if (explicitSex != null) return explicitSex;
  const fromSelection = deriveSexFromSelectionKeys(video?.sport_selection_keys ?? [], record.sport_item_id);
  if (fromSelection != null) return fromSelection;
  const fromText = deriveSexFromText(
    record.venue,
    typeof record.raw_record?.venue === 'string' ? record.raw_record.venue : '',
    video?.venue ?? '',
    ...(video?.venues ?? []),
  );
  if (fromText != null) return fromText;
  return deriveSexFromSportItemId(record.sport_item_id);
}

function getClipSearchText(
  clip: CandidateClip,
  linkedRecord?: PlatformRecord | null,
  video?: ProjectState['videos'][number] | null,
): string {
  return [
    getClipDisplayName(clip, linkedRecord, video),
    linkedRecord?.english_name ?? '',
    linkedRecord?.user_name ?? '',
    clip.athlete_name,
    getClipDisplayCountry(clip, linkedRecord),
    clip.country,
    video?.file_name ?? '',
    video ? stripFileExtension(video.file_name) : '',
  ]
    .join(' ')
    .toLowerCase();
}

function getClipFailureStage(clip: CandidateClip): 'export' | 'oss' | 'platform' | null {
  if (clip.platform_sync_status !== 'failed') return null;
  if (!clip.exported_path) return 'export';
  if (clip.uploaded_url) return 'platform';
  if (clip.linked_platform_record_id) return 'oss';
  return 'export';
}

function pipelineToneClass(tone: PipelineTone): string {
  switch (tone) {
    case 'success':
      return 'bg-green-50 text-green-700 border-green-200';
    case 'warning':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'danger':
      return 'bg-red-50 text-red-700 border-red-200';
    case 'muted':
      return 'bg-slate-100 text-slate-500 border-slate-200';
    case 'neutral':
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200';
  }
}

function getClipPipelineBadges(
  clip: CandidateClip,
  options: {
    linkedRecord: PlatformRecord | null;
    activeExportJob: AppJob | null;
    lockedExportClipIdSet: ReadonlySet<string>;
  },
): ClipPipelineBadgeItem[] {
  const {activeExportJob, lockedExportClipIdSet} = options;
  const uploadItem = getClipUploadItem(activeExportJob, clip.id);
  const activeJobClipId = String(activeExportJob?.progress.clip_id || '');
  const activeStage = activeJobClipId === clip.id ? String(activeExportJob?.progress.stage || '') : '';
  if (activeStage === 'local_export') {
    return [
      {key: 'export', text: '导出中', tone: 'warning'},
      {key: 'oss', text: 'OSS 未上传', tone: 'neutral'},
      {key: 'platform', text: '平台 未上传', tone: 'neutral'},
    ];
  }
  if (uploadItem?.stage === 'oss_upload' || activeStage === 'oss_upload') {
    return [
      {key: 'export', text: '已导出', tone: 'success'},
      {
        key: 'oss',
        text: uploadItem && uploadItem.percent > 0 ? `OSS ${Math.round(uploadItem.percent)}%` : 'OSS 上传中',
        tone: 'warning',
      },
      {key: 'platform', text: '平台 未上传', tone: 'neutral'},
    ];
  }
  if (uploadItem?.stage === 'platform_callback' || activeStage === 'platform_callback') {
    return [
      {key: 'export', text: '已导出', tone: 'success'},
      {key: 'oss', text: 'OSS 已上传', tone: 'success'},
      {key: 'platform', text: '平台 上传中', tone: 'warning'},
    ];
  }
  if (uploadItem?.stage === 'queued') {
    return [
      {key: 'export', text: clip.exported_path ? '已导出' : getExportQueueStatusLabel(activeExportJob), tone: clip.exported_path ? 'success' : 'warning'},
      {key: 'oss', text: 'OSS 排队中', tone: 'warning'},
      {key: 'platform', text: '平台 未上传', tone: 'neutral'},
    ];
  }
  if (lockedExportClipIdSet.has(clip.id)) {
    return [
      {key: 'export', text: getExportQueueStatusLabel(activeExportJob), tone: 'warning'},
      {key: 'oss', text: 'OSS 未上传', tone: 'neutral'},
      {key: 'platform', text: '平台 未上传', tone: 'neutral'},
    ];
  }

  const failureStage = getClipFailureStage(clip);
  if (failureStage === 'export') {
    return [
      {key: 'export', text: '导出失败', tone: 'danger'},
      {key: 'oss', text: 'OSS 未上传', tone: 'neutral'},
      {key: 'platform', text: '平台 未上传', tone: 'neutral'},
    ];
  }

  if (!clip.exported_path) {
    return [
      {key: 'export', text: '未导出', tone: 'neutral'},
      {key: 'oss', text: 'OSS 未上传', tone: 'neutral'},
      {key: 'platform', text: '平台 未上传', tone: 'neutral'},
    ];
  }

  if (failureStage === 'oss') {
    return [
      {key: 'export', text: '已导出', tone: 'success'},
      {key: 'oss', text: 'OSS 上传失败', tone: 'danger'},
      {key: 'platform', text: '平台 未上传', tone: 'neutral'},
    ];
  }

  if (failureStage === 'platform') {
    return [
      {key: 'export', text: '已导出', tone: 'success'},
      {key: 'oss', text: 'OSS 已上传', tone: 'success'},
      {key: 'platform', text: '平台 上传失败', tone: 'danger'},
    ];
  }

  if (clip.platform_sync_status === 'synced') {
    return [
      {key: 'export', text: '已导出', tone: 'success'},
      {key: 'oss', text: 'OSS 已上传', tone: 'success'},
      {key: 'platform', text: '平台 已上传', tone: 'success'},
    ];
  }

  if (clip.uploaded_url || clip.platform_sync_status === 'uploading_done') {
    return [
      {key: 'export', text: '已导出', tone: 'success'},
      {key: 'oss', text: 'OSS 已上传', tone: 'success'},
      {key: 'platform', text: '平台 未上传', tone: 'neutral'},
    ];
  }

  return [
    {key: 'export', text: '已导出', tone: 'success'},
    {key: 'oss', text: 'OSS 未上传', tone: 'neutral'},
    {key: 'platform', text: '平台 未上传', tone: 'neutral'},
  ];
}

function getClipRuntimeStatusText(
  clip: CandidateClip,
  activeExportJob: AppJob | null,
  lockedExportClipIdSet: ReadonlySet<string>,
): string | null {
  const uploadItem = getClipUploadItem(activeExportJob, clip.id);
  const activeJobClipId = String(activeExportJob?.progress.clip_id || '');
  const activeStage = activeJobClipId === clip.id ? String(activeExportJob?.progress.stage || '') : '';
  if (activeStage === 'local_export') {
    return '本地导出中';
  }
  if (!uploadItem) {
    return lockedExportClipIdSet.has(clip.id) ? `${getExportQueueStatusLabel(activeExportJob)}（只读）` : null;
  }
  if (uploadItem.stage === 'oss_upload') {
    if (uploadItem.bytes_sent <= 0 || uploadItem.percent <= 0 || uploadItem.speed_bps <= 0) {
      return '等待上传';
    }
    return `OSS ${Math.round(uploadItem.percent)}% · ${formatSpeed(uploadItem.speed_bps)}`;
  }
  if (uploadItem.stage === 'platform_callback') {
    return '平台回写中';
  }
  if (uploadItem.stage === 'failed') {
    return uploadItem.error_message || '上传失败';
  }
  if (uploadItem.stage === 'completed') {
    return '上传完成';
  }
  if (uploadItem.stage === 'queued') {
    return '等待上传（只读）';
  }
  return null;
}

function normalizeSegments(
  _clip: CandidateClip,
  segments: ClipSegment[],
): ClipSegment[] {
  const sorted = [...segments]
    .map((segment) => ({
      ...segment,
      start: Number(segment.start.toFixed(3)),
      end: Number(segment.end.toFixed(3)),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));

  let previousEnd: number | null = null;
  return sorted.map((segment) => {
    const start = Math.max(previousEnd ?? 0, segment.start);
    const end = Math.max(start + CLIP_STEP, segment.end);
    previousEnd = end;
    return {
      ...segment,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    };
  });
}

function firstEditableSegment(clip: CandidateClip): ClipSegment | null {
  return orderedSegments(clip)[0] ?? null;
}

function cloneCandidateClips(clips: CandidateClip[]): CandidateClip[] {
  return clips.map((clip) => ({
    ...clip,
    segments: clip.segments.map((segment) => ({...segment})),
  }));
}

function selectionSummaryLabel(selectionKeys: string[]): string {
  if (selectionKeys.length === 0) return '未选择项目';
  return selectionKeys
    .map((key) => parseSportKey(key))
    .filter((item): item is {sex: number; sportItemId: number} => item != null)
    .map((item) => formatSportItemLabel(item.sportItemId, item.sex))
    .join(' / ');
}

function StatusBadge({
  status,
  size = 'sm',
}: {
  status: ClipStatus;
  size?: 'sm' | 'lg';
}) {
  const sizeClass = size === 'lg' ? 'text-sm px-3 py-1.5 min-w-[5rem]' : 'text-[11px] px-2.5 py-1 min-w-[3.5rem]';
  return (
    <span className={`inline-flex items-center justify-center whitespace-nowrap leading-none rounded-full border font-medium shrink-0 ${sizeClass} ${clipBadgeClass(status)}`}>
      {statusLabel(status)}
    </span>
  );
}

function TriStateCheckboxButton({
  state,
  disabled = false,
  onClick,
  title,
}: {
  state: 'checked' | 'indeterminate' | 'unchecked';
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
        disabled
          ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-300'
          : state === 'unchecked'
            ? 'border-gray-300 bg-white text-gray-500 hover:border-gray-400'
            : 'border-red-200 bg-red-50 text-red-600 hover:border-red-300'
      }`}
    >
      {state === 'checked' && <Check size={11} strokeWidth={3} />}
      {state === 'indeterminate' && <Minus size={11} strokeWidth={3} />}
    </button>
  );
}

function ScoreFilterDropdown({
  id,
  placeholder,
  allLabel,
  value,
  options,
  openFilter,
  onToggle,
  onChange,
}: {
  id: ScoreFilterMenu;
  placeholder: string;
  allLabel: string;
  value: string;
  options: ScoreFilterOption[];
  openFilter: ScoreFilterMenu | null;
  onToggle: (next: ScoreFilterMenu | null) => void;
  onChange: (nextValue: string) => void;
}) {
  const isOpen = openFilter === id;
  const selectedLabel = value === 'all'
    ? placeholder
    : options.find((option) => option.value === value)?.label ?? placeholder;

  return (
    <div data-score-filter-root className="relative">
      <button
        type="button"
        onClick={() => onToggle(isOpen ? null : id)}
        className="flex w-full min-w-[5.8rem] items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm transition-colors hover:border-gray-300"
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={14} className={`shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
          <div className="max-h-64 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => {
                onChange('all');
                onToggle(null);
              }}
              className={`flex w-full items-center px-3 py-2 text-left text-sm transition-colors ${
                value === 'all' ? 'bg-red-50 text-red-600' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {allLabel}
            </button>
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  onToggle(null);
                }}
                className={`flex w-full items-center px-3 py-2 text-left text-sm transition-colors ${
                  value === option.value ? 'bg-red-50 text-red-600' : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function emptyLocalCardForm(): LocalCardFormState {
  return {
    user_name: '',
    english_name: '',
    country: '',
    sport_item_id: '',
    difficulty_score: '',
    execution_score: '',
    bonus_score: '',
    penalty_score: '',
    total_score: '',
    total_overridden: false,
  };
}

function localCardRecordToForm(record: PlatformRecord): LocalCardFormState {
  return {
    user_name: record.user_name || '',
    english_name: record.english_name || '',
    country: record.country || '',
    sport_item_id: record.sport_item_id != null ? String(record.sport_item_id) : '',
    difficulty_score: record.difficulty_score || '',
    execution_score: record.execution_score || '',
    bonus_score: record.bonus_score || '',
    penalty_score: record.penalty_score || '',
    total_score: record.total_score || '',
    total_overridden: true,
  };
}

function parseScoreNumber(value: string): number {
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function computeLocalCardAutoTotal(form: LocalCardFormState): string {
  const total =
    parseScoreNumber(form.difficulty_score) +
    parseScoreNumber(form.execution_score) +
    parseScoreNumber(form.bonus_score) -
    parseScoreNumber(form.penalty_score);
  return total.toFixed(3).replace(/\.?0+$/, '') || '0';
}

const LOCAL_CARD_SPORT_OPTIONS: Array<{value: string; label: string}> = Object.entries(SPORT_ITEM_LABELS).map(
  ([id, label]) => ({value: id, label: `${label} (${id})`}),
);

function stopFormShortcutPropagation(event: React.KeyboardEvent<HTMLElement>) {
  event.stopPropagation();
}

type LocalCardInlineFormProps = {
  form: LocalCardFormState;
  setForm: (updater: (prev: LocalCardFormState) => LocalCardFormState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  title: string;
  onDelete?: () => void;
  nameSuggestions?: string[];
};

const LOCAL_CARD_NAME_DATALIST_ID = 'local-card-name-suggestions';

function LocalCardInlineForm({
  form,
  setForm,
  onSave,
  onCancel,
  saving,
  title,
  onDelete,
  nameSuggestions,
}: LocalCardInlineFormProps) {
  const autoTotal = computeLocalCardAutoTotal(form);
  const totalDisplay = form.total_overridden && form.total_score.trim() !== '' ? form.total_score : autoTotal;
  return (
    <div
      className="rounded-2xl border border-amber-300 bg-amber-50/70 p-3 shadow-sm space-y-2.5"
      onKeyDown={stopFormShortcutPropagation}
    >
      {nameSuggestions && nameSuggestions.length > 0 && (
        <datalist id={LOCAL_CARD_NAME_DATALIST_ID}>
          {nameSuggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-200/70 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
          本地补录
        </span>
        <span className="text-[11px] text-amber-700">{title}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px] text-amber-900">
          姓名 *
          <input
            type="text"
            value={form.user_name}
            onChange={(event) => setForm((prev) => ({...prev, user_name: event.target.value}))}
            list={nameSuggestions && nameSuggestions.length > 0 ? LOCAL_CARD_NAME_DATALIST_ID : undefined}
            autoComplete="off"
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          英文名
          <input
            type="text"
            value={form.english_name}
            onChange={(event) => setForm((prev) => ({...prev, english_name: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          国家
          <input
            type="text"
            value={form.country}
            onChange={(event) => setForm((prev) => ({...prev, country: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          项目 *
          <select
            value={form.sport_item_id}
            onChange={(event) => setForm((prev) => ({...prev, sport_item_id: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          >
            <option value="">-- 选择 --</option>
            {LOCAL_CARD_SPORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <label className="block text-[11px] text-amber-900">
          难度 D
          <input
            type="number"
            step="0.1"
            value={form.difficulty_score}
            onChange={(event) => setForm((prev) => ({...prev, difficulty_score: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          执行 E
          <input
            type="number"
            step="0.1"
            value={form.execution_score}
            onChange={(event) => setForm((prev) => ({...prev, execution_score: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          加点
          <input
            type="number"
            step="0.1"
            value={form.bonus_score}
            onChange={(event) => setForm((prev) => ({...prev, bonus_score: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          扣分
          <input
            type="number"
            step="0.1"
            value={form.penalty_score}
            onChange={(event) => setForm((prev) => ({...prev, penalty_score: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
      </div>
      <label className="block text-[11px] text-amber-900">
        总分 {!form.total_overridden && <span className="text-[10px] text-amber-700">(自动 = D + E + 加点 − 扣分)</span>}
        <div className="mt-0.5 flex items-center gap-2">
          <input
            type="number"
            step="0.001"
            value={totalDisplay}
            onChange={(event) => setForm((prev) => ({...prev, total_score: event.target.value, total_overridden: true}))}
            className="w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm font-semibold text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
          {form.total_overridden && (
            <button
              type="button"
              onClick={() => setForm((prev) => ({...prev, total_score: '', total_overridden: false}))}
              className="text-[11px] text-amber-700 underline hover:text-amber-900"
            >
              恢复自动
            </button>
          )}
        </div>
      </label>
      <div className="flex items-center justify-end gap-2 pt-1">
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            className="mr-auto inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-[12px] text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            删除
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-gray-200 bg-white px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded-md border border-amber-600 bg-amber-600 px-3 py-1 text-[12px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
}

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
  const [isImporting, setIsImporting] = useState(false);
  const [videoContextMenu, setVideoContextMenu] = useState<{x: number; y: number; videoId: string} | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>('full_video');
  const [pendingImportVideos, setPendingImportVideos] = useState<PendingImportVideo[]>([]);
  const [pendingDirectClipFiles, setPendingDirectClipFiles] = useState<PendingDirectClipFile[]>([]);
  const [directClipSelectedMatchIds, setDirectClipSelectedMatchIds] = useState<string[]>([]);
  const [directClipSelectedFrequenciesByMatchId, setDirectClipSelectedFrequenciesByMatchId] = useState<Record<string, PlatformFrequency[]>>({});
  const [directClipManualSportKeys, setDirectClipManualSportKeys] = useState<string[]>([]);
  const [directClipPreview, setDirectClipPreview] = useState<{count: number | null; loading: boolean; error: string | null; cacheKey: string | null}>({
    count: null,
    loading: false,
    error: null,
    cacheKey: null,
  });
  const [platformMatches, setPlatformMatches] = useState<PlatformMatch[]>([]);
  const [isLoadingPlatformMatches, setIsLoadingPlatformMatches] = useState(false);
  const [platformFrequenciesByMatchId, setPlatformFrequenciesByMatchId] = useState<Record<string, PlatformFrequency[]>>({});
  const [loadingFrequencyMatchIds, setLoadingFrequencyMatchIds] = useState<Record<string, boolean>>({});
  const [previewByImportId, setPreviewByImportId] = useState<Record<string, {count: number | null; loading: boolean; error: string | null}>>({});
  const [showExport, setShowExport] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [rememberApiKey, setRememberApiKey] = useState(false);
  const [supportsSecureStorage, setSupportsSecureStorage] = useState(false);
  const [isPersistingApiKey, setIsPersistingApiKey] = useState(false);
  const [ossAccessKeyId, setOssAccessKeyId] = useState('');
  const [ossAccessKeySecret, setOssAccessKeySecret] = useState('');
  const [isPersistingOssCredentials, setIsPersistingOssCredentials] = useState(false);
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([]);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [isBatchDetecting, setIsBatchDetecting] = useState(false);
  const [collapsedClipGroupIds, setCollapsedClipGroupIds] = useState<string[]>([]);
  const [collapsedVideoFolderIds, setCollapsedVideoFolderIds] = useState<string[]>([]);
  const [isVideoSidebarCollapsed, setIsVideoSidebarCollapsed] = useState(false);
  const [outputDir, setOutputDir] = useState('');
  const [savedOutputDir, setSavedOutputDir] = useState('');
  const [exportMode, setExportMode] = useState<ExportMode>('standard');
  const [exportOperation, setExportOperation] = useState<ExportOperation>('export_and_upload');
  const [uploadParallelFiles, setUploadParallelFiles] = useState(2);
  const [uploadPartThreads, setUploadPartThreads] = useState(4);
  const [isUploadSettingsExpanded, setIsUploadSettingsExpanded] = useState(false);
  const [scoreSearchQuery, setScoreSearchQuery] = useState('');
  const [scoreApparatusFilter, setScoreApparatusFilter] = useState('all');
  const [scoreSexFilter, setScoreSexFilter] = useState('all');
  const [scoreCountryFilter, setScoreCountryFilter] = useState('all');
  const [openScoreFilter, setOpenScoreFilter] = useState<ScoreFilterMenu | null>(null);
  const [localCardDraft, setLocalCardDraft] = useState<LocalCardFormState | null>(null);
  const [editingLocalCardId, setEditingLocalCardId] = useState<string | null>(null);
  const [editingLocalCardForm, setEditingLocalCardForm] = useState<LocalCardFormState | null>(null);
  const [localCardSaving, setLocalCardSaving] = useState(false);
  const [isOssCredentialsExpanded, setIsOssCredentialsExpanded] = useState(true);
  const [exportSummary, setExportSummary] = useState<{
    operation: ExportOperation;
    attempted: number;
    exported: number;
    failed: number;
    uploaded: number;
    synced: number;
    output_directory: string;
  } | null>(null);

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

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const directClipFileInputRef = useRef<HTMLInputElement | null>(null);
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
  const handledJobIdsRef = useRef<Set<string>>(new Set());
  const notifiedDesktopJobIdsRef = useRef<Set<string>>(new Set());
  const desktopNotificationPrimedRef = useRef(false);
  const toastIdRef = useRef(0);
  const apiKeyPersistenceReadyRef = useRef(false);
  const uploadSettingsPersistenceReadyRef = useRef(false);
  const platformFrequenciesByMatchIdRef = useRef<Record<string, PlatformFrequency[]>>({});
  const loadingFrequencyMatchIdsRef = useRef<Record<string, boolean>>({});
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

  function getMatchById(matchId: string | null): PlatformMatch | null {
    if (!matchId) return null;
    return platformMatches.find((item) => item.id === matchId) ?? null;
  }

  function getFrequenciesForMatch(matchId: string | null): PlatformFrequency[] {
    if (!matchId) return [];
    return platformFrequenciesByMatchId[matchId] ?? [];
  }

  function getSelectedFrequenciesForItem(item: PendingImportVideo): PlatformFrequency[] {
    return item.selectedFrequencies;
  }

  function getDerivedCategoryForItem(item: PendingImportVideo): PlatformCategory | '' {
    const categories = Array.from(
      new Set(
        getSelectedFrequenciesForItem(item)
          .map((frequency) => normalizeCategory(frequency.category))
          .filter((value): value is PlatformCategory => value !== ''),
      ),
    );
    if (categories.length !== 1) return '';
    return categories[0];
  }

  function getDerivedSportKeysForItem(item: PendingImportVideo): string[] {
    const category = getDerivedCategoryForItem(item);
    if (!(category === 'EF' || category === 'QF')) return [];
    const next = new Set<string>();
    getSelectedFrequenciesForItem(item).forEach((frequency) => {
      const derived = deriveSelectionFromVenue(frequency.venue);
      if (derived.sex != null && derived.sportItemId != null) {
        next.add(sportKey(derived.sex, derived.sportItemId));
      }
    });
    return Array.from(next);
  }

  function getEffectiveSportKeysForItem(item: PendingImportVideo): string[] {
    const category = getDerivedCategoryForItem(item);
    return category === 'EF' || category === 'QF'
      ? getDerivedSportKeysForItem(item)
      : item.manualSportKeys;
  }

  function getEffectiveSportItemIdsForItem(item: PendingImportVideo): number[] {
    return Array.from(
      new Set(
        getEffectiveSportKeysForItem(item)
          .map((key) => parseSportKey(key))
          .filter((value): value is {sex: number; sportItemId: number} => value != null)
          .map((value) => value.sportItemId),
      ),
    ).sort((a, b) => a - b);
  }

  function getItemSexes(item: PendingImportVideo): number[] {
    return Array.from(
      new Set(
        getEffectiveSportKeysForItem(item)
          .map((key) => parseSportKey(key))
          .filter((value): value is {sex: number; sportItemId: number} => value != null)
          .map((value) => value.sex),
      ),
    ).sort((a, b) => a - b);
  }

  function getItemValidationError(item: PendingImportVideo): string | null {
    const match = getMatchById(item.matchId);
    if (!match) return '请选择赛事';
    const selectedFrequencies = getSelectedFrequenciesForItem(item);
    if (selectedFrequencies.length === 0) return '请至少选择一个场次';
    const categoryValues = Array.from(
      new Set(
        selectedFrequencies
          .map((frequency) => normalizeCategory(frequency.category))
          .filter((value): value is PlatformCategory => value !== ''),
      ),
    );
    if (categoryValues.length !== 1) return '同一视频的场次必须属于同一比赛类型';
    if (getEffectiveSportKeysForItem(item).length === 0) {
      return categoryValues[0] === 'EF' || categoryValues[0] === 'QF'
        ? '当前场次无法自动识别项目，请检查场次名称'
        : '请至少选择一个项目';
    }
    return null;
  }

  const directClipSelectedCategories = useMemo(
    () =>
      Array.from(
        new Set(
          directClipSelectedMatchIds.flatMap((matchId) =>
            (directClipSelectedFrequenciesByMatchId[matchId] ?? [])
              .map((frequency) => normalizeCategory(frequency.category))
              .filter((value): value is PlatformCategory => value !== ''),
          ),
        ),
      ),
    [directClipSelectedFrequenciesByMatchId, directClipSelectedMatchIds],
  );
  const directClipRequiresManualApparatus = directClipSelectedCategories.some(
    (category) => category === 'AA' || category === 'TF',
  );
  const directClipDerivedSportKeys = useMemo(
    () =>
      Array.from(
        new Set(
          directClipSelectedMatchIds.flatMap((matchId) =>
            (directClipSelectedFrequenciesByMatchId[matchId] ?? [])
              .filter((frequency) => {
                const category = normalizeCategory(frequency.category);
                return category === 'EF' || category === 'QF';
              })
              .map((frequency) => deriveSelectionFromVenue(frequency.venue))
              .filter((value) => value.sex != null && value.sportItemId != null)
              .map((value) => sportKey(value.sex as number, value.sportItemId as number)),
          ),
        ),
      ),
    [directClipSelectedFrequenciesByMatchId, directClipSelectedMatchIds],
  );
  const directClipEffectiveSportKeys = useMemo(
    () => (
      directClipRequiresManualApparatus
        ? [...directClipManualSportKeys]
        : [...directClipDerivedSportKeys]
    ),
    [directClipDerivedSportKeys, directClipManualSportKeys, directClipRequiresManualApparatus],
  );
  const directClipManualSportKeySet = useMemo(
    () => new Set(directClipEffectiveSportKeys),
    [directClipEffectiveSportKeys],
  );
  const directClipHasAllMag = MAG_OPTIONS.every((option) => directClipManualSportKeySet.has(sportKey(1, option.id)));
  const directClipHasAllWag = WAG_OPTIONS.every((option) => directClipManualSportKeySet.has(sportKey(2, option.id)));
  const directClipScopeQueries = useMemo<PlatformScopeQuery[]>(() => {
    const queries: PlatformScopeQuery[] = [];
    directClipSelectedMatchIds.forEach((matchId) => {
      const match = getMatchById(matchId);
      if (!match) return;
      const selectedFrequencies = directClipSelectedFrequenciesByMatchId[matchId] ?? [];
      const groupedByCategory = new Map<PlatformCategory, PlatformFrequency[]>();
      selectedFrequencies.forEach((frequency) => {
        const category = normalizeCategory(frequency.category);
        if (!category) return;
        const existing = groupedByCategory.get(category) ?? [];
        existing.push(frequency);
        groupedByCategory.set(category, existing);
      });

      groupedByCategory.forEach((categoryFrequencies, category) => {
        const sportSelectionKeys =
          category === 'EF' || category === 'QF'
            ? Array.from(
                new Set(
                  categoryFrequencies
                    .map((frequency) => deriveSelectionFromVenue(frequency.venue))
                    .filter((value) => value.sex != null && value.sportItemId != null)
                    .map((value) => sportKey(value.sex as number, value.sportItemId as number)),
                ),
              )
            : [...directClipEffectiveSportKeys];
        const sportItemIds = Array.from(
          new Set(
            sportSelectionKeys
              .map((key) => parseSportKey(key))
              .filter((value): value is {sex: number; sportItemId: number} => value != null)
              .map((value) => value.sportItemId),
          ),
        ).sort((a, b) => a - b);
        if (categoryFrequencies.length === 0 || sportItemIds.length === 0) return;
        const sexes = Array.from(
          new Set(
            sportSelectionKeys
              .map((key) => parseSportKey(key))
              .filter((value): value is {sex: number; sportItemId: number} => value != null)
              .map((value) => value.sex),
          ),
        );
        queries.push({
          match_id: matchId,
          match_name: match.match_name,
          frequency_info_id: categoryFrequencies[0]?.id ?? null,
          frequency_info_ids: categoryFrequencies.map((frequency) => frequency.id),
          venue: categoryFrequencies[0]?.venue ?? '',
          venues: categoryFrequencies.map((frequency) => frequency.venue),
          category,
          sex: sexes.length === 1 ? sexes[0] : null,
          sport_selection_keys: sportSelectionKeys,
          sport_item_ids: sportItemIds,
          team_country: null,
        });
      });
    });
    return queries;
  }, [directClipEffectiveSportKeys, directClipSelectedFrequenciesByMatchId, directClipSelectedMatchIds, platformMatches]);
  const directClipValidationError = useMemo(() => {
    if (pendingDirectClipFiles.length === 0) return '请先选择已有片段文件';
    if (directClipSelectedMatchIds.length === 0) return '请至少选择一个比赛';
    for (const matchId of directClipSelectedMatchIds) {
      const match = getMatchById(matchId);
      if (!match) return '存在无效的比赛选择';
      const selectedFrequencies = directClipSelectedFrequenciesByMatchId[matchId] ?? [];
      if (selectedFrequencies.length === 0) {
        return `请至少为比赛《${match.match_name}》选择一个场次`;
      }
      if (selectedFrequencies.some((frequency) => normalizeCategory(frequency.category) === '')) {
        return `比赛《${match.match_name}》存在无法识别比赛类型的场次`;
      }
    }
    if (directClipRequiresManualApparatus && directClipEffectiveSportKeys.length === 0) {
      return '当前包含全能或团体场次，请至少选择一个项目';
    }
    if (directClipScopeQueries.length === 0) {
      return '当前选择无法生成平台卡片查询条件';
    }
    return null;
  }, [
    directClipEffectiveSportKeys.length,
    directClipRequiresManualApparatus,
    directClipScopeQueries.length,
    directClipSelectedFrequenciesByMatchId,
    directClipSelectedMatchIds,
    pendingDirectClipFiles.length,
    platformMatches,
  ]);

  const selectedClipIdSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);
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
  const hasOssCredentials = Boolean(ossAccessKeyId.trim() && ossAccessKeySecret.trim());
  const hasSavedOutputDir = savedOutputDir.trim().length > 0;
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

  const selectedVideoIdSet = useMemo(() => new Set(selectedVideoIds), [selectedVideoIds]);
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
  const shouldUseSelectedVideosForDetect = selectedVideoIds.length > 0;
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

  useEffect(() => {
    if (!desktopBridge?.isDesktop) {
      const browserDefaultDirectory = loadBrowserDefaultExportDirectory();
      const browserUploadSettings = loadBrowserUploadSettings();
      if (browserDefaultDirectory) {
        setSavedOutputDir(browserDefaultDirectory);
        setOutputDir(browserDefaultDirectory);
      }
      setUploadParallelFiles(browserUploadSettings.uploadParallelFiles);
      setUploadPartThreads(browserUploadSettings.uploadPartThreads);
      apiKeyPersistenceReadyRef.current = true;
      uploadSettingsPersistenceReadyRef.current = true;
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

    void desktopBridge
      .loadOssCredentials()
      .then((response) => {
        if (cancelled) return;
        if (response.accessKeyId) {
          setOssAccessKeyId(response.accessKeyId);
        }
        if (response.accessKeySecret) {
          setOssAccessKeySecret(response.accessKeySecret);
        }
      })
      .catch(() => {
        if (cancelled) return;
      });

    void desktopBridge
      .loadDefaultExportDirectory()
      .then((response) => {
        if (cancelled) return;
        const nextDirectory = String(response.defaultExportDirectory || '').trim();
        if (!nextDirectory) return;
        setSavedOutputDir(nextDirectory);
        setOutputDir(nextDirectory);
      })
      .catch(() => {
        if (cancelled) return;
      });

    void desktopBridge
      .loadUploadSettings()
      .then((response) => {
        if (cancelled) return;
        setUploadParallelFiles(response.uploadParallelFiles);
        setUploadPartThreads(response.uploadPartThreads);
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (!cancelled) {
          uploadSettingsPersistenceReadyRef.current = true;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [desktopBridge]);

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
    if (!uploadSettingsPersistenceReadyRef.current) return;

    const timer = window.setTimeout(async () => {
      const nextParallelFiles = Math.max(1, uploadParallelFiles);
      const nextPartThreads = Math.max(1, uploadPartThreads);
      if (desktopBridge?.isDesktop && desktopBridge.loadUploadSettings && desktopBridge.saveUploadSettings) {
        try {
          await desktopBridge.saveUploadSettings(nextParallelFiles, nextPartThreads);
        } catch {
          // ignore persistence failures to avoid blocking export configuration
        }
      } else {
        saveBrowserUploadSettings(nextParallelFiles, nextPartThreads);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [desktopBridge, uploadParallelFiles, uploadPartThreads]);

  useEffect(() => {
    if (!desktopBridge?.isDesktop) return;
    if (!apiKeyPersistenceReadyRef.current) return;
    if (!supportsSecureStorage) return;

    const timer = window.setTimeout(async () => {
      const trimmedId = ossAccessKeyId.trim();
      const trimmedSecret = ossAccessKeySecret.trim();
      if (!trimmedId && !trimmedSecret) {
        setIsPersistingOssCredentials(true);
        try {
          await desktopBridge.clearOssCredentials();
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : '清除 OSS 凭证失败');
        } finally {
          setIsPersistingOssCredentials(false);
        }
        return;
      }
      if (!trimmedId || !trimmedSecret) {
        return;
      }
      setIsPersistingOssCredentials(true);
      try {
        await desktopBridge.saveOssCredentials(trimmedId, trimmedSecret);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '保存 OSS 凭证失败');
      } finally {
        setIsPersistingOssCredentials(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [desktopBridge, supportsSecureStorage, ossAccessKeyId, ossAccessKeySecret]);

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
    setSelectedVideoIds((current) => current.filter((videoId) => validVideoIds.has(videoId)));
  }, [videos]);

  useEffect(() => {
    const validClipIds = new Set(
      clips
        .filter((clip) => isClipExportSelectable(clip.status))
        .map((clip) => clip.id),
    );
    setSelectedClipIds((current) => current.filter((clipId) => validClipIds.has(clipId)));
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
    if (!showImportModal) {
      setIsLoadingPlatformMatches(false);
      return;
    }
    if (platformMatches.length > 0) return;
    let cancelled = false;
    setIsLoadingPlatformMatches(true);
    void fetchPlatformMatches()
      .then((response) => {
        if (cancelled) return;
        setPlatformMatches(response.matches);
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : '无法读取赛事列表');
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoadingPlatformMatches(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showImportModal, platformMatches.length]);

  useEffect(() => {
    platformFrequenciesByMatchIdRef.current = platformFrequenciesByMatchId;
  }, [platformFrequenciesByMatchId]);

  useEffect(() => {
    loadingFrequencyMatchIdsRef.current = loadingFrequencyMatchIds;
  }, [loadingFrequencyMatchIds]);

  useEffect(() => {
    if (!showImportModal) {
      loadingFrequencyMatchIdsRef.current = {};
      setLoadingFrequencyMatchIds({});
      return;
    }
    const seenMatchIds = new Set<string>();
    const targetMatchIds =
      importMode === 'direct_clip'
        ? directClipSelectedMatchIds.reduce<string[]>((result, matchId) => {
            if (!matchId || seenMatchIds.has(matchId)) {
              return result;
            }
            seenMatchIds.add(matchId);
            if (
              !platformFrequenciesByMatchIdRef.current[matchId]
              && !loadingFrequencyMatchIdsRef.current[matchId]
            ) {
              result.push(matchId);
            }
            return result;
          }, [])
        : pendingImportVideos.reduce<string[]>((result, item) => {
            if (!item.matchId || seenMatchIds.has(item.matchId)) {
              return result;
            }
            seenMatchIds.add(item.matchId);
            if (
              !platformFrequenciesByMatchIdRef.current[item.matchId]
              && !loadingFrequencyMatchIdsRef.current[item.matchId]
            ) {
              result.push(item.matchId);
            }
            return result;
          }, []);
    if (targetMatchIds.length === 0) return;

    const nextLoadingState = {...loadingFrequencyMatchIdsRef.current};
    targetMatchIds.forEach((matchId) => {
      nextLoadingState[matchId] = true;
    });
    loadingFrequencyMatchIdsRef.current = nextLoadingState;
    setLoadingFrequencyMatchIds(nextLoadingState);

    void Promise.all(
      targetMatchIds.map(async (matchId) => {
        const match = platformMatches.find((item) => item.id === matchId) ?? null;
        if (!match) return [matchId, []] as const;
        const response = await fetchPlatformFrequencies({
          matchId,
          matchName: match.match_name,
        });
        return [matchId, response.frequencies] as const;
      }),
    )
      .then((entries) => {
        const nextFrequencyMap = {...platformFrequenciesByMatchIdRef.current};
        for (const [matchId, frequencies] of entries) {
          nextFrequencyMap[matchId] = frequencies;
        }
        platformFrequenciesByMatchIdRef.current = nextFrequencyMap;
        setPlatformFrequenciesByMatchId(nextFrequencyMap);
      })
      .catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : '无法读取场次列表');
      })
      .finally(() => {
        const settledLoadingState = {...loadingFrequencyMatchIdsRef.current};
        targetMatchIds.forEach((matchId) => {
          delete settledLoadingState[matchId];
        });
        loadingFrequencyMatchIdsRef.current = settledLoadingState;
        setLoadingFrequencyMatchIds(settledLoadingState);
      });
  }, [directClipSelectedMatchIds, importMode, pendingImportVideos, platformMatches, showImportModal]);

  useEffect(() => {
    if (!showImportModal) {
      setPreviewByImportId({});
      setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
      return;
    }

    if (importMode === 'direct_clip') {
      let cancelled = false;
      if (directClipValidationError) {
        setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
        return () => {
          cancelled = true;
        };
      }

      setDirectClipPreview((current) => ({
        count: current.count,
        loading: true,
        error: null,
        cacheKey: current.cacheKey,
      }));
      const timer = window.setTimeout(() => {
        void previewScopePlatformRecords(directClipScopeQueries)
        .then((response) => {
          if (cancelled) return;
          setDirectClipPreview({
            count: response.count,
            loading: false,
            error: null,
            cacheKey: response.cache_key ?? null,
          });
        })
        .catch((error) => {
          if (cancelled) return;
          setDirectClipPreview({
            count: null,
            loading: false,
            error: error instanceof Error ? error.message : '预览失败',
            cacheKey: null,
          });
        });
      }, 500);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    let cancelled = false;

    async function loadPreviews() {
      const nextState: Record<string, {count: number | null; loading: boolean; error: string | null}> = {};
      pendingImportVideos.forEach((item) => {
        nextState[item.clientFileId] = {count: null, loading: false, error: null};
      });
      setPreviewByImportId(nextState);

      for (const item of pendingImportVideos) {
        const validationError = getItemValidationError(item);
        if (validationError) {
          continue;
        }

        const match = getMatchById(item.matchId);
        const selectedFrequencies = getSelectedFrequenciesForItem(item);
        const category = getDerivedCategoryForItem(item);
        const sportItemIds = getEffectiveSportItemIdsForItem(item);
        if (!match || selectedFrequencies.length === 0 || !category || sportItemIds.length === 0) {
          continue;
        }

        setPreviewByImportId((current) => ({
          ...current,
          [item.clientFileId]: {count: current[item.clientFileId]?.count ?? null, loading: true, error: null},
        }));
        try {
          const response = await fetchPlatformRecords({
            matchId: item.matchId,
            matchName: match.match_name,
            frequencyInfoIds: selectedFrequencies.map((frequency) => frequency.id),
            venues: selectedFrequencies.map((frequency) => frequency.venue),
            category,
            sportSelectionKeys: getEffectiveSportKeysForItem(item),
            sportItemIds,
          });
          if (cancelled) return;
          setPreviewByImportId((current) => ({
            ...current,
            [item.clientFileId]: {count: response.count, loading: false, error: null},
          }));
        } catch (error) {
          if (cancelled) return;
          setPreviewByImportId((current) => ({
            ...current,
            [item.clientFileId]: {
              count: null,
              loading: false,
              error: error instanceof Error ? error.message : '预览失败',
            },
          }));
        }
      }
    }

    void loadPreviews();
    return () => {
      cancelled = true;
    };
  }, [
    directClipScopeQueries,
    directClipValidationError,
    importMode,
    pendingImportVideos,
    platformFrequenciesByMatchId,
    platformMatches,
    showImportModal,
  ]);

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
    for (const job of jobs) {
      if (job.status === 'queued' || job.status === 'running') continue;
      if (handledJobIdsRef.current.has(job.id)) continue;
      handledJobIdsRef.current.add(job.id);

      if (job.status === 'failed') {
        setErrorMessage(job.error_message || `${job.kind === 'detect' ? '检测' : '导出'}任务失败`);
        continue;
      }

      if (job.status === 'cancelled') {
        if (job.kind === 'detect') {
          setSuccessMessage('检测已取消');
        }
        continue;
      }

      if (job.kind === 'detect') {
        const totalCandidates = Number(job.result.total_candidates || 0);
        setSuccessMessage(`检测完成，生成 ${totalCandidates} 个候选片段`);
        continue;
      }

      if (job.kind === 'export') {
        const summary = summarizeExportJob(job, outputDir);
        const {operation} = summary;
        setExportSummary(summary);
        if (operation === 'export_only') {
          setSuccessMessage(`导出完成：本地 ${summary.exported}/${summary.attempted}`);
        } else if (operation === 'upload_only') {
          setSuccessMessage(`上传完成：OSS ${summary.uploaded}/${summary.attempted}，回写 ${summary.synced}`);
        } else {
          setSuccessMessage(`导出完成：本地 ${summary.exported}/${summary.attempted}，上传 ${summary.uploaded}，回写 ${summary.synced}`);
        }
      }
    }
  }, [jobs, outputDir]);

  useEffect(() => {
    if (!desktopBridge?.isDesktop || !desktopBridge.showSystemNotification) return;

    if (!desktopNotificationPrimedRef.current) {
      for (const job of jobs) {
        if (job.status === 'queued' || job.status === 'running') continue;
        notifiedDesktopJobIdsRef.current.add(job.id);
      }
      desktopNotificationPrimedRef.current = true;
      return;
    }

    for (const job of jobs) {
      if (job.status === 'queued' || job.status === 'running') continue;
      if (notifiedDesktopJobIdsRef.current.has(job.id)) continue;
      notifiedDesktopJobIdsRef.current.add(job.id);
      if (job.kind !== 'export') continue;

      const payload =
        job.status === 'failed'
          ? buildExportFailedNotification(job, outputDir)
          : job.status === 'completed'
            ? buildExportCompletedNotification(summarizeExportJob(job, outputDir))
            : null;
      if (!payload) continue;

      void desktopBridge.showSystemNotification(payload).catch(() => {
        // Ignore notification failures and keep in-app status as the source of truth.
      });
    }
  }, [desktopBridge, jobs, outputDir]);

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
    setSelectedVideoIds((current) =>
      current.includes(videoId)
        ? current.filter((id) => id !== videoId)
        : [...current, videoId],
    );
  }

  function toggleClipSelection(clipId: string) {
    setSelectedClipIds((current) =>
      current.includes(clipId)
        ? current.filter((id) => id !== clipId)
        : [...current, clipId],
    );
  }

  function setClipSelectionBatch(clipIds: string[], shouldSelect: boolean) {
    if (clipIds.length === 0) return;
    setSelectedClipIds((current) => {
      const next = new Set(current);
      clipIds.forEach((clipId) => {
        if (shouldSelect) {
          next.add(clipId);
        } else {
          next.delete(clipId);
        }
      });
      return Array.from(next);
    });
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
    setSelectedVideoIds([]);
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
    setSelectedVideoIds((current) => {
      const next = new Set(current);
      videoIds.forEach((videoId) => {
        if (selectionState === 'checked') {
          next.delete(videoId);
        } else {
          next.add(videoId);
        }
      });
      return Array.from(next);
    });
  }

  function toggleSelectAllVideos() {
    if (selectedVideoIds.length === videos.length) {
      clearVideoSelection();
      return;
    }
    setSelectedVideoIds(videos.map((video) => video.id));
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

  async function handleImportFiles(
    fileList: FileList | File[] | DesktopImportSource[],
    mode: ImportMode = 'full_video',
  ) {
    const rawEntries: Array<File | DesktopImportSource> = fileList instanceof FileList
      ? Array.from(fileList)
      : [...fileList];
    const entries = rawEntries.filter((item) =>
      isDesktopImportSource(item)
        ? !item.name.startsWith('.') && /\.(mp4|mov|mkv|avi|flv|wmv)$/i.test(item.name)
        : !item.name.startsWith('.') && (item.type.startsWith('video/') || /\.(mp4|mov|mkv|avi|flv|wmv)$/i.test(item.name)),
    );
    if (!entries.length) {
      setErrorMessage('未检测到支持的视频文件');
      return;
    }
    setImportMode(mode);
    if (mode === 'direct_clip') {
      setPendingDirectClipFiles(entries.map((file) => createPendingDirectClipFile(file)));
      setDirectClipSelectedMatchIds([]);
      setDirectClipSelectedFrequenciesByMatchId({});
      setDirectClipManualSportKeys([]);
      setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
      setPendingImportVideos([]);
      setPreviewByImportId({});
    } else {
      setPendingImportVideos(entries.map((file) => createPendingImportVideo(file)));
      setPendingDirectClipFiles([]);
      setDirectClipSelectedMatchIds([]);
      setDirectClipSelectedFrequenciesByMatchId({});
      setDirectClipManualSportKeys([]);
      setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
    }
    setPreviewByImportId({});
    setShowImportModal(true);
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  async function openImportSourcePicker(mode: ImportMode) {
    if (desktopBridge?.isDesktop && desktopBridge.selectImportSources) {
      try {
        const sources = await desktopBridge.selectImportSources();
        if (sources.length > 0) {
          await handleImportFiles(sources, mode);
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '选择导入文件夹失败');
      }
      return;
    }
    if (mode === 'direct_clip') {
      directClipFileInputRef.current?.click();
    } else {
      fileInputRef.current?.click();
    }
  }

  function closeImportModal() {
    if (isImporting) return;
    setShowImportModal(false);
    setImportMode('full_video');
    setPendingImportVideos([]);
    setPendingDirectClipFiles([]);
    setDirectClipSelectedMatchIds([]);
    setDirectClipSelectedFrequenciesByMatchId({});
    setDirectClipManualSportKeys([]);
    setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
    setPreviewByImportId({});
    setIsLoadingPlatformMatches(false);
    setLoadingFrequencyMatchIds({});
  }

  function updatePendingImportVideo(clientFileId: string, updater: (item: PendingImportVideo) => PendingImportVideo) {
    setPendingImportVideos((current) =>
      current.map((item) => (item.clientFileId === clientFileId ? updater(item) : item)),
    );
  }

  function resetPreviewForImportVideo(clientFileId: string) {
    setPreviewByImportId((current) => ({
      ...current,
      [clientFileId]: {count: null, loading: false, error: null},
    }));
  }

  function resetDirectClipPreview() {
    setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
  }

  function togglePendingVideoApparatus(clientFileId: string, sex: number, sportItemId: number) {
    updatePendingImportVideo(clientFileId, (item) => ({
      ...item,
      manualSportKeys: toggleSportKey(item.manualSportKeys, sportKey(sex, sportItemId)),
    }));
    resetPreviewForImportVideo(clientFileId);
  }

  function setPendingVideoApparatusGroup(clientFileId: string, sex: number, ids: number[]) {
    updatePendingImportVideo(clientFileId, (item) => {
      const keys = ids.map((id) => sportKey(sex, id));
      const hasAll = keys.every((key) => item.manualSportKeys.includes(key));
      return {
        ...item,
        manualSportKeys: hasAll
          ? item.manualSportKeys.filter((key) => !keys.includes(key))
          : Array.from(new Set([...item.manualSportKeys.filter((key) => !keys.includes(key)), ...keys])),
      };
    });
    resetPreviewForImportVideo(clientFileId);
  }

  function setPendingVideoMatch(clientFileId: string, matchId: string | null) {
    updatePendingImportVideo(clientFileId, (item) => ({
      ...item,
      matchId,
      selectedFrequencies: [],
      manualSportKeys: [],
    }));
    resetPreviewForImportVideo(clientFileId);
  }

  function togglePendingVideoFrequency(clientFileId: string, frequency: PlatformFrequency) {
    updatePendingImportVideo(clientFileId, (item) => {
      const nextSelectedFrequencies = item.selectedFrequencies.some((entry) => entry.id === frequency.id)
        ? item.selectedFrequencies.filter((entry) => entry.id !== frequency.id)
        : [...item.selectedFrequencies, frequency];
      const nextCategories = Array.from(
        new Set(
          nextSelectedFrequencies
            .map((entry) => normalizeCategory(entry.category))
            .filter((value): value is PlatformCategory => value !== ''),
        ),
      );
      if (nextCategories.length > 1) {
        setErrorMessage('同一视频只能选择同一比赛类型的场次');
        return item;
      }
      return {
        ...item,
        selectedFrequencies: nextSelectedFrequencies,
        manualSportKeys:
          nextCategories[0] === 'EF' || nextCategories[0] === 'QF'
            ? []
            : item.manualSportKeys,
      };
    });
    resetPreviewForImportVideo(clientFileId);
  }

  function toggleDirectClipMatch(matchId: string) {
    setDirectClipSelectedMatchIds((current) => {
      const exists = current.includes(matchId);
      const next = exists ? current.filter((id) => id !== matchId) : [...current, matchId];
      if (exists) {
        setDirectClipSelectedFrequenciesByMatchId((currentFrequencies) => {
          const copy = {...currentFrequencies};
          delete copy[matchId];
          return copy;
        });
      }
      return next;
    });
    resetDirectClipPreview();
  }

  function toggleDirectClipFrequency(matchId: string, frequency: PlatformFrequency) {
    setDirectClipSelectedFrequenciesByMatchId((current) => {
      const existing = current[matchId] ?? [];
      return {
        ...current,
        [matchId]: existing.some((entry) => entry.id === frequency.id)
          ? existing.filter((entry) => entry.id !== frequency.id)
          : [...existing, frequency],
      };
    });
    resetDirectClipPreview();
  }

  function toggleDirectClipApparatus(sex: number, sportItemId: number) {
    setDirectClipManualSportKeys((current) => toggleSportKey(current, sportKey(sex, sportItemId)));
    resetDirectClipPreview();
  }

  function setDirectClipApparatusGroup(sex: number, ids: number[]) {
    setDirectClipManualSportKeys((current) => {
      const keys = ids.map((id) => sportKey(sex, id));
      const hasAll = keys.every((key) => current.includes(key));
      return hasAll
        ? current.filter((key) => !keys.includes(key))
        : Array.from(new Set([...current.filter((key) => !keys.includes(key)), ...keys]));
    });
    resetDirectClipPreview();
  }

  async function handleSubmitImport() {
    if (isImporting) return;
    if (importMode === 'direct_clip') {
      if (directClipValidationError) {
        setErrorMessage(directClipValidationError);
        return;
      }
      if (directClipPreview.error) {
        setErrorMessage(directClipPreview.error);
        return;
      }

      setIsImporting(true);
      setSuccessMessage(null);
      try {
        const response = await importDirectClipFiles(
          pendingDirectClipFiles.map((item) => ({
            clientFileId: item.clientFileId,
            file: item.file,
            path: item.path,
          })),
          directClipScopeQueries,
          directClipPreview.cacheKey,
        );
        setProjectState(response.project);
        if (response.imported_videos.length > 0) {
          setActiveVideoId(response.imported_videos[0].id);
        }
        setErrorMessage(null);
        setSuccessMessage(`已导入 ${response.imported_count} 个已有片段`);
        setShowImportModal(false);
        setImportMode('full_video');
        setPendingDirectClipFiles([]);
        setDirectClipSelectedMatchIds([]);
        setDirectClipSelectedFrequenciesByMatchId({});
        setDirectClipManualSportKeys([]);
        setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '导入已有片段失败');
      } finally {
        setIsImporting(false);
      }
      return;
    }

    const invalidRow = pendingImportVideos.find(
      (item) => Boolean(getItemValidationError(item)),
    );
    if (invalidRow) {
      setErrorMessage(`请先完成视频《${invalidRow.name}》的比赛、场次和项目选择`);
      return;
    }
    const failedPreview = pendingImportVideos.find((item) => previewByImportId[item.clientFileId]?.error);
    if (failedPreview) {
      setErrorMessage(`视频《${failedPreview.name}》的平台卡片预览失败，请先修正查询条件`);
      return;
    }

    setIsImporting(true);
    setSuccessMessage(null);
    try {
      const response = await importProjectFiles(
        pendingImportVideos.flatMap((item) => {
          const match = getMatchById(item.matchId);
          const selectedFrequencies = getSelectedFrequenciesForItem(item);
          const category = getDerivedCategoryForItem(item);
          const sportItemIds = getEffectiveSportItemIdsForItem(item);
          if (!match || selectedFrequencies.length === 0 || !category || sportItemIds.length === 0) {
            return [];
          }
          return [{
            clientFileId: item.clientFileId,
            file: item.file,
            path: item.path,
            matchId: item.matchId,
            matchName: match.match_name,
            frequencyInfoIds: selectedFrequencies.map((frequency) => frequency.id),
            venues: selectedFrequencies.map((frequency) => frequency.venue),
            category,
            sportSelectionKeys: getEffectiveSportKeysForItem(item),
            sportItemIds,
          }];
        }),
      );
      setProjectState(response.project);
      if (response.imported_videos.length > 0) {
        setActiveVideoId(response.imported_videos[0].id);
      }
      setErrorMessage(null);
      setSuccessMessage(`已导入 ${response.imported_count} 个视频`);
      setShowImportModal(false);
      setPendingImportVideos([]);
      setPreviewByImportId({});
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '导入失败');
    } finally {
      setIsImporting(false);
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
        setSelectedVideoIds((current) =>
          current.filter((videoId) => !queuedJobs.some((job) => job.video_id === videoId)),
        );
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

  async function persistDefaultOutputDirectory(nextPath: string) {
    const trimmed = nextPath.trim();
    if (!trimmed) return;

    if (desktopBridge?.isDesktop && desktopBridge.loadDefaultExportDirectory && desktopBridge.saveDefaultExportDirectory) {
      await desktopBridge.saveDefaultExportDirectory(trimmed);
    } else {
      saveBrowserDefaultExportDirectory(trimmed);
    }
    setSavedOutputDir(trimmed);
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
              setExportOperation('export_and_upload');
              setIsOssCredentialsExpanded(!hasOssCredentials);
              setIsUploadSettingsExpanded(false);
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
                    {selectedVideoIds.length > 0 && (
                      <span className="text-[11px] font-medium text-gray-500">已选 {selectedVideoIds.length}</span>
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
                  {selectedVideoIds.length === videos.length ? '取消全选' : '全选'}
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

      {showImportModal && (
        <div className="fixed inset-0 z-40 bg-gray-900/40 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-full max-w-6xl max-h-[88vh] bg-white border border-gray-100 rounded-3xl shadow-2xl overflow-hidden flex flex-col">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-white">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  {importMode === 'direct_clip' ? '导入已有片段' : '导入视频与平台成绩卡片'}
                </h3>
                <p className="text-sm text-gray-500 mt-1">
                  {importMode === 'direct_clip'
                    ? '这一批片段共用一套平台查询条件；每个文件导入后直接成为一个可绑定、可导出的候选片段。'
                    : '每个视频独立选择比赛与场次；单项会自动识别项目，全能和团体按视频实际内容手动勾选项目。'}
                </p>
              </div>
              <button
                onClick={closeImportModal}
                disabled={isImporting}
                className="text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-40"
              >
                <XCircle size={22} />
              </button>
            </div>

            {importMode === 'full_video' ? (
              <div className="flex-1 min-h-0 grid grid-cols-[1.55fr_0.85fr]">
              <div className="border-r border-gray-100 min-h-0 flex flex-col bg-gray-50/40">
                <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">待导入视频</div>
                    <div className="text-xs text-gray-500 mt-1">{pendingImportVideos.length} 个文件</div>
                  </div>
                  <button
                    onClick={() => void openImportSourcePicker('full_video')}
                    className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                  >
                    <Upload size={15} />
                    重新选择视频
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {pendingImportVideos.map((item) => {
                    const match = getMatchById(item.matchId);
                    const availableFrequencies = getFrequenciesForMatch(item.matchId);
                    const selectedFrequencyIdSet = new Set(item.selectedFrequencies.map((frequency) => frequency.id));
                    const selectedFrequencies = getSelectedFrequenciesForItem(item);
                    const derivedCategory = getDerivedCategoryForItem(item);
                    const effectiveSportKeys = getEffectiveSportKeysForItem(item);
                    const effectiveSportKeySet = new Set(effectiveSportKeys);
                    const isAutoDerivedByVenue = derivedCategory === 'EF' || derivedCategory === 'QF';
                    const canChooseManualApparatus = selectedFrequencies.length > 0 && !isAutoDerivedByVenue;
                    const hasAllMag = MAG_OPTIONS.every((option) => effectiveSportKeySet.has(sportKey(1, option.id)));
                    const hasAllWag = WAG_OPTIONS.every((option) => effectiveSportKeySet.has(sportKey(2, option.id)));
                    const validationMessage = getItemValidationError(item);
                    const isLoadingFrequencies = item.matchId ? Boolean(loadingFrequencyMatchIds[item.matchId]) : false;
                    const preview = previewByImportId[item.clientFileId];
                    return (
                      <div key={item.clientFileId} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm space-y-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-gray-900 truncate">{item.name}</div>
                            <div className="mt-1 text-xs text-gray-500">
                              {(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-gray-400">平台卡片预览</div>
                            <div className={`mt-1 text-sm font-semibold ${preview?.error ? 'text-red-500' : 'text-gray-900'}`}>
                              {preview?.loading
                                ? '查询中...'
                                : preview?.error
                                  ? '查询失败'
                                  : preview?.count != null
                                    ? `${preview.count} 条`
                                    : '待选择'}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-3">
                          <label className="space-y-2 block">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">赛事</span>
                            <select
                              value={item.matchId ?? ''}
                              onChange={(event) => setPendingVideoMatch(item.clientFileId, event.target.value || null)}
                              className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700"
                            >
                              <option value="">选择赛事</option>
                              {platformMatches.map((platformMatch) => (
                                <option key={platformMatch.id} value={platformMatch.id}>
                                  {platformMatch.match_name}
                                </option>
                              ))}
                            </select>
                            {isLoadingPlatformMatches && <div className="text-[11px] text-gray-400">正在加载赛事列表...</div>}
                          </label>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">场次</span>
                              {selectedFrequencies.length > 0 && (
                                <span className="text-[11px] text-gray-400">已选 {selectedFrequencies.length} 个</span>
                              )}
                            </div>
                            {!item.matchId ? (
                              <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-400">
                                请先为当前视频选择赛事，再从该比赛中勾选一个或多个场次。
                              </div>
                            ) : isLoadingFrequencies ? (
                              <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-400">
                                正在加载该赛事的场次列表...
                              </div>
                            ) : availableFrequencies.length === 0 ? (
                              <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-400">
                                当前赛事没有可用场次。
                              </div>
                            ) : (
                              <div className="max-h-44 overflow-y-auto rounded-xl border border-gray-200 bg-white divide-y divide-gray-100">
                                {availableFrequencies.map((frequency) => {
                                  const checked = selectedFrequencyIdSet.has(frequency.id);
                                  return (
                                    <label key={frequency.id} className="flex items-start gap-3 px-3 py-2.5 text-sm cursor-pointer hover:bg-gray-50">
                                      <input
                                        type="checkbox"
                                        className="mt-0.5 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                        checked={checked}
                                        onChange={() => togglePendingVideoFrequency(item.clientFileId, frequency)}
                                      />
                                      <span className="min-w-0 flex-1">
                                        <span className="block text-gray-800 break-words">{frequency.venue}</span>
                                        <span className="mt-0.5 block text-[11px] text-gray-400">{categoryLabel(normalizeCategory(frequency.category))}</span>
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>

                          <div>
                            <div className="mb-2 flex items-center justify-between">
                              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">男子项目</span>
                              <button
                                onClick={() => setPendingVideoApparatusGroup(item.clientFileId, 1, MAG_OPTIONS.map((option) => option.id))}
                                className={`rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors ${
                                  hasAllMag
                                    ? 'bg-gray-900 border-gray-900 text-white'
                                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                                }`}
                                disabled={!canChooseManualApparatus}
                              >
                                全部
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {MAG_OPTIONS.map((option) => {
                                const selected = effectiveSportKeySet.has(sportKey(1, option.id));
                                return (
                                  <button
                                    key={`mag-${option.id}`}
                                    onClick={() => togglePendingVideoApparatus(item.clientFileId, 1, option.id)}
                                    className={`rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                                      selected
                                        ? 'bg-gray-900 border-gray-900 text-white'
                                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                                    }`}
                                    disabled={!canChooseManualApparatus}
                                  >
                                    {option.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div>
                            <div className="mb-2 flex items-center justify-between">
                              <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">女子项目</span>
                              <button
                                onClick={() => setPendingVideoApparatusGroup(item.clientFileId, 2, WAG_OPTIONS.map((option) => option.id))}
                                className={`rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors ${
                                  hasAllWag
                                    ? 'bg-gray-900 border-gray-900 text-white'
                                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                                }`}
                                disabled={!canChooseManualApparatus}
                              >
                                全部
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {WAG_OPTIONS.map((option) => {
                                const selected = effectiveSportKeySet.has(sportKey(2, option.id));
                                return (
                                  <button
                                    key={`wag-${option.id}`}
                                    onClick={() => togglePendingVideoApparatus(item.clientFileId, 2, option.id)}
                                    className={`rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                                      selected
                                        ? 'bg-gray-900 border-gray-900 text-white'
                                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                                    }`}
                                    disabled={!canChooseManualApparatus}
                                  >
                                    {option.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs">
                            {validationMessage ? (
                              <span className="text-gray-400">{validationMessage}</span>
                            ) : preview?.error ? (
                              <span className="text-red-500">{preview.error}</span>
                            ) : preview?.loading ? (
                              <span className="text-gray-600">正在查询平台卡片...</span>
                            ) : preview?.count != null ? (
                              <span className="text-gray-600">将为该视频加载 {preview.count} 张平台成绩卡片。</span>
                            ) : (
                              <span className="text-gray-400">
                                {isAutoDerivedByVenue
                                  ? '已按场次自动同步项目，确认场次后会自动查询预览。'
                                  : '完成当前视频的比赛、场次和项目选择后自动查询预览。'}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="min-h-0 flex flex-col bg-white">
                <div className="px-5 py-4 border-b border-gray-100">
                  <div className="text-sm font-semibold text-gray-900">导入规则</div>
                  <div className="mt-1 text-xs text-gray-500">每个视频独立选择比赛和场次，右侧卡片只显示当前视频命中的平台记录。</div>
                </div>
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-500 space-y-2">
                    <p>导入要求：</p>
                    <p>1. 每个视频都要单独选择比赛与一个或多个场次。</p>
                    <p>2. 同一视频允许混合男子与女子内容，但已选场次必须属于同一比赛类型。</p>
                    <p>3. 单项/资格赛会根据场次自动识别项目；全能和团体请手动勾选视频实际包含的项目。</p>
                    <p>4. 预览成功后，导入会缓存该视频对应的平台卡片，右侧绑定栏只看当前视频。</p>
                    <p>5. 团体赛不在导入阶段选国家，绑定时通过右侧国家筛选缩小范围。</p>
                  </div>
                </div>
              </div>
              </div>
            ) : (
              <div className="flex-1 min-h-0 grid grid-cols-[1.1fr_0.9fr]">
                <div className="border-r border-gray-100 min-h-0 flex flex-col bg-gray-50/40">
                  <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">共享平台查询条件</div>
                      <div className="text-xs text-gray-500 mt-1">
                        {directClipPreview.loading
                          ? '平台卡片预览查询中...'
                          : directClipPreview.error
                            ? '平台卡片预览失败'
                            : directClipPreview.count != null
                              ? `命中 ${directClipPreview.count} 张卡片`
                              : '选择比赛、场次、项目后自动预览'}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-gray-400">查询组</div>
                      <div className="text-sm font-semibold text-gray-900">{directClipScopeQueries.length}</div>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">比赛</span>
                        <span className="text-[11px] text-gray-400">已选 {directClipSelectedMatchIds.length} 个</span>
                      </div>
                      <div className="max-h-48 overflow-y-auto rounded-2xl border border-gray-200 bg-white divide-y divide-gray-100">
                        {platformMatches.map((match) => {
                          const checked = directClipSelectedMatchIds.includes(match.id);
                          return (
                            <label key={match.id} className="flex items-start gap-3 px-3 py-2.5 text-sm cursor-pointer hover:bg-gray-50">
                              <input
                                type="checkbox"
                                className="mt-0.5 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                checked={checked}
                                onChange={() => toggleDirectClipMatch(match.id)}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block text-gray-800 break-words">{match.match_name}</span>
                                {match.city && (
                                  <span className="mt-0.5 block text-[11px] text-gray-400">{match.city}</span>
                                )}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">场次</div>
                      {directClipSelectedMatchIds.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-gray-200 bg-white px-3 py-3 text-xs text-gray-400">
                          先选择一个或多个比赛，再为每个比赛勾选场次。
                        </div>
                      ) : (
                        directClipSelectedMatchIds.map((matchId) => {
                          const match = getMatchById(matchId);
                          const availableFrequencies = getFrequenciesForMatch(matchId);
                          const selectedFrequencyIdSet = new Set((directClipSelectedFrequenciesByMatchId[matchId] ?? []).map((frequency) => frequency.id));
                          const isLoadingFrequencies = Boolean(loadingFrequencyMatchIds[matchId]);
                          return (
                            <div key={matchId} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-sm font-semibold text-gray-900">{match?.match_name || '未命名比赛'}</div>
                                <div className="text-[11px] text-gray-400">
                                  已选 {(directClipSelectedFrequenciesByMatchId[matchId] ?? []).length} 个场次
                                </div>
                              </div>
                              {isLoadingFrequencies ? (
                                <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-400">
                                  正在加载该比赛的场次列表...
                                </div>
                              ) : availableFrequencies.length === 0 ? (
                                <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-400">
                                  当前比赛没有可用场次。
                                </div>
                              ) : (
                                <div className="max-h-44 overflow-y-auto rounded-xl border border-gray-200 bg-white divide-y divide-gray-100">
                                  {availableFrequencies.map((frequency) => {
                                    const checked = selectedFrequencyIdSet.has(frequency.id);
                                    return (
                                      <label key={frequency.id} className="flex items-start gap-3 px-3 py-2.5 text-sm cursor-pointer hover:bg-gray-50">
                                        <input
                                          type="checkbox"
                                          className="mt-0.5 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                          checked={checked}
                                          onChange={() => toggleDirectClipFrequency(matchId, frequency)}
                                        />
                                        <span className="min-w-0 flex-1">
                                          <span className="block text-gray-800 break-words">{frequency.venue}</span>
                                          <span className="mt-0.5 block text-[11px] text-gray-400">{categoryLabel(normalizeCategory(frequency.category))}</span>
                                        </span>
                                      </label>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">共享项目选择</div>
                          <div className="mt-1 text-[11px] text-gray-500">
                            EF / QF 会按场次自动识别项目；AA / TF 使用这里的手动选择。
                          </div>
                        </div>
                      </div>

                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">男子项目</span>
                          <button
                            onClick={() => setDirectClipApparatusGroup(1, MAG_OPTIONS.map((option) => option.id))}
                            className={`rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors ${
                              directClipHasAllMag
                                ? 'bg-gray-900 border-gray-900 text-white'
                                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                            }`}
                            disabled={!directClipRequiresManualApparatus}
                          >
                            全部
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {MAG_OPTIONS.map((option) => {
                            const selected = directClipManualSportKeySet.has(sportKey(1, option.id));
                            return (
                              <button
                                key={`direct-mag-${option.id}`}
                                onClick={() => toggleDirectClipApparatus(1, option.id)}
                                className={`rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                                  selected
                                    ? 'bg-gray-900 border-gray-900 text-white'
                                    : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                                }`}
                                disabled={!directClipRequiresManualApparatus}
                              >
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">女子项目</span>
                          <button
                            onClick={() => setDirectClipApparatusGroup(2, WAG_OPTIONS.map((option) => option.id))}
                            className={`rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors ${
                              directClipHasAllWag
                                ? 'bg-gray-900 border-gray-900 text-white'
                                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                            }`}
                            disabled={!directClipRequiresManualApparatus}
                          >
                            全部
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {WAG_OPTIONS.map((option) => {
                            const selected = directClipManualSportKeySet.has(sportKey(2, option.id));
                            return (
                              <button
                                key={`direct-wag-${option.id}`}
                                onClick={() => toggleDirectClipApparatus(2, option.id)}
                                className={`rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                                  selected
                                    ? 'bg-gray-900 border-gray-900 text-white'
                                    : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                                }`}
                                disabled={!directClipRequiresManualApparatus}
                              >
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs">
                        {directClipValidationError ? (
                          <span className="text-gray-400">{directClipValidationError}</span>
                        ) : directClipPreview.error ? (
                          <span className="text-red-500">{directClipPreview.error}</span>
                        ) : directClipPreview.loading ? (
                          <span className="text-gray-600">正在查询平台成绩卡片...</span>
                        ) : directClipPreview.count != null ? (
                          <span className="text-gray-600">本批片段将共享 {directClipPreview.count} 张平台成绩卡片。</span>
                        ) : (
                          <span className="text-gray-400">完成比赛、场次和项目选择后，会自动生成平台成绩卡片预览。</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="min-h-0 flex flex-col bg-white">
                  <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">待导入片段</div>
                      <div className="text-xs text-gray-500 mt-1">{pendingDirectClipFiles.length} 个文件</div>
                    </div>
                    <button
                      onClick={() => void openImportSourcePicker('direct_clip')}
                      className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                    >
                      <Upload size={15} />
                      重新选择片段
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-5 space-y-3 bg-gray-50/40">
                    {pendingDirectClipFiles.map((item) => (
                      <div key={item.clientFileId} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                        <div className="text-sm font-semibold text-gray-900 truncate">{item.name}</div>
                        <div className="mt-1 text-xs text-gray-500">
                          {(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                        </div>
                      </div>
                    ))}
                    <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-4 text-sm text-gray-500 space-y-2">
                      <p>导入规则：</p>
                      <p>1. 这一批片段共用一个卡片池，可同时覆盖多个比赛、多个场次和多个项目。</p>
                      <p>2. 每个文件导入后会直接生成一个候选片段，默认保留，可立即绑定和导出。</p>
                      <p>3. 右侧卡片区会按比赛和场次分组展示，继续复用现有性别、项目、国家筛选。</p>
                      <p>4. 导出、重命名、OSS 上传和平台回写全部沿用现有逻辑。</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="p-5 border-t border-gray-100 flex justify-end gap-3 bg-white">
              <button
                onClick={closeImportModal}
                disabled={isImporting}
                className="px-4 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium text-sm transition-colors border border-gray-200 shadow-sm disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => void handleSubmitImport()}
                disabled={
                  importMode === 'direct_clip'
                    ? (
                      isImporting ||
                      pendingDirectClipFiles.length === 0 ||
                      Boolean(directClipValidationError) ||
                      directClipPreview.loading ||
                      Boolean(directClipPreview.error)
                    )
                    : (
                      isImporting ||
                      pendingImportVideos.length === 0 ||
                      pendingImportVideos.some(
                        (item) =>
                          Boolean(getItemValidationError(item)) ||
                          previewByImportId[item.clientFileId]?.loading ||
                          Boolean(previewByImportId[item.clientFileId]?.error),
                      )
                    )
                }
                className="px-5 py-2.5 rounded-xl bg-gray-900 hover:bg-black text-white font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
              >
                {isImporting ? '导入中...' : importMode === 'direct_clip' ? '确认导入已有片段' : '确认导入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showExport && (
        <div className="fixed inset-0 z-40 bg-gray-900/40 backdrop-blur-sm flex items-center justify-center">
          <div className="w-[520px] max-h-[min(92vh,920px)] bg-white border border-gray-100 rounded-3xl shadow-2xl flex flex-col overflow-hidden">
            <div className="shrink-0 p-5 border-b border-gray-100 flex items-center justify-between bg-white">
              <h3 className="text-lg font-semibold text-gray-900">导出与上传</h3>
              <button onClick={() => setShowExport(false)} className="text-gray-400 hover:text-gray-600 transition-colors">
                <XCircle size={22} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-6 space-y-6 bg-gray-50/50">
              <div className="flex items-center justify-between p-4 rounded-2xl bg-white border border-gray-200 shadow-sm">
                <div>
                  <p className="text-sm font-medium text-gray-500 mb-1">准备执行</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {exportTargetClipsCount} <span className="text-base font-medium text-gray-500">个片段</span>
                  </p>
                  <p className="mt-2 text-xs text-gray-500">
                    {exportTargetClipsCount > 0
                      ? exportOperation === 'export_only'
                        ? '当前模式只做本地导出，不上传 OSS，也不回写平台。'
                        : exportOperation === 'upload_only'
                          ? uploadOnlyInvalidClips.length > 0
                            ? `仅上传要求所选片段已绑定平台卡片，且已导出或满足已有片段原片直传条件；当前有 ${uploadOnlyInvalidClips.length} 个片段不满足条件。`
                            : `当前将直接上传所选片段；默认优先上传已导出文件，仅当没有导出文件时才会重命名原片直传。已绑定平台卡片会在 OSS 成功后自动回写平台。`
                          : `当前将导出所选片段；其中 ${Math.max(exportTargetBoundCount - exportTargetLocalBoundCount, 0)} 个已绑定平台卡片会自动上传 OSS 并回写平台${exportTargetLocalBoundCount > 0 ? `，${exportTargetLocalBoundCount} 个本地补录片段会落入"本地补录"子文件夹` : ''}。`
                      : '请先在候选片段列表中选择要导出的片段。'}
                  </p>
                </div>
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-gray-900">
                  <CheckCircle2 size={24} />
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-sm font-semibold text-gray-700">执行模式</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['export_only', 'upload_only', 'export_and_upload'] as const).map((operation) => (
                    <button
                      key={operation}
                      type="button"
                      onClick={() => setExportOperation(operation)}
                      className={`rounded-2xl border px-3 py-3 text-left transition-colors ${
                        exportOperation === operation
                          ? 'border-red-200 bg-red-50 text-red-600'
                          : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                      }`}
                    >
                      <div className="text-sm font-semibold">{EXPORT_OPERATION_DETAILS[operation].label}</div>
                      <div className={`mt-1 text-xs ${exportOperation === operation ? 'text-red-500' : 'text-gray-500'}`}>
                        {EXPORT_OPERATION_DETAILS[operation].description}
                      </div>
                    </button>
                  ))}
                </div>
                {exportOperation === 'upload_only' && uploadOnlyInvalidClips.length > 0 && (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                    仅上传要求所选片段已绑定平台卡片，且已导出或满足已有片段原片直传条件。请先处理不满足条件的片段。
                  </div>
                )}
                {exportOperation === 'upload_only' && exportTargetClipsCount > 0 && uploadOnlyInvalidClips.length === 0 && (
                  <div className="rounded-2xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-700">
                    当前上传来源：已导出文件 {uploadOnlySourceSummary.exportedFileCount} 个；原片直传 {uploadOnlySourceSummary.directSourceCount} 个。
                    规则：如果片段已有导出文件，优先上传导出文件；只有没有导出文件时，才会对未编辑的已有片段重命名原文件后直传。
                  </div>
                )}
                {exportOperation !== 'export_only' && exportTargetLocalBoundCount > 0 && (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                    选中片段中有 {exportTargetLocalBoundCount} 个绑定本地补录卡片，将自动跳过上传与平台回写，{exportOperation === 'upload_only' ? '仅作为跳过处理' : '本地导出后落入"本地补录"子文件夹'}。
                  </div>
                )}
              </div>

              {exportOperation !== 'export_only' && (
                <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">上传设置</div>
                      <div className="text-xs text-gray-500">自动记住同时上传文件数和单文件分片线程。</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsUploadSettingsExpanded((current) => !current)}
                      className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100"
                    >
                      {isUploadSettingsExpanded ? '收起' : '展开'}
                      {isUploadSettingsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                  </div>
                  {isUploadSettingsExpanded && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="space-y-2 text-sm font-semibold text-gray-700">
                          同时上传文件数
                          <input
                            type="number"
                            min={1}
                            max={6}
                            value={uploadParallelFiles}
                            onChange={(event) => setUploadParallelFiles(Math.max(1, Number(event.target.value) || 1))}
                            className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 shadow-sm"
                          />
                        </label>
                        <label className="space-y-2 text-sm font-semibold text-gray-700">
                          单文件分片线程
                          <input
                            type="number"
                            min={1}
                            max={8}
                            value={uploadPartThreads}
                            onChange={(event) => setUploadPartThreads(Math.max(1, Number(event.target.value) || 1))}
                            className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 shadow-sm"
                          />
                        </label>
                      </div>
                      <p className="text-xs text-gray-400">默认使用 2 个文件并发上传，每个文件 4 个分片线程。网络或磁盘吃满时可调低。</p>
                    </>
                  )}
                </div>
              )}

              {exportOperation !== 'upload_only' && (
                <div className="space-y-3">
                  <label className="text-sm font-semibold text-gray-700">默认导出目录</label>
                  <input
                    type="text"
                    value={outputDir}
                    onChange={(event) => setOutputDir(event.target.value)}
                    onBlur={() => {
                      if (outputDir.trim()) {
                        void persistDefaultOutputDirectory(outputDir);
                      }
                    }}
                    placeholder="输入或选择默认导出目录"
                    className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 font-mono shadow-sm"
                  />
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        if (hasSavedOutputDir) {
                          setOutputDir(savedOutputDir);
                        }
                      }}
                      disabled={!hasSavedOutputDir}
                      className="rounded-xl border border-gray-200 bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-200 disabled:opacity-50"
                    >
                      使用默认目录
                    </button>
                    {desktopBridge?.isDesktop && (
                      <button
                        onClick={() => void handlePickExportDirectory()}
                        className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
                      >
                        <FolderOpen size={16} />
                        选择文件夹
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-400">
                    {hasSavedOutputDir ? '当前已记住这个目录，下次打开会默认回填。' : '输入或选择目录后，app 会记住它作为下次默认目录。'}
                  </p>
                </div>
              )}

              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">OSS 凭证</div>
                    <div className="text-xs text-gray-500">
                      {hasOssCredentials ? '已配置，可用于包含上传的模式。' : '未配置完整 OSS 凭证，包含上传的模式将无法开始。'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(isPersistingOssCredentials || isPersistingApiKey) && (
                      <div className="text-xs text-gray-400">保存中...</div>
                    )}
                    <button
                      type="button"
                      onClick={() => setIsOssCredentialsExpanded((current) => !current)}
                      className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100"
                    >
                      {isOssCredentialsExpanded ? '收起' : '展开'}
                      {isOssCredentialsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                  </div>
                </div>
                {isOssCredentialsExpanded && (
                  <>
                    <div className="grid grid-cols-1 gap-3">
                      <label className="space-y-1.5">
                        <div className="text-xs font-medium text-gray-600">AccessKey ID</div>
                        <input
                          type="text"
                          value={ossAccessKeyId}
                          onChange={(event) => setOssAccessKeyId(event.target.value)}
                          placeholder="输入 OSS AccessKey ID"
                          className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700 shadow-sm"
                        />
                      </label>
                      <label className="space-y-1.5">
                        <div className="text-xs font-medium text-gray-600">AccessKey Secret</div>
                        <input
                          type="password"
                          value={ossAccessKeySecret}
                          onChange={(event) => setOssAccessKeySecret(event.target.value)}
                          placeholder="输入 OSS AccessKey Secret"
                          className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700 shadow-sm"
                        />
                      </label>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className={hasOssCredentials ? 'text-green-600' : 'text-amber-600'}>
                        {hasOssCredentials ? '已就绪，可执行 OSS 上传' : '未配置完整 OSS 凭证，已绑定片段将无法上传'}
                      </span>
                      {desktopBridge?.isDesktop && (
                        <button
                          onClick={async () => {
                            setOssAccessKeyId('');
                            setOssAccessKeySecret('');
                            if (desktopBridge?.clearOssCredentials) {
                              await desktopBridge.clearOssCredentials();
                            }
                          }}
                          className="text-gray-500 hover:text-gray-700"
                        >
                          清除凭证
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>

              {activeExportJob && (
                <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm space-y-1.5">
                  <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full bg-red-500 transition-all duration-300"
                      style={{width: `${renderJobPercent(activeExportJob)}%`}}
                    />
                  </div>
                  <div className="text-base text-gray-700">{renderJobProgress(activeExportJob)}</div>
                  {activeExportJob.error_message && (
                    <div className="text-xs text-red-600">{activeExportJob.error_message}</div>
                  )}
                </div>
              )}

              {exportOperation !== 'upload_only' && (
                <div className="space-y-3">
                  <label className="text-sm font-semibold text-gray-700">编码模式</label>
                  <select
                    value={exportMode}
                    onChange={(event) => setExportMode(event.target.value as ExportMode)}
                    className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 shadow-sm"
                  >
                    <option value="standard">标准</option>
                    <option value="fast">快速</option>
                  </select>
                  <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="text-sm font-semibold text-gray-900">{EXPORT_MODE_DETAILS[exportMode].label}</div>
                    <div className="mt-1 text-xs text-gray-500">{EXPORT_MODE_DETAILS[exportMode].description}</div>
                  </div>
                </div>
              )}

              {exportSummary && (
                <div className="rounded-2xl bg-white border border-gray-200 p-4 text-sm text-gray-600 space-y-1 shadow-sm">
                  <div>执行模式：{EXPORT_OPERATION_DETAILS[exportSummary.operation].label}</div>
                  <div>输出目录：{exportSummary.output_directory}</div>
                  <div>尝试导出：{exportSummary.attempted}</div>
                  <div>本地导出成功：{exportSummary.exported}</div>
                  <div>OSS 上传成功：{exportSummary.uploaded}</div>
                  <div>平台回写成功：{exportSummary.synced}</div>
                  <div>失败：{exportSummary.failed}</div>
                </div>
              )}

            </div>

            <div className="shrink-0 border-t border-gray-100 bg-white px-6 py-4">
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setShowExport(false)}
                  className="px-4 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium text-sm transition-colors border border-gray-200 shadow-sm"
                >
                  关闭
                </button>
                <button
                  onClick={() => void handleExport()}
                  disabled={exportTargetClipsCount === 0 || Boolean(activeExportJob)}
                  className="px-5 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
                >
                  {activeExportJob
                    ? (activeExportJob.status === 'queued' ? '排队中...' : '处理中...')
                    : `开始${EXPORT_OPERATION_DETAILS[exportOperation].label}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
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
