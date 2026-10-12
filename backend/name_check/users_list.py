"""
The saved CLM users list (from the Users Collector or an uploaded users.xlsx).

Kept in backend/data/users/ (git-ignored: it is client data) so it is collected once
and reused by every name check.
"""
from __future__ import annotations

import io
import json
import shutil
import threading
import time
from pathlib import Path
from typing import Any

import openpyxl

from .users_match import User, UserMatcher, is_active

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "users"
FILE = DATA_DIR / "users.xlsx"
META = DATA_DIR / "meta.json"

_lock = threading.Lock()
_cached: tuple[float, UserMatcher] | None = None


class UsersListError(Exception):
    pass


def read_users(path: Path) -> list[User]:
    """Users from the first sheet with a "Name" header (Users Collector layout)."""
    try:
        # Read from memory: a read-only workbook keeps its file open (and locked on Windows).
        wb = openpyxl.load_workbook(io.BytesIO(path.read_bytes()), read_only=True, data_only=True)
    except Exception as e:
        raise UsersListError(f"Not a readable Excel file ({e}).") from e
    try:
        for ws in wb.worksheets:
            rows = ws.iter_rows(values_only=True)
            header = [str(h).strip().lower() if h is not None else "" for h in next(rows, ())]
            if "name" not in header:
                continue
            col = {h: i for i, h in enumerate(header) if h}

            def cell(row: tuple, key: str) -> str:
                i = col.get(key)
                return str(row[i]).strip() if i is not None and i < len(row) and row[i] is not None else ""

            users = []
            for row in rows:
                name = cell(row, "name")
                if name:
                    users.append(User(
                        name=name,
                        email=cell(row, "email"),
                        active=is_active(cell(row, "is active?")) if "is active?" in col else True,
                        department=cell(row, "department"),
                        role=cell(row, "role"),
                    ))
            return users
    finally:
        wb.close()
    raise UsersListError('No sheet has a "Name" column. Upload the users.xlsx from the Users Collector.')


def save(path: Path, source: str, site: str | None = None) -> dict[str, Any]:
    users = read_users(path)
    if not users:
        raise UsersListError("The users list has no users.")
    meta = {
        "source": source,  # "collected" | "uploaded"
        "site": site,
        "savedAt": time.time(),
        "count": len(users),
        "active": sum(u.active for u in users),
    }
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = FILE.with_suffix(".tmp")
        shutil.copyfile(path, tmp)
        tmp.replace(FILE)
        META.write_text(json.dumps(meta), encoding="utf-8")
    return meta


def meta() -> dict[str, Any] | None:
    if not FILE.is_file() or not META.is_file():
        return None
    try:
        return json.loads(META.read_text(encoding="utf-8"))
    except ValueError:
        return None


def matcher() -> UserMatcher:
    """Matcher over the saved list, rebuilt only when the list changes."""
    global _cached
    if not FILE.is_file():
        raise UsersListError("There is no users list yet. Collect it from the CLM or upload users.xlsx.")
    mtime = FILE.stat().st_mtime
    with _lock:
        if _cached is None or _cached[0] != mtime:
            _cached = (mtime, UserMatcher(read_users(FILE)))
        return _cached[1]
