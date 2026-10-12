
import os
import re
import sys
import time
import random
import logging
import subprocess

from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

import config

logger = logging.getLogger(__name__)

# Matches "Showing X to Y of Z results"
SHOWING_RE = re.compile(r'Showing\s+\d+\s+to\s+\d+\s+of\s+(\d+)\s+results', re.IGNORECASE)
# Same line with every number captured: (first row, last row, total).
SHOWING_RANGE_RE = re.compile(r'Showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+results', re.IGNORECASE)


# ── Human-like micro-behaviour ────────────────────────────────────────────────

def human_delay(lo=None, hi=None):
    lo, hi = (lo, hi) if lo is not None else config.CLICK_DELAY
    time.sleep(random.uniform(lo, hi))


def type_like_human(driver, el, text, secret=False):
    from selenium.webdriver.common.keys import Keys
    el.click()
    el.send_keys(Keys.CONTROL, 'a')
    el.send_keys(Keys.DELETE)
    for ch in text:
        el.send_keys(ch)
        time.sleep(random.uniform(*config.TYPE_DELAY))
    actual = el.get_attribute('value')
    if actual != text:
        if secret:
            logger.warning('typed value mismatch on a secret field -> forcing via JS')
        else:
            logger.warning(f'typed value mismatch (got {actual!r}) -> forcing via JS')
        driver.execute_script(
            "arguments[0].value = arguments[1];"
            "arguments[0].dispatchEvent(new Event('input', {bubbles:true}));"
            "arguments[0].dispatchEvent(new Event('change', {bubbles:true}));",
            el, text,
        )


def _safe(predicate):
    """Wrap a WebDriverWait predicate to treat StaleElementReferenceException
    as 'not ready yet' -- normal on a Vue SPA that re-renders elements."""
    from selenium.common.exceptions import StaleElementReferenceException
    def wrapped(d):
        try:
            return predicate(d)
        except StaleElementReferenceException:
            return False
    return wrapped


def click_when_ready(driver, el, timeout=None):
    """Scroll into view, wait for clickability, then click -- retrying
    through transient ElementClickInterceptedException."""
    from selenium.common.exceptions import ElementClickInterceptedException
    timeout = timeout or config.WAIT_TIMEOUT
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
    WebDriverWait(driver, timeout).until(EC.element_to_be_clickable(el))
    deadline = time.time() + timeout
    last_exc = None
    while time.time() < deadline:
        try:
            el.click()
            return
        except ElementClickInterceptedException as e:
            last_exc = e
            time.sleep(0.5)
    raise last_exc


def find_link_by_href(driver, href_substring):
    """Find a visible <a> whose href contains href_substring."""
    for el in driver.find_elements(By.CSS_SELECTOR, f'a[href*="{href_substring}"]'):
        try:
            if el.is_displayed():
                return el
        except Exception:
            continue
    return None


def find_clickable_by_text(driver, text, tags=('button', 'a')):
    """Most specific visible element whose text matches: exact wins;
    otherwise the shortest (innermost) substring match."""
    text_low = text.strip().lower()
    exact, substr = [], []
    for tag in tags:
        for el in driver.find_elements(By.TAG_NAME, tag):
            try:
                if not el.is_displayed():
                    continue
                el_text = el.text.strip().lower()
                if not el_text:
                    continue
                if el_text == text_low:
                    exact.append(el)
                elif text_low in el_text:
                    substr.append(el)
            except Exception:
                continue
    if exact:
        return exact[0]
    if substr:
        return min(substr, key=lambda e: len(e.text))
    return None


def dismiss_banner(driver):
    """Close the rebrand announcement banner if it overlaps the login form."""
    for el in driver.find_elements(By.TAG_NAME, 'button'):
        try:
            if el.text.strip() == '✕' and el.is_displayed():
                el.click()
                human_delay(0.2, 0.5)
                return True
        except Exception:
            continue
    return False


def dump_failure_state(driver, out_dir):
    """Best-effort screenshot + full page source when the pipeline hits an
    unexpected error -- self-diagnosing evidence for the next debug session."""
    try:
        os.makedirs(out_dir, exist_ok=True)
        driver.save_screenshot(os.path.join(out_dir, 'failure.png'))
        with open(os.path.join(out_dir, 'failure.html'), 'w', encoding='utf-8') as fh:
            fh.write(driver.page_source)
        with open(os.path.join(out_dir, 'failure_info.txt'), 'w', encoding='utf-8') as fh:
            fh.write(f'current_url: {driver.current_url}\n')
            fh.write(f'title: {driver.title}\n')
        logger.info(f'failure diagnostics saved to {out_dir}')
    except Exception as e:
        logger.warning(f'could not save failure diagnostics: {e}')


# ── Driver setup ──────────────────────────────────────────────────────────────

def get_chrome_version():
    if sys.platform == 'win32':
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Google\Chrome\BLBeacon')
            return int(winreg.QueryValueEx(key, 'version')[0].split('.')[0])
        except Exception:
            pass
    for cmd in ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']:
        try:
            out = subprocess.check_output([cmd, '--version'], stderr=subprocess.DEVNULL).decode()
            return int(out.strip().split()[-1].split('.')[0])
        except Exception:
            continue
    return None


def build_driver():
    import undetected_chromedriver as uc
    from selenium_stealth import stealth

    opts = uc.ChromeOptions()
    if config.HEADLESS_MODE:
        opts.add_argument('--headless=new')
    opts.add_argument('--no-sandbox')
    opts.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--disable-gpu')
    opts.add_argument('--window-size=1920,1080')
    opts.add_argument('--lang=en-US,en;q=0.9')
    opts.add_argument('--disable-features=AutofillServerCommunication,PasswordManagerOnboarding')
    opts.add_experimental_option('prefs', {
        'credentials_enable_service': False,
        'profile.password_manager_enabled': False,
        'autofill.profile_enabled': False,
        'autofill.credit_card_enabled': False,
    })
    version = get_chrome_version()
    kwargs = {'options': opts, 'use_subprocess': True}
    if version:
        kwargs['version_main'] = version
    driver = uc.Chrome(**kwargs)
    stealth(
        driver,
        languages=['en-US', 'en'],
        vendor='Google Inc.',
        platform='Win32',
        webgl_vendor='Intel Inc.',
        renderer='Intel Iris OpenGL Engine',
        fix_hairline=True,
    )
    driver.set_page_load_timeout(90)
    return driver


# ── Login ─────────────────────────────────────────────────────────────────────

def login(driver):
    """Log into the CLM. Returns True on success."""
    logger.info(f'navigating to {config.SITE_URL}')
    driver.get(config.SITE_URL)
    human_delay(1.5, 2.5)

    for attempt in range(4):
        url   = driver.current_url.lower()
        title = driver.title.lower()
        if 'login.microsoftonline.com' not in url and 'microsoft' not in title:
            break
        logger.info(f'attempt {attempt}: Microsoft login page detected -> retrying on new tab')
        driver.close()
        if driver.window_handles:
            driver.switch_to.window(driver.window_handles[-1])
        else:
            driver.switch_to.new_window('tab')
        driver.get(config.SITE_URL)
        human_delay(1.5, 2.5)

    try:
        WebDriverWait(driver, config.WAIT_TIMEOUT).until(
            lambda d: len(d.find_elements(By.CSS_SELECTOR, 'input[type="password"]')) > 0
        )
    except Exception:
        logger.warning('no password field appeared within timeout')

    dismiss_banner(driver)

    user_el = pass_el = None
    for el in driver.find_elements(By.TAG_NAME, 'input'):
        try:
            autocomplete = (el.get_attribute('autocomplete') or '').lower()
            itype        = (el.get_attribute('type') or '').lower()
            if itype == 'password' or autocomplete == 'current-password':
                pass_el = pass_el or el
            elif autocomplete == 'username':
                user_el = user_el or el
        except Exception:
            continue

    if not user_el or not pass_el:
        logger.error('could not locate login inputs dynamically')
        return False

    click_when_ready(driver, user_el)
    type_like_human(driver, user_el, config.SITE_USERNAME)
    human_delay()
    click_when_ready(driver, pass_el)
    type_like_human(driver, pass_el, config.SITE_PASSWORD, secret=True)
    human_delay()

    login_btn = None
    for el in driver.find_elements(By.TAG_NAME, 'button'):
        try:
            if el.get_attribute('type') == 'submit' and el.is_displayed():
                login_btn = el
                break
        except Exception:
            continue
    login_btn = login_btn or find_clickable_by_text(driver, 'log in')
    if not login_btn:
        logger.error('could not find login/submit button dynamically')
        return False

    click_when_ready(driver, login_btn)
    human_delay(2, 3)

    body_text = driver.find_element(By.TAG_NAME, 'body').text.lower()
    if 'invalid user' in body_text or 'invalid username' in body_text:
        logger.error('login rejected: invalid username/password')
        return False

    try:
        WebDriverWait(driver, config.WAIT_TIMEOUT).until(
            lambda d: find_link_by_href(d, '#/vault') is not None
        )
    except Exception:
        logger.error(f'app shell never loaded within {config.WAIT_TIMEOUT}s of logging in')
        return False

    time.sleep(config.PAGE_LOAD_WAIT)
    logger.info(f'login ok, current_url={driver.current_url}')
    return True


# ── Navigation ────────────────────────────────────────────────────────────────

def goto_users_page(driver):
    """Navigate to the Users page.

    The vault landing page shows top-level cards (Operational Management,
    Forms & Fields, ...). The User Management sub-links only appear after
    clicking the Operational Management card, so the sequence is:
      1. Click sidebar Vault link (by stable href -- label is CSS-hidden).
      2. Click "Operational Management" card (by text).
      3. Click the Users link (by stable href #/vault/user-management/users).
    """
    # Step 1: vault sidebar link.
    WebDriverWait(driver, config.WAIT_TIMEOUT).until(
        lambda d: find_link_by_href(d, '#/vault') is not None
    )
    click_when_ready(driver, find_link_by_href(driver, '#/vault'))
    WebDriverWait(driver, config.WAIT_TIMEOUT).until(lambda d: '#/vault' in d.current_url)
    time.sleep(config.PAGE_LOAD_WAIT)
    logger.info(f'vault: {driver.current_url}')

    # Step 2: Operational Management card.
    WebDriverWait(driver, config.WAIT_TIMEOUT).until(
        lambda d: find_clickable_by_text(d, 'operational management', tags=('a', 'div', 'h3', 'h4')) is not None
    )
    click_when_ready(driver, find_clickable_by_text(driver, 'operational management', tags=('a', 'div', 'h3', 'h4')))
    time.sleep(config.PAGE_LOAD_WAIT)
    logger.info(f'operational management: {driver.current_url}')

    # Step 3: Users link (now visible after step 2).
    WebDriverWait(driver, config.WAIT_TIMEOUT).until(
        _safe(lambda d: find_link_by_href(d, '#/vault/user-management/users') is not None)
    )
    click_when_ready(driver, find_link_by_href(driver, '#/vault/user-management/users'))
    WebDriverWait(driver, config.WAIT_TIMEOUT).until(
        lambda d: 'user-management/users' in d.current_url
    )
    time.sleep(config.PAGE_LOAD_WAIT)
    logger.info(f'users page: {driver.current_url}')


# ── Table helpers ─────────────────────────────────────────────────────────────

def _wait_for_table_data(driver, timeout=None):
    """Block until the table has real data rows (spinner row gone)."""
    timeout = timeout or config.WAIT_TIMEOUT

    def _ready(d):
        rows = d.find_elements(By.CSS_SELECTOR, 'table tbody tr')
        if not rows:
            return False
        combined = ' '.join(r.text for r in rows).lower()
        return 'spinning' not in combined and combined.strip() != ''

    WebDriverWait(driver, timeout).until(_safe(_ready))
    time.sleep(config.PAGE_LOAD_WAIT)


def set_report_page_size(driver, size):
    """Click the PER PAGE selector to show `size` records per page.

    The selector (ul.pagination.mb-0) lives below the table -- the caller
    must ensure the table data has loaded (spinner gone) before calling
    this, so the full page including the footer is rendered. We then wait
    for the selector element itself before trying to click it, and scroll
    it into view so click_when_ready doesn't have to fight a partially
    off-screen element.

    Best-effort: logs a warning and returns False if not found rather than
    failing the run, so the pipeline degrades gracefully to the default
    page size instead of crashing.
    """
    try:
        # Wait for the per-page UL to appear in the DOM -- it renders
        # after the table body finishes loading (same "data before footer"
        # sequence confirmed by the explore run).
        WebDriverWait(driver, config.WAIT_TIMEOUT).until(_safe(
            lambda d: any(
                'mb-0' in (ul.get_attribute('class') or '')
                for ul in d.find_elements(By.CSS_SELECTOR, 'ul.pagination')
            )
        ))
        per_page_uls = [
            ul for ul in driver.find_elements(By.CSS_SELECTOR, 'ul.pagination')
            if 'mb-0' in (ul.get_attribute('class') or '')
        ]
        if not per_page_uls:
            logger.warning('per-page selector not found after waiting')
            return False
        # Scroll the selector into view before clicking -- it's at the
        # bottom of the page and may be off-screen.
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", per_page_uls[0])
        human_delay(0.3, 0.6)
        for li in per_page_uls[0].find_elements(By.CSS_SELECTOR, 'li.page-item'):
            btns = li.find_elements(By.TAG_NAME, 'button')
            if btns and btns[0].text.strip() == str(size):
                click_when_ready(driver, btns[0])
                _wait_for_table_data(driver)
                logger.info(f'per-page set to {size}')
                return True
        logger.warning(f'per-page button "{size}" not found in the selector')
    except Exception as e:
        logger.warning(f'set_report_page_size({size}) error: {e}')
    return False


def _get_total_users(driver):
    """Read 'Showing X to Y of Z results' to get the total user count."""
    for el in driver.find_elements(By.CSS_SELECTOR, 'div'):
        try:
            t = el.text.strip()
            m = SHOWING_RE.search(t)
            if m:
                return int(m.group(1))
        except Exception:
            continue
    return None


def _read_page_via_js(driver):
    """Extract all table row cell texts in a single JS call -- avoids the
    N×M individual Selenium round-trips that make per-cell reading slow
    at 100 rows/page (100 rows × 10 cells = 1000 Selenium calls vs 1 here).

    Returns a list of cell-text lists, one per <tbody> <tr>."""
    return driver.execute_script("""
        var rows = document.querySelectorAll('table tbody tr');
        return Array.from(rows).map(function(row) {
            return Array.from(row.querySelectorAll('td')).map(function(td) {
                return td.innerText.trim();
            });
        });
    """)


def _navigate_to_page(driver, page_num, per_page):
    """Navigate directly to a page by URL query params -- faster and more
    reliable than clicking Next repeatedly (avoids the Next-still-enabled
    edge case on the last page, and avoids per-click wait overhead)."""
    base = config.BASE_APP_URL + '/#/vault/user-management/users'
    url  = f'{base}?perPage={per_page}&page={page_num}'
    driver.get(url)
    _wait_for_table_data(driver)


def collect_all_users(driver):
    """Walk every page of the Users table and return a list of dicts,
    one per user, with keys matching USER_DATA_COLUMNS.

    Strategy:
      1. Get total user count from the "Showing X to Y of Z" text.
      2. Compute total pages from total / per_page.
      3. Navigate to each page by URL (not by clicking Next) -- avoids
         per-click overhead and the ambiguous last-page Next state.
      4. Read all rows in one JS call per page.
      5. Slice cells[3:9] per row (confirmed by recon: 3 leading empty
         cells before data, 1 trailing ACTIONS empty).
    """
    _wait_for_table_data(driver)
    total = _get_total_users(driver)
    if total:
        logger.info(f'total users: {total}')
    else:
        logger.warning('could not determine total user count from page text')

    per_page = config.REPORT_PAGE_SIZE
    import math
    total_pages = math.ceil(total / per_page) if total else config.MAX_PAGES
    total_pages = min(total_pages, config.MAX_PAGES)
    logger.info(f'expecting {total_pages} page(s) at {per_page}/page')

    col = config.USER_DATA_COLUMNS
    sl  = config.CELL_DATA_SLICE
    all_users = []
    seen = set()   # dedupe by email (primary key on this table)

    for page_num in range(1, total_pages + 1):
        if page_num > 1:
            _navigate_to_page(driver, page_num, per_page)
        else:
            _wait_for_table_data(driver)

        raw_rows = _read_page_via_js(driver)
        page_records = []
        for cells in raw_rows:
            if len(cells) < 9:
                continue
            data = cells[sl]
            # Skip rows that are clearly blank or spinner artefacts.
            if not any(data) or 'spinning' in ' '.join(data).lower():
                continue
            record = dict(zip(col, data))
            email = record.get('Email', '').strip().lower()
            if email and email in seen:
                continue
            if email:
                seen.add(email)
            page_records.append(record)
            all_users.append(record)

        logger.info(f'page {page_num}/{total_pages}: {len(page_records)} user(s) collected '
                    f'(running total: {len(all_users)})')

        if total and len(all_users) >= total:
            logger.info('collected all expected users -- stopping early')
            break

    return all_users


# ── Verified paging (web app version) ────────────────────────────────────────
# The page-size click and URL paging have both been seen to silently fail
# (page size stuck at 50, or a URL that reloads page 1). Every page move
# below is therefore checked against the "Showing X to Y of Z results"
# footer before its rows are read.

def parse_showing(text):
    """(first_row, last_row, total) from the footer text, or None."""
    m = SHOWING_RANGE_RE.search(text or '')
    return tuple(int(g) for g in m.groups()) if m else None


def read_showing(driver):
    try:
        return parse_showing(driver.execute_script('return document.body.innerText'))
    except Exception:
        return None


def _wait_for_first_row(driver, expected_first, timeout):
    """Wait until the footer says the table starts at `expected_first`."""
    try:
        WebDriverWait(driver, timeout).until(_safe(
            lambda d: (read_showing(d) or (0,))[0] == expected_first
        ))
    except Exception:
        return False
    _wait_for_table_data(driver)
    return (read_showing(driver) or (0,))[0] == expected_first


def _click_pagination(driver, aria_label):
    for btn in driver.find_elements(By.CSS_SELECTOR, 'ul.pagination button'):
        try:
            if (btn.get_attribute('aria-label') or '').strip().lower() == aria_label.lower():
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", btn)
                human_delay(0.2, 0.5)
                click_when_ready(driver, btn)
                return True
        except Exception:
            continue
    return False


def goto_page_verified(driver, page_num, per_page, timeout=None):
    """Show page `page_num` and confirm it is really that page.

    Clicks the in-app "Next" button first: it keeps the page size that was
    chosen. Falls back to the page-number button, then to the URL. Raises
    if none of them lands on the right rows.
    """
    timeout = timeout or min(config.WAIT_TIMEOUT, 60)
    expected_first = (page_num - 1) * per_page + 1
    attempts = (
        ('next button', lambda: _click_pagination(driver, 'Go to next page')),
        ('page button', lambda: _click_pagination(driver, f'Go to page {page_num}')),
        ('url', lambda: (_navigate_to_page(driver, page_num, per_page), True)[1]),
    )
    for how, act in attempts:
        current = read_showing(driver)
        if current and current[0] == expected_first:
            return current
        if how == 'next button' and current and current[0] != expected_first - per_page:
            continue  # not on the previous page, so "Next" would land elsewhere
        try:
            if not act():
                continue
        except Exception as e:
            logger.warning(f'page {page_num}: {how} failed ({e})')
            continue
        if _wait_for_first_row(driver, expected_first, timeout):
            return read_showing(driver)
        logger.warning(f'page {page_num}: {how} did not show row {expected_first} '
                       f'(footer: {read_showing(driver)})')
    raise RuntimeError(f'could not load page {page_num}: expected rows from {expected_first}, '
                       f'footer shows {read_showing(driver)}')

