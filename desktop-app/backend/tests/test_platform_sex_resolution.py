from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from video_review_backend.export_service import ExportService
from video_review_backend.models import PlatformRecord, VideoTask
from video_review_backend.platform_client import PlatformClient, PlatformQuery


def make_video() -> VideoTask:
    return VideoTask(
        id="video_1",
        file_path="",
        file_name="mixed_scope.mp4",
        source_kind="direct_clip",
        platform_scope_id="scope_1",
        match_id="match_1",
        match_name="测试比赛",
        frequency_info_id="freq_ring",
        frequency_info_ids=["freq_ring", "freq_ub"],
        venue="男子吊环",
        venues=["男子吊环", "女子高低杠"],
        category="EF",
        sex=None,
        sport_selection_keys=["1:2", "2:6"],
        sport_item_ids=[2, 6],
    )


def test_fetch_single_item_records_infers_record_sex_from_selected_scope(monkeypatch) -> None:
    client = PlatformClient()
    video = make_video()
    query = PlatformQuery.from_video(video)

    def fake_request(_method: str, _path: str, *, params=None, json_body=None):
        assert json_body is None
        return {
            "code": 200,
            "data": {
                "records": [
                    {
                        "id": f"platform_{params['frequencyInfoId']}_{params['sportItemId']}",
                        "matchId": params["matchId"],
                        "matchName": params["matchName"],
                        "frequencyInfoId": params["frequencyInfoId"],
                        "venue": params["venue"],
                        "sportItemId": params["sportItemId"],
                        "userName": "测试运动员",
                        "englishName": "Test Athlete",
                        "country": "CHN",
                        "ranking": "1",
                        "difficultyScore": "5.0",
                        "executionScore": "8.5",
                        "totalScore": "13.5",
                    }
                ]
            },
        }

    monkeypatch.setattr(client, "_request", fake_request)

    records = client._fetch_single_item_records(video, query)

    assert len(records) == 2
    assert {(record.sport_item_id, record.sex) for record in records} == {(2, 1), (6, 2)}


def test_export_service_prefers_selection_keys_over_mixed_venues_for_sex() -> None:
    service = object.__new__(ExportService)
    video = make_video()

    women_record = PlatformRecord(
        id="record_w",
        video_id=video.id,
        platform_scope_id=video.platform_scope_id,
        platform_id="platform_w",
        match_id=video.match_id,
        match_name=video.match_name,
        frequency_info_id="freq_ub",
        venue="女子高低杠",
        category="EF",
        sex=None,
        sport_item_id=6,
        sport_item_label="高低杠",
        user_name="运动员A",
        english_name="Athlete A",
        country="CHN",
        ranking="1",
        difficulty_score="5.0",
        execution_score="8.5",
        total_score="13.5",
        raw_record={},
    )
    men_record = PlatformRecord(
        id="record_m",
        video_id=video.id,
        platform_scope_id=video.platform_scope_id,
        platform_id="platform_m",
        match_id=video.match_id,
        match_name=video.match_name,
        frequency_info_id="freq_ring",
        venue="男子吊环",
        category="EF",
        sex=None,
        sport_item_id=2,
        sport_item_label="吊环",
        user_name="运动员B",
        english_name="Athlete B",
        country="JPN",
        ranking="2",
        difficulty_score="5.2",
        execution_score="8.1",
        total_score="13.3",
        raw_record={},
    )

    assert service._resolve_export_sex(video, women_record) == 2
    assert service._resolve_export_sex(video, men_record) == 1
