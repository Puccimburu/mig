"""Job runner and API tests. Stand-in orchestrators replace the CLM/browser runs."""
from __future__ import annotations

import dataclasses
import io
import json
import logging
import shutil
import sys
import tempfile
import time
from pathlib import Path

import openpyxl
import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import app as app_module  # noqa: E402
import jobs as jobs_module  # noqa: E402
from jobs import REQUEST_ID, USERS, JobBusy, JobError, JobManager  # noqa: E402
from name_check import users_list  # noqa: E402

PASSWORD = "s3cret-Pa55word!"
SITE = {
    "url": "https://cloud9.example.com/tenant/help.aspx",
    "username": "someone@example.com",
    "password": PASSWORD,
    "headless": True,
}
SETTINGS = {
    **SITE,
    "uploaded_on": "2026-10-05 04:16 PM",
    "total_count": "2",
    "template": "MSA",
    "supporting_docs": False,
}

# Stands in for request_id/orchestrator.py: reports what config it saw (minus the
# password), logs the lines the job manager counts, and writes the real outputs.
FAKE_REQUEST_ORCHESTRATOR = '''
import json, logging, os, shutil, time
import config

logger = logging.getLogger("orchestrator")

def main():
    if config.UPLOADED_ON == "slow":
        time.sleep(60)
    name = os.listdir(config.INPUT_DIR)[0]
    latest = os.path.join(config.OUTPUT_DIR, "latest")
    os.makedirs(latest, exist_ok=True)
    logger.info("matched batch report has 2 record(s)")
    logger.info("row 2: Record Reference Id=1 -> Request ID=100, Record ID=200, File Names='a.pdf', File Path='x/a.pdf'")
    logger.info("row 3: Record Reference Id=2 status='In Progress' -> not ready, skipping")
    shutil.copyfile(os.path.join(config.INPUT_DIR, name), os.path.join(latest, name))
    with open(os.path.join(latest, "detailed_report.csv"), "w", encoding="utf-8") as fh:
        fh.write("record_reference_id,request_id\\n1,100\\n")
    return {
        "success": True, "processed": 1, "skipped_not_ready": 1, "skipped_no_match": 0,
        "fully_completed": False, "errors": [],
        "seen": {
            "url": config.SITE_URL, "base": config.BASE_APP_URL, "user": config.SITE_USERNAME,
            "password_set": config.SITE_PASSWORD == "%s",
            "uploaded_on": config.UPLOADED_ON, "total": config.TOTAL_COUNT,
            "template": config.BULK_IMPORT_TEMPLATE,
            "supporting": config.ENABLE_SUPPORTING_DOCUMENTS, "headless": config.HEADLESS_MODE,
        },
    }
''' % PASSWORD

# Stands in for users_collector/orchestrator.py.
FAKE_USERS_ORCHESTRATOR = '''
import logging, os
import openpyxl
import config

logger = logging.getLogger("orchestrator")

def main():
    latest = os.path.join(config.OUTPUT_DIR, "latest")
    os.makedirs(latest, exist_ok=True)
    logger.info("3 users across 2 page(s) at 2/page")
    logger.info("page 1/2: 2 user(s)  (total so far: 2)")
    logger.info("page 2/2: 1 user(s)  (total so far: 3)")
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Users"
    ws.append(["Name", "User License", "Email", "Department", "Role", "Is Active?"])
    ws.append(["Sudipta Sen", "Full", "s.sen@example.com", "Legal", "User", "Yes"])
    ws.append(["Chandni Gurnani", "Full", "c.g@example.com", "PICG", "User", "Yes"])
    ws.append(["Old Account", "Full", "old@example.com", "IT", "User", "No"])
    wb.save(os.path.join(latest, "users.xlsx"))
    return {"success": True, "users_collected": 3, "pages_processed": 2, "total_users": 3,
            "duplicates_skipped": 0, "errors": [], "password_set": config.SITE_PASSWORD == "%s"}
''' % PASSWORD


def _kind(tmp_path: Path, kind, folder: str, orchestrator: str):
    shutil.copy(BACKEND / "job_runtime.py", tmp_path / "job_runtime.py")
    d = tmp_path / folder
    d.mkdir()
    for name in ("job.py", "config.py"):
        shutil.copy(BACKEND / folder / name, d / name)
    (d / "orchestrator.py").write_text(orchestrator, encoding="utf-8")
    return dataclasses.replace(kind, script_dir=d)


@pytest.fixture
def request_kind(tmp_path: Path):
    return _kind(tmp_path, REQUEST_ID, "request_id", FAKE_REQUEST_ORCHESTRATOR)


@pytest.fixture
def users_kind(tmp_path: Path):
    return _kind(tmp_path, USERS, "users_collector", FAKE_USERS_ORCHESTRATOR)


@pytest.fixture(autouse=True)
def isolate(monkeypatch, tmp_path: Path):
    """Delete every run folder a test creates, and keep the saved users list in tmp."""
    created: list[Path] = []
    real_mkdtemp = tempfile.mkdtemp

    def tracking_mkdtemp(*args, **kwargs):
        path = real_mkdtemp(*args, **kwargs)
        created.append(Path(path))
        return path

    monkeypatch.setattr(jobs_module.tempfile, "mkdtemp", tracking_mkdtemp)
    data = tmp_path / "data"
    monkeypatch.setattr(users_list, "DATA_DIR", data)
    monkeypatch.setattr(users_list, "FILE", data / "users.xlsx")
    monkeypatch.setattr(users_list, "META", data / "meta.json")
    yield
    for path in created:
        shutil.rmtree(path, ignore_errors=True)


def workbook_bytes(sheet: str = "Contract Request", header: str = "Record Reference Id") -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append(["Batch Id", header])
    ws.append([1, "1"])
    ws.append([1, "2"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def wait(job, timeout: float = 60):
    end = time.time() + timeout
    while job.status == "running" and time.time() < end:
        time.sleep(0.1)
    return job


def test_runs_with_ui_settings_and_returns_outputs(request_kind):
    manager = JobManager()
    job = wait(manager.start(request_kind, dict(SETTINGS), ("MSA_2302.xlsx", workbook_bytes())))

    assert job.status == "done", job.result
    assert job.result["seen"] == {
        "url": SETTINGS["url"],
        "base": "https://cloud9.example.com/tenant",
        "user": SETTINGS["username"],
        "password_set": True,
        "uploaded_on": SETTINGS["uploaded_on"],
        "total": "2",
        "template": "MSA",
        "supporting": False,
        "headless": True,
    }
    assert job.counters == {"total": 2, "processed": 1, "notReady": 1, "noMatch": 0, "errors": 0}
    assert job.workbook() is not None and job.workbook().name == "MSA_2302.xlsx"
    assert job.report() is not None
    view = job.view()
    assert view["hasWorkbook"] and view["hasReport"]
    assert view["result"]["fully_completed"] is False
    assert "seen" not in view["result"]

    # The password reaches the run, but never its logs, the job view or any file on disk.
    assert PASSWORD not in str(job.logs)
    assert PASSWORD not in str(view)
    assert PASSWORD not in "\n".join(job.stderr_tail)
    for f in job.dir.rglob("*"):
        if f.is_file():
            assert PASSWORD.encode() not in f.read_bytes(), f


def test_only_one_clm_run_at_a_time_and_cancel(request_kind, users_kind):
    manager = JobManager()
    first = manager.start(request_kind, {**SETTINGS, "uploaded_on": "slow"}, ("a.xlsx", workbook_bytes()))
    with pytest.raises(JobBusy):
        manager.start(request_kind, dict(SETTINGS), ("b.xlsx", workbook_bytes()))
    with pytest.raises(JobBusy, match="Populate Request ID"):
        manager.start(users_kind, dict(SITE))
    manager.cancel(first)
    assert wait(first, 20).status == "cancelled"
    second = wait(manager.start(request_kind, dict(SETTINGS), ("b.xlsx", workbook_bytes())))
    assert second.status == "done"


def test_rejects_unusable_input_before_starting(request_kind):
    manager = JobManager()
    with pytest.raises(JobError, match="Contract Request"):
        manager.start(request_kind, dict(SETTINGS), ("x.xlsx", workbook_bytes(sheet="Sheet1")))
    with pytest.raises(JobError, match="Record Reference Id"):
        manager.start(request_kind, dict(SETTINGS), ("x.xlsx", workbook_bytes(header="Ref")))
    with pytest.raises(JobError, match="password"):
        manager.start(request_kind, {**SETTINGS, "password": ""}, ("x.xlsx", workbook_bytes()))
    with pytest.raises(JobError, match="xlsx"):
        manager.start(request_kind, dict(SETTINGS), ("x.csv", b"a,b"))
    with pytest.raises(JobError, match="Upload"):
        manager.start(request_kind, dict(SETTINGS))
    assert manager.jobs == {}


def test_api_round_trip(request_kind, monkeypatch):
    monkeypatch.setattr(app_module.jobs, "jobs", {})
    monkeypatch.setattr(app_module, "REQUEST_ID", request_kind)
    client = TestClient(app_module.app)
    assert client.get("/api/health").json() == {"ok": True}

    bad = client.post(
        "/api/request-id/jobs",
        files={"workbook": ("x.xlsx", workbook_bytes(), "application/octet-stream")},
        data={"options": "{}"},
    )
    assert bad.status_code == 400 and "Missing" in bad.json()["detail"]

    started = client.post(
        "/api/request-id/jobs",
        files={"workbook": ("MSA.xlsx", workbook_bytes(), "application/octet-stream")},
        data={"options": json.dumps(SETTINGS)},
    ).json()
    wait(app_module.jobs.get(started["id"]))
    view = client.get(f"/api/request-id/jobs/{started['id']}?since=1").json()
    assert view["status"] == "done"
    assert view["logCount"] == len(view["logs"]) + 1
    assert client.get(f"/api/request-id/jobs/{started['id']}/workbook").status_code == 200
    assert client.get(f"/api/request-id/jobs/{started['id']}/report").text.startswith("record_reference_id")
    assert client.get(f"/api/request-id/jobs/{started['id']}/records").json() == [
        {"record_reference_id": "1", "request_id": "100"}
    ]
    assert client.get("/api/request-id/jobs/nope").status_code == 404
    # A request-id run is not reachable through the users-list routes.
    assert client.get(f"/api/users-list/jobs/{started['id']}").status_code == 404


def test_collecting_users_saves_the_list(users_kind, monkeypatch):
    monkeypatch.setattr(app_module.jobs, "jobs", {})
    monkeypatch.setattr(app_module, "USERS", users_kind)
    client = TestClient(app_module.app)
    assert client.get("/api/users-list").json() is None

    started = client.post("/api/users-list/jobs", data={"options": json.dumps(SITE)}).json()
    job = wait(app_module.jobs.get(started["id"]))
    assert job.status == "done", job.result
    assert job.counters == {"total": 3, "collected": 3, "pages": 2, "pagesDone": 2, "errors": 0}
    assert job.result["password_set"] is True
    assert PASSWORD not in str(job.logs) and PASSWORD not in json.dumps(job.view())

    meta = client.get("/api/users-list").json()
    assert meta["source"] == "collected" and meta["site"] == SITE["url"]
    assert (meta["count"], meta["active"]) == (3, 2)
    assert client.get("/api/users-list/file").status_code == 200


def test_uploading_a_users_list(monkeypatch):
    client = TestClient(app_module.app)
    bad = client.post("/api/users-list", files={"file": ("u.xlsx", workbook_bytes(), "application/octet-stream")})
    assert bad.status_code == 400 and "Name" in bad.json()["detail"]

    wb = openpyxl.Workbook()
    wb.active.append(["Name", "Email", "Is Active?"])
    wb.active.append(["Sudipta Sen", "s@example.com", "Yes"])
    buf = io.BytesIO()
    wb.save(buf)
    ok = client.post("/api/users-list", files={"file": ("u.xlsx", buf.getvalue(), "application/octet-stream")})
    assert ok.status_code == 200 and ok.json()["count"] == 1 and ok.json()["source"] == "uploaded"


def test_scraper_never_logs_the_password(caplog, monkeypatch):
    sys.path.insert(0, str(BACKEND / "request_id"))
    import scraper

    monkeypatch.setattr(scraper.time, "sleep", lambda _s: None)

    class Field:
        _parent = type("Driver", (), {"execute_script": lambda *a: None})()

        def click(self):
            pass

        def send_keys(self, *keys):
            pass

        def get_attribute(self, _name):
            return "autofilled"

    with caplog.at_level(logging.WARNING):
        scraper.type_like_human(Field(), PASSWORD, secret=True)
        scraper.type_like_human(Field(), "visible-user")
    assert PASSWORD not in caplog.text
    assert "visible-user" in caplog.text
