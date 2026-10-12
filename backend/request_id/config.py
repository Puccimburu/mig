
import os
import re

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
INPUT_DIR   = os.path.join(BASE_DIR, 'input')
OUTPUT_DIR  = os.path.join(BASE_DIR, 'output')
LOGS_DIR    = os.path.join(BASE_DIR, 'logs')
DEBUG_DIR   = os.path.join(BASE_DIR, 'debug')       # exploration artifacts
STATE_FILE  = os.path.join(BASE_DIR, 'state.json')
ENV_FILE    = os.path.join(BASE_DIR, '.env')

for _d in (INPUT_DIR, OUTPUT_DIR, LOGS_DIR, DEBUG_DIR):
    os.makedirs(_d, exist_ok=True)


def _parse_env(path):
    """
    Lenient parser for the team's .env file. Handles lines like:
        URL = "https://example.com",
        USERNAME = "someone",
    i.e. optional surrounding whitespace, optional quotes, optional
    trailing comma.
    """
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, 'r', encoding='utf-8-sig') as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            key = key.strip()
            val = val.strip()
            if val.endswith(','):
                val = val[:-1].strip()
            val = val.strip('"').strip("'")
            values[key] = val
    return values


_env = _parse_env(ENV_FILE)
# The .env file takes precedence over ambient OS environment variables.
# This matters on Windows specifically: the OS always defines USERNAME
# (and USERDOMAIN, USERPROFILE, ...) as the logged-in account name, which
# would otherwise silently shadow the site credential of the same name.
def _get(key, default=None):
    return _env.get(key, os.environ.get(key, default))


# ── Site credentials (may change per upload batch, same site) ────────────────
SITE_URL      = _get('URL', 'https://cloud9.contractpod.com/mashreqbank/help.aspx')
SITE_USERNAME = _get('USERNAME')
SITE_PASSWORD = _get('PASSWORD')

# The app's base URL (before the /help.aspx login entry point and the
# hash-router routes) -- used to navigate straight to an internal route
# like #/contract-snapshot/<id> once already authenticated, rather than
# needing to find-and-click a link to it. Derived once from SITE_URL
# rather than hardcoded, since SITE_URL itself already varies per batch.
BASE_APP_URL = SITE_URL.rsplit('/', 1)[0] if SITE_URL else ''

# Informational only (used to help identify/confirm the right bulk-import
# batch in the Operational Management report, NOT hardcoded into selectors).
BULK_IMPORT_TEMPLATE = _get('BULK_IMPORT_TEMPLATE')
UPLOADED_ON           = _get('UPLOADED_ON')
TOTAL_COUNT           = _get('TOTAL_COUNT')

# ── Browser ───────────────────────────────────────────────────────────────────
HEADLESS_MODE  = os.environ.get('HEADLESS', 'false').lower() == 'true'

# These are CEILINGS for condition-polling waits (WebDriverWait), not fixed
# sleeps -- every wait in scraper.py blocks on a real condition (an element
# existing, a spinner disappearing, table rows loading) and returns the
# moment that's true. Raising the ceiling costs nothing on a fast network
# and is what keeps the pipeline from breaking the first time it runs
# somewhere slower (a different network, a loaded server, a cold cache) --
# a short fixed guess is exactly what "not future-proof" means here.
# Override via env vars if a given site/network needs it tuned without a
# code change.
WAIT_TIMEOUT        = int(os.environ.get('WAIT_TIMEOUT_SECONDS', '180'))        # per-element/condition ceiling
DETAIL_PAGE_TIMEOUT = int(os.environ.get('DETAIL_PAGE_TIMEOUT_SECONDS', '180')) # contract-snapshot tab is the heaviest page
PAGE_LOAD_WAIT = 1.5          # small paint-settle buffer applied AFTER a real
                               # condition already passed -- not itself a
                               # substitute for waiting on that condition.
CLICK_DELAY    = (0.4, 1.1)   # human-like pause range between actions (seconds)
TYPE_DELAY     = (0.05, 0.18) # per-keystroke delay range (seconds)
MAX_REPORT_PAGES = 500        # safety cap against a runaway pagination loop

# Confirming a Completed record's Record ID (opening its contract-snapshot
# page) is by far the slowest per-record step (~10-20s each, vs ~1-2s to
# scrape a row). Measured on a real 88-record batch: running several of
# these concurrently as separate TABS within the one authenticated
# session (never a second login -- see CLAUDE.md, concurrent logins under
# the same account break the first session) cut per-record time from
# ~12.6s serial to ~7-10s at 3-8 tabs, with no clear optimum in that
# range and real record-to-record noise (the AI-metadata-modal only
# appears on some records and adds real time when it does) -- so this
# default is a reasonable, not precisely-tuned, concurrency cap.
MAX_CONCURRENT_TABS = int(os.environ.get('MAX_CONCURRENT_TABS', '5'))

# Report pages default to 50 rows; bumping to the site's max (100) before
# scraping means fewer page transitions for any batch over 50 records
# (e.g. 88 records: 1 page instead of 2).
REPORT_PAGE_SIZE = 100

# ── Input / matching ──────────────────────────────────────────────────────────
# Columns the pipeline writes on the Contract Request sheet. These (plus
# File Path) are created automatically by extractor.ensure_output_columns()
# if the raw uploads-team file doesn't already have them -- confirmed live
# against a fresh export (MSA_2302.xlsx, 2026-09-24) that had none of the
# four yet.
TARGET_COLUMNS = ['Request ID', 'Record ID', 'File Names']
MATCH_KEY_COLUMN = 'Record Reference Id'  # links a workbook row to a report row

# ── Supporting Documents (optional feature) ───────────────────────────────────
# Each record's inline expand (used for File Names/File Path above) also
# has a second nested table, "Supporting Documents", listing every
# supporting file uploaded with that record plus its own per-file
# Completed/Failed status -- confirmed live against MSA_2302 record 1
# (Request ID 91518): headers "ID | DOCUMENT REFERENCE ID | FILENAME |
# STATUS | ERROR MESSAGE". When enabled, this data is written into the
# workbook's separate 'Supporting Document' sheet (matched by Record
# Reference Id + Document Reference Id), which the uploads team's raw
# export already has pre-populated with one row per expected document.
# Toggle off to fall back to the original Contract-Request-only pipeline.
# Settable in .env (alongside the batch identifiers) or as an OS env var --
# .env wins if both are set, same precedence as URL/USERNAME/PASSWORD above.
ENABLE_SUPPORTING_DOCUMENTS = str(_get('ENABLE_SUPPORTING_DOCUMENTS', 'true')).lower() == 'true'

# ── Output ────────────────────────────────────────────────────────────────────
DATASET_NAME = 'RequestIdPopulator'
