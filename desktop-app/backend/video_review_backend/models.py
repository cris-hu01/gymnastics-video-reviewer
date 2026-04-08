from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def _as_int_list(values: Any) -> list[int]:
    result: list[int] = []
    for value in values or []:
        try:
            result.append(int(value))
        except (TypeError, ValueError):
            continue
    return result


def _as_str_list(values: Any) -> list[str]:
    result: list[str] = []
    for value in values or []:
        text = str(value or "").strip()
        if text:
            result.append(text)
    return result


def _coerce_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_str(value: Any) -> str | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    return text or None


def _load_clip_segments(data: dict[str, Any]) -> list["ClipSegment"]:
    raw_segments = data.get("segments") or []
    if raw_segments:
        return [ClipSegment.from_dict(item) for item in raw_segments if isinstance(item, dict)]

    review_start = float(data.get("review_start") or data.get("candidate_start") or 0.0)
    review_end = float(
        data.get("review_end")
        or data.get("candidate_end")
        or review_start
    )
    gap_start = data.get("gap_start")
    gap_end = data.get("gap_end")
    if gap_start in (None, "") or gap_end in (None, ""):
        return [ClipSegment(id=new_id("seg"), start=review_start, end=review_end)]

    gap_start_value = float(gap_start)
    gap_end_value = float(gap_end)
    segments: list[ClipSegment] = []
    if gap_start_value > review_start:
        segments.append(ClipSegment(id=new_id("seg"), start=review_start, end=gap_start_value))
    if gap_end_value < review_end:
        segments.append(ClipSegment(id=new_id("seg"), start=gap_end_value, end=review_end))
    if not segments:
        segments.append(ClipSegment(id=new_id("seg"), start=review_start, end=review_end))
    return segments


@dataclass
class VideoTask:
    id: str
    file_path: str
    file_name: str
    source_kind: str = "full_video"
    platform_scope_id: str = ""
    match_id: str | None = None
    match_name: str = ""
    frequency_info_id: str | None = None
    frequency_info_ids: list[str] = field(default_factory=list)
    venue: str = ""
    venues: list[str] = field(default_factory=list)
    category: str = ""
    sex: int | None = None
    sport_selection_keys: list[str] = field(default_factory=list)
    sport_item_ids: list[int] = field(default_factory=list)
    team_country: str | None = None
    duration: float | None = None
    resolution: str | None = None
    status: str = "queued"
    total_candidates: int = 0
    reviewed_candidates: int = 0
    error_message: str | None = None
    detection_stats: dict[str, Any] = field(default_factory=dict)
    detection_progress: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "VideoTask":
        video_id = str(data.get("id") or new_id("video"))
        source_kind = str(data.get("source_kind") or "full_video").strip() or "full_video"
        if source_kind not in {"full_video", "direct_clip"}:
            source_kind = "full_video"
        payload = {
            "id": video_id,
            "file_path": str(data.get("file_path") or ""),
            "file_name": str(data.get("file_name") or ""),
            "source_kind": source_kind,
            "platform_scope_id": str(data.get("platform_scope_id") or video_id),
            "match_id": _coerce_str(data.get("match_id")),
            "match_name": str(data.get("match_name") or ""),
            "frequency_info_id": _coerce_str(data.get("frequency_info_id")),
            "frequency_info_ids": _as_str_list(data.get("frequency_info_ids")),
            "venue": str(data.get("venue") or ""),
            "venues": _as_str_list(data.get("venues")),
            "category": str(data.get("category") or ""),
            "sex": _coerce_int(data.get("sex")),
            "sport_selection_keys": _as_str_list(data.get("sport_selection_keys")),
            "sport_item_ids": _as_int_list(data.get("sport_item_ids")),
            "team_country": str(data.get("team_country") or "").strip() or None,
            "duration": data.get("duration"),
            "resolution": data.get("resolution"),
            "status": str(data.get("status") or "queued"),
            "total_candidates": int(data.get("total_candidates") or 0),
            "reviewed_candidates": int(data.get("reviewed_candidates") or 0),
            "error_message": data.get("error_message"),
            "detection_stats": dict(data.get("detection_stats") or {}),
            "detection_progress": dict(data.get("detection_progress") or {}),
            "created_at": str(data.get("created_at") or utc_now_iso()),
            "updated_at": str(data.get("updated_at") or utc_now_iso()),
        }
        if not payload["frequency_info_ids"] and payload["frequency_info_id"]:
            payload["frequency_info_ids"] = [payload["frequency_info_id"]]
        if not payload["venues"] and payload["venue"]:
            payload["venues"] = [payload["venue"]]
        if payload["frequency_info_id"] is None and payload["frequency_info_ids"]:
            payload["frequency_info_id"] = payload["frequency_info_ids"][0]
        if not payload["venue"] and payload["venues"]:
            payload["venue"] = payload["venues"][0]
        return cls(**payload)


@dataclass
class PlatformQueryContext:
    video_id: str
    platform_scope_id: str = ""
    match_id: str | None = None
    match_name: str = ""
    frequency_info_id: str | None = None
    frequency_info_ids: list[str] = field(default_factory=list)
    venue: str = ""
    venues: list[str] = field(default_factory=list)
    category: str = ""
    sex: int | None = None
    sport_selection_keys: list[str] = field(default_factory=list)
    sport_item_ids: list[int] = field(default_factory=list)
    team_country: str | None = None
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_video(cls, video: VideoTask) -> "PlatformQueryContext":
        return cls(
            video_id=video.id,
            platform_scope_id=video.platform_scope_id or video.id,
            match_id=video.match_id,
            match_name=video.match_name,
            frequency_info_id=video.frequency_info_id,
            frequency_info_ids=list(video.frequency_info_ids),
            venue=video.venue,
            venues=list(video.venues),
            category=video.category,
            sex=video.sex,
            sport_selection_keys=list(video.sport_selection_keys),
            sport_item_ids=list(video.sport_item_ids),
            team_country=video.team_country,
            created_at=video.created_at,
            updated_at=video.updated_at,
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlatformQueryContext":
        video_id = str(data.get("video_id") or "")
        return cls(
            video_id=video_id,
            platform_scope_id=str(data.get("platform_scope_id") or video_id),
            match_id=_coerce_str(data.get("match_id")),
            match_name=str(data.get("match_name") or ""),
            frequency_info_id=_coerce_str(data.get("frequency_info_id")),
            frequency_info_ids=_as_str_list(data.get("frequency_info_ids")),
            venue=str(data.get("venue") or ""),
            venues=_as_str_list(data.get("venues")),
            category=str(data.get("category") or ""),
            sex=_coerce_int(data.get("sex")),
            sport_selection_keys=_as_str_list(data.get("sport_selection_keys")),
            sport_item_ids=_as_int_list(data.get("sport_item_ids")),
            team_country=str(data.get("team_country") or "").strip() or None,
            created_at=str(data.get("created_at") or utc_now_iso()),
            updated_at=str(data.get("updated_at") or utc_now_iso()),
        )


@dataclass
class PlatformScopeQuery:
    match_id: str | None = None
    match_name: str = ""
    frequency_info_id: str | None = None
    frequency_info_ids: list[str] = field(default_factory=list)
    venue: str = ""
    venues: list[str] = field(default_factory=list)
    category: str = ""
    sex: int | None = None
    sport_selection_keys: list[str] = field(default_factory=list)
    sport_item_ids: list[int] = field(default_factory=list)
    team_country: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_video(cls, video: VideoTask) -> "PlatformScopeQuery":
        return cls(
            match_id=video.match_id,
            match_name=video.match_name,
            frequency_info_id=video.frequency_info_id,
            frequency_info_ids=list(video.frequency_info_ids),
            venue=video.venue,
            venues=list(video.venues),
            category=video.category,
            sex=video.sex,
            sport_selection_keys=list(video.sport_selection_keys),
            sport_item_ids=list(video.sport_item_ids),
            team_country=video.team_country,
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlatformScopeQuery":
        payload = {
            "match_id": _coerce_str(data.get("match_id")),
            "match_name": str(data.get("match_name") or ""),
            "frequency_info_id": _coerce_str(data.get("frequency_info_id")),
            "frequency_info_ids": _as_str_list(data.get("frequency_info_ids")),
            "venue": str(data.get("venue") or ""),
            "venues": _as_str_list(data.get("venues")),
            "category": str(data.get("category") or ""),
            "sex": _coerce_int(data.get("sex")),
            "sport_selection_keys": _as_str_list(data.get("sport_selection_keys")),
            "sport_item_ids": _as_int_list(data.get("sport_item_ids")),
            "team_country": str(data.get("team_country") or "").strip() or None,
        }
        if not payload["frequency_info_ids"] and payload["frequency_info_id"]:
            payload["frequency_info_ids"] = [payload["frequency_info_id"]]
        if not payload["venues"] and payload["venue"]:
            payload["venues"] = [payload["venue"]]
        if payload["frequency_info_id"] is None and payload["frequency_info_ids"]:
            payload["frequency_info_id"] = payload["frequency_info_ids"][0]
        if not payload["venue"] and payload["venues"]:
            payload["venue"] = payload["venues"][0]
        return cls(**payload)


@dataclass
class PlatformScope:
    id: str
    mode: str = "single_video"
    query_groups: list[PlatformScopeQuery] = field(default_factory=list)
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "mode": self.mode,
            "query_groups": [query.to_dict() for query in self.query_groups],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_video(cls, video: VideoTask) -> "PlatformScope":
        return cls(
            id=video.platform_scope_id or video.id,
            mode="single_video",
            query_groups=[PlatformScopeQuery.from_video(video)],
            created_at=video.created_at,
            updated_at=video.updated_at,
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlatformScope":
        return cls(
            id=str(data.get("id") or new_id("scope")),
            mode=str(data.get("mode") or "single_video"),
            query_groups=[
                PlatformScopeQuery.from_dict(item)
                for item in data.get("query_groups", [])
                if isinstance(item, dict)
            ],
            created_at=str(data.get("created_at") or utc_now_iso()),
            updated_at=str(data.get("updated_at") or utc_now_iso()),
        )


@dataclass
class DetectionBlock:
    id: str
    video_id: str
    athlete_name: str
    country: str = ""
    subtitle_start: float = 0.0
    subtitle_end: float = 0.0
    confidence: float = 0.0
    count: int = 1
    timestamp: str = ""
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DetectionBlock":
        payload = dict(data)
        payload.setdefault("id", new_id("det"))
        payload.setdefault("video_id", "")
        payload.setdefault("timestamp", "")
        payload.setdefault("created_at", utc_now_iso())
        payload.setdefault("updated_at", utc_now_iso())
        return cls(**payload)


@dataclass
class CandidateClip:
    id: str
    video_id: str
    detection_block_id: str | None = None
    linked_platform_record_id: str | None = None
    athlete_name: str = ""
    country: str = ""
    subtitle_start: float = 0.0
    subtitle_end: float = 0.0
    candidate_start: float = 0.0
    candidate_end: float = 0.0
    review_start: float = 0.0
    review_end: float = 0.0
    segments: list["ClipSegment"] = field(default_factory=list)
    gap_start: float | None = None
    gap_end: float | None = None
    confidence: float = 0.0
    status: str = "pending"
    notes: str = ""
    exported_path: str | None = None
    export_error_message: str | None = None
    uploaded_object_key: str | None = None
    uploaded_url: str | None = None
    platform_sync_status: str | None = None
    platform_sync_error_message: str | None = None
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["segments"] = [segment.to_dict() for segment in self.segments]
        return payload

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CandidateClip":
        payload = dict(data)
        payload.setdefault("detection_block_id", None)
        payload.setdefault(
            "linked_platform_record_id",
            payload.pop("linked_score_entry_id", None),
        )
        payload.setdefault("export_error_message", None)
        payload.setdefault("uploaded_object_key", None)
        payload.setdefault("uploaded_url", None)
        payload.setdefault("platform_sync_status", None)
        payload.setdefault("platform_sync_error_message", None)
        payload.setdefault("gap_start", None)
        payload.setdefault("gap_end", None)
        payload["segments"] = _load_clip_segments(payload)
        if payload["segments"]:
            payload["review_start"] = payload["segments"][0].start
            payload["review_end"] = payload["segments"][-1].end
        payload["gap_start"] = None
        payload["gap_end"] = None
        payload.setdefault("created_at", utc_now_iso())
        payload.setdefault("updated_at", utc_now_iso())
        return cls(**payload)


@dataclass
class ClipSegment:
    id: str
    start: float
    end: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ClipSegment":
        start = float(data.get("start") or 0.0)
        end = float(data.get("end") or start)
        return cls(
            id=str(data.get("id") or new_id("seg")),
            start=start,
            end=end,
        )


@dataclass
class PlatformRecord:
    id: str
    video_id: str
    platform_scope_id: str = ""
    platform_id: str | None = None
    match_id: str | None = None
    match_name: str = ""
    frequency_info_id: str | None = None
    venue: str = ""
    category: str = ""
    sex: int | None = None
    team_country: str | None = None
    sport_item_id: int | None = None
    sport_item_label: str = ""
    user_name: str = ""
    english_name: str = ""
    country: str = ""
    ranking: str = ""
    difficulty_score: str = ""
    execution_score: str = ""
    bonus_score: str = ""
    penalty_score: str = ""
    total_score: str = ""
    single_score: str = ""
    video_url: str = ""
    vault_attempt: int | None = None
    raw_record: dict[str, Any] = field(default_factory=dict)
    linked_clip_ids: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlatformRecord":
        video_id = str(data.get("video_id") or "")
        return cls(
            id=str(data.get("id") or new_id("platform")),
            video_id=video_id,
            platform_scope_id=str(data.get("platform_scope_id") or video_id),
            platform_id=_coerce_str(data.get("platform_id")),
            match_id=_coerce_str(data.get("match_id")),
            match_name=str(data.get("match_name") or ""),
            frequency_info_id=_coerce_str(data.get("frequency_info_id")),
            venue=str(data.get("venue") or ""),
            category=str(data.get("category") or ""),
            sex=_coerce_int(data.get("sex")),
            team_country=str(data.get("team_country") or "").strip() or None,
            sport_item_id=_coerce_int(data.get("sport_item_id")),
            sport_item_label=str(data.get("sport_item_label") or ""),
            user_name=str(data.get("user_name") or ""),
            english_name=str(data.get("english_name") or ""),
            country=str(data.get("country") or ""),
            ranking=str(data.get("ranking") or ""),
            difficulty_score=str(data.get("difficulty_score") or ""),
            execution_score=str(data.get("execution_score") or ""),
            bonus_score=str(data.get("bonus_score") or ""),
            penalty_score=str(data.get("penalty_score") or ""),
            total_score=str(data.get("total_score") or ""),
            single_score=str(data.get("single_score") or ""),
            video_url=str(data.get("video_url") or ""),
            vault_attempt=_coerce_int(data.get("vault_attempt")),
            raw_record=dict(data.get("raw_record") or {}),
            linked_clip_ids=[str(value) for value in data.get("linked_clip_ids", []) if str(value)],
            created_at=str(data.get("created_at") or utc_now_iso()),
            updated_at=str(data.get("updated_at") or utc_now_iso()),
        )


@dataclass
class ProjectSettings:
    ai_backend: str = "zhipu"
    sampling_interval: float = 2.0
    detection_threads: int = 3
    merge_threshold_seconds: float = 8.0
    min_detection_count: int = 2
    pre_padding_seconds: float = 2.0
    max_parallel_videos: int = 1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProjectSettings":
        return cls(**data)


@dataclass
class ProjectState:
    version: str = "1.3.0"
    name: str = "Untitled Project"
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)
    videos: list[VideoTask] = field(default_factory=list)
    platform_query_contexts: list[PlatformQueryContext] = field(default_factory=list)
    platform_scopes: list[PlatformScope] = field(default_factory=list)
    platform_records: list[PlatformRecord] = field(default_factory=list)
    detection_blocks: list[DetectionBlock] = field(default_factory=list)
    candidate_clips: list[CandidateClip] = field(default_factory=list)
    settings: ProjectSettings = field(default_factory=ProjectSettings)

    def touch(self) -> None:
        self.updated_at = utc_now_iso()

    def get_video(self, video_id: str) -> VideoTask | None:
        for video in self.videos:
            if video.id == video_id:
                return video
        return None

    def get_platform_record(self, record_id: str) -> PlatformRecord | None:
        for record in self.platform_records:
            if record.id == record_id:
                return record
        return None

    def get_platform_scope(self, scope_id: str) -> PlatformScope | None:
        for scope in self.platform_scopes:
            if scope.id == scope_id:
                return scope
        return None

    def get_platform_query_context(self, video_id: str) -> PlatformQueryContext | None:
        for context in self.platform_query_contexts:
            if context.video_id == video_id:
                return context
        return None

    def upsert_platform_scope(self, scope: PlatformScope) -> None:
        existing = self.get_platform_scope(scope.id)
        if existing is None:
            self.platform_scopes.append(scope)
            return
        existing.mode = scope.mode
        existing.query_groups = [PlatformScopeQuery.from_dict(query.to_dict()) for query in scope.query_groups]
        existing.updated_at = utc_now_iso()

    def ensure_video_platform_scope(self, video: VideoTask) -> None:
        if not video.platform_scope_id:
            video.platform_scope_id = video.id
        self.upsert_platform_scope(PlatformScope.from_video(video))

    def upsert_platform_query_context(self, video: VideoTask) -> None:
        context = PlatformQueryContext.from_video(video)
        existing = self.get_platform_query_context(video.id)
        if existing is None:
            self.platform_query_contexts.append(context)
        else:
            existing.match_id = context.match_id
            existing.match_name = context.match_name
            existing.frequency_info_id = context.frequency_info_id
            existing.frequency_info_ids = list(context.frequency_info_ids)
            existing.venue = context.venue
            existing.venues = list(context.venues)
            existing.category = context.category
            existing.sex = context.sex
            existing.sport_selection_keys = list(context.sport_selection_keys)
            existing.sport_item_ids = list(context.sport_item_ids)
            existing.team_country = context.team_country
            existing.updated_at = utc_now_iso()
            existing.platform_scope_id = context.platform_scope_id
        self.ensure_video_platform_scope(video)

    def replace_video_platform_records(self, video_id: str, records: list[PlatformRecord]) -> None:
        video = self.get_video(video_id)
        scope_id = video.platform_scope_id if video is not None else video_id
        self.replace_scope_platform_records(scope_id, records)
        self.touch()

    def replace_scope_platform_records(self, scope_id: str, records: list[PlatformRecord]) -> None:
        self.platform_records = [
            record for record in self.platform_records if record.platform_scope_id != scope_id
        ]
        for record in records:
            record.platform_scope_id = scope_id
        self.platform_records.extend(records)
        self.rebuild_platform_record_links()
        self.touch()

    def remove_unreferenced_platform_scope(self, scope_id: str) -> None:
        if not scope_id:
            return
        if any(video.platform_scope_id == scope_id for video in self.videos):
            return
        self.platform_scopes = [scope for scope in self.platform_scopes if scope.id != scope_id]
        self.platform_records = [
            record for record in self.platform_records if record.platform_scope_id != scope_id
        ]
        self.platform_query_contexts = [
            context for context in self.platform_query_contexts if context.platform_scope_id != scope_id
        ]

    def remove_video_outputs(self, video_id: str, scope_id: str | None = None) -> None:
        self.platform_query_contexts = [
            context for context in self.platform_query_contexts if context.video_id != video_id
        ]
        self.detection_blocks = [
            block for block in self.detection_blocks if block.video_id != video_id
        ]
        self.candidate_clips = [
            clip for clip in self.candidate_clips if clip.video_id != video_id
        ]
        self.remove_unreferenced_platform_scope(scope_id or "")
        self.rebuild_platform_record_links()
        self.touch()

    def remove_video(self, video_id: str) -> bool:
        video = self.get_video(video_id)
        if video is None:
            return False
        scope_id = video.platform_scope_id or video.id
        original_count = len(self.videos)
        self.videos = [video for video in self.videos if video.id != video_id]
        if len(self.videos) == original_count:
            return False
        self.remove_video_outputs(video_id, scope_id)
        self.touch()
        return True

    def get_video_clips(self, video_id: str) -> list[CandidateClip]:
        return [clip for clip in self.candidate_clips if clip.video_id == video_id]

    def rebuild_platform_record_links(self) -> None:
        links_by_record_id = {record.id: [] for record in self.platform_records}
        valid_record_ids = set(links_by_record_id)
        for clip in self.candidate_clips:
            if clip.linked_platform_record_id and clip.linked_platform_record_id not in valid_record_ids:
                clip.linked_platform_record_id = None
                clip.updated_at = utc_now_iso()
            if clip.linked_platform_record_id:
                links_by_record_id[clip.linked_platform_record_id].append(clip.id)

        for record in self.platform_records:
            record.linked_clip_ids = sorted(links_by_record_id.get(record.id, []))
            record.updated_at = utc_now_iso()

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "name": self.name,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "videos": [video.to_dict() for video in self.videos],
            "platform_query_contexts": [
                context.to_dict() for context in self.platform_query_contexts
            ],
            "platform_scopes": [scope.to_dict() for scope in self.platform_scopes],
            "platform_records": [record.to_dict() for record in self.platform_records],
            "detection_blocks": [block.to_dict() for block in self.detection_blocks],
            "candidate_clips": [clip.to_dict() for clip in self.candidate_clips],
            "settings": self.settings.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProjectState":
        state = cls(
            version=data.get("version", "1.3.0"),
            name=data.get("name", "Untitled Project"),
            created_at=data.get("created_at", utc_now_iso()),
            updated_at=data.get("updated_at", utc_now_iso()),
            videos=[VideoTask.from_dict(item) for item in data.get("videos", [])],
            platform_query_contexts=[
                PlatformQueryContext.from_dict(item)
                for item in data.get("platform_query_contexts", [])
            ],
            platform_scopes=[
                PlatformScope.from_dict(item)
                for item in data.get("platform_scopes", [])
            ],
            platform_records=[
                PlatformRecord.from_dict(item)
                for item in data.get("platform_records", [])
            ],
            detection_blocks=[
                DetectionBlock.from_dict(item) for item in data.get("detection_blocks", [])
            ],
            candidate_clips=[
                CandidateClip.from_dict(item) for item in data.get("candidate_clips", [])
            ],
            settings=ProjectSettings.from_dict(data.get("settings", {})),
        )
        video_by_id = {video.id: video for video in state.videos}
        for video in state.videos:
            if not video.platform_scope_id:
                video.platform_scope_id = video.id
        for context in state.platform_query_contexts:
            if not context.platform_scope_id:
                video = video_by_id.get(context.video_id)
                context.platform_scope_id = video.platform_scope_id if video is not None else context.video_id
        for record in state.platform_records:
            if not record.platform_scope_id:
                video = video_by_id.get(record.video_id)
                record.platform_scope_id = video.platform_scope_id if video is not None else record.video_id
        for video in state.videos:
            if state.get_platform_query_context(video.id) is None and (
                video.match_name
                or video.frequency_info_id is not None
                or video.frequency_info_ids
                or video.category
                or video.sex is not None
                or video.sport_selection_keys
                or video.sport_item_ids
                or video.team_country
            ):
                state.platform_query_contexts.append(PlatformQueryContext.from_video(video))
            if state.get_platform_scope(video.platform_scope_id) is None:
                state.ensure_video_platform_scope(video)
        state.rebuild_platform_record_links()
        return state
