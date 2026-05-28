import type {
  AppJob,
  CandidateClip,
  ClipSegment,
  PlatformRecord,
  ProjectState,
} from '../types';

// ---------------------------------------------------------------------------
// Local-only types used by helpers below. Kept here (not in src/types.ts) to
// avoid widening the public surface of the global type module; the original
// definitions lived inside App.tsx and were not exported elsewhere.
// ---------------------------------------------------------------------------

export type ExportOperation = 'export_only' | 'upload_only' | 'export_and_upload';

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

export type ExportJobSummary = {
  operation: ExportOperation;
  attempted: number;
  exported: number;
  failed: number;
  uploaded: number;
  synced: number;
  output_directory: string;
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

// Step granularity used when normalizing segment boundaries — kept aligned with
// the constant of the same name in App.tsx.
const CLIP_STEP = 0.2;

// ---------------------------------------------------------------------------
// count / summary
// ---------------------------------------------------------------------------

export function normalizeJobCount(value: unknown): number {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export function summarizeExportJob(job: AppJob, fallbackOutputDir: string): ExportJobSummary {
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

// ---------------------------------------------------------------------------
// upload parse
// ---------------------------------------------------------------------------

export function toUploadItem(value: unknown): ExportUploadItem | null {
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
// score
// ---------------------------------------------------------------------------

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

export function parseScoreNumber(value: string): number {
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function computeLocalCardAutoTotal(form: LocalCardFormState): string {
  const total =
    parseScoreNumber(form.difficulty_score) +
    parseScoreNumber(form.execution_score) +
    parseScoreNumber(form.bonus_score) -
    parseScoreNumber(form.penalty_score);
  return total.toFixed(3).replace(/\.?0+$/, '') || '0';
}

// ---------------------------------------------------------------------------
// segment / duration / direct-clip eligibility
// ---------------------------------------------------------------------------

export function orderedSegments(clip: CandidateClip): ClipSegment[] {
  return [...clip.segments].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}

export function clipEffectiveDuration(clip: CandidateClip): number {
  return orderedSegments(clip).reduce((total, segment) => total + Math.max(0, segment.end - segment.start), 0);
}

export function isDirectSourceUploadEligible(
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

export function getUploadOnlySourceMode(
  clip: CandidateClip,
  video?: ProjectState['videos'][number] | null,
): 'exported_file' | 'direct_source' | 'invalid' {
  if (clip.exported_path) return 'exported_file';
  if (isDirectSourceUploadEligible(clip, video)) return 'direct_source';
  return 'invalid';
}

export function normalizeSegments(
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

export function firstEditableSegment(clip: CandidateClip): ClipSegment | null {
  return orderedSegments(clip)[0] ?? null;
}

// ---------------------------------------------------------------------------
// deep clone
// ---------------------------------------------------------------------------

export function cloneCandidateClips(clips: CandidateClip[]): CandidateClip[] {
  return clips.map((clip) => ({
    ...clip,
    segments: clip.segments.map((segment) => ({...segment})),
  }));
}
