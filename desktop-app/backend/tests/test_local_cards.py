from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend import api
from video_review_backend.export_service import ExportService
from video_review_backend.models import (
    CandidateClip,
    ClipSegment,
    PlatformRecord,
    PlatformScope,
    ProjectState,
    VideoTask,
)
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


def _make_video(path: Path, *, video_id: str, scope_id: str) -> VideoTask:
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
        detection_progress={"stage": "direct_clip_imported", "message": ""},
    )


def _make_clip(video_id: str, clip_id: str) -> CandidateClip:
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


def _make_platform_record(scope_id: str, record_id: str) -> PlatformRecord:
    return PlatformRecord(
        id=record_id,
        video_id=scope_id,
        platform_scope_id=scope_id,
        platform_id=record_id,
        match_name="测试比赛",
        venue="男子自由体操",
        category="EF",
        sex=1,
        sport_item_id=0,
        sport_item_label="自由体操",
        user_name="王五",
        english_name="Wang Wu",
        country="CHN",
        difficulty_score="5.4",
        execution_score="8.5",
        total_score="13.9",
    )


def _seed_state(tmp_path: Path) -> tuple[ProjectState, VideoTask, CandidateClip]:
    scope_id = "scope_local"
    source = tmp_path / "video.mp4"
    source.write_bytes(b"video")
    video = _make_video(source, video_id="video_local", scope_id=scope_id)
    clip = _make_clip(video.id, "clip_local")
    state = ProjectState(
        videos=[video],
        platform_scopes=[PlatformScope(id=scope_id, mode="direct_clip_batch", query_groups=[])],
        candidate_clips=[clip],
    )
    return state, video, clip


def test_create_local_card_returns_is_local(client_env, tmp_path: Path):
    client, project_file, _ = client_env
    state, video, _ = _seed_state(tmp_path)
    save_project_state(project_file, state)

    response = client.post(
        f"/api/videos/{video.id}/local-cards",
        json={
            "user_name": "张三",
            "english_name": "Zhang San",
            "country": "CHN",
            "sport_item_id": 0,
            "difficulty_score": "5.6",
            "execution_score": "8.1",
            "total_score": "13.7",
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    record = payload["record"]
    assert record["is_local"] is True
    assert record["user_name"] == "张三"
    assert record["sport_item_id"] == 0
    assert record["sport_item_label"] == "自由体操"
    assert record["match_name"] == "测试比赛"
    assert record["platform_scope_id"] == video.platform_scope_id
    project = payload["project"]
    assert any(r["id"] == record["id"] for r in project["platform_records"])


def test_patch_non_local_card_is_forbidden(client_env, tmp_path: Path):
    client, project_file, _ = client_env
    state, video, _ = _seed_state(tmp_path)
    state.platform_records.append(_make_platform_record(video.platform_scope_id, "platform_card_1"))
    save_project_state(project_file, state)

    response = client.patch(
        f"/api/videos/{video.id}/local-cards/platform_card_1",
        json={"user_name": "试图改名"},
    )
    assert response.status_code == 403
    assert "本地补录" in response.json()["detail"]


def test_delete_local_card_unbinds_clip(client_env, tmp_path: Path):
    client, project_file, _ = client_env
    state, video, clip = _seed_state(tmp_path)
    save_project_state(project_file, state)

    create_resp = client.post(
        f"/api/videos/{video.id}/local-cards",
        json={
            "user_name": "李四",
            "sport_item_id": 0,
            "difficulty_score": "5.0",
            "execution_score": "8.2",
            "total_score": "13.2",
        },
    )
    record_id = create_resp.json()["record"]["id"]

    bind_resp = client.patch(
        f"/api/clips/{clip.id}/binding",
        json={"platform_record_id": record_id},
    )
    assert bind_resp.status_code == 200, bind_resp.text
    bound_clip = next(c for c in bind_resp.json()["project"]["candidate_clips"] if c["id"] == clip.id)
    assert bound_clip["linked_platform_record_id"] == record_id

    delete_resp = client.delete(f"/api/videos/{video.id}/local-cards/{record_id}")
    assert delete_resp.status_code == 200, delete_resp.text
    project = delete_resp.json()["project"]
    assert all(r["id"] != record_id for r in project["platform_records"])
    unbound_clip = next(c for c in project["candidate_clips"] if c["id"] == clip.id)
    assert unbound_clip["linked_platform_record_id"] is None


def test_build_output_file_redirects_local_to_subfolder(tmp_path: Path):
    state, video, clip = _seed_state(tmp_path)
    local_record = PlatformRecord(
        id="local_record_1",
        video_id=video.id,
        platform_scope_id=video.platform_scope_id,
        platform_id=None,
        match_name="比赛",
        sport_item_id=0,
        sport_item_label="自由体操",
        user_name="张三",
        difficulty_score="5.6",
        execution_score="8.1",
        total_score="13.7",
        is_local=True,
    )
    state.platform_records.append(local_record)
    clip.linked_platform_record_id = local_record.id

    service = ExportService()
    output_dir = tmp_path / "exports"
    output_dir.mkdir()
    out_file = service._build_output_file(
        output_dir=output_dir,
        video=video,
        clip=clip,
        index=1,
        state=state,
    )
    assert out_file.parent == output_dir / "本地补录"
    assert out_file.name.endswith(".mp4")
    assert "张三" in out_file.name
    assert "5.6+8.100=13.700" in out_file.name
    assert out_file.parent.exists()


def test_build_output_file_keeps_platform_card_in_root(tmp_path: Path):
    state, video, clip = _seed_state(tmp_path)
    platform_record = _make_platform_record(video.platform_scope_id, "platform_card_2")
    state.platform_records.append(platform_record)
    clip.linked_platform_record_id = platform_record.id

    service = ExportService()
    output_dir = tmp_path / "exports"
    output_dir.mkdir()
    out_file = service._build_output_file(
        output_dir=output_dir,
        video=video,
        clip=clip,
        index=1,
        state=state,
    )
    assert out_file.parent == output_dir
    assert "王五" in out_file.name
    assert "5.4+8.500=13.900" in out_file.name


def test_retry_oss_stage_rejects_local_card(tmp_path: Path):
    state, video, clip = _seed_state(tmp_path)
    local_record = PlatformRecord(
        id="local_rec_x",
        video_id=video.id,
        platform_scope_id=video.platform_scope_id,
        platform_id=None,
        match_name="比赛",
        sport_item_id=0,
        sport_item_label="自由体操",
        user_name="张三",
        difficulty_score="5.0",
        execution_score="8.0",
        total_score="13.0",
        is_local=True,
    )
    state.platform_records.append(local_record)
    clip.linked_platform_record_id = local_record.id
    clip.exported_path = str(tmp_path / "fake_export.mp4")
    Path(clip.exported_path).write_bytes(b"x")

    service = ExportService()
    with pytest.raises(ValueError, match="本地补录"):
        service.retry_single_clip_stage(
            state=state,
            clip_id=clip.id,
            stage="oss",
            output_dir=str(tmp_path / "exports"),
        )
