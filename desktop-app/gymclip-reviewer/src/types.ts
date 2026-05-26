export type VideoStatus =
  | 'queued'
  | 'detecting'
  | 'no_candidates'
  | 'ready_for_review'
  | 'reviewing'
  | 'done'
  | 'error';

export type ClipStatus = 'pending' | 'kept' | 'deleted' | 'exported';

export type PlatformCategory = 'EF' | 'AA' | 'TF' | 'QF';
export type SourceKind = 'full_video' | 'direct_clip';

export type VideoTask = {
  id: string;
  file_path: string;
  file_name: string;
  source_kind: SourceKind;
  platform_scope_id: string;
  match_id: string | null;
  match_name: string;
  frequency_info_id: string | null;
  frequency_info_ids: string[];
  venue: string;
  venues: string[];
  category: PlatformCategory | '';
  sex: number | null;
  sport_selection_keys: string[];
  sport_item_ids: number[];
  team_country: string | null;
  duration: number | null;
  resolution: string | null;
  status: VideoStatus;
  total_candidates: number;
  reviewed_candidates: number;
  error_message: string | null;
  detection_stats: Record<string, unknown>;
  detection_progress: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type PlatformQueryContext = {
  video_id: string;
  platform_scope_id: string;
  match_id: string | null;
  match_name: string;
  frequency_info_id: string | null;
  frequency_info_ids: string[];
  venue: string;
  venues: string[];
  category: PlatformCategory | '';
  sex: number | null;
  sport_selection_keys: string[];
  sport_item_ids: number[];
  team_country: string | null;
  created_at: string;
  updated_at: string;
};

export type PlatformScopeQuery = {
  match_id: string | null;
  match_name: string;
  frequency_info_id: string | null;
  frequency_info_ids: string[];
  venue: string;
  venues: string[];
  category: PlatformCategory | '';
  sex: number | null;
  sport_selection_keys: string[];
  sport_item_ids: number[];
  team_country: string | null;
};

export type PlatformScope = {
  id: string;
  mode: 'single_video' | 'direct_clip_batch';
  query_groups: PlatformScopeQuery[];
  created_at: string;
  updated_at: string;
};

export type DetectionBlock = {
  id: string;
  video_id: string;
  athlete_name: string;
  country: string;
  subtitle_start: number;
  subtitle_end: number;
  confidence: number;
  count: number;
  timestamp: string;
  created_at: string;
  updated_at: string;
};

export type ClipSegment = {
  id: string;
  start: number;
  end: number;
};

export type CandidateClip = {
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
  segments: ClipSegment[];
  confidence: number;
  status: ClipStatus;
  notes: string;
  exported_path: string | null;
  export_error_message: string | null;
  uploaded_object_key: string | null;
  uploaded_url: string | null;
  platform_sync_status: string | null;
  platform_sync_error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type PlatformRecord = {
  id: string;
  video_id: string;
  platform_scope_id: string;
  platform_id: string | null;
  match_id: string | null;
  match_name: string;
  frequency_info_id: string | null;
  venue: string;
  category: PlatformCategory | '';
  sex: number | null;
  team_country: string | null;
  sport_item_id: number | null;
  sport_item_label: string;
  user_name: string;
  english_name: string;
  country: string;
  ranking: string;
  difficulty_score: string;
  execution_score: string;
  bonus_score: string;
  penalty_score: string;
  total_score: string;
  single_score: string;
  video_url: string;
  vault_attempt: number | null;
  raw_record: Record<string, unknown>;
  linked_clip_ids: string[];
  is_local?: boolean;
  created_at: string;
  updated_at: string;
};

export type LocalCardCreatePayload = {
  user_name: string;
  english_name?: string;
  country?: string;
  sport_item_id: number;
  sport_item_label?: string;
  sex?: number | null;
  difficulty_score?: string;
  execution_score?: string;
  bonus_score?: string;
  penalty_score?: string;
  total_score?: string;
};

export type LocalCardUpdatePayload = Partial<LocalCardCreatePayload>;

export type ProjectSettings = {
  ai_backend: string;
  sampling_interval: number;
  detection_threads: number;
  merge_threshold_seconds: number;
  min_detection_count: number;
  pre_padding_seconds: number;
  max_parallel_videos: number;
};

export type ProjectState = {
  version: string;
  name: string;
  created_at: string;
  updated_at: string;
  videos: VideoTask[];
  platform_query_contexts: PlatformQueryContext[];
  platform_scopes: PlatformScope[];
  platform_records: PlatformRecord[];
  detection_blocks: DetectionBlock[];
  candidate_clips: CandidateClip[];
  settings: ProjectSettings;
};

export type ProjectResponse = ProjectState;

export type ImportProjectResponse = {
  imported_count: number;
  imported_videos: VideoTask[];
  project: ProjectState;
};

export type DetectProjectResponse = {
  job: AppJob;
  project: ProjectState;
};

export type CancelDetectResponse = {
  project: ProjectState;
  message: string;
};

export type UpdateClipResponse = {
  project: ProjectState;
};

export type SplitClipResponse = {
  project: ProjectState;
  new_clip_id: string;
};

export type DeleteSegmentResponse = {
  project: ProjectState;
  deleted_clip: boolean;
  surviving_clip_id: string | null;
};

export type RestoreCandidateClipsResponse = {
  project: ProjectState;
};

export type ExportClipResult = {
  clip_id: string;
  video_id: string;
  output_file: string | null;
  success: boolean;
  uploaded_object_key: string | null;
  uploaded_url: string | null;
  platform_synced: boolean;
  error_message: string | null;
};

export type ExportProjectResponse = {
  job: AppJob;
  project: ProjectState;
};

export type JobKind = 'detect' | 'export';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type AppJob = {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  video_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  error_message: string | null;
};

export type JobListResponse = {
  jobs: AppJob[];
};

export type JobResponse = {
  job: AppJob;
};

export type ThumbnailFrame = {
  time_seconds: number;
  url: string;
};

export type ThumbnailResponse = {
  video_id: string;
  start: number;
  end: number;
  count: number;
  thumbnails: ThumbnailFrame[];
};

export type PlatformMatch = {
  id: string;
  match_name: string;
  year: string;
  city: string;
  raw: Record<string, unknown>;
};

export type PlatformFrequency = {
  id: string;
  match_id: string;
  venue: string;
  category: string;
  raw: Record<string, unknown>;
};

export type PlatformMatchesResponse = {
  matches: PlatformMatch[];
};

export type PlatformFrequenciesResponse = {
  frequencies: PlatformFrequency[];
};

export type PlatformTeamCountriesResponse = {
  countries: string[];
};

export type PlatformRecordsResponse = {
  cache_key?: string | null;
  count: number;
  records: PlatformRecord[];
};
