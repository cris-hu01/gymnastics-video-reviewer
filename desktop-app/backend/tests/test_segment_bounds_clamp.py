from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend.models import (
    CandidateClip,
    ClipSegment,
    ProjectState,
    VideoTask,
)
from video_review_backend.review_service import ReviewService


def _make_video(path: Path, *, duration: float) -> VideoTask:
    return VideoTask(
        id="video_clamp",
        file_path=str(path),
        file_name=path.name,
        source_kind="direct_clip",
        platform_scope_id="scope_clamp",
        match_name="测试比赛",
        frequency_info_ids=[],
        venues=[],
        venue="",
        category="EF",
        sport_selection_keys=["1:0"],
        sport_item_ids=[0],
        duration=duration,
        resolution="1920x1080",
        status="reviewing",
    )


def _make_clip(video_id: str, *, candidate_end: float) -> CandidateClip:
    return CandidateClip(
        id="clip_clamp",
        video_id=video_id,
        candidate_start=0.0,
        candidate_end=candidate_end,
        review_start=0.0,
        review_end=candidate_end,
        subtitle_start=0.0,
        subtitle_end=candidate_end,
        segments=[ClipSegment(id="seg_clamp", start=0.0, end=candidate_end)],
        status="kept",
    )


@pytest.fixture
def seeded_state(tmp_path: Path) -> tuple[ProjectState, VideoTask, CandidateClip]:
    source = tmp_path / "video.mp4"
    source.write_bytes(b"x")
    video = _make_video(source, duration=60.0)
    clip = _make_clip(video.id, candidate_end=50.0)
    state = ProjectState(videos=[video], candidate_clips=[clip])
    return state, video, clip


def test_segment_end_past_duration_is_silently_clamped(seeded_state):
    state, _, clip = seeded_state
    service = ReviewService()

    result = service.update_clip(
        state=state,
        clip_id=clip.id,
        segments=[{"id": "seg_clamp", "start": 10.0, "end": 120.0}],
        segments_provided=True,
    )

    assert len(result.clip.segments) == 1
    assert result.clip.segments[0].end == 60.0
    assert result.clip.segments[0].start == 10.0


def test_segment_start_past_duration_still_rejected(seeded_state):
    state, _, clip = seeded_state
    service = ReviewService()

    with pytest.raises(ValueError, match="选区终点必须大于起点"):
        service.update_clip(
            state=state,
            clip_id=clip.id,
            segments=[{"id": "seg_clamp", "start": 70.0, "end": 120.0}],
            segments_provided=True,
        )


def test_segment_negative_start_is_clamped(seeded_state):
    state, _, clip = seeded_state
    service = ReviewService()

    result = service.update_clip(
        state=state,
        clip_id=clip.id,
        segments=[{"id": "seg_clamp", "start": -5.0, "end": 30.0}],
        segments_provided=True,
    )

    assert result.clip.segments[0].start == 0.0
    assert result.clip.segments[0].end == 30.0


def test_segment_well_within_bounds_unchanged(seeded_state):
    state, _, clip = seeded_state
    service = ReviewService()

    result = service.update_clip(
        state=state,
        clip_id=clip.id,
        segments=[{"id": "seg_clamp", "start": 5.0, "end": 25.0}],
        segments_provided=True,
    )

    assert result.clip.segments[0].start == 5.0
    assert result.clip.segments[0].end == 25.0
