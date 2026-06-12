import type {
  CancelDetectResponse,
  ProjectResponse,
  ThumbnailResponse,
} from '../types';
import {buildMediaUrl, request} from './http';

export function getVideoStreamUrl(videoId: string): string {
  // <video> src cannot carry headers — buildMediaUrl appends ?token=.
  return buildMediaUrl(`/api/videos/${videoId}/stream`);
}

export async function cancelDetectVideo(videoId: string): Promise<CancelDetectResponse> {
  return request<CancelDetectResponse>(`/api/videos/${videoId}/cancel-detect`, {
    method: 'POST',
  });
}

export async function addVideoAsCandidate(videoId: string): Promise<ProjectResponse> {
  return request<ProjectResponse>(`/api/videos/${videoId}/add-as-candidate`, {
    method: 'POST',
  });
}

export async function deleteProjectVideo(videoId: string): Promise<ProjectResponse> {
  return request<ProjectResponse>(`/api/videos/${videoId}`, {
    method: 'DELETE',
  });
}

export async function fetchVideoThumbnails(
  videoId: string,
  payload: {
    start: number;
    end: number;
    count?: number;
  },
): Promise<ThumbnailResponse> {
  const query = new URLSearchParams({
    start: String(payload.start),
    end: String(payload.end),
    count: String(payload.count ?? 12),
  });
  return request<ThumbnailResponse>(`/api/videos/${videoId}/thumbnails?${query.toString()}`);
}
