"""Auto-Migrate API. Run from this folder: python -m uvicorn app:app --port 8000 --reload"""
from __future__ import annotations

import csv
import json

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from jobs import JobBusy, JobError, JobManager

app = FastAPI(title="Auto-Migrate API")
jobs = JobManager()

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}


# ---------- Populate Request ID ----------


@app.post("/api/request-id/jobs")
async def start_job(workbook: UploadFile = File(...), options: str = Form("{}")):
    try:
        settings = json.loads(options)
    except ValueError:
        raise HTTPException(400, "Options must be JSON.")
    if not isinstance(settings, dict):
        raise HTTPException(400, "Options must be a JSON object.")
    try:
        job = jobs.start(workbook.filename or "", await workbook.read(), settings)
    except JobBusy as e:
        raise HTTPException(409, str(e))
    except JobError as e:
        raise HTTPException(400, str(e))
    return job.view()


def _job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Run not found. The API may have been restarted.")
    return job


@app.get("/api/request-id/jobs/{job_id}")
def get_job(job_id: str, since: int = 0):
    return _job(job_id).view(max(0, since))


@app.post("/api/request-id/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    _job(job_id)
    return jobs.cancel(job_id).view()  # type: ignore[union-attr]


@app.get("/api/request-id/jobs/{job_id}/workbook")
def job_workbook(job_id: str):
    job = _job(job_id)
    path = job.workbook()
    if path is None:
        raise HTTPException(404, "No updated workbook for this run yet.")
    return FileResponse(path, media_type=XLSX, filename=path.name)


@app.get("/api/request-id/jobs/{job_id}/records")
def job_records(job_id: str):
    """Rows of the run's detailed report (one per record written)."""
    path = _job(job_id).report()
    if path is None:
        return []
    with path.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


@app.get("/api/request-id/jobs/{job_id}/report")
def job_report(job_id: str):
    job = _job(job_id)
    path = job.report()
    if path is None:
        raise HTTPException(404, "No report for this run yet.")
    return FileResponse(path, media_type="text/csv", filename=f"request-ids_{job.id}.csv")
