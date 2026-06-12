import type {
  AppJob,
  DetectProjectResponse,
  ExportProjectResponse,
  ProjectResponse,
  RestoreCandidateClipsResponse,
} from '../types';
import {request} from './http';

export async function fetchProject(): Promise<ProjectResponse> {
  return request<ProjectResponse>('/api/project');
}

export async function detectProjectVideo(
  videoId: string,
  apiKey?: string,
): Promise<DetectProjectResponse> {
  return request<DetectProjectResponse>('/api/project/detect', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({video_id: videoId, api_key: apiKey || undefined}),
  });
}

export async function restoreCandidateClips(
  candidateClips: Array<{
    id: string;
    video_id: string;
    detection_block_id: string | null;
    linked_platform_record_id: string | null;
    athlete_name: string;
    country: string;
    subtitle_start: number;
    subtitle_end: number;
    candidate_start: number;
    candidate_end: number;
    review_start: number;
    review_end: number;
    segments: Array<{
      id: string;
      start: number;
      end: number;
    }>;
    confidence: number;
    status: string;
    notes: string;
    exported_path: string | null;
    export_error_message: string | null;
    uploaded_object_key: string | null;
    uploaded_url: string | null;
    platform_sync_status: string | null;
    platform_sync_error_message: string | null;
    created_at: string;
    updated_at: string;
  }>,
): Promise<RestoreCandidateClipsResponse> {
  return request<RestoreCandidateClipsResponse>('/api/project/candidate-clips/restore', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({candidate_clips: candidateClips}),
  });
}

export async function exportProject(payload: {
  output_dir?: string;
  video_id?: string;
  clip_ids?: string[];
  export_mode?: string;
  operation?: 'export_only' | 'upload_only' | 'export_and_upload';
  oss_access_key_id?: string;
  oss_access_key_secret?: string;
  upload_parallel_files?: number;
  upload_part_threads?: number;
}): Promise<ExportProjectResponse> {
  return request<ExportProjectResponse>('/api/project/export', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
}

export async function cancelExport(): Promise<{job: AppJob; message: string}> {
  return request<{job: AppJob; message: string}>('/api/project/cancel-export', {
    method: 'POST',
  });
}
