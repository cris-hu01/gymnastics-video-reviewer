"""Background job inspection endpoints (list / get)."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from ..deps.services import get_job_by_id
from ..deps.state_helpers import jobs_payload


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("")
def list_jobs():
    return {"jobs": jobs_payload()}


@router.get("/{job_id}")
def get_job(job_id: str):
    job = get_job_by_id(job_id)
    if job is None:
        logger.info("get_job miss job_id=%s", job_id)
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job": job.to_dict()}
