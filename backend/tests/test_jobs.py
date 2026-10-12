"""Job runner and API tests. A stand-in orchestrator replaces the CLM/browser run."""
from __future__ import annotations

import io
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
from jobs import JobBusy, JobError, JobManager  # noqa: E402

PASSWORD = "s3cret-Pa55word!"
SETTINGS = {
    "url": "https://cloud9.example.com/tenant/help.aspx",
    "username": "someone@example.com",
    "password": PASSWORD,
    "uploaded_on": "2026-10-05 04:16 PM",
    "total_count": "2",
    "template": "MSA",
    "supporting_docs": False,
    "headless": True,
}

# Stands in for orchestrator.py: reports what config it saw (minus the password),
# logs the lines the job manager counts, and writes the outputs the real one writes.
FAKE_ORCHESTRATOR = '''
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


@pytest.fixture
def script_dir(tmp_path: Path) -> Path:
    d = tmp_path / "request_id"
    d.mkdir()
    for name in ("job.py", "config.py"):
        shutil.copy(BACKEND / "request_id" / name, d / name)
    (d / "orchestrator.py").write_text(FAKE_ORCHESTRATOR, encoding="utf-8")
    return d


@pytest.fixture(autouse=True)
def remove_job_folders(monkeypatch):
    """Delete every run folder the test creates (they live in the system temp dir)."""
    created: list[Path] = []
    real_mkdtemp = tempfile.mkdtemp

    def tracking_mkdtemp(*args, **kwargs):
        path = real_mkdtemp(*args, **kwargs)
        created.append(Path(path))
        return path

    monkeypatch.setattr(jobs_module.tempfile, "mkdtemp", tracking_mkdtemp)
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


def test_runs_with_ui_settings_and_returns_outputs(script_dir: Path):
    manager = JobManager(script_dir=script_dir)
    job = wait(manager.start("MSA_2302.xlsx", workbook_bytes(), dict(SETTINGS)))

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

    # The password reaches the run, but never its logs, the job view or any file on disk.
    assert PASSWORD not in str(job.logs)
    assert PASSWORD not in str(view)
    assert PASSWORD not in "\n".join(job.stderr_tail)
    for f in job.dir.rglob("*"):
        if f.is_file():
            assert PASSWORD.encode() not in f.read_bytes(), f


def test_only_one_run_at_a_time_and_cancel(script_dir: Path):
    manager = JobManager(script_dir=script_dir)
    first = manager.start("a.xlsx", workbook_bytes(), {**SETTINGS, "uploaded_on": "slow"})
    with pytest.raises(JobBusy):
        manager.start("b.xlsx", workbook_bytes(), dict(SETTINGS))
    manager.cancel(first.id)
    assert wait(first, 20).status == "cancelled"
    second = wait(manager.start("b.xlsx", workbook_bytes(), dict(SETTINGS)))
    assert second.status == "done"


def test_rejects_unusable_input_before_starting(script_dir: Path):
    manager = JobManager(script_dir=script_dir)
    with pytest.raises(JobError, match="Contract Request"):
        manager.start("x.xlsx", workbook_bytes(sheet="Sheet1"), dict(SETTINGS))
    with pytest.raises(JobError, match="Record Reference Id"):
        manager.start("x.xlsx", workbook_bytes(header="Ref"), dict(SETTINGS))
    with pytest.raises(JobError, match="password"):
        manager.start("x.xlsx", workbook_bytes(), {**SETTINGS, "password": ""})
    with pytest.raises(JobError, match="xlsx"):
        manager.start("x.csv", b"a,b", dict(SETTINGS))
    assert manager.jobs == {}


def test_api_round_trip(script_dir: Path, monkeypatch):
    monkeypatch.setattr(app_module, "jobs", JobManager(script_dir=script_dir))
    client = TestClient(app_module.app)
    assert client.get("/api/health").json() == {"ok": True}

    bad = client.post(
        "/api/request-id/jobs",
        files={"workbook": ("x.xlsx", workbook_bytes(), "application/octet-stream")},
        data={"options": "{}"},
    )
    assert bad.status_code == 400 and "Missing" in bad.json()["detail"]

    import json

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
