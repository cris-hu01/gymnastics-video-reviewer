from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


@dataclass
class VideoTask:
    id: str
    file_path: str
    file_name: str
    duration: float | None = None
    resolution: str | None = None
    status: str = "queued"
    total_candidates: int = 0
    reviewed_candidates: int = 0
    error_message: str | None = None
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "VideoTask":
        return cls(**data)


@dataclass
class DetectionBlock:
    athlete_name: str
    country: str = ""
    subtitle_start: float = 0.0
    subtitle_end: float = 0.0
    confidence: float = 0.0
    count: int = 1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DetectionBlock":
        return cls(**data)


@dataclass
class CandidateClip:
    id: str
    video_id: str
    athlete_name: str = ""
    country: str = ""
    subtitle_start: float = 0.0
    subtitle_end: float = 0.0
    candidate_start: float = 0.0
    candidate_end: float = 0.0
    review_start: float = 0.0
    review_end: float = 0.0
    confidence: float = 0.0
    status: str = "pending"
    notes: str = ""
    exported_path: str | None = None
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CandidateClip":
        return cls(**data)


@dataclass
class ProjectSettings:
    ai_backend: str = "zhipu"
    sampling_interval: float = 2.0
    detection_threads: int = 3
    pre_padding_seconds: float = 2.0
    max_parallel_videos: int = 2

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProjectSettings":
        return cls(**data)


@dataclass
class ProjectState:
    version: str = "0.1.0"
    name: str = "Untitled Project"
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)
    videos: list[VideoTask] = field(default_factory=list)
    detection_blocks: list[DetectionBlock] = field(default_factory=list)
    candidate_clips: list[CandidateClip] = field(default_factory=list)
    settings: ProjectSettings = field(default_factory=ProjectSettings)

    def touch(self) -> None:
        self.updated_at = utc_now_iso()

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "name": self.name,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "videos": [video.to_dict() for video in self.videos],
            "detection_blocks": [block.to_dict() for block in self.detection_blocks],
            "candidate_clips": [clip.to_dict() for clip in self.candidate_clips],
            "settings": self.settings.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProjectState":
        return cls(
            version=data.get("version", "0.1.0"),
            name=data.get("name", "Untitled Project"),
            created_at=data.get("created_at", utc_now_iso()),
            updated_at=data.get("updated_at", utc_now_iso()),
            videos=[VideoTask.from_dict(item) for item in data.get("videos", [])],
            detection_blocks=[
                DetectionBlock.from_dict(item) for item in data.get("detection_blocks", [])
            ],
            candidate_clips=[
                CandidateClip.from_dict(item) for item in data.get("candidate_clips", [])
            ],
            settings=ProjectSettings.from_dict(data.get("settings", {})),
        )
