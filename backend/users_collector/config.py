
import os

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE_DIR, 'output')
LOGS_DIR   = os.path.join(BASE_DIR, 'logs')
DEBUG_DIR  = os.path.join(BASE_DIR, 'debug')
ENV_FILE   = os.path.join(BASE_DIR, '.env')

for _d in (OUTPUT_DIR, LOGS_DIR, DEBUG_DIR):
    os.makedirs(_d, exist_ok=True)


def _parse_env(path):
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, encoding='utf-8-sig') as fh:
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

# .env wins over ambient OS environment so Windows USERNAME never shadows
# the site credential (Windows always defines USERNAME as the logged-in
# OS account name, which would otherwise silently override the value set
# by the team in .env).
def _get(key, default=None):
    return _env.get(key, os.environ.get(key, default))


# ── Site credentials ──────────────────────────────────────────────────────────
SITE_URL      = _get('URL', '')
SITE_USERNAME = _get('USERNAME')
SITE_PASSWORD = _get('PASSWORD')
BASE_APP_URL  = SITE_URL.rsplit('/', 1)[0] if SITE_URL else ''

# ── Browser ───────────────────────────────────────────────────────────────────
HEADLESS_MODE = os.environ.get('HEADLESS', 'false').lower() == 'true'

# Condition-polling ceilings (WebDriverWait), not fixed sleeps. Every wait
# in scraper.py blocks on a real DOM condition and returns as soon as it's
# true. Raising these costs nothing on a fast network.
WAIT_TIMEOUT = int(os.environ.get('WAIT_TIMEOUT_SECONDS', '120'))
PAGE_LOAD_WAIT = 1.5   # small paint-settle buffer AFTER a real condition passed
CLICK_DELAY    = (0.4, 1.1)
TYPE_DELAY     = (0.05, 0.18)

# Safety cap against a runaway pagination loop.
MAX_PAGES = int(os.environ.get('MAX_PAGES', '500'))

# Set per-page to 100 before collecting (reduces page count from ~225 to ~113).
REPORT_PAGE_SIZE = 100

# ── Table structure (confirmed by recon against the live site) ────────────────
# The users table renders 10 <td> cells per row: 3 leading empties
# (select-all checkbox column + two avatar-icon columns), then the 6
# data columns, then 1 trailing empty (ACTIONS). Data lives at [3:9].
USER_DATA_COLUMNS = ['Name', 'User License', 'Email', 'Department', 'Role', 'Is Active?']
CELL_DATA_SLICE   = slice(3, 9)   # cells[3:9] maps 1-to-1 onto USER_DATA_COLUMNS
