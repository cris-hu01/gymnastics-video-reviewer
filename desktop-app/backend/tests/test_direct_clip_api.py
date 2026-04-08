from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend import api, video_import
from video_review_backend.models import CandidateClip, ClipSegment, PlatformRecord, PlatformScope, ProjectState, VideoTask
from video_review_backend.storage import save_project_state


@pytest.fixture
def client_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    project_file = tmp_path / "project_state.json"
    monkeypatch.setattr(api, "PROJECT_FILE", project_file)
    monkeypatch.setattr(api, "_platform_client", None)
    monkeypatch.setattr(api, "_thumbnail_service", None)
    monkeypatch.setattr(api, "_export_service", None)
    monkeypatch.setattr(api, "_detection_service", None)
    with TestClient(api.app) as client:
        yield client, project_file, tmp_path


def make_video(path: Path, *, video_id: str, scope_id: str) -> VideoTask:
    return VideoTask(
        id=video_id,
        file_path=str(path),
        file_name=path.name,
        source_kind="direct_clip",
        platform_scope_id=scope_id,
        match_name="测试比赛",
        frequency_info_ids=["freq_1"],
        venues=["男子自由体操"],
        venue="男子自由体操",
        category="EF",
        sport_selection_keys=["1:0"],
        sport_item_ids=[0],
        duration=12.5,
        resolution="1920x1080",
        status="reviewing",
        total_candidates=1,
        reviewed_candidates=1,
        detection_progress={"stage": "direct_clip_imported", "message": "已有片段已导入，无需检测"},
    )


def make_clip(video_id: str, clip_id: str) -> CandidateClip:
    return CandidateClip(
        id=clip_id,
        video_id=video_id,
        candidate_start=0.0,
        candidate_end=12.5,
        review_start=0.0,
        review_end=12.5,
        subtitle_start=0.0,
        subtitle_end=12.5,
        segments=[ClipSegment(id=f"seg_{clip_id}", start=0.0, end=12.5)],
        status="kept",
        confidence=1.0,
    )


def make_record(scope_id: str, record_id: str) -> PlatformRecord:
    return PlatformRecord(
        id=record_id,
        video_id=scope_id,
        platform_scope_id=scope_id,
        platform_id=record_id,
        match_name="测试比赛",
        frequency_info_id="freq_1",
        venue="男子自由体操",
        category="EF",
        sex=1,
        sport_item_id=0,
        sport_item_label="自由体操",
        user_name="张三",
        english_name=f"Athlete {record_id}",
        country="CHN",
        ranking="1",
        difficulty_score="5.2",
        execution_score="8.6",
        total_score="13.8",
    )


def stub_active_export_job(
    monkeypatch: pytest.MonkeyPatch,
    *,
    status: str = "running",
    target_clip_ids: list[str] | None = None,
) -> api.AppJob:
    job = api.AppJob(
        id="job_export",
        kind="export",
        title="导出任务",
        status=status,
        progress={"target_clip_ids": list(target_clip_ids or [])},
    )
    monkeypatch.setattr(api.export_job_manager, "list_jobs", lambda: [job])
    return job


def make_export_lock_state(tmp_path: Path) -> ProjectState:
    scope_id = "scope_shared"
    source_a = tmp_path / "clip_a.mp4"
    source_b = tmp_path / "clip_b.mp4"
    for path in (source_a, source_b):
        path.write_bytes(b"clip")

    return ProjectState(
        videos=[
            make_video(source_a, video_id="video_a", scope_id=scope_id),
            make_video(source_b, video_id="video_b", scope_id=scope_id),
        ],
        platform_scopes=[PlatformScope(id=scope_id, mode="direct_clip_batch", query_groups=[])],
        platform_records=[
            make_record(scope_id, "record_a"),
            make_record(scope_id, "record_b"),
        ],
        candidate_clips=[
            make_clip("video_a", "clip_a"),
            make_clip("video_b", "clip_b"),
        ],
    )


def test_import_direct_clips_creates_shared_scope(
    client_env,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _project_file, tmp_path = client_env
    clip_paths = []
    for index in range(3):
        path = tmp_path / f"clip_{index + 1}.mp4"
        path.write_bytes(b"fake-video")
        clip_paths.append(path)

    monkeypatch.setattr(
        api,
        "build_direct_clip_inputs",
        lambda _files: [{"path": str(path)} for path in clip_paths],
    )
    monkeypatch.setattr(
        video_import,
        "probe_video_metadata",
        lambda path: {
            "file_path": str(path),
            "file_name": Path(path).name,
            "duration": 12.5,
            "resolution": "1920x1080",
        },
    )

    class FakePlatformClient:
        def fetch_scope_records(self, *, scope_id: str, scope_queries):
            return [
                PlatformRecord(
                    id=f"record_{index}",
                    video_id=scope_id,
                    platform_scope_id=scope_id,
                    platform_id=f"platform_{index}",
                    match_id=query.match_id,
                    match_name=query.match_name,
                    frequency_info_id=query.frequency_info_ids[0],
                    venue=query.venues[0],
                    category=query.category,
                    sex=query.sex,
                    sport_item_id=query.sport_item_ids[0],
                    sport_item_label="测试项目",
                    user_name=f"运动员{index}",
                    english_name=f"Athlete {index}",
                    country="CHN",
                    ranking=str(index + 1),
                    difficulty_score="5.0",
                    execution_score="8.0",
                    total_score="13.0",
                )
                for index, query in enumerate(scope_queries)
            ]

    monkeypatch.setattr(api, "get_platform_client", lambda: FakePlatformClient())

    response = client.post(
        "/api/project/import-direct-clips",
        data={
            "scope_queries_json": json.dumps(
                [
                    {
                        "match_id": "match_1",
                        "match_name": "比赛一",
                        "frequency_info_ids": ["freq_1"],
                        "venues": ["男子自由体操"],
                        "category": "EF",
                        "sport_selection_keys": ["1:0"],
                        "sport_item_ids": [0],
                    },
                    {
                        "match_id": "match_2",
                        "match_name": "比赛二",
                        "frequency_info_ids": ["freq_2"],
                        "venues": ["女子跳马"],
                        "category": "EF",
                        "sport_selection_keys": ["2:3"],
                        "sport_item_ids": [3],
                    },
                ]
            )
        },
        files=[
            ("files", ("clip_1.mp4", b"clip-1", "video/mp4")),
            ("files", ("clip_2.mp4", b"clip-2", "video/mp4")),
            ("files", ("clip_3.mp4", b"clip-3", "video/mp4")),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["imported_count"] == 3
    assert len(payload["project"]["videos"]) == 3
    assert len(payload["project"]["candidate_clips"]) == 3
    assert len(payload["project"]["platform_scopes"]) == 1
    scope_id = payload["project"]["platform_scopes"][0]["id"]
    assert payload["project"]["platform_scopes"][0]["mode"] == "direct_clip_batch"
    assert all(video["source_kind"] == "direct_clip" for video in payload["project"]["videos"])
    assert all(video["platform_scope_id"] == scope_id for video in payload["project"]["videos"])
    assert all(clip["status"] == "kept" for clip in payload["project"]["candidate_clips"])
    assert all(record["platform_scope_id"] == scope_id for record in payload["project"]["platform_records"])


def test_clip_binding_respects_shared_scope_and_single_binding(client_env) -> None:
    client, project_file, tmp_path = client_env
    source_a = tmp_path / "clip_a.mp4"
    source_b = tmp_path / "clip_b.mp4"
    source_c = tmp_path / "clip_c.mp4"
    for path in (source_a, source_b, source_c):
        path.write_bytes(b"clip")

    scope_id = "scope_shared"
    other_scope_id = "scope_other"
    state = ProjectState(
        videos=[
            make_video(source_a, video_id="video_a", scope_id=scope_id),
            make_video(source_b, video_id="video_b", scope_id=scope_id),
            make_video(source_c, video_id="video_c", scope_id=other_scope_id),
        ],
        platform_scopes=[
            PlatformScope(id=scope_id, mode="direct_clip_batch", query_groups=[]),
            PlatformScope(id=other_scope_id, mode="direct_clip_batch", query_groups=[]),
        ],
        platform_records=[
            make_record(scope_id, "record_shared"),
            make_record(other_scope_id, "record_other"),
        ],
        candidate_clips=[
            make_clip("video_a", "clip_a"),
            make_clip("video_b", "clip_b"),
            make_clip("video_c", "clip_c"),
        ],
    )
    save_project_state(project_file, state)

    bind_ok = client.patch("/api/clips/clip_a/binding", json={"platform_record_id": "record_shared"})
    assert bind_ok.status_code == 200
    assert bind_ok.json()["project"]["candidate_clips"][0]["linked_platform_record_id"] == "record_shared"

    bind_duplicate = client.patch("/api/clips/clip_b/binding", json={"platform_record_id": "record_shared"})
    assert bind_duplicate.status_code == 400
    assert "已绑定其他片段" in bind_duplicate.json()["detail"]

    bind_wrong_scope = client.patch("/api/clips/clip_a/binding", json={"platform_record_id": "record_other"})
    assert bind_wrong_scope.status_code == 400
    assert "同一导入批次" in bind_wrong_scope.json()["detail"]


def test_delete_video_keeps_scope_until_last_clip_removed(client_env) -> None:
    client, project_file, tmp_path = client_env
    source_a = tmp_path / "clip_scope_a.mp4"
    source_b = tmp_path / "clip_scope_b.mp4"
    for path in (source_a, source_b):
        path.write_bytes(b"clip")

    scope_id = "scope_batch"
    state = ProjectState(
        videos=[
            make_video(source_a, video_id="video_a", scope_id=scope_id),
            make_video(source_b, video_id="video_b", scope_id=scope_id),
        ],
        platform_scopes=[
            PlatformScope(id=scope_id, mode="direct_clip_batch", query_groups=[]),
        ],
        platform_records=[
            make_record(scope_id, "record_a"),
        ],
        candidate_clips=[
            make_clip("video_a", "clip_a"),
            make_clip("video_b", "clip_b"),
        ],
    )
    save_project_state(project_file, state)

    delete_first = client.delete("/api/videos/video_a")
    assert delete_first.status_code == 200
    assert len(delete_first.json()["platform_scopes"]) == 1
    assert len(delete_first.json()["platform_records"]) == 1

    delete_second = client.delete("/api/videos/video_b")
    assert delete_second.status_code == 200
    assert delete_second.json()["platform_scopes"] == []
    assert delete_second.json()["platform_records"] == []


def test_export_job_progress_contains_target_clip_ids(client_env, monkeypatch: pytest.MonkeyPatch) -> None:
    client, project_file, tmp_path = client_env
    state = make_export_lock_state(tmp_path)
    save_project_state(project_file, state)

    captured_progress: dict[str, object] = {}

    def fake_start_job(*, kind, title, runner, video_id=None, initial_progress=None):
        assert kind == "export"
        captured_progress.update(initial_progress or {})
        return api.AppJob(
            id="job_export",
            kind=kind,
            title=title,
            status="queued",
            video_id=video_id,
            progress=initial_progress or {},
        )

    monkeypatch.setattr(api.export_job_manager, "start_job", fake_start_job)

    response = client.post(
        "/api/project/export",
        json={
            "output_dir": str(tmp_path / "exports"),
            "clip_ids": ["clip_a", "clip_b"],
            "operation": "export_only",
        },
    )

    assert response.status_code == 200
    assert captured_progress["target_clip_ids"] == ["clip_a", "clip_b"]
    assert response.json()["job"]["progress"]["target_clip_ids"] == ["clip_a", "clip_b"]


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("patch", "/api/clips/clip_a", {"status": "deleted"}),
        ("post", "/api/clips/clip_a/split", {"split_at": 6.0}),
        ("post", "/api/clips/clip_a/split-segment", {"segment_id": "seg_clip_a", "split_at": 6.0}),
        ("post", "/api/clips/clip_a/extract-segment", {"segment_id": "seg_clip_a"}),
        ("post", "/api/clips/clip_a/delete-segment", {"segment_id": "seg_clip_a"}),
        ("patch", "/api/clips/clip_a/binding", {"platform_record_id": "record_a"}),
    ],
)
def test_locked_export_clip_mutations_return_409(
    client_env,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    payload: dict[str, object],
) -> None:
    client, project_file, tmp_path = client_env
    state = make_export_lock_state(tmp_path)
    save_project_state(project_file, state)
    stub_active_export_job(monkeypatch, target_clip_ids=["clip_a"])

    response = getattr(client, method)(path, json=payload)

    assert response.status_code == 409
    assert response.json()["detail"] == api.EXPORT_LOCKED_CLIP_DETAIL


def test_restore_candidate_clips_is_blocked_during_active_export(
    client_env,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, project_file, tmp_path = client_env
    state = make_export_lock_state(tmp_path)
    save_project_state(project_file, state)
    stub_active_export_job(monkeypatch, target_clip_ids=["clip_a"])

    response = client.post(
        "/api/project/candidate-clips/restore",
        json={"candidate_clips": [clip.to_dict() for clip in state.candidate_clips]},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == api.EXPORT_LOCKED_RESTORE_DETAIL


def test_non_target_clips_remain_editable_and_locked_clips_unlock_after_export(
    client_env,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, project_file, tmp_path = client_env
    state = make_export_lock_state(tmp_path)
    save_project_state(project_file, state)
    stub_active_export_job(monkeypatch, target_clip_ids=["clip_a"])

    update_other = client.patch("/api/clips/clip_b", json={"status": "deleted"})
    assert update_other.status_code == 200
    updated_clip_b = next(
        clip for clip in update_other.json()["project"]["candidate_clips"] if clip["id"] == "clip_b"
    )
    assert updated_clip_b["status"] == "deleted"

    bind_other = client.patch("/api/clips/clip_b/binding", json={"platform_record_id": "record_b"})
    assert bind_other.status_code == 200
    rebound_clip_b = next(
        clip for clip in bind_other.json()["project"]["candidate_clips"] if clip["id"] == "clip_b"
    )
    assert rebound_clip_b["linked_platform_record_id"] == "record_b"

    stub_active_export_job(monkeypatch, status="completed", target_clip_ids=["clip_a"])
    update_locked_after_completion = client.patch("/api/clips/clip_a", json={"status": "deleted"})
    assert update_locked_after_completion.status_code == 200
    updated_clip_a = next(
        clip for clip in update_locked_after_completion.json()["project"]["candidate_clips"] if clip["id"] == "clip_a"
    )
    assert updated_clip_a["status"] == "deleted"
