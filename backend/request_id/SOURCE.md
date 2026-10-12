# Source

Copied from https://github.com/markcastorm/Bulk-design_process at commit `38d6d56` (2026-10-12):
`config.py`, `extractor.py`, `scraper.py`, `orchestrator.py`, `file_generator.py`.

Not copied: `main.py` and `explore.py` (CLI only), `output/` (holds client data), `.env*`.

## Local changes

Keep these when copying newer versions of the files over.

- `scraper.py`: `type_like_human()` has a `secret` parameter, and `login()` passes `secret=True` for the
  password, so a typed-value mismatch never writes the password to the log.

## Added here

- `job.py`: runs one population for the web app. Settings (including the password) come in on stdin;
  progress goes out on stdout as JSON lines. See `backend/jobs.py`.
