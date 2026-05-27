"""Resource lookup helpers that raise HTTPException on miss."""
from __future__ import annotations

from fastapi import HTTPException

from ..models import CandidateClip, ProjectState, VideoTask


def find_video_or_404(state: ProjectState, video_id: str) -> VideoTask:
    """Return the video matching `video_id` or raise 404."""
    video = state.get_video(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found")
    return video


def find_clip_or_404(state: ProjectState, clip_id: str) -> CandidateClip:
    """Return the candidate clip matching `clip_id` or raise 404."""
    for clip in state.candidate_clips:
        if clip.id == clip_id:
            return clip
    raise HTTPException(status_code=404, detail="Clip not found")
