import type {KeyboardEvent} from 'react';
import type {
  AppJob,
  PlatformCategory,
  PlatformFrequency,
  PlatformRecord,
} from '../types';
import {
  extractOutputDirectoryLabel,
  formatNotificationCount,
  formatNotificationResultSummary,
  formatNotificationTargetCount,
  truncateNotificationText,
} from './format';
import {summarizeExportJob} from './clip-math';

// ---- Re-exported shared types (originally local to App.tsx) ----

export type ExportOperation = 'export_only' | 'upload_only' | 'export_and_upload';

export type DesktopImportSource = {
  path: string;
  name: string;
  size: number;
};

export type PendingImportVideo = {
  clientFileId: string;
  file: File | null;
  path: string | null;
  name: string;
  sizeBytes: number;
  matchId: string | null;
  selectedFrequencies: PlatformFrequency[];
  manualSportKeys: string[];
};

export type PendingDirectClipFile = {
  clientFileId: string;
  file: File | null;
  path: string | null;
  name: string;
  sizeBytes: number;
};

export type LocalCardFormState = {
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

export type DesktopNotificationPayload = {
  title: string;
  subtitle?: string;
  body?: string;
};

export type ExportJobSummary = {
  operation: ExportOperation;
  attempted: number;
  exported: number;
  failed: number;
  uploaded: number;
  synced: number;
  output_directory: string;
};

export type VenueDerivedSelection = {
  sex: number | null;
  sportItemId: number | null;
};

// ---- Shared constants ----

const DEFAULT_EXPORT_DIRECTORY_STORAGE_KEY = 'gymclip-default-output-dir';
const UPLOAD_PARALLEL_FILES_STORAGE_KEY = 'gymclip-upload-parallel-files';
const UPLOAD_PART_THREADS_STORAGE_KEY = 'gymclip-upload-part-threads';

export const EXPORT_OPERATION_DETAILS: Record<ExportOperation, {label: string; description: string}> = {
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

// ---- Notification builders ----

export function buildExportCompletedNotification(summary: ExportJobSummary): DesktopNotificationPayload {
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

export function buildExportFailedNotification(job: AppJob, fallbackOutputDir: string): DesktopNotificationPayload {
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

// ---- Browser storage helpers ----

export function loadBrowserDefaultExportDirectory(): string {
  try {
    return window.localStorage.getItem(DEFAULT_EXPORT_DIRECTORY_STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

export function saveBrowserDefaultExportDirectory(nextPath: string): void {
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

export function loadBrowserUploadSettings(): {uploadParallelFiles: number; uploadPartThreads: number} {
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

export function saveBrowserUploadSettings(uploadParallelFiles: number, uploadPartThreads: number): void {
  try {
    window.localStorage.setItem(UPLOAD_PARALLEL_FILES_STORAGE_KEY, String(Math.max(1, uploadParallelFiles)));
    window.localStorage.setItem(UPLOAD_PART_THREADS_STORAGE_KEY, String(Math.max(1, uploadPartThreads)));
  } catch {
    // ignore localStorage failures in browser preview
  }
}

// ---- String / category helpers ----

export function normalizeCategory(value: string | null | undefined): PlatformCategory | '' {
  if (value === 'EF' || value === 'AA' || value === 'TF' || value === 'QF') {
    return value;
  }
  return '';
}

export function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

// ---- Import helpers ----

export function createPendingImportVideo(file: File | DesktopImportSource): PendingImportVideo {
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

export function createPendingDirectClipFile(file: File | DesktopImportSource): PendingDirectClipFile {
  const isBrowserFile = file instanceof File;
  return {
    clientFileId: `clip_${crypto.randomUUID()}`,
    file: isBrowserFile ? file : null,
    path: isBrowserFile ? null : file.path,
    name: isBrowserFile ? file.name : file.name,
    sizeBytes: isBrowserFile ? file.size : file.size,
  };
}

export function isDesktopImportSource(entry: File | DesktopImportSource): entry is DesktopImportSource {
  return !(entry instanceof File);
}

// ---- Sport key helpers ----

export function sportKey(sex: number, sportItemId: number): string {
  return `${sex}:${sportItemId}`;
}

export function parseSportKey(value: string): {sex: number; sportItemId: number} | null {
  const [rawSex, rawSportItemId] = value.split(':');
  const sex = Number(rawSex);
  const sportItemId = Number(rawSportItemId);
  if (![1, 2].includes(sex) || Number.isNaN(sportItemId)) return null;
  return {sex, sportItemId};
}

export function toggleSportKey(current: string[], next: string): string[] {
  return current.includes(next)
    ? current.filter((item) => item !== next)
    : [...current, next];
}

// ---- Venue helpers ----

export function normalizeVenueText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, '');
}

export function deriveSelectionFromVenue(venue: string): VenueDerivedSelection {
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

// ---- Local card form helpers ----

export function emptyLocalCardForm(): LocalCardFormState {
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

export function localCardRecordToForm(record: PlatformRecord): LocalCardFormState {
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

// ---- Event utility ----

export function stopFormShortcutPropagation(event: KeyboardEvent<HTMLElement>) {
  event.stopPropagation();
}
