// Formatting & display helpers extracted from App.tsx (A1-2 refactor).
//
// These are pure helpers — no React, no hooks, no side effects.
// Function bodies preserved verbatim from App.tsx (commit 16421a5).
//
// Grouped by theme: 通知 → 通用 → 时间 → 字节 → 状态 → 分数 → tone

import type {
  AppJob,
  ClipStatus,
  PlatformCategory,
  PlatformRecord,
  PlatformScope,
  ProjectState,
  SourceKind,
  VideoStatus,
} from '../types';

// ---------------------------------------------------------------------------
// Local type aliases & constants (mirrored from App.tsx to keep format.ts
// self-contained; original definitions in App.tsx remain untouched).
// ---------------------------------------------------------------------------

type ExportOperation = 'export_only' | 'upload_only' | 'export_and_upload';

export type ExportJobSummary = {
  operation: ExportOperation;
  attempted: number;
  exported: number;
  failed: number;
  uploaded: number;
  synced: number;
  output_directory: string;
};

export type PipelineTone = 'neutral' | 'muted' | 'success' | 'warning' | 'danger';

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

// ===========================================================================
// 通知 (notifications)
// ===========================================================================

export function formatNotificationCount(label: string, completed: number, total: number): string {
  if (total > 0) {
    return `${label}：${completed}/${total}`;
  }
  return `${label}：${completed}`;
}

export function truncateNotificationText(value: string, maxLength = 96): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function formatNotificationTargetCount(count: number): string {
  return `目标片段：${count}`;
}

export function formatNotificationResultSummary(summary: ExportJobSummary): string {
  if (summary.failed > 0) {
    return `部分完成，失败 ${summary.failed}`;
  }
  return '全部完成';
}

export function extractOutputDirectoryLabel(outputDirectory: string): string {
  const trimmed = outputDirectory.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  const folderName = segments[segments.length - 1] || trimmed;
  return truncateNotificationText(folderName, 28);
}

// ===========================================================================
// 通用 (generic)
// ===========================================================================

export function firstDisplayText(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return '';
}

export function compactJoin(values: string[], maxVisible: number = 2): string {
  const filtered = values.filter((value) => value.trim().length > 0);
  if (filtered.length <= maxVisible) {
    return filtered.join(' / ');
  }
  return `${filtered.slice(0, maxVisible).join(' / ')} 等 ${filtered.length} 项`;
}

export function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

// ===========================================================================
// 时间 (duration / clock)
// ===========================================================================

export function formatDuration(value?: number | null): string {
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

export function formatClock(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '--:--:--';
  const totalSeconds = Math.max(0, value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

// ===========================================================================
// 字节 / 速度 (bytes / speed)
// ===========================================================================

export function formatBytes(value?: number | null): string {
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

export function formatSpeed(value?: number | null): string {
  if (value == null || Number.isNaN(value) || value <= 0) return '--';
  return `${formatBytes(value)}/s`;
}

// ===========================================================================
// 状态 (status labels & classes)
// ===========================================================================

export function getExportQueueStatusLabel(job: AppJob | null): string {
  const operation = String(job?.progress.operation || 'export_and_upload') as ExportOperation;
  return operation === 'upload_only' ? '上传队列中' : '导出队列中';
}

export function statusLabel(status: ClipStatus | VideoStatus): string {
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

export function clipBadgeClass(status: ClipStatus): string {
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

export function videoStatusClass(status: VideoStatus, sourceKind: SourceKind = 'full_video'): string {
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

export function videoStatusLabel(video: ProjectState['videos'][number]): string {
  if (video.source_kind === 'direct_clip') {
    if (video.status === 'error') return '异常';
    if (video.status === 'done') return '已完成';
    return '已就绪';
  }
  return statusLabel(video.status);
}

export function categoryLabel(value: string | null | undefined): string {
  if (!value) return '未选择';
  return CATEGORY_OPTIONS.find((item) => item.value === value)?.label ?? value;
}

export function formatScopeFolderLabel(scope: PlatformScope | null): string {
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

export function formatSportItemLabel(id: number | null | undefined, sex?: number | null): string {
  if (id == null) return '--';
  const base = SPORT_ITEM_LABELS[id] ?? String(id);
  if (sex === 1) return `男子${base}`;
  if (sex === 2) return `女子${base}`;
  return base;
}

// ---------------------------------------------------------------------------
// parseSportKey is shared with App.tsx (used by selectionSummaryLabel below
// and by other call sites that still live in App.tsx). Exporting so App.tsx
// can import it back.
// ---------------------------------------------------------------------------
export function parseSportKey(value: string): {sex: number; sportItemId: number} | null {
  const [rawSex, rawSportItemId] = value.split(':');
  const sex = Number(rawSex);
  const sportItemId = Number(rawSportItemId);
  if (![1, 2].includes(sex) || Number.isNaN(sportItemId)) return null;
  return {sex, sportItemId};
}

export function selectionSummaryLabel(selectionKeys: string[]): string {
  if (selectionKeys.length === 0) return '未选择项目';
  return selectionKeys
    .map((key) => parseSportKey(key))
    .filter((item): item is {sex: number; sportItemId: number} => item != null)
    .map((item) => formatSportItemLabel(item.sportItemId, item.sex))
    .join(' / ');
}

// ===========================================================================
// 分数 (scores)
// ===========================================================================

// parseNumericScore / firstNonEmptyScore / deriveDisplayedScore are private
// helpers required by the score formatters below. Exported so App.tsx can
// import them when needed; not in the original 28-helper migration list but
// pulled along to keep migrated bodies verbatim.

export function firstNonEmptyScore(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function parseNumericScore(value: unknown): number | null {
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

export function formatScoreValue(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return '--';
  const numeric = parseNumericScore(text);
  if (!Number.isFinite(numeric)) return '--';
  return numeric.toFixed(3);
}

export function deriveDisplayedScore(record: PlatformRecord): string {
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

export function formatScoreExpression(values: string[]): string {
  return values.reduce((result, value, index) => {
    if (index === 0) return value;
    return /^[+-]/.test(value) ? `${result}${value}` : `${result}+${value}`;
  }, '');
}

export function isZeroScore(value: string): boolean {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric === 0;
}

export function scoreFormulaLabel(record: PlatformRecord): string {
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

export function primaryScoreValue(record: PlatformRecord): string {
  return deriveDisplayedScore(record);
}

// ===========================================================================
// tone (pipeline badge tone classes)
// ===========================================================================

export function pipelineToneClass(tone: PipelineTone): string {
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

