"""Schema-migration regression tests for ``models.*.from_dict``.

This is the "code can roll back but data can't" defence line. Old project-state
JSON (written by earlier app versions) must still load: renamed fields migrate,
missing fields get sane defaults, and a from_dict -> to_dict round-trip does not
silently drop data.

Migrations actually present in ``models.py`` (verified against the source):

* ``CandidateClip``: ``linked_score_entry_id`` -> ``linked_platform_record_id``
  (old field name pop'd into the new one).
* ``CandidateClip``: legacy ``gap_start``/``gap_end`` (a single review window with
  a removed middle gap) -> explicit ``segments`` list, via ``_load_clip_segments``.
  After conversion the gap fields are force-nulled.
* ``VideoTask`` / ``PlatformRecord`` / ``PlatformQueryContext``: missing
  ``platform_scope_id`` backfilled from the id / video_id.
* ``VideoTask`` / ``PlatformScopeQuery``: ``frequency_info_id`` <-> ``frequency_info_ids``
  and ``venue`` <-> ``venues`` cross-fill (singular<->plural).
* ``ProjectState.from_dict``: backfills scope ids across videos/contexts/records
  and auto-materializes missing platform scopes / query contexts.

Each test feeds a hand-built *old-version* dict and asserts (1) no exception,
(2) the new field is populated, (3) missing fields default sanely, and where
relevant (4) round-trip stability.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend.models import (
    CandidateClip,
    PlatformQueryContext,
    PlatformRecord,
    PlatformScopeQuery,
    ProjectState,
    VideoTask,
)


# ---------------------------------------------------------------------------
# 1) CandidateClip: linked_score_entry_id -> linked_platform_record_id
# ---------------------------------------------------------------------------


class TestCandidateClipLinkRename:
    def test_legacy_link_field_migrates_to_new_name(self):
        old = {
            "id": "clip_1",
            "video_id": "video_1",
            "linked_score_entry_id": "rec_99",  # legacy field name
            "review_start": 1.0,
            "review_end": 5.0,
        }
        clip = CandidateClip.from_dict(old)
        assert clip.linked_platform_record_id == "rec_99"
        # The legacy attribute must not leak onto the dataclass.
        assert not hasattr(clip, "linked_score_entry_id")

    def test_new_link_field_takes_precedence_when_both_present(self):
        old = {
            "id": "clip_2",
            "video_id": "video_1",
            "linked_platform_record_id": "rec_new",
            "linked_score_entry_id": "rec_legacy",
            "review_start": 0.0,
            "review_end": 2.0,
        }
        clip = CandidateClip.from_dict(old)
        # setdefault keeps the already-present new value, ignoring the legacy one.
        assert clip.linked_platform_record_id == "rec_new"

    def test_no_link_field_defaults_to_none(self):
        clip = CandidateClip.from_dict({"id": "c", "video_id": "v", "review_start": 0, "review_end": 1})
        assert clip.linked_platform_record_id is None


# ---------------------------------------------------------------------------
# 2) CandidateClip: gap_start/gap_end -> segments
# ---------------------------------------------------------------------------


class TestCandidateClipGapToSegments:
    def test_gap_in_middle_splits_into_two_segments(self):
        """A review window 0..10 with a removed gap 4..6 becomes two segments."""
        old = {
            "id": "clip_gap",
            "video_id": "v",
            "review_start": 0.0,
            "review_end": 10.0,
            "gap_start": 4.0,
            "gap_end": 6.0,
        }
        clip = CandidateClip.from_dict(old)
        assert len(clip.segments) == 2
        assert (clip.segments[0].start, clip.segments[0].end) == (0.0, 4.0)
        assert (clip.segments[1].start, clip.segments[1].end) == (6.0, 10.0)
        # review bounds re-derived from first/last segment
        assert clip.review_start == 0.0
        assert clip.review_end == 10.0
        # legacy gap fields are force-nulled after migration
        assert clip.gap_start is None
        assert clip.gap_end is None

    def test_no_gap_yields_single_segment(self):
        old = {
            "id": "clip_nogap",
            "video_id": "v",
            "review_start": 2.0,
            "review_end": 8.0,
        }
        clip = CandidateClip.from_dict(old)
        assert len(clip.segments) == 1
        assert (clip.segments[0].start, clip.segments[0].end) == (2.0, 8.0)

    def test_legacy_candidate_bounds_used_when_review_missing(self):
        """Very old clips only had candidate_start/end; segments fall back to them."""
        old = {
            "id": "clip_cand",
            "video_id": "v",
            "candidate_start": 3.0,
            "candidate_end": 9.0,
        }
        clip = CandidateClip.from_dict(old)
        assert len(clip.segments) == 1
        assert (clip.segments[0].start, clip.segments[0].end) == (3.0, 9.0)

    def test_explicit_segments_take_precedence_over_gap_fields(self):
        old = {
            "id": "clip_seg",
            "video_id": "v",
            "review_start": 0.0,
            "review_end": 10.0,
            "gap_start": 4.0,
            "gap_end": 6.0,
            "segments": [
                {"id": "s1", "start": 1.0, "end": 2.0},
                {"id": "s2", "start": 7.0, "end": 9.0},
            ],
        }
        clip = CandidateClip.from_dict(old)
        assert [(s.start, s.end) for s in clip.segments] == [(1.0, 2.0), (7.0, 9.0)]
        # review bounds follow the explicit segments, not the legacy window
        assert clip.review_start == 1.0
        assert clip.review_end == 9.0

    def test_gap_covering_whole_window_falls_back_to_full_segment(self):
        """Degenerate gap (>= whole window) must not produce zero segments."""
        old = {
            "id": "clip_full_gap",
            "video_id": "v",
            "review_start": 5.0,
            "review_end": 10.0,
            "gap_start": 0.0,   # before start
            "gap_end": 20.0,    # after end
        }
        clip = CandidateClip.from_dict(old)
        assert len(clip.segments) == 1
        assert (clip.segments[0].start, clip.segments[0].end) == (5.0, 10.0)


# ---------------------------------------------------------------------------
# 3) platform_scope_id backfill
# ---------------------------------------------------------------------------


class TestPlatformScopeBackfill:
    def test_video_missing_scope_id_backfills_from_id(self):
        video = VideoTask.from_dict({"id": "video_x", "file_path": "/a.mp4", "file_name": "a.mp4"})
        assert video.platform_scope_id == "video_x"

    def test_platform_record_missing_scope_id_backfills_from_video_id(self):
        record = PlatformRecord.from_dict({"id": "rec_1", "video_id": "video_y"})
        assert record.platform_scope_id == "video_y"

    def test_query_context_missing_scope_id_backfills_from_video_id(self):
        ctx = PlatformQueryContext.from_dict({"video_id": "video_z"})
        assert ctx.platform_scope_id == "video_z"

    def test_project_state_backfills_scope_across_entities(self):
        """Old state with no platform_scope_id anywhere: ProjectState.from_dict
        must derive a consistent scope id for video, context and record."""
        old_state = {
            "videos": [{"id": "video_1", "file_path": "/v.mp4", "file_name": "v.mp4"}],
            "platform_query_contexts": [{"video_id": "video_1"}],
            "platform_records": [{"id": "rec_1", "video_id": "video_1"}],
        }
        state = ProjectState.from_dict(old_state)
        assert state.videos[0].platform_scope_id == "video_1"
        assert state.platform_query_contexts[0].platform_scope_id == "video_1"
        assert state.platform_records[0].platform_scope_id == "video_1"
        # A scope object was materialized for the video.
        assert state.get_platform_scope("video_1") is not None


# ---------------------------------------------------------------------------
# 4) singular <-> plural cross-fill (frequency_info / venue)
# ---------------------------------------------------------------------------


class TestSingularPluralCrossFill:
    def test_singular_frequency_populates_plural(self):
        video = VideoTask.from_dict(
            {
                "id": "v",
                "file_path": "/v.mp4",
                "file_name": "v.mp4",
                "frequency_info_id": "freq_1",
            }
        )
        assert video.frequency_info_ids == ["freq_1"]

    def test_plural_frequency_populates_singular(self):
        video = VideoTask.from_dict(
            {
                "id": "v",
                "file_path": "/v.mp4",
                "file_name": "v.mp4",
                "frequency_info_ids": ["freq_a", "freq_b"],
            }
        )
        assert video.frequency_info_id == "freq_a"

    def test_singular_venue_populates_plural(self):
        video = VideoTask.from_dict(
            {"id": "v", "file_path": "/v.mp4", "file_name": "v.mp4", "venue": "馆A"}
        )
        assert video.venues == ["馆A"]

    def test_plural_venue_populates_singular(self):
        video = VideoTask.from_dict(
            {"id": "v", "file_path": "/v.mp4", "file_name": "v.mp4", "venues": ["馆A", "馆B"]}
        )
        assert video.venue == "馆A"

    def test_scope_query_cross_fill_matches_video(self):
        query = PlatformScopeQuery.from_dict({"frequency_info_id": "f1", "venue": "馆"})
        assert query.frequency_info_ids == ["f1"]
        assert query.venues == ["馆"]


# ---------------------------------------------------------------------------
# 5) missing-field defaults
# ---------------------------------------------------------------------------


class TestMissingFieldDefaults:
    def test_empty_video_dict_gets_defaults_without_crashing(self):
        video = VideoTask.from_dict({})
        assert video.id  # auto-generated
        assert video.source_kind == "full_video"
        assert video.status == "queued"
        assert video.total_candidates == 0
        assert video.detection_stats == {}
        assert video.frequency_info_ids == []

    def test_unknown_source_kind_normalizes_to_full_video(self):
        video = VideoTask.from_dict({"id": "v", "source_kind": "garbage"})
        assert video.source_kind == "full_video"

    def test_blank_strings_coerced_to_none(self):
        record = PlatformRecord.from_dict({"id": "r", "video_id": "v", "match_id": "  "})
        assert record.match_id is None

    def test_optional_int_field_coerces_garbage_to_none(self):
        """``sex`` goes through ``_coerce_int`` -> bad input becomes None, no crash.

        Note (documented, not a bug): ``total_candidates`` uses the stricter
        ``int(... or 0)`` and would raise on a non-numeric string. It is always
        written as an int by ``to_dict``, so real persisted state never carries a
        non-numeric value there; this test pins the *optional* fields that do
        defend against garbage.
        """
        video = VideoTask.from_dict({"id": "v", "sex": "not-a-number"})
        assert video.sex is None
        # Empty / falsy counts still default cleanly.
        assert VideoTask.from_dict({"id": "v"}).total_candidates == 0
        assert VideoTask.from_dict({"id": "v", "total_candidates": None}).total_candidates == 0

    def test_sport_item_ids_drops_unparseable_entries(self):
        video = VideoTask.from_dict({"id": "v", "sport_item_ids": [1, "2", "x", None, 4]})
        assert video.sport_item_ids == [1, 2, 4]

    def test_empty_project_state_defaults(self):
        state = ProjectState.from_dict({})
        assert state.version == "1.3.0"
        assert state.name == "Untitled Project"
        assert state.videos == []
        assert state.settings.max_parallel_videos == 1


# ---------------------------------------------------------------------------
# 6) round-trip stability (from_dict -> to_dict -> from_dict)
# ---------------------------------------------------------------------------


class TestRoundTrip:
    def _full_modern_state(self) -> ProjectState:
        return ProjectState.from_dict(
            {
                "version": "1.3.0",
                "name": "测试项目",
                "videos": [
                    {
                        "id": "video_1",
                        "file_path": "/v.mp4",
                        "file_name": "v.mp4",
                        "platform_scope_id": "scope_1",
                        "match_name": "全锦赛",
                        "frequency_info_ids": ["f1", "f2"],
                        "venues": ["馆A"],
                        "sport_item_ids": [3, 7],
                        "sex": 1,
                    }
                ],
                "platform_scopes": [
                    {"id": "scope_1", "mode": "single_video", "query_groups": []}
                ],
                "platform_records": [
                    {
                        "id": "rec_1",
                        "video_id": "video_1",
                        "platform_scope_id": "scope_1",
                        "difficulty_score": "5.6",
                        "execution_score": "8.100",
                        "total_score": "13.700",
                    }
                ],
                "candidate_clips": [
                    {
                        "id": "clip_1",
                        "video_id": "video_1",
                        "linked_platform_record_id": "rec_1",
                        "review_start": 1.0,
                        "review_end": 9.0,
                        "status": "kept",
                    }
                ],
            }
        )

    @staticmethod
    def _strip_record_updated_at(dump: dict) -> dict:
        """``rebuild_platform_record_links`` bumps record.updated_at on every load,
        so that one timestamp is expected to churn. Strip it to compare *data*."""
        for record in dump.get("platform_records", []):
            record.pop("updated_at", None)
        return dump

    def test_modern_state_round_trips_without_data_loss(self):
        state = self._full_modern_state()
        dumped = state.to_dict()
        reloaded = ProjectState.from_dict(dumped)
        redumped = reloaded.to_dict()

        # Every value survives except the intentionally-churned record timestamp.
        assert self._strip_record_updated_at(redumped) == self._strip_record_updated_at(dumped)

    def test_only_record_updated_at_churns_on_reload(self):
        """Document the *only* non-stable field: record.updated_at. No other
        field may differ across a reload (guards against silent drift)."""
        state = self._full_modern_state()
        dumped = state.to_dict()
        redumped = ProjectState.from_dict(dumped).to_dict()
        differing = {
            key
            for key in dumped
            if key != "platform_records" and dumped[key] != redumped[key]
        }
        assert differing == set()
        rec_before = dumped["platform_records"][0]
        rec_after = redumped["platform_records"][0]
        churned = {k for k in rec_before if rec_before[k] != rec_after.get(k)}
        assert churned <= {"updated_at"}

    def test_legacy_state_round_trip_is_stable_after_first_migration(self):
        """Old state with renamed/legacy fields: the FIRST from_dict migrates;
        the resulting modern dict must then round-trip unchanged (idempotent)."""
        legacy = {
            "videos": [
                {
                    "id": "video_1",
                    "file_path": "/v.mp4",
                    "file_name": "v.mp4",
                    "frequency_info_id": "f1",  # singular only
                    "venue": "馆A",
                }
            ],
            "candidate_clips": [
                {
                    "id": "clip_1",
                    "video_id": "video_1",
                    "linked_score_entry_id": "rec_legacy",  # legacy name
                    "review_start": 0.0,
                    "review_end": 10.0,
                    "gap_start": 4.0,  # legacy gap
                    "gap_end": 6.0,
                }
            ],
            "platform_records": [{"id": "rec_legacy", "video_id": "video_1"}],
        }
        once = ProjectState.from_dict(legacy)
        modern_dump = once.to_dict()

        # Field migrations took effect in the dump.
        clip_dump = modern_dump["candidate_clips"][0]
        assert clip_dump["linked_platform_record_id"] == "rec_legacy"
        assert "linked_score_entry_id" not in clip_dump
        assert len(clip_dump["segments"]) == 2
        assert modern_dump["videos"][0]["frequency_info_ids"] == ["f1"]
        assert modern_dump["videos"][0]["venues"] == ["馆A"]

        # Idempotency: feeding the migrated dump back is a no-op structurally,
        # apart from rebuilt link bookkeeping (which we assert explicitly).
        twice = ProjectState.from_dict(modern_dump)
        second_dump = twice.to_dict()
        assert second_dump["candidate_clips"][0]["segments"] == clip_dump["segments"]
        assert second_dump["videos"] == modern_dump["videos"]
        assert second_dump["platform_records"][0]["id"] == "rec_legacy"

    def test_clip_link_preserved_through_round_trip(self):
        state = self._full_modern_state()
        # The record should know which clip links to it after rebuild.
        record = state.get_platform_record("rec_1")
        assert "clip_1" in record.linked_clip_ids
        reloaded = ProjectState.from_dict(state.to_dict())
        assert "clip_1" in reloaded.get_platform_record("rec_1").linked_clip_ids
