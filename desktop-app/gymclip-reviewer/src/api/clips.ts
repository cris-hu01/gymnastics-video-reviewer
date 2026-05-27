import type {
  DeleteSegmentResponse,
  ExportProjectResponse,
  SplitClipResponse,
  UpdateClipResponse,
} from '../types';
import {request} from './http';

export async function updateClip(
  clipId: string,
  payload: {
    status?: string;
    review_start?: number;
    review_end?: number;
    segments?: Array<{
      id: string;
      start: number;
      end: number;
    }>;
    notes?: string;
  },
): Promise<UpdateClipResponse> {
  return request<UpdateClipResponse>(`/api/clips/${clipId}`, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
}

export async function splitClip(
  clipId: string,
  splitAt: number,
): Promise<SplitClipResponse> {
  return request<SplitClipResponse>(`/api/clips/${clipId}/split`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({split_at: splitAt}),
  });
}

export async function splitClipSegment(
  clipId: string,
  segmentId: string,
  splitAt: number,
): Promise<UpdateClipResponse> {
  return request<UpdateClipResponse>(`/api/clips/${clipId}/split-segment`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({segment_id: segmentId, split_at: splitAt}),
  });
}

export async function extractClipSegment(
  clipId: string,
  segmentId: string,
): Promise<SplitClipResponse> {
  return request<SplitClipResponse>(`/api/clips/${clipId}/extract-segment`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({segment_id: segmentId}),
  });
}

export async function deleteClipSegment(
  clipId: string,
  segmentId: string,
): Promise<DeleteSegmentResponse> {
  return request<DeleteSegmentResponse>(`/api/clips/${clipId}/delete-segment`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({segment_id: segmentId}),
  });
}

export async function bindClipPlatformRecord(
  clipId: string,
  platformRecordId: string | null,
): Promise<UpdateClipResponse> {
  return request<UpdateClipResponse>(`/api/clips/${clipId}/binding`, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({platform_record_id: platformRecordId}),
  });
}

export async function retryClipStage(
  clipId: string,
  stage: 'export' | 'oss' | 'platform',
  options: {
    output_dir?: string;
    oss_access_key_id?: string;
    oss_access_key_secret?: string;
  },
): Promise<ExportProjectResponse> {
  return request<ExportProjectResponse>(`/api/clips/${clipId}/retry-stage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage, ...options }),
  });
}
