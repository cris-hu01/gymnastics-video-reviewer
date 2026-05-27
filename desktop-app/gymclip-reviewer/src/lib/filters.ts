// Pure helpers extracted from App.tsx (A1-3 refactor).
// Filter / search / sex / pipeline status / clip display utilities.
// IMPORTANT: this module MUST stay free of React, hooks, and any side effects.

import type {
  AppJob,
  CandidateClip,
  ClipStatus,
  PlatformRecord,
  ProjectState,
} from '../types';

// ---------------------------------------------------------------------------
// Local type aliases (mirror the equivalent App.tsx-local declarations so that
// this module stays self-contained without touching unrelated App.tsx code).
// ---------------------------------------------------------------------------

export type PipelineTone = 'neutral' | 'muted' | 'success' | 'warning' | 'danger';

export type ClipPipelineBadgeItem = {
  key: 'export' | 'oss' | 'platform';
  text: string;
  tone: PipelineTone;
};

export type ExportUploadItem = {
  clip_id: string;
  file_name: string;
  stage: string;
  bytes_sent: number;
  total_bytes: number;
  percent: number;
  speed_bps: number;
  error_message: string | null;
};

type ExportOperation = 'export_only' | 'upload_only' | 'export_and_upload';

// ---------------------------------------------------------------------------
// Private helpers (kept here because they are referenced by the extracted
// functions; the App.tsx copies remain because they are also used by other
// (non-extracted) call sites and we are not allowed to touch unrelated code).
// ---------------------------------------------------------------------------

function firstDisplayText(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return '';
}

function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function parseSportKey(value: string): {sex: number; sportItemId: number} | null {
  const [rawSex, rawSportItemId] = value.split(':');
  const sex = Number(rawSex);
  const sportItemId = Number(rawSportItemId);
  if (![1, 2].includes(sex) || Number.isNaN(sportItemId)) return null;
  return {sex, sportItemId};
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
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

function getExportQueueStatusLabel(job: AppJob | null): string {
  const operation = String(job?.progress.operation || 'export_and_upload') as ExportOperation;
  return operation === 'upload_only' ? '上传队列中' : '导出队列中';
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

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------

export function getJobUploadItems(job: AppJob | null): ExportUploadItem[] {
  if (!job) return [];
  const rawItems = (job.progress as Record<string, unknown>).upload_items;
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((item) => toUploadItem(item))
    .filter((item): item is ExportUploadItem => item != null);
}

export function getClipUploadItem(job: AppJob | null, clipId: string): ExportUploadItem | null {
  return getJobUploadItems(job).find((item) => item.clip_id === clipId) ?? null;
}

export function getJobTargetClipIds(job: AppJob | null): string[] {
  if (!job) return [];
  const rawTargetClipIds = (job.progress as Record<string, unknown>).target_clip_ids;
  if (!Array.isArray(rawTargetClipIds)) return [];
  return rawTargetClipIds
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0);
}

// ---------------------------------------------------------------------------
// Clip display helpers
// ---------------------------------------------------------------------------

export function bindingTheme(recordId: string) {
  const hue = hashString(recordId) % 360;
  return {
    accent: `hsl(${hue} 72% 46%)`,
    accentSoft: `hsla(${hue}, 85%, 94%, 1)`,
    accentStrong: `hsla(${hue}, 90%, 90%, 1)`,
    border: `hsla(${hue}, 62%, 72%, 1)`,
    text: `hsl(${hue} 55% 32%)`,
  };
}

export function isClipExportSelectable(status: ClipStatus): boolean {
  return status === 'kept' || status === 'exported';
}

export function getClipDisplayName(
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

export function getClipDisplayCountry(clip: CandidateClip, linkedRecord?: PlatformRecord | null): string {
  return firstDisplayText(linkedRecord?.country, clip.country) || '--';
}

// ---------------------------------------------------------------------------
// Sex / gender helpers
// ---------------------------------------------------------------------------

export function coerceRecordSex(value: unknown): number | null {
  if (value === 1 || value === 2) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '1' || trimmed === '男' || trimmed === '男子' || trimmed.toUpperCase() === 'M') return 1;
    if (trimmed === '2' || trimmed === '女' || trimmed === '女子' || trimmed.toUpperCase() === 'W') return 2;
  }
  return null;
}

export function deriveSexFromText(...values: Array<string | null | undefined>): number | null {
  const merged = values.join('');
  if (merged.includes('男子') || merged.includes('男')) return 1;
  if (merged.includes('女子') || merged.includes('女')) return 2;
  return null;
}

export function deriveSexFromSelectionKeys(selectionKeys: string[], sportItemId: number | null | undefined): number | null {
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

export function deriveSexFromSportItemId(sportItemId: number | null | undefined): number | null {
  if (sportItemId == null) return null;
  if ([1, 2, 4, 5].includes(sportItemId)) return 1;
  if ([6, 7].includes(sportItemId)) return 2;
  return null;
}

export function getResolvedPlatformRecordSex(
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

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

export function getClipSearchText(
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

// ---------------------------------------------------------------------------
// Clip failure / pipeline helpers
// ---------------------------------------------------------------------------

export function getClipFailureStage(clip: CandidateClip): 'export' | 'oss' | 'platform' | null {
  if (clip.platform_sync_status !== 'failed') return null;
  if (!clip.exported_path) return 'export';
  if (clip.uploaded_url) return 'platform';
  if (clip.linked_platform_record_id) return 'oss';
  return 'export';
}

export function getClipPipelineBadges(
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

// ---------------------------------------------------------------------------
// Clip runtime helpers
// ---------------------------------------------------------------------------

export function getClipRuntimeStatusText(
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
