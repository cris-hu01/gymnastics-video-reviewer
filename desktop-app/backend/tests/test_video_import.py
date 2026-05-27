"""Unit tests for ``video_import`` + ``video_metadata`` (D-5).

We mock ``subprocess.run`` to fake an ``ffprobe`` JSON response, so the
tests work without an installed ffmpeg binary. Filesystem fixtures use
``tmp_path`` to create dummy ``.mp4`` files; the actual byte contents are
irrelevant — only existence + suffix matter for ``is_supported_video``.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend import video_metadata as video_metadata_module
from video_review_backend.models import ProjectState
from video_review_backend.video_import import (
    build_full_video_clip,
    import_videos_into_project,
    is_supported_video,
    summarize_scope_queries,
)
from video_review_backend.video_metadata import probe_video_metadata


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _ffprobe_json(*, duration: float | None = 12.5, width: int = 1920, height: int = 1080) -> str:
    payload: dict = {
        "format": {"duration": str(duration) if duration is not None else None},
        "streams": [
            {"codec_type": "audio"},
            {"codec_type": "video", "width": width, "height": height},
        ],
    }
    if duration is None:
        payload["format"] = {}
    return json.dumps(payload)


# ---------------------------------------------------------------------------
# is_supported_video
# ---------------------------------------------------------------------------


class TestIsSupportedVideo:
    @pytest.mark.parametrize(
        "name,ok",
        [
            ("clip.mp4", True),
            ("clip.MP4", True),  # case-insensitive suffix
            ("clip.mov", True),
            ("clip.mkv", True),
            ("clip.avi", True),
            ("clip.txt", False),
            ("clip.gif", False),
            ("clip", False),
            (".clip.mp4", False),  # hidden file rejected
        ],
    )
    def test_extensions(self, name: str, ok: bool):
        assert is_supported_video(name) is ok


# ---------------------------------------------------------------------------
# probe_video_metadata — mocked subprocess
# ---------------------------------------------------------------------------


class TestProbeMetadata:
    def test_returns_normalised_payload(self, tmp_path: Path):
        video = tmp_path / "fight.mp4"
        video.write_bytes(b"x")

        completed = subprocess.CompletedProcess(
            args=["ffprobe"],
            returncode=0,
            stdout=_ffprobe_json(duration=42.5, width=1280, height=720),
            stderr="",
        )
        with patch.object(video_metadata_module.subprocess, "run", return_value=completed):
            with patch.object(
                video_metadata_module,
                "resolve_ffprobe_path",
                return_value="/fake/ffprobe",
            ):
                out = probe_video_metadata(str(video))

        assert out["file_name"] == "fight.mp4"
        assert out["file_path"] == str(video.resolve())
        assert out["duration"] == 42.5
        assert out["resolution"] == "1280x720"

    def test_missing_duration_is_none(self, tmp_path: Path):
        video = tmp_path / "x.mp4"
        video.write_bytes(b"x")

        completed = subprocess.CompletedProcess(
            args=["ffprobe"],
            returncode=0,
            stdout=_ffprobe_json(duration=None, width=640, height=360),
            stderr="",
        )
        with patch.object(video_metadata_module.subprocess, "run", return_value=completed):
            with patch.object(
                video_metadata_module,
                "resolve_ffprobe_path",
                return_value="/fake/ffprobe",
            ):
                out = probe_video_metadata(str(video))

        assert out["duration"] is None
        assert out["resolution"] == "640x360"

    def test_no_video_stream_yields_none_resolution(self, tmp_path: Path):
        video = tmp_path / "audio.mp4"
        video.write_bytes(b"x")
        payload = json.dumps(
            {
                "format": {"duration": "10.0"},
                "streams": [{"codec_type": "audio"}],
            }
        )
        completed = subprocess.CompletedProcess(
            args=["ffprobe"], returncode=0, stdout=payload, stderr=""
        )
        with patch.object(video_metadata_module.subprocess, "run", return_value=completed):
            with patch.object(
                video_metadata_module,
                "resolve_ffprobe_path",
                return_value="/fake/ffprobe",
            ):
                out = probe_video_metadata(str(video))
        assert out["duration"] == 10.0
        assert out["resolution"] is None

    def test_invalid_video_propagates_ffprobe_failure(self, tmp_path: Path):
        video = tmp_path / "broken.mp4"
        video.write_bytes(b"\x00")

        def boom(*args, **kwargs):
            raise subprocess.CalledProcessError(returncode=1, cmd=["ffprobe"])

        with patch.object(video_metadata_module.subprocess, "run", side_effect=boom):
            with patch.object(
                video_metadata_module,
                "resolve_ffprobe_path",
                return_value="/fake/ffprobe",
            ):
                with pytest.raises(subprocess.CalledProcessError):
                    probe_video_metadata(str(video))


# ---------------------------------------------------------------------------
# import_videos_into_project — orchestration (mocks probe_video_metadata)
# ---------------------------------------------------------------------------


def _mock_probe(path: str) -> dict[str, object]:
    p = Path(path)
    return {
        "file_name": p.name,
        "file_path": str(p.resolve()),
        "duration": 30.0,
        "resolution": "1920x1080",
    }


class TestImportVideos:
    def test_string_input_imports_supported_files(self, tmp_path: Path):
        v1 = tmp_path / "a.mp4"
        v1.write_bytes(b"x")
        v2 = tmp_path / "b.mov"
        v2.write_bytes(b"x")
        skipped = tmp_path / "c.txt"
        skipped.write_bytes(b"x")

        state = ProjectState()
        with patch(
            "video_review_backend.video_import.probe_video_metadata",
            side_effect=_mock_probe,
        ):
            imported = import_videos_into_project(state, [str(v1), str(v2), str(skipped)])

        assert len(imported) == 2
        assert {v.file_name for v in imported} == {"a.mp4", "b.mov"}
        # platform_scope_id is set to the video id
        assert all(v.platform_scope_id == v.id for v in imported)

    def test_missing_file_is_skipped(self, tmp_path: Path):
        state = ProjectState()
        with patch(
            "video_review_backend.video_import.probe_video_metadata",
            side_effect=_mock_probe,
        ):
            out = import_videos_into_project(state, [str(tmp_path / "nope.mp4")])
        assert out == []

    def test_duplicate_path_skipped(self, tmp_path: Path):
        video = tmp_path / "dup.mp4"
        video.write_bytes(b"x")
        state = ProjectState()
        with patch(
            "video_review_backend.video_import.probe_video_metadata",
            side_effect=_mock_probe,
        ):
            first = import_videos_into_project(state, [str(video)])
            second = import_videos_into_project(state, [str(video)])
        assert len(first) == 1
        assert second == []  # second import is a no-op

    def test_probe_failure_skips_that_file(self, tmp_path: Path):
        v1 = tmp_path / "good.mp4"
        v1.write_bytes(b"x")
        v2 = tmp_path / "bad.mp4"
        v2.write_bytes(b"x")

        def probe(path: str):
            if "bad" in path:
                raise RuntimeError("ffprobe died")
            return _mock_probe(path)

        state = ProjectState()
        with patch(
            "video_review_backend.video_import.probe_video_metadata",
            side_effect=probe,
        ):
            out = import_videos_into_project(state, [str(v1), str(v2)])
        assert len(out) == 1
        assert out[0].file_name == "good.mp4"

    def test_dict_input_with_metadata_fields(self, tmp_path: Path):
        video = tmp_path / "x.mp4"
        video.write_bytes(b"x")
        state = ProjectState()
        with patch(
            "video_review_backend.video_import.probe_video_metadata",
            side_effect=_mock_probe,
        ):
            imported = import_videos_into_project(
                state,
                [
                    {
                        "path": str(video),
                        "match_name": "2024年全锦赛",
                        "venue": "上海",
                        "category": "EF",
                        "sex": 1,
                        "sport_selection_keys": ["1:1", "1:2"],
                        "sport_item_ids": [1, 2],
                    }
                ],
            )
        assert len(imported) == 1
        v = imported[0]
        assert v.match_name == "2024年全锦赛"
        assert v.venue == "上海"
        assert v.venues == ["上海"]  # fallback population
        assert v.sex == 1
        assert v.sport_item_ids == [1, 2]


# ---------------------------------------------------------------------------
# build_full_video_clip — first-frame / duration handling
# ---------------------------------------------------------------------------


class TestBuildFullVideoClip:
    def test_full_duration_clip(self):
        from video_review_backend.models import VideoTask

        video = VideoTask(
            id="v1",
            file_path="/tmp/x.mp4",
            file_name="x.mp4",
            source_kind="direct_clip",
            duration=15.5,
        )
        clip = build_full_video_clip(video, source_label="upload")
        assert clip.video_id == "v1"
        assert clip.candidate_start == 0.0
        assert clip.candidate_end == 15.5
        assert clip.review_end == 15.5
        assert clip.status == "kept"
        assert clip.confidence == 1.0
        assert len(clip.segments) == 1
        assert clip.segments[0].end == 15.5

    def test_zero_duration_yields_zero_span(self):
        from video_review_backend.models import VideoTask

        video = VideoTask(
            id="v0",
            file_path="/tmp/empty.mp4",
            file_name="empty.mp4",
            source_kind="direct_clip",
            duration=None,
        )
        clip = build_full_video_clip(video, source_label="")
        assert clip.candidate_end == 0.0
        assert clip.review_end == 0.0
        assert clip.notes == ""


# ---------------------------------------------------------------------------
# summarize_scope_queries
# ---------------------------------------------------------------------------


class TestSummarizeScopeQueries:
    def test_single_query_passes_through(self):
        out = summarize_scope_queries(
            [
                {
                    "match_id": "m1",
                    "match_name": "锦标赛",
                    "venues": ["北京"],
                    "category": "QF",
                    "sex": 1,
                    "sport_item_ids": [1, 4],
                    "frequency_info_ids": ["f1"],
                    "sport_selection_keys": ["1:1"],
                }
            ]
        )
        assert out["match_id"] == "m1"
        assert out["match_name"] == "锦标赛"
        assert out["venue"] == "北京"
        assert out["category"] == "QF"
        assert out["sex"] == 1
        assert out["sport_item_ids"] == [1, 4]

    def test_multiple_matches_yield_placeholder_name(self):
        out = summarize_scope_queries(
            [
                {"match_id": "m1", "match_name": "赛事 A", "venues": ["A"], "category": "QF", "sex": 1},
                {"match_id": "m2", "match_name": "赛事 B", "venues": ["B"], "category": "EF", "sex": 2},
            ]
        )
        assert out["match_name"] == "多个比赛"
        # mixed categories collapse to empty
        assert out["category"] == ""
        # mixed sex → None
        assert out["sex"] is None
        # venues list keeps both
        assert out["venues"] == ["A", "B"]
