# Source

Copied from https://github.com/markcastorm/Users-collector at commit `25f9a0a` (2026-10-12):
`config.py`, `scraper.py`, `orchestrator.py`, `file_generator.py`. Hound's `matcher.py` is in
`backend/name_check/matcher.py` (unchanged).

Not copied: `main.py`, `explore.py`, `Hound/main.py` and `Hound/config.py` (replaced by
`backend/name_check/`), `Hound/input/`, `Project_Information/` (client data), `.env*`.

## Local changes

Keep these when copying newer versions of the files over.

- `scraper.py`
  - `type_like_human()` has a `secret` parameter; `login()` passes `secret=True` so a typed-value
    mismatch never logs the password field's content.
  - Added `parse_showing()`, `read_showing()` and `goto_page_verified()` at the end: every page move
    is checked against the "Showing X to Y of Z results" footer. It clicks "Next" first (keeps the
    page size), then the page-number button, then the URL, and raises if none shows the right rows.
- `orchestrator.py`
  - Retries the 100-per-page click and then uses the page size the footer actually shows.
  - Moves between pages with `goto_page_verified()` instead of unverified URL paging.
  - Fails the run when the users collected (plus skipped duplicate emails) don't add up to the total.

## Added here

- `job.py`: runs one collection for the web app (see `backend/job_runtime.py`).
