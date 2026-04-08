import type {
  CancelDetectResponse,
  DeleteSegmentResponse,
  DetectProjectResponse,
  ExportProjectResponse,
  ImportProjectResponse,
  JobListResponse,
  JobResponse,
  PlatformFrequenciesResponse,
  PlatformMatchesResponse,
  PlatformRecordsResponse,
  PlatformScopeQuery,
  PlatformTeamCountriesResponse,
  ProjectResponse,
  RestoreCandidateClipsResponse,
  SplitClipResponse,
  ThumbnailResponse,
  UpdateClipResponse,
} from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    cache: 'no-store',
    ...init,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (typeof data?.detail === 'string') {
        message = data.detail;
      }
    } catch {
      // ignore json parse errors for non-json responses
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

export function getVideoStreamUrl(videoId: string): string {
  return `${API_BASE_URL}/api/videos/${videoId}/stream`;
}

export async function fetchProject(): Promise<ProjectResponse> {
  return request<ProjectResponse>('/api/project');
}

export async function fetchPlatformMatches(): Promise<PlatformMatchesResponse> {
  return request<PlatformMatchesResponse>('/api/platform/matches');
}

export async function fetchPlatformFrequencies(params: {
  matchId?: string | null;
  matchName?: string;
  category?: string;
}): Promise<PlatformFrequenciesResponse> {
  const query = new URLSearchParams();
  if (params.matchId != null) query.set('match_id', String(params.matchId));
  if (params.matchName) query.set('match_name', params.matchName);
  if (params.category) query.set('category', params.category);
  return request<PlatformFrequenciesResponse>(`/api/platform/frequencies?${query.toString()}`);
}

export async function fetchPlatformTeamCountries(params: {
  frequencyInfoId: string;
  sex: number;
  matchName?: string;
  venue?: string;
}): Promise<PlatformTeamCountriesResponse> {
  const query = new URLSearchParams({
    frequency_info_id: String(params.frequencyInfoId),
    sex: String(params.sex),
  });
  if (params.matchName) query.set('match_name', params.matchName);
  if (params.venue) query.set('venue', params.venue);
  return request<PlatformTeamCountriesResponse>(`/api/platform/team-countries?${query.toString()}`);
}

export async function fetchPlatformRecords(params: {
  matchId?: string | null;
  matchName: string;
  frequencyInfoIds: string[];
  venues: string[];
  category: string;
  sportSelectionKeys: string[];
  sportItemIds: number[];
}): Promise<PlatformRecordsResponse> {
  const query = new URLSearchParams({
    match_name: params.matchName,
    category: params.category,
    sport_item_ids: params.sportItemIds.join(','),
  });
  if (params.matchId != null) query.set('match_id', String(params.matchId));
  params.frequencyInfoIds.forEach((id) => query.append('frequency_info_ids', String(id)));
  params.venues.forEach((venue) => query.append('venues', venue));
  params.sportSelectionKeys.forEach((key) => query.append('sport_selection_keys', key));
  return request<PlatformRecordsResponse>(`/api/platform/records?${query.toString()}`);
}

export async function previewScopePlatformRecords(
  scopeQueries: PlatformScopeQuery[],
): Promise<PlatformRecordsResponse> {
  return request<PlatformRecordsResponse>('/api/platform/records/preview-scope', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({scope_queries: scopeQueries}),
  });
}

export async function importProjectFiles(
  files: Array<{
    clientFileId: string;
    file: File | null;
    path?: string | null;
    matchId?: string | null;
    matchName: string;
    frequencyInfoIds: string[];
    venues: string[];
    category: string;
    sportSelectionKeys: string[];
    sportItemIds: number[];
  }>,
): Promise<ImportProjectResponse> {
  const shouldUseJsonPaths = files.every((item) => !item.file && item.path);
  if (shouldUseJsonPaths) {
    return request<ImportProjectResponse>('/api/project/import', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        files: files.map((item) => ({
          path: item.path,
          match_id: item.matchId ?? null,
          match_name: item.matchName,
          frequency_info_ids: item.frequencyInfoIds,
          venues: item.venues,
          category: item.category,
          sport_selection_keys: item.sportSelectionKeys,
          sport_item_ids: item.sportItemIds,
        })),
      }),
    });
  }
  const formData = new FormData();
  formData.append(
    'contexts_json',
    JSON.stringify(
      files.map((item) => ({
        client_file_id: item.clientFileId,
        match_id: item.matchId ?? null,
        match_name: item.matchName,
        frequency_info_ids: item.frequencyInfoIds,
        venues: item.venues,
        category: item.category,
        sport_selection_keys: item.sportSelectionKeys,
        sport_item_ids: item.sportItemIds,
      })),
    ),
  );
  files.forEach((item) => {
    if (item.file) {
      formData.append('files', item.file);
      formData.append('file_client_ids', item.clientFileId);
    }
  });
  return request<ImportProjectResponse>('/api/project/import', {
    method: 'POST',
    body: formData,
  });
}

export async function importDirectClipFiles(
  files: Array<{
    clientFileId: string;
    file: File | null;
    path?: string | null;
  }>,
  scopeQueries: PlatformScopeQuery[],
  previewCacheKey?: string | null,
): Promise<ImportProjectResponse> {
  const shouldUseJsonPaths = files.every((item) => !item.file && item.path);
  if (shouldUseJsonPaths) {
    return request<ImportProjectResponse>('/api/project/import-direct-clips', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        scope_queries: scopeQueries,
        preview_cache_key: previewCacheKey ?? null,
        files: files.map((item) => ({path: item.path})),
      }),
    });
  }
  const formData = new FormData();
  formData.append('scope_queries_json', JSON.stringify(scopeQueries));
  if (previewCacheKey) {
    formData.append('preview_cache_key', previewCacheKey);
  }
  files.forEach((item) => {
    if (item.file) {
      formData.append('files', item.file);
      formData.append('file_client_ids', item.clientFileId);
    }
  });
  return request<ImportProjectResponse>('/api/project/import-direct-clips', {
    method: 'POST',
    body: formData,
  });
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

export async function cancelDetectVideo(videoId: string): Promise<CancelDetectResponse> {
  return request<CancelDetectResponse>(`/api/videos/${videoId}/cancel-detect`, {
    method: 'POST',
  });
}

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

export async function deleteProjectVideo(videoId: string): Promise<ProjectResponse> {
  return request<ProjectResponse>(`/api/videos/${videoId}`, {
    method: 'DELETE',
  });
}

export async function fetchJobs(): Promise<JobListResponse> {
  return request<JobListResponse>('/api/jobs');
}

export async function fetchJob(jobId: string): Promise<JobResponse> {
  return request<JobResponse>(`/api/jobs/${jobId}`);
}

export async function retryClipStage(
  clipId: string,
  stage: 'export' | 'oss' | 'platform',
  options?: {
    output_dir?: string;
    oss_access_key_id?: string;
    oss_access_key_secret?: string;
  },
): Promise<UpdateClipResponse> {
  return request<UpdateClipResponse>(`/api/clips/${clipId}/retry-stage`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({stage, ...options}),
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

export async function fetchScrubThumbnails(
  videoId: string,
  payload: {
    start: number;
    end: number;
    fps?: number;
  },
): Promise<ThumbnailResponse> {
  const query = new URLSearchParams({
    start: String(payload.start),
    end: String(payload.end),
    fps: String(payload.fps ?? 2),
  });
  return request<ThumbnailResponse>(`/api/videos/${videoId}/scrub-thumbnails?${query.toString()}`);
}
