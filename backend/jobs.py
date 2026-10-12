"""Runs CLM jobs (Selenium scrapers) as child processes and tracks their progress."""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import openpyxl

BACKEND_DIR = Path(__file__).resolve().parent
SITE_SETTINGS = ("url", "username", "password")
MAX_FINISHED_JOBS = 5


class JobError(Exception):
    """A request the user can fix (bad input); shown as-is in the UI."""


class JobBusy(JobError):
    pass


@dataclass(frozen=True)
class JobKind:
    """One kind of CLM job: which job.py runs it and how its progress is read."""

    name: str
    script_dir: Path
    required: tuple[str, ...]
    counters: tuple[str, ...]
    #: Updates the live counters from one log line.
    count: Callable[[dict[str, int], str], None]
    #: Updates the counters from the final result.
    finish: Callable[[dict[str, int], dict[str, Any]], None]
    #: Result keys shown to the UI (never anything from the settings).
    result_keys: tuple[str, ...]
    #: Validates the uploaded input file; None when the job takes no file.
    check_input: Callable[[Path], None] | None = None


# ---------- Populate Request ID ----------

CONTRACT_REQUEST = "Contract Request"
RECORD_REFERENCE_ID = "Record Reference Id"
_BATCH_TOTAL_RE = re.compile(r"matched batch report has (\d+) record")


def check_request_workbook(path: Path) -> None:
    """Fail fast on a file the populator can't use, before any browser starts."""
    try:
        wb = openpyxl.load_workbook(path, read_only=True)
    except Exception as e:
        raise JobError(f"Not a readable Excel file ({e}).") from e
    try:
        if CONTRACT_REQUEST not in wb.sheetnames:
            raise JobError(f'The workbook has no "{CONTRACT_REQUEST}" sheet. Upload the filled template.')
        header = next(wb[CONTRACT_REQUEST].iter_rows(min_row=1, max_row=1, values_only=True), ())
        if RECORD_REFERENCE_ID not in {str(h).strip() for h in header if h is not None}:
            raise JobError(f'The "{CONTRACT_REQUEST}" sheet has no "{RECORD_REFERENCE_ID}" column.')
    finally:
        wb.close()


def _count_request_id(c: dict[str, int], text: str) -> None:
    if m := _BATCH_TOTAL_RE.search(text):
        c["total"] = int(m.group(1))
    elif text.startswith("row ") and "-> Request ID=" in text:
        c["processed"] += 1
    elif "not ready, skipping" in text:
        c["notReady"] += 1
    elif "no report record for" in text or "unrecognized status" in text:
        c["noMatch"] += 1


def _finish_request_id(c: dict[str, int], r: dict[str, Any]) -> None:
    c["processed"] = int(r.get("processed") or c["processed"])
    c["notReady"] = int(r.get("skipped_not_ready") or c["notReady"])
    c["noMatch"] = int(r.get("skipped_no_match") or c["noMatch"])


REQUEST_ID = JobKind(
    name="request-id",
    script_dir=BACKEND_DIR / "request_id",
    required=(*SITE_SETTINGS, "uploaded_on", "total_count"),
    counters=("total", "processed", "notReady", "noMatch", "errors"),
    count=_count_request_id,
    finish=_finish_request_id,
    result_keys=("success", "processed", "skipped_not_ready", "skipped_no_match",
                 "fully_completed", "errors", "skipped"),
    check_input=check_request_workbook,
)


# ---------- Collect CLM users ----------

_USERS_TOTAL_RE = re.compile(r"^(\d+) users across (\d+) page")
_USERS_PAGE_RE = re.compile(r"^page (\d+)/\d+: \d+ user\(s\)\s+\(total so far: (\d+)\)")


def _count_users(c: dict[str, int], text: str) -> None:
    if m := _USERS_TOTAL_RE.search(text):
        c["total"], c["pages"] = int(m.group(1)), int(m.group(2))
    elif m := _USERS_PAGE_RE.search(text):
        c["pagesDone"], c["collected"] = int(m.group(1)), int(m.group(2))


def _finish_users(c: dict[str, int], r: dict[str, Any]) -> None:
    c["collected"] = int(r.get("users_collected") or c["collected"])
    c["pagesDone"] = int(r.get("pages_processed") or c["pagesDone"])
    if r.get("total_users"):
        c["total"] = int(r["total_users"])


USERS = JobKind(
    name="users",
    script_dir=BACKEND_DIR / "users_collector",
    required=SITE_SETTINGS,
    counters=("total", "collected", "pages", "pagesDone", "errors"),
    count=_count_users,
    finish=_finish_users,
    result_keys=("success", "users_collected", "pages_processed", "total_users",
                 "duplicates_skipped", "errors"),
)


# ---------- jobs ----------


@dataclass
class Job:
    id: str
    kind: JobKind
    dir: Path
    input_name: str | None
    counters: dict[str, int]
    #: CLM site URL the job ran against (not secret; shown with the users list).
    site: str | None = None
    status: str = "running"  # running | done | failed | cancelled
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    logs: list[dict[str, Any]] = field(default_factory=list)
    result: dict[str, Any] | None = None
    stderr_tail: deque = field(default_factory=lambda: deque(maxlen=40))
    process: subprocess.Popen | None = None
    cancelled: bool = False

    def output_file(self, name: str) -> Path | None:
        path = self.dir / "output" / "latest" / name
        return path if path.is_file() else None

    def workbook(self) -> Path | None:
        """The updated input workbook (Populate Request ID)."""
        return self.output_file(self.input_name) if self.input_name else None

    def report(self) -> Path | None:
        return self.output_file("detailed_report.csv")

    def view(self, since: int = 0) -> dict[str, Any]:
        result = None
        if self.result is not None:
            result = {k: self.result.get(k) for k in self.kind.result_keys}
        return {
            "id": self.id,
            "kind": self.kind.name,
            "status": self.status,
            "workbookName": self.input_name,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "counters": dict(self.counters),
            "logs": self.logs[since:],
            "logCount": len(self.logs),
            "result": result,
            "hasWorkbook": self.workbook() is not None,
            "hasReport": self.report() is not None,
        }


def _kill_tree(proc: subprocess.Popen) -> None:
    """Stop the job and the Chrome it started (Chrome runs as a child process)."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


class JobManager:
    def __init__(self, python: str | None = None):
        self.python = python or sys.executable
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        #: Called once with each job that finishes successfully.
        self.on_success: list[Callable[[Job], None]] = []

    def get(self, job_id: str, kind: JobKind | None = None) -> Job | None:
        job = self.jobs.get(job_id)
        return job if job and (kind is None or job.kind.name == kind.name) else None

    def running(self) -> Job | None:
        return next((j for j in self.jobs.values() if j.status == "running"), None)

    def start(
        self,
        kind: JobKind,
        settings: dict[str, Any],
        upload: tuple[str, bytes] | None = None,
    ) -> Job:
        missing = [k for k in kind.required if not str(settings.get(k) or "").strip()]
        if missing:
            raise JobError(f"Missing: {', '.join(missing)}.")
        name = None
        if kind.check_input:
            if upload is None:
                raise JobError("Upload the workbook.")
            name = Path(upload[0] or "workbook.xlsx").name
            if not name.lower().endswith(".xlsx"):
                raise JobError("Upload the workbook as an .xlsx file.")

        with self.lock:
            # Every job logs into the CLM; concurrent logins on one account break
            # the first session, so only one job runs at a time.
            if running := self.running():
                raise JobBusy(
                    "Another CLM run is in progress"
                    f" ({'Populate Request ID' if running.kind.name == 'request-id' else 'users list'})."
                    " Wait for it to finish or cancel it."
                )
            job_dir = Path(tempfile.mkdtemp(prefix=f"{kind.name}-"))
            if kind.check_input and upload and name:
                (job_dir / "input").mkdir()
                path = job_dir / "input" / name
                path.write_bytes(upload[1])
                try:
                    kind.check_input(path)
                except JobError:
                    shutil.rmtree(job_dir, ignore_errors=True)
                    raise
            job = Job(
                id=uuid.uuid4().hex[:12],
                kind=kind,
                dir=job_dir,
                input_name=name,
                counters={c: 0 for c in kind.counters},
                site=str(settings.get("url") or "").strip() or None,
            )
            self._evict_old()
            self.jobs[job.id] = job

        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        kwargs: dict[str, Any] = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        proc = subprocess.Popen(
            [self.python, "job.py", str(job_dir)],
            cwd=kind.script_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            encoding="utf-8",
            errors="replace",
            **kwargs,
        )
        job.process = proc
        # Settings (with the password) only ever travel over this pipe.
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(settings))
        proc.stdin.close()
        threading.Thread(target=self._read_stdout, args=(job,), daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(job,), daemon=True).start()
        return job

    def cancel(self, job: Job) -> Job:
        if job.status == "running" and job.process:
            job.cancelled = True
            _kill_tree(job.process)
        return job

    def _evict_old(self) -> None:
        finished = sorted(
            (j for j in self.jobs.values() if j.status != "running"), key=lambda j: j.started_at
        )
        for job in finished[: max(0, len(finished) - MAX_FINISHED_JOBS + 1)]:
            shutil.rmtree(job.dir, ignore_errors=True)
            del self.jobs[job.id]

    def _read_stderr(self, job: Job) -> None:
        assert job.process and job.process.stderr
        for line in job.process.stderr:
            job.stderr_tail.append(line.rstrip())

    def _read_stdout(self, job: Job) -> None:
        proc = job.process
        assert proc and proc.stdout
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                msg = {"type": "log", "level": "INFO", "logger": "stdout", "message": line, "time": time.time()}
            if msg.get("type") == "result":
                msg.pop("type")
                job.result = msg
            elif msg.get("type") == "log":
                msg.pop("type")
                job.kind.count(job.counters, str(msg.get("message", "")))
                if msg.get("level") in ("ERROR", "CRITICAL"):
                    job.counters["errors"] += 1
                job.logs.append(msg)
        proc.wait()
        self._finish(job)

    def _finish(self, job: Job) -> None:
        r = job.result
        if r is not None:
            job.kind.finish(job.counters, r)
            job.counters["errors"] = len(r.get("errors") or []) or job.counters["errors"]
        if job.cancelled:
            status = "cancelled"
        elif r is not None and r.get("success"):
            status = "done"
            for callback in self.on_success:
                try:
                    callback(job)
                except Exception as e:  # keep the job's own outcome
                    job.logs.append({"level": "ERROR", "logger": "jobs", "message": str(e), "time": time.time()})
        else:
            status = "failed"
            if r is None:
                tail = "\n".join(list(job.stderr_tail)[-8:]) or f"exit code {job.process.returncode if job.process else '?'}"
                job.result = {"success": False, "errors": [f"The run stopped unexpectedly: {tail}"]}
        job.finished_at = time.time()
        job.status = status
