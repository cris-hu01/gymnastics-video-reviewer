from __future__ import annotations

import json
import os
import ssl
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from .models import PlatformRecord, PlatformScopeQuery, VideoTask, utc_now_iso

try:
    import certifi
except ImportError:  # pragma: no cover - optional dependency at runtime
    certifi = None


DEFAULT_PLATFORM_BASE_URL = "https://www.sciensports.com"
DEFAULT_PLATFORM_BASE_PATH = "/api/yd-match"
SCORE_API_PREFIX = "/matchGymnasticsScore"

SPORT_ITEM_LABELS: dict[int, str] = {
    0: "自由体操",
    1: "鞍马",
    2: "吊环",
    3: "跳马",
    4: "双杠",
    5: "单杠",
    6: "高低杠",
    7: "平衡木",
}

SPORT_ITEM_ALIASES: dict[int, tuple[str, ...]] = {
    0: ("自由体操", "自由操"),
    1: ("鞍马",),
    2: ("吊环",),
    3: ("跳马",),
    4: ("双杠",),
    5: ("单杠",),
    6: ("高低杠", "高低双杠"),
    7: ("平衡木",),
}


def normalize_platform_base_url() -> str:
    raw_base_url = (os.environ.get("GYMCLIP_PLATFORM_BASE_URL") or DEFAULT_PLATFORM_BASE_URL).strip()
    raw_base_path = (os.environ.get("GYMCLIP_PLATFORM_BASE_PATH") or DEFAULT_PLATFORM_BASE_PATH).strip() or ""
    base_url = raw_base_url.rstrip("/")
    base_path = raw_base_path if raw_base_path.startswith("/") else f"/{raw_base_path}"
    if base_url.endswith(base_path):
        return base_url
    return f"{base_url}{base_path}"


def _coerce_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _safe_request_data(payload: dict[str, Any] | list[dict[str, Any]] | None) -> bytes | None:
    if payload is None:
        return None
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _normalize_public_video_url(value: Any) -> str:
    text = _stringify(value)
    if not text:
        raise PlatformApiError("平台回写失败: videoUrl 为空")
    parsed = urlparse(text)
    if parsed.scheme != "https" or not parsed.netloc:
        raise PlatformApiError(f"平台回写失败: videoUrl 非法 ({text})")
    if any(char.isspace() for char in text):
        raise PlatformApiError(f"平台回写失败: videoUrl 含空白字符 ({text})")
    return text


def _normalize_original_name(value: Any) -> str:
    text = _stringify(value)
    if not text:
        raise PlatformApiError("平台回写失败: originalName 为空")
    if any(char in text for char in "\r\n\t"):
        raise PlatformApiError("平台回写失败: originalName 含非法控制字符")
    return text


@dataclass
class PlatformQuery:
    match_id: str | None
    match_name: str
    frequency_info_id: str | None
    frequency_info_ids: list[str]
    venue: str
    venues: list[str]
    category: str
    sex: int | None
    sport_selection_keys: list[str]
    sport_item_ids: list[int]
    team_country: str | None = None

    @classmethod
    def from_video(cls, video: VideoTask) -> "PlatformQuery":
        return cls(
            match_id=video.match_id,
            match_name=video.match_name,
            frequency_info_id=video.frequency_info_id,
            frequency_info_ids=list(video.frequency_info_ids),
            venue=video.venue,
            venues=list(video.venues),
            category=video.category,
            sex=video.sex,
            sport_selection_keys=list(video.sport_selection_keys),
            sport_item_ids=list(video.sport_item_ids),
            team_country=video.team_country,
        )

    def frequency_pairs(self) -> list[tuple[str | None, str]]:
        if self.frequency_info_ids and self.venues and len(self.frequency_info_ids) == len(self.venues):
            return list(zip(self.frequency_info_ids, self.venues))
        if self.frequency_info_id or self.venue:
            return [(self.frequency_info_id, self.venue)]
        return []


class PlatformApiError(RuntimeError):
    pass


def _looks_like_html(payload: str) -> bool:
    sample = payload.lstrip().lower()
    return sample.startswith("<!doctype html") or sample.startswith("<html")


def _normalize_text(value: Any) -> str:
    return _stringify(value).lower().replace(" ", "")


def _derive_sex_from_venue(venue: str) -> int | None:
    if "男子" in venue:
        return 1
    if "女子" in venue:
        return 2
    return None


def _sport_selection_key(sex: int | None, sport_item_id: int | None) -> str | None:
    if sex not in {1, 2} or sport_item_id is None:
        return None
    return f"{sex}:{sport_item_id}"


class PlatformClient:
    def __init__(self) -> None:
        self.base_url = normalize_platform_base_url()
        self.timeout_seconds = float(os.environ.get("GYMCLIP_PLATFORM_TIMEOUT_SECONDS", "30"))
        self.auth_mode = (os.environ.get("GYMCLIP_PLATFORM_AUTH_MODE") or "whitelist").strip().lower()
        self.token = (os.environ.get("GYMCLIP_PLATFORM_TOKEN") or "").strip()
        self.token_header = (os.environ.get("GYMCLIP_PLATFORM_TOKEN_HEADER") or "Authorization").strip() or "Authorization"
        self.token_prefix = os.environ.get("GYMCLIP_PLATFORM_TOKEN_PREFIX", "Bearer").strip()
        self.verify_ssl = os.environ.get("GYMCLIP_PLATFORM_VERIFY_SSL", "1").strip() != "0"

    def fetch_matches(self) -> list[dict[str, Any]]:
        data = self._request("GET", "/matchInfo/selectList")
        records = self._extract_records(data)
        return [
            {
                "id": _stringify(item.get("id")),
                "match_name": _stringify(item.get("matchName") or item.get("label") or item.get("name")),
                "year": _stringify(item.get("year")),
                "city": _stringify(item.get("city")),
                "raw": item,
            }
            for item in records
            if _stringify(item.get("matchName") or item.get("label") or item.get("name"))
        ]

    def fetch_frequencies(
        self,
        *,
        match_id: str | None = None,
        match_name: str | None = None,
        category: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "current": 1,
            "size": 200,
        }
        if match_id is not None:
            params["matchId"] = match_id
        if match_name:
            params["matchName"] = match_name
        if category:
            params["category"] = category

        data = self._request("GET", "/matchFrequencyInfo/page", params=params)
        records = self._extract_records(data)
        return [
            {
                "id": _stringify(item.get("id")),
                "match_id": _stringify(item.get("matchId")),
                "venue": _stringify(item.get("venue")),
                "category": _stringify(item.get("category")),
                "raw": item,
            }
            for item in records
            if _stringify(item.get("venue"))
        ]

    def fetch_team_countries(
        self,
        *,
        frequency_info_id: str,
        sex: int,
        match_name: str | None = None,
        venue: str | None = None,
    ) -> list[str]:
        params: dict[str, Any] = {
            "current": 1,
            "size": 500,
            "frequencyInfoId": frequency_info_id,
            "sex": sex,
        }
        if match_name:
            params["matchName"] = match_name
        if venue:
            params["venue"] = venue

        data = self._request("GET", f"{SCORE_API_PREFIX}/teamPage", params={k: v for k, v in params.items() if k != "venue"})
        records = self._extract_records(data)
        countries = sorted(
            {
                _stringify(item.get("country"))
                for item in records
                if _stringify(item.get("country"))
            }
        )
        return countries

    def fetch_platform_records(self, video: VideoTask) -> list[PlatformRecord]:
        query = PlatformQuery.from_video(video)
        category = query.category.upper()
        if category in {"EF", "QF", "AA", "TF"}:
            records = self._fetch_single_item_records(video, query)
        else:
            raise PlatformApiError(f"不支持的比赛类型: {query.category}")

        return self._dedupe_records(records)

    def fetch_scope_records(
        self,
        *,
        scope_id: str,
        scope_queries: list[PlatformScopeQuery],
    ) -> list[PlatformRecord]:
        records: list[PlatformRecord] = []

        def run_query(index: int, query: PlatformScopeQuery) -> list[PlatformRecord]:
            preview_video = VideoTask(
                id=f"scope_preview_{index}",
                file_path="",
                file_name=f"scope_preview_{index}",
                source_kind="direct_clip",
                platform_scope_id=scope_id,
                match_id=query.match_id,
                match_name=query.match_name,
                frequency_info_id=query.frequency_info_id,
                frequency_info_ids=list(query.frequency_info_ids),
                venue=query.venue,
                venues=list(query.venues),
                category=query.category,
                sex=query.sex,
                sport_selection_keys=list(query.sport_selection_keys),
                sport_item_ids=list(query.sport_item_ids),
                team_country=query.team_country,
            )
            return self.fetch_platform_records(preview_video)

        if len(scope_queries) <= 1:
            for index, query in enumerate(scope_queries, start=1):
                records.extend(run_query(index, query))
            return self._dedupe_records(records)

        with ThreadPoolExecutor(max_workers=min(6, len(scope_queries)), thread_name_prefix="gymclip-platform-scope") as executor:
            futures = [
                executor.submit(run_query, index, query)
                for index, query in enumerate(scope_queries, start=1)
            ]
            for future in as_completed(futures):
                records.extend(future.result())
        return self._dedupe_records(records)

    def update_video_urls(
        self,
        records: list[PlatformRecord],
        upload_payload_by_record_id: dict[str, dict[str, str]],
    ) -> dict[str, Any]:
        payload: list[dict[str, Any]] = []
        seen_platform_ids: set[str] = set()
        for record in records:
            upload_payload = upload_payload_by_record_id.get(record.id)
            if not upload_payload:
                continue
            platform_id = _stringify(record.platform_id) or _stringify((record.raw_record or {}).get("id"))
            if not platform_id or platform_id in seen_platform_ids:
                continue
            seen_platform_ids.add(platform_id)
            target_url = _normalize_public_video_url(upload_payload.get("link"))
            original_name = _normalize_original_name(upload_payload.get("originalName"))
            payload.append(
                {
                    "id": platform_id,
                    "videoUrl": json.dumps(
                        [
                            {
                                "link": target_url,
                                "originalName": original_name,
                            }
                        ],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                }
            )
        if not payload:
            return {"updated": 0}
        if len(payload) != 1:
            raise PlatformApiError(f"平台回写失败: 一次只允许提交 1 条记录，当前为 {len(payload)} 条")
        return self._request("POST", f"{SCORE_API_PREFIX}/updateUrl", json_body=payload)

    def _fetch_single_item_records(self, video: VideoTask, query: PlatformQuery) -> list[PlatformRecord]:
        normalized: list[PlatformRecord] = []
        selected_ids = set(query.sport_item_ids)
        selected_keys = set(query.sport_selection_keys)
        tasks = [
            (frequency_info_id, venue, sport_item_id)
            for frequency_info_id, venue in query.frequency_pairs()
            for sport_item_id in query.sport_item_ids
        ]

        def fetch_one(frequency_info_id: str | None, venue: str, sport_item_id: int) -> list[PlatformRecord]:
            data = self._request(
                "GET",
                f"{SCORE_API_PREFIX}/singleItemList",
                params={
                    "matchId": query.match_id,
                    "matchName": query.match_name,
                    "frequencyInfoId": frequency_info_id,
                    "category": query.category,
                    "sportItemId": sport_item_id,
                    "venue": venue,
                },
            )
            items = self._extract_records(data)
            results: list[PlatformRecord] = []
            for item in items:
                current_sport_item_id = _coerce_int(item.get("sportItemId"))
                if current_sport_item_id not in {None, sport_item_id}:
                    continue
                if venue and not self._record_matches_venue(item, venue):
                    continue
                if selected_ids and sport_item_id not in selected_ids:
                    continue

                item_sex = (
                    _coerce_int(item.get("sex"))
                    or query.sex
                    or _derive_sex_from_venue(_stringify(item.get("venue")) or venue)
                )
                selection_key = _sport_selection_key(item_sex, sport_item_id)
                if selected_keys and selection_key not in selected_keys:
                    continue

                item_country = _stringify(item.get("country"))
                if query.category.upper() == "TF" and query.team_country and item_country != query.team_country:
                    continue

                results.append(
                    self._build_platform_record(
                        video=video,
                        raw_record=item,
                        sport_item_id=sport_item_id,
                        category=query.category,
                        team_country=item_country if query.category.upper() == "TF" else None,
                    )
                )
            return results

        if len(tasks) <= 1:
            for frequency_info_id, venue, sport_item_id in tasks:
                normalized.extend(fetch_one(frequency_info_id, venue, sport_item_id))
            return normalized

        with ThreadPoolExecutor(max_workers=min(6, len(tasks)), thread_name_prefix="gymclip-platform-score") as executor:
            futures = [
                executor.submit(fetch_one, frequency_info_id, venue, sport_item_id)
                for frequency_info_id, venue, sport_item_id in tasks
            ]
            for future in as_completed(futures):
                normalized.extend(future.result())
        return normalized

    def clone_records_for_scope(
        self,
        scope_id: str,
        records: list[PlatformRecord],
    ) -> list[PlatformRecord]:
        rebound: list[PlatformRecord] = []
        for record in records:
            rebound.append(
                PlatformRecord.from_dict(
                    {
                        **record.to_dict(),
                        "id": self._build_local_record_id(
                            scope_id,
                            record.platform_id,
                            record.sport_item_id,
                            record.ranking,
                            record.user_name,
                            record.english_name,
                            record.raw_record,
                        ),
                        "video_id": scope_id,
                        "platform_scope_id": scope_id,
                        "linked_clip_ids": [],
                        "created_at": utc_now_iso(),
                        "updated_at": utc_now_iso(),
                    }
                )
            )
        return rebound

    def _dedupe_records(self, records: list[PlatformRecord]) -> list[PlatformRecord]:
        deduped: list[PlatformRecord] = []
        seen_ids: set[str] = set()
        for record in records:
            if record.id in seen_ids:
                continue
            seen_ids.add(record.id)
            deduped.append(record)
        self._assign_vault_attempts(deduped)
        return deduped

    def _fetch_all_around_records(self, video: VideoTask, query: PlatformQuery) -> list[PlatformRecord]:
        normalized: list[PlatformRecord] = []
        selected_ids = set(query.sport_item_ids)
        selected_keys = set(query.sport_selection_keys)
        for frequency_info_id, venue in query.frequency_pairs():
            data = self._request(
                "GET",
                f"{SCORE_API_PREFIX}/AAlist",
                params={
                    "current": 1,
                    "size": 500,
                    "matchId": query.match_id,
                    "matchName": query.match_name,
                    "frequencyInfoId": frequency_info_id,
                    "category": query.category,
                },
            )
            items = self._extract_records(data)
            for parent in items:
                parent_name = _stringify(parent.get("userName"))
                parent_english_name = _stringify(parent.get("englishName"))
                parent_country = _stringify(parent.get("country"))
                for score in parent.get("scores") or []:
                    sport_item_id = _coerce_int(score.get("sportItemId"))
                    if sport_item_id is None or (selected_ids and sport_item_id not in selected_ids):
                        continue
                    score_sex = _coerce_int(score.get("sex")) or _coerce_int(parent.get("sex"))
                    selection_key = _sport_selection_key(score_sex, sport_item_id)
                    if selected_keys and selection_key not in selected_keys:
                        continue
                    merged = dict(score)
                    merged.setdefault("matchId", parent.get("matchId"))
                    merged.setdefault("matchName", parent.get("matchName"))
                    merged.setdefault("frequencyInfoId", parent.get("frequencyInfoId"))
                    merged.setdefault("venue", parent.get("venue"))
                    merged.setdefault("sex", parent.get("sex"))
                    merged.setdefault("userName", parent_name)
                    merged.setdefault("englishName", parent_english_name)
                    merged.setdefault("country", parent_country)
                    if venue and not self._record_matches_venue(merged, venue):
                        continue
                    normalized.append(
                        self._build_platform_record(
                            video=video,
                            raw_record=merged,
                            sport_item_id=sport_item_id,
                            category=query.category,
                            team_country=None,
                        )
                    )
        self._assign_vault_attempts(normalized)
        return normalized

    def _fetch_team_records(self, video: VideoTask, query: PlatformQuery) -> list[PlatformRecord]:
        if not query.frequency_pairs():
            raise PlatformApiError("团体赛缺少场次信息")
        normalized: list[PlatformRecord] = []
        selected_ids = set(query.sport_item_ids)
        selected_keys = set(query.sport_selection_keys)
        for frequency_info_id, venue in query.frequency_pairs():
            if not frequency_info_id:
                continue
            sex = _derive_sex_from_venue(venue)
            if sex is None:
                raise PlatformApiError(f"无法从场次推导团体赛性别: {venue}")
            countries = self.fetch_team_countries(
                frequency_info_id=frequency_info_id,
                sex=sex,
                match_name=query.match_name,
                venue=venue,
            )
            for country in countries:
                data = self._request(
                    "GET",
                    f"{SCORE_API_PREFIX}/teamDetail",
                    params={
                        "frequencyInfoId": frequency_info_id,
                        "sex": sex,
                        "country": country,
                    },
                )
                items = self._extract_records(data)
                athlete_rows = self._flatten_team_athletes(items)
                for athlete in athlete_rows:
                    athlete_name = _stringify(athlete.get("userName"))
                    athlete_english_name = _stringify(athlete.get("englishName"))
                    athlete_country = _stringify(athlete.get("country") or country)
                    scores = athlete.get("scores") or []
                    if scores:
                        for score in scores:
                            sport_item_id = _coerce_int(score.get("sportItemId"))
                            if sport_item_id is None or (selected_ids and sport_item_id not in selected_ids):
                                continue
                            score_sex = _coerce_int(score.get("sex")) or _coerce_int(athlete.get("sex")) or sex
                            selection_key = _sport_selection_key(score_sex, sport_item_id)
                            if selected_keys and selection_key not in selected_keys:
                                continue
                            merged = dict(score)
                            merged.setdefault("matchId", athlete.get("matchId"))
                            merged.setdefault("matchName", athlete.get("matchName"))
                            merged.setdefault("frequencyInfoId", athlete.get("frequencyInfoId"))
                            merged.setdefault("venue", athlete.get("venue") or venue)
                            merged.setdefault("sex", athlete.get("sex") or sex)
                            merged.setdefault("userName", athlete_name)
                            merged.setdefault("englishName", athlete_english_name)
                            merged.setdefault("country", athlete_country)
                            normalized.append(
                                self._build_platform_record(
                                    video=video,
                                    raw_record=merged,
                                    sport_item_id=sport_item_id,
                                    category=query.category,
                                    team_country=athlete_country,
                                )
                            )
                        continue

                    sport_item_id = _coerce_int(athlete.get("sportItemId"))
                    if sport_item_id is None or (selected_ids and sport_item_id not in selected_ids):
                        continue
                    selection_key = _sport_selection_key(_coerce_int(athlete.get("sex")) or sex, sport_item_id)
                    if selected_keys and selection_key not in selected_keys:
                        continue
                    normalized.append(
                        self._build_platform_record(
                            video=video,
                            raw_record=athlete,
                            sport_item_id=sport_item_id,
                            category=query.category,
                            team_country=athlete_country,
                        )
                    )
        return normalized

    def _flatten_team_athletes(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        flattened: list[dict[str, Any]] = []
        for item in items:
            child_scores = item.get("childScores") or []
            if child_scores:
                flattened.extend(self._flatten_team_athletes(child_scores))
                continue
            flattened.append(item)
        return flattened

    def _assign_vault_attempts(self, records: list[PlatformRecord]) -> None:
        groups: dict[tuple[str, str, str, str], list[PlatformRecord]] = {}
        for record in records:
            if record.sport_item_id != 3:
                continue
            key = (
                record.user_name or record.english_name,
                record.country,
                record.category,
                record.venue,
            )
            groups.setdefault(key, []).append(record)
        for group in groups.values():
            if len(group) <= 1:
                continue
            group.sort(key=lambda item: (item.platform_id or "", item.id))
            for index, record in enumerate(group, start=1):
                record.vault_attempt = index

    def _build_platform_record(
        self,
        *,
        video: VideoTask,
        raw_record: dict[str, Any],
        sport_item_id: int | None,
        category: str,
        team_country: str | None,
    ) -> PlatformRecord:
        platform_id = _stringify(raw_record.get("id")) or None
        ranking = _stringify(raw_record.get("ranking"))
        user_name = _stringify(raw_record.get("userName"))
        english_name = _stringify(raw_record.get("englishName"))
        scope_id = video.platform_scope_id or video.id
        record_id = self._build_local_record_id(
            scope_id,
            platform_id,
            sport_item_id,
            ranking,
            user_name,
            english_name,
            raw_record,
        )
        return PlatformRecord(
            id=record_id,
            video_id=video.id,
            platform_scope_id=scope_id,
            platform_id=platform_id,
            match_id=_stringify(raw_record.get("matchId")) or video.match_id,
            match_name=_stringify(raw_record.get("matchName")) or video.match_name,
            frequency_info_id=_stringify(raw_record.get("frequencyInfoId")) or video.frequency_info_id,
            venue=_stringify(raw_record.get("venue")) or video.venue,
            category=category,
            sex=_coerce_int(raw_record.get("sex")) or video.sex,
            team_country=team_country,
            sport_item_id=sport_item_id,
            sport_item_label=SPORT_ITEM_LABELS.get(sport_item_id or -1, _stringify(raw_record.get("sportItem"))),
            user_name=user_name,
            english_name=english_name,
            country=_stringify(raw_record.get("country")),
            ranking=ranking,
            difficulty_score=_stringify(raw_record.get("difficultyScore")),
            execution_score=_stringify(raw_record.get("executionScore")),
            bonus_score=_stringify(raw_record.get("bscore")),
            penalty_score=_stringify(raw_record.get("penaltyScore")),
            total_score=_stringify(raw_record.get("totalScore")),
            single_score=_stringify(raw_record.get("singleScore")),
            video_url=_stringify(raw_record.get("videoUrl")),
            raw_record=raw_record,
            created_at=utc_now_iso(),
            updated_at=utc_now_iso(),
        )

    def _build_local_record_id(
        self,
        scope_id: str,
        platform_id: str | None,
        sport_item_id: int | None,
        ranking: str,
        user_name: str,
        english_name: str,
        raw_record: dict[str, Any],
    ) -> str:
        if platform_id:
            return f"platform_{scope_id}_{platform_id}_{sport_item_id if sport_item_id is not None else 'na'}"
        name_part = (user_name or english_name or "unknown").replace(" ", "_")
        venue_part = _stringify(raw_record.get("venue") or raw_record.get("frequencyInfoId") or raw_record.get("matchId"))
        stable_suffix = re.sub(r"[^\w]+", "_", "_".join(
            part for part in [
                str(sport_item_id if sport_item_id is not None else "na"),
                ranking or name_part,
                venue_part,
            ]
            if part
        )).strip("_") or "record"
        return f"platform_{scope_id}_{stable_suffix}"

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | list[dict[str, Any]] | None = None,
    ) -> Any:
        filtered_params = {
            key: value
            for key, value in (params or {}).items()
            if value not in (None, "", [])
        }
        url = f"{self.base_url}{path}"
        if filtered_params:
            url = f"{url}?{urlencode(filtered_params, doseq=True)}"

        headers = {
            "Accept": "application/json",
        }
        data = None
        if json_body is not None:
            data = _safe_request_data(json_body)
            headers["Content-Type"] = "application/json"

        if self.token:
            if self.token_header.lower() == "authorization" and self.token_prefix:
                headers[self.token_header] = f"{self.token_prefix} {self.token}"
            else:
                headers[self.token_header] = self.token

        request = Request(url, data=data, method=method.upper(), headers=headers)
        try:
            with urlopen(request, timeout=self.timeout_seconds, context=self._build_ssl_context()) as response:
                payload = response.read().decode("utf-8")
        except HTTPError as error:
            try:
                error_payload = error.read().decode("utf-8", "replace")
            except Exception:
                error_payload = ""
            try:
                error_result = json.loads(error_payload) if error_payload else None
            except json.JSONDecodeError:
                error_result = None
            if isinstance(error_result, dict):
                message = _stringify(error_result.get("msg")) or _stringify(error_result.get("message"))
                if message:
                    raise PlatformApiError(f"平台接口请求失败: HTTP {error.code} {error.reason} - {message}") from error
            if _looks_like_html(error_payload):
                raise PlatformApiError(
                    f"平台接口未接通: {url} 返回了 HTML 页面（HTTP {error.code}），请检查 API 路径、白名单或网关代理配置"
                ) from error
            raise PlatformApiError(f"平台接口请求失败: HTTP {error.code} {error.reason}") from error
        except Exception as error:
            raise PlatformApiError(f"平台接口请求失败: {error}") from error

        if _looks_like_html(payload):
            raise PlatformApiError(
                f"平台接口未接通: {url} 返回了 HTML 页面，而不是 JSON。请检查 API 路径、白名单或前端代理是否只在浏览器内生效"
            )

        try:
            result = json.loads(payload)
        except json.JSONDecodeError as error:
            raise PlatformApiError(f"平台接口返回了无效 JSON: {error}") from error

        code = result.get("code")
        if code not in (None, 200):
            raise PlatformApiError(result.get("msg") or f"平台接口返回错误 code={code}")
        return result

    def _extract_records(self, result: Any) -> list[dict[str, Any]]:
        data = result.get("data") if isinstance(result, dict) else result
        if isinstance(data, dict):
            records = data.get("records")
            if isinstance(records, list):
                return [item for item in records if isinstance(item, dict)]
            return []
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        return []

    def _record_matches_venue(self, raw_record: dict[str, Any], expected_venue: str) -> bool:
        actual = _normalize_text(raw_record.get("venue"))
        expected = _normalize_text(expected_venue)
        if not expected:
            return True
        if not actual:
            return False
        return expected in actual or actual in expected

    def _build_ssl_context(self) -> ssl.SSLContext | None:
        if not self.verify_ssl:
            return ssl._create_unverified_context()
        if certifi is not None:
            return ssl.create_default_context(cafile=certifi.where())
        return ssl.create_default_context()
