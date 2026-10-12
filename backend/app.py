"""Auto-Migrate API. Run from this folder: python -m uvicorn app:app --port 8000 --reload"""
from __future__ import annotations

import csv
import json
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.concurrency import run_in_threadpool

from jobs import REQUEST_ID, USERS, Job, JobBusy, JobError, JobKind, JobManager
from name_check import users_list
from name_check import workbook as name_check
from name_check.users_list import UsersListError
from name_check.workbook import CheckError

app = FastAPI(title="Auto-Migrate API")
jobs = JobManager()

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _save_collected_users(job: Job) -> None:
    if job.kind.name == USERS.name and (path := job.output_file("users.xlsx")):
        users_list.save(path, source="collected", site=job.site)


jobs.on_success.append(_save_collected_users)


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}


def _options(options: str) -> dict[str, Any]:
    try:
        value = json.loads(options)
    except ValueError:
        raise HTTPException(400, "Options must be JSON.")
    if not isinstance(value, dict):
        raise HTTPException(400, "Options must be a JSON object.")
    return value


def _start(kind: JobKind, settings: dict[str, Any], upload: tuple[str, bytes] | None = None):
    try:
        return jobs.start(kind, settings, upload).view()
    except JobBusy as e:
        raise HTTPException(409, str(e))
    except JobError as e:
        raise HTTPException(400, str(e))


def _job(job_id: str, kind: JobKind) -> Job:
    job = jobs.get(job_id, kind)
    if job is None:
        raise HTTPException(404, "Run not found. The API may have been restarted.")
    return job


# ---------- Populate Request ID ----------


@app.post("/api/request-id/jobs")
async def start_request_id(workbook: UploadFile = File(...), options: str = Form("{}")):
    return _start(REQUEST_ID, _options(options), (workbook.filename or "", await workbook.read()))


@app.get("/api/request-id/jobs/{job_id}")
def get_request_id(job_id: str, since: int = 0):
    return _job(job_id, REQUEST_ID).view(max(0, since))


@app.post("/api/request-id/jobs/{job_id}/cancel")
def cancel_request_id(job_id: str):
    return jobs.cancel(_job(job_id, REQUEST_ID)).view()


@app.get("/api/request-id/jobs/{job_id}/workbook")
def request_id_workbook(job_id: str):
    job = _job(job_id, REQUEST_ID)
    path = job.workbook()
    if path is None:
        raise HTTPException(404, "No updated workbook for this run yet.")
    return FileResponse(path, media_type=XLSX, filename=path.name)


@app.get("/api/request-id/jobs/{job_id}/records")
def request_id_records(job_id: str):
    """Rows of the run's detailed report (one per record written)."""
    path = _job(job_id, REQUEST_ID).report()
    if path is None:
        return []
    with path.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


@app.get("/api/request-id/jobs/{job_id}/report")
def request_id_report(job_id: str):
    job = _job(job_id, REQUEST_ID)
    path = job.report()
    if path is None:
        raise HTTPException(404, "No report for this run yet.")
    return FileResponse(path, media_type="text/csv", filename=f"request-ids_{job.id}.csv")


# ---------- CLM users list ----------


@app.get("/api/users-list")
def get_users_list():
    """The saved users list's summary, or null when there is none."""
    return users_list.meta()


@app.post("/api/users-list")
async def upload_users_list(file: UploadFile = File(...)):
    data = await file.read()
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "users.xlsx"
        path.write_bytes(data)
        try:
            return await run_in_threadpool(users_list.save, path, "uploaded")
        except UsersListError as e:
            raise HTTPException(400, str(e))


@app.get("/api/users-list/file")
def users_list_file():
    if users_list.meta() is None:
        raise HTTPException(404, "There is no users list yet.")
    return FileResponse(users_list.FILE, media_type=XLSX, filename="users.xlsx")


@app.post("/api/users-list/jobs")
def start_users(options: str = Form("{}")):
    return _start(USERS, _options(options))


@app.get("/api/users-list/jobs/{job_id}")
def get_users_job(job_id: str, since: int = 0):
    return _job(job_id, USERS).view(max(0, since))


@app.post("/api/users-list/jobs/{job_id}/cancel")
def cancel_users_job(job_id: str):
    return jobs.cancel(_job(job_id, USERS)).view()


# ---------- Name check ----------


def _check(fn, *args):
    try:
        return fn(*args)
    except (CheckError, UsersListError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/name-check/inspect")
async def name_check_inspect(workbook: UploadFile = File(...)):
    data = await workbook.read()
    return await run_in_threadpool(_check, name_check.inspect, data)


@app.post("/api/name-check/match")
async def name_check_match(workbook: UploadFile = File(...), options: str = Form("{}")):
    o = _options(options)
    data = await workbook.read()

    def run():
        return name_check.match(data, str(o.get("sheet") or ""), list(o.get("columns") or []),
                                users_list.matcher())

    return await run_in_threadpool(_check, run)


@app.post("/api/name-check/apply")
async def name_check_apply(workbook: UploadFile = File(...), options: str = Form("{}")):
    o = _options(options)
    data = await workbook.read()
    out = await run_in_threadpool(
        _check, name_check.apply, data, str(o.get("sheet") or ""),
        list(o.get("columns") or []), list(o.get("decisions") or []),
    )
    name = Path(workbook.filename or "workbook.xlsx").stem
    return Response(
        out,
        media_type=XLSX,
        headers={"Content-Disposition": f'attachment; filename="{name}_names-checked.xlsx"'},
    )
