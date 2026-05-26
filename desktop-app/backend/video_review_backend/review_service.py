from __future__ import annotations

from dataclasses import dataclass, replace

from .models import CandidateClip, ClipSegment, ProjectState, new_id, utc_now_iso


ALLOWED_CLIP_STATUSES = {"pending", "kept", "deleted", "exported"}
MIN_SEGMENT_DURATION_SECONDS = 0.5


@dataclass
class ClipUpdateResult:
    clip: CandidateClip
    video_status: str


class ReviewService:
    def update_clip(
        self,
        state: ProjectState,
        clip_id: str,
        status: str | None = None,
        review_start: float | None = None,
        review_end: float | None = None,
        segments: list[dict[str, object]] | None = None,
        segments_provided: bool = False,
        notes: str | None = None,
    ) -> ClipUpdateResult:
        clip = self._find_clip(state, clip_id)
        video = state.get_video(clip.video_id)
        if video is None:
            raise ValueError(f"Video not found for clip: {clip.video_id}")

        next_status = status or clip.status
        if next_status not in ALLOWED_CLIP_STATUSES:
            raise ValueError(f"Unsupported clip status: {next_status}")

        next_segments = clip.segments
        if segments_provided:
            next_segments = self._normalize_segments(
                raw_segments=segments or [],
                candidate_start=clip.candidate_start,
                candidate_end=clip.candidate_end,
                duration=video.duration,
            )
        elif review_start is not None or review_end is not None:
            if not clip.segments:
                raise ValueError("当前候选片段没有可编辑选区")
            first_segment = clip.segments[0]
            next_start = first_segment.start if review_start is None else float(review_start)
            next_end = first_segment.end if review_end is None else float(review_end)
            next_segments = self._normalize_segments(
                raw_segments=[
                    {
                        "id": first_segment.id,
                        "start": next_start,
                        "end": next_end,
                    },
                    *[
                        {"id": segment.id, "start": segment.start, "end": segment.end}
                        for segment in clip.segments[1:]
                    ],
                ],
                candidate_start=clip.candidate_start,
                candidate_end=clip.candidate_end,
                duration=video.duration,
            )

        clip.status = next_status
        clip.segments = next_segments
        self._sync_clip_summary(clip)
        clip.gap_start = None
        clip.gap_end = None
        if notes is not None:
            clip.notes = notes
        clip.updated_at = utc_now_iso()

        self._recalculate_video_progress(state, clip.video_id)
        state.touch()
        return ClipUpdateResult(clip=clip, video_status=video.status)

    def split_segment(
        self,
        state: ProjectState,
        clip_id: str,
        segment_id: str,
        split_at: float,
    ) -> CandidateClip:
        clip = self._find_clip(state, clip_id)
        video = state.get_video(clip.video_id)
        if video is None:
            raise ValueError(f"Video not found for clip: {clip.video_id}")

        segment_index, segment = self._find_segment(clip, segment_id)
        split_point = float(split_at)
        if split_point <= segment.start or split_point >= segment.end:
            raise ValueError("拆分点必须位于当前选区范围内")
        if split_point - segment.start < MIN_SEGMENT_DURATION_SECONDS:
            raise ValueError("拆分后前半段至少保留 0.5 秒")
        if segment.end - split_point < MIN_SEGMENT_DURATION_SECONDS:
            raise ValueError("拆分后后半段至少保留 0.5 秒")

        left_segment = ClipSegment(
            id=segment.id,
            start=segment.start,
            end=split_point,
        )
        right_segment = ClipSegment(
            id=new_id("seg"),
            start=split_point,
            end=segment.end,
        )
        clip.segments = [
            *clip.segments[:segment_index],
            left_segment,
            right_segment,
            *clip.segments[segment_index + 1 :],
        ]
        self._reset_clip_after_structure_change(clip)
        self._sync_clip_summary(clip)
        self._recalculate_video_progress(state, clip.video_id)
        state.touch()
        return clip

    def extract_segment(
        self,
        state: ProjectState,
        clip_id: str,
        segment_id: str,
    ) -> tuple[CandidateClip, CandidateClip]:
        clip = self._find_clip(state, clip_id)
        if len(clip.segments) <= 1:
            raise ValueError("当前候选片段只有一个选区，无需独立")

        segment_index, segment = self._find_segment(clip, segment_id)
        now = utc_now_iso()
        new_clip = replace(
            clip,
            id=new_id("clip"),
            linked_platform_record_id=None,
            candidate_start=segment.start,
            candidate_end=segment.end,
            review_start=segment.start,
            review_end=segment.end,
            segments=[
                ClipSegment(
                    id=new_id("seg"),
                    start=segment.start,
                    end=segment.end,
                )
            ],
            status="pending",
            notes="",
            exported_path=None,
            export_error_message=None,
            uploaded_object_key=None,
            uploaded_url=None,
            platform_sync_status=None,
            platform_sync_error_message=None,
            created_at=now,
            updated_at=now,
        )

        clip.segments = [
            *clip.segments[:segment_index],
            *clip.segments[segment_index + 1 :],
        ]
        self._reset_clip_after_structure_change(clip)
        self._sync_clip_summary(clip)

        insert_at = next(
            (index for index, candidate in enumerate(state.candidate_clips) if candidate.id == clip.id),
            len(state.candidate_clips),
        )
        state.candidate_clips.insert(insert_at, new_clip)
        self._recalculate_video_progress(state, clip.video_id)
        state.touch()
        return clip, new_clip

    def delete_segment(
        self,
        state: ProjectState,
        clip_id: str,
        segment_id: str,
    ) -> tuple[bool, str | None]:
        clip = self._find_clip(state, clip_id)
        if len(clip.segments) <= 1:
            raise ValueError("候选片段至少保留一个选区")
        segment_index, _ = self._find_segment(clip, segment_id)
        clip.segments = [
            *clip.segments[:segment_index],
            *clip.segments[segment_index + 1 :],
        ]
        self._reset_clip_after_structure_change(clip)
        self._sync_clip_summary(clip)
        self._recalculate_video_progress(state, clip.video_id)
        state.touch()
        return False, clip.id

    def _find_clip(self, state: ProjectState, clip_id: str) -> CandidateClip:
        for clip in state.candidate_clips:
            if clip.id == clip_id:
                return clip
        raise ValueError(f"Clip not found: {clip_id}")

    def _find_segment(self, clip: CandidateClip, segment_id: str) -> tuple[int, ClipSegment]:
        for index, segment in enumerate(clip.segments):
            if segment.id == segment_id:
                return index, segment
        raise ValueError("当前选区不存在")

    def _normalize_segments(
        self,
        raw_segments: list[dict[str, object]],
        candidate_start: float,
        candidate_end: float,
        duration: float | None,
    ) -> list[ClipSegment]:
        if not raw_segments:
            raise ValueError("候选片段至少保留一个选区")

        normalized: list[ClipSegment] = []
        for item in raw_segments:
            segment_id = str(item.get("id") or new_id("seg"))
            start = float(item.get("start") or 0.0)
            end = float(item.get("end") or start)
            self._validate_segment_bounds(
                start=start,
                end=end,
                candidate_start=candidate_start,
                candidate_end=candidate_end,
                duration=duration,
            )
            normalized.append(
                ClipSegment(
                    id=segment_id,
                    start=round(start, 3),
                    end=round(end, 3),
                )
            )

        normalized.sort(key=lambda segment: (segment.start, segment.end, segment.id))
        previous_end: float | None = None
        for segment in normalized:
            if previous_end is not None and segment.start < previous_end:
                raise ValueError("选区之间不能重叠")
            previous_end = segment.end
        return normalized

    def _validate_segment_bounds(
        self,
        start: float,
        end: float,
        candidate_start: float,
        candidate_end: float,
        duration: float | None,
    ) -> None:
        if start < 0:
            raise ValueError("选区起点必须大于等于 0")
        if end <= start:
            raise ValueError("选区终点必须大于起点")
        if end - start < MIN_SEGMENT_DURATION_SECONDS:
            raise ValueError("每个选区至少保留 0.5 秒")
        if duration is not None and end > duration:
            raise ValueError("选区超过视频总时长")

    def _reset_clip_after_structure_change(self, clip: CandidateClip) -> None:
        clip.linked_platform_record_id = None
        clip.status = "pending"
        clip.notes = ""
        clip.exported_path = None
        clip.export_error_message = None
        clip.uploaded_object_key = None
        clip.uploaded_url = None
        clip.platform_sync_status = None
        clip.platform_sync_error_message = None
        clip.gap_start = None
        clip.gap_end = None
        clip.updated_at = utc_now_iso()

    def _sync_clip_summary(self, clip: CandidateClip) -> None:
        if not clip.segments:
            return
        clip.review_start = clip.segments[0].start
        clip.review_end = clip.segments[-1].end

    def _recalculate_video_progress(self, state: ProjectState, video_id: str) -> None:
        video = state.get_video(video_id)
        if video is None:
            return

        clips = state.get_video_clips(video_id)
        total = len(clips)
        reviewed = sum(1 for clip in clips if clip.status != "pending")
        pending = sum(1 for clip in clips if clip.status == "pending")
        kept = sum(1 for clip in clips if clip.status == "kept")
        exported = sum(1 for clip in clips if clip.status == "exported")

        video.total_candidates = total
        video.reviewed_candidates = reviewed

        if total == 0:
            video.status = "queued"
        elif pending == total:
            video.status = "ready_for_review"
        elif pending > 0:
            video.status = "reviewing"
        elif kept > 0:
            video.status = "reviewing"
        elif exported > 0 and exported == total:
            video.status = "done"
        else:
            video.status = "done"

        video.updated_at = utc_now_iso()
