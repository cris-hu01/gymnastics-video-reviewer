/**
 * Progress-text helpers extracted from App.tsx during A4-6.
 *
 * These are pure functions — given a video / job snapshot they return the
 * human-readable label or percent. They live in lib so any panel that
 * needs to display task progress (VideoListPanel, the in-app banner,
 * potentially a future detail drawer) can import them without going
 * through App.
 */
import type {AppJob, ProjectState} from '../types';
import type {ExportOperation} from './utils';

import {formatSpeed} from './format';

type ProjectVideo = ProjectState['videos'][number];

/**
 * Human-readable progress string for a row in VideoListPanel.
 *
 * `activeJobs` is supplied by the caller because the snapshot lives in
 * the zustand store and we want this function to stay pure (no React
 * hooks).
 */
export function describeVideoProgress(video: ProjectVideo, activeJobs: AppJob[]): string {
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

  if (stage === 'cancel_requested') return message || '正在取消检测...';
  if (stage === 'cancelled') return message || '检测已取消';
  if (stage === 'interrupted') return message || '检测任务已中断，请重新开始';

  if (stage === 'completed') {
    const finalCount = progress.final_count;
    if (typeof finalCount === 'number') {
      if (finalCount === 0) return '检测完成，未识别到候选片段';
      return `检测完成，得到 ${finalCount} 个候选`;
    }
    return '检测完成';
  }

  if (video.status === 'error' && video.error_message) {
    return video.error_message;
  }

  return `${video.reviewed_candidates}/${video.total_candidates} 已审`;
}

/**
 * Human-readable status string for a row in the active-jobs banner.
 * Branches by job.kind + job.status; export jobs have the most complex
 * label because they multiplex three pipeline stages.
 */
export function describeJobProgress(job: AppJob): string {
  const completed = Number(job.progress.completed || 0);
  const total = Number(job.progress.total || 0);
  const message = String(job.progress.message || '');
  const stage = String(job.progress.stage || '');

  if (job.status === 'failed') return job.error_message || '任务失败';
  if (job.status === 'cancelled') return message || '任务已取消';

  if (job.kind === 'export') {
    const progressRecord = job.progress as Record<string, unknown>;
    const aggregateUploadSpeed = Number(progressRecord.aggregate_upload_speed_bps || 0);
    const activeUploadCount = Number(progressRecord.active_upload_count || 0);
    const localExported = Number(progressRecord.local_exported || 0);
    const uploaded = Number(progressRecord.uploaded || 0);
    const synced = Number(progressRecord.synced || 0);
    const operation = String(progressRecord.operation || 'export_and_upload') as ExportOperation;
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
    const label =
      stageLabel ||
      (message && message !== '等待检测任务开始' ? message : '') ||
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

/**
 * Job completion percentage [0, 100]. Export jobs multiplex multiple
 * pipeline stages per clip and use steps_per_clip from backend.
 */
export function jobPercent(job: AppJob): number {
  const completed = Number(job.progress.completed || 0);
  const total = Number(job.progress.total || 0);
  const stage = String(job.progress.stage || '');
  const progressRecord = job.progress as Record<string, unknown>;
  const completedSteps = Number(progressRecord.completed_steps || 0);
  const totalStepsRaw = Number(progressRecord.total_steps || 0);
  if (job.kind === 'export' && totalStepsRaw > 0) {
    return Math.max(0, Math.min(100, Math.round((completedSteps / totalStepsRaw) * 100)));
  }
  if (total <= 0) return 0;
  if (job.kind === 'export') {
    const operation = String(job.progress.operation || 'export_and_upload') as ExportOperation;
    const stepsPerClip = Number(
      job.progress.steps_per_clip ||
        (operation === 'export_only' ? 1 : operation === 'upload_only' ? 2 : 3),
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
