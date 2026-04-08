"""Backend foundations for the desktop video review app."""

from .detection_service import DetectionRunResult, DetectionService
from .export_service import ExportRunResult, ExportService, ExportedClipResult
from .models import CandidateClip, DetectionBlock, ProjectSettings, ProjectState, VideoTask
from .review_service import ClipUpdateResult, ReviewService
from .storage import load_project_state, save_project_state
from .video_import import import_videos_into_project

__all__ = [
    "CandidateClip",
    "ClipUpdateResult",
    "DetectionRunResult",
    "DetectionService",
    "DetectionBlock",
    "ExportedClipResult",
    "ExportRunResult",
    "ExportService",
    "ProjectSettings",
    "ProjectState",
    "ReviewService",
    "VideoTask",
    "load_project_state",
    "save_project_state",
    "import_videos_into_project",
]
