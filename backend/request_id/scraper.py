
import os
import re
import sys
import time
import random
import logging
import subprocess

from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

import config

logger = logging.getLogger(__name__)

HEADER_RE = re.compile(r'Request ID:\s*(\d+)\s*\|\s*Record ID:\s*(\d+)')


# ── Human-like micro-behaviour ────────────────────────────────────────────────

def human_delay(lo=None, hi=None):
    lo, hi = (lo, hi) if lo is not None else config.CLICK_DELAY
    time.sleep(random.uniform(lo, hi))


def type_like_human(el, text, secret=False):
    """Click, clear defensively, type char-by-char, then verify the value
    stuck -- autofill/OS suggestions have been observed to hijack a field
    on this site's login form, so we never trust send_keys blindly."""
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
            logger.warning(f'typed value mismatch (got {actual!r}, want {text!r}) -> forcing via JS')
        driver = el._parent
        driver.execute_script(
            "arguments[0].value = arguments[1];"
            "arguments[0].dispatchEvent(new Event('input', {bubbles:true}));"
            "arguments[0].dispatchEvent(new Event('change', {bubbles:true}));",
            el, text,
        )


def _safe(predicate):
    """Wrap a WebDriverWait predicate so a StaleElementReferenceException
    -- raised when Vue re-renders/replaces an element between us finding
    it and reading its .text/attribute a moment later -- is treated as
    'not ready yet' (return False, poll again) instead of an uncaught
    exception blowing up the whole wait. WebDriverWait only auto-ignores
    NoSuchElementException by default; staleness during a live re-render
    is a normal, expected condition on this SPA and needs the same
    treatment, not a fatal error."""
    from selenium.common.exceptions import StaleElementReferenceException

    def wrapped(d):
        try:
            return predicate(d)
        except StaleElementReferenceException:
            return False
    return wrapped


def click_when_ready(driver, el, timeout=None):
    """Scroll into view, wait for Selenium's own clickability check, then
    click -- retrying through ElementClickInterceptedException (a
    transient overlay, e.g. right after a route change/login, can sit on
    top of an otherwise-ready element for a moment).

    Deliberately does NOT pre-guess "is some overlay/spinner-looking
    element currently displayed" via a CSS class heuristic first: this
    site keeps a permanently-in-DOM, permanently-"displayed" `topbar-
    loader` progress-bar element (0-width when idle, but Selenium still
    reports it as displayed) -- confirmed to make any such heuristic
    false-positive forever and burn its full wait ceiling on every single
    call. Catching the actual ElementClickInterceptedException Selenium
    raises when a click is genuinely blocked is the reliable signal.
    """
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


def click_hovered(driver, el, timeout=None):
    """Click an element we've already deliberately scrolled-to and
    hovered, WITHOUT re-scrolling it into view first (unlike
    click_when_ready). Confirmed by direct diagnosis: re-running
    scrollIntoView on a hover-revealed action button living in a sticky
    (right-pinned) table column can shift horizontal scroll just enough
    to break the hover relationship the click depends on, turning a
    normally-instant click into a repeated ElementClickInterceptedException
    that eats the full wait ceiling. Only real remaining risk is a
    transient intercept, so still retry on that -- just never re-scroll.
    """
    from selenium.common.exceptions import ElementClickInterceptedException
    timeout = timeout or config.WAIT_TIMEOUT
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
    """Find a visible <a> whose href contains href_substring -- for nav
    items like the sidebar's Vault entry, whose text LABEL is
    deliberately CSS-hidden (class="invisible") while the sidebar is in
    its default collapsed/icon-only state. Matching by href (a stable
    application route, not a build-hash class) is the correct way to
    find this kind of icon-only nav link -- text-matching is simply the
    wrong tool here, since there may be no visible text at all by design.
    """
    for el in driver.find_elements(By.CSS_SELECTOR, f'a[href*="{href_substring}"]'):
        try:
            if el.is_displayed():
                return el
        except Exception:
            continue
    return None


def find_clickable_by_text(driver, text, tags=('button', 'a')):
    """Most specific visible element whose text matches: exact match wins;
    otherwise the shortest (innermost) substring match, so we never grab
    an ancestor container that merely happens to contain the text among
    many children."""
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
    """Close the 'rebrand to Leah' announcement banner if present -- it
    can visually overlap the login form and cause
    ElementNotInteractableException on an otherwise-valid element."""
    for el in driver.find_elements(By.TAG_NAME, 'button'):
        try:
            if el.text.strip() == '✕' and el.is_displayed():
                el.click()
                human_delay(0.2, 0.5)
                return True
        except Exception:
            continue
    return False


def dismiss_ai_metadata_modal(driver):
    """The contract-snapshot page can pop an 'AI has detected a change in
    your metadata' modal proposing to overwrite a field. We are read-only
    here -- always Cancel, never Submit, or we'd mutate live contract
    data based on an unverified AI guess."""
    for btn in driver.find_elements(By.TAG_NAME, 'button'):
        try:
            if btn.text.strip().lower() == 'cancel' and btn.is_displayed():
                logger.warning('AI metadata-change modal detected -> clicking Cancel (never Submit)')
                btn.click()
                human_delay(0.5, 1)
                return True
        except Exception:
            continue
    return False


def wait_until_findable(driver, text, tags=('a', 'div'), timeout=None):
    """Poll until an element matching `text` (see find_clickable_by_text)
    exists -- used after every SPA route change instead of a fixed sleep,
    since the loading-spinner window is inconsistent in length and can
    finish before the next screen's content has actually rendered."""
    timeout = timeout or config.WAIT_TIMEOUT
    WebDriverWait(driver, timeout).until(
        lambda d: find_clickable_by_text(d, text, tags=tags) is not None
    )
    time.sleep(config.PAGE_LOAD_WAIT)


def dump_failure_state(driver, out_dir):
    """Best-effort screenshot + full page source + open-tab list, saved
    into this run's output folder when the pipeline hits an unexpected
    error -- self-diagnosing evidence instead of a bare traceback the
    next time the site does something we haven't seen yet."""
    try:
        os.makedirs(out_dir, exist_ok=True)
        driver.save_screenshot(os.path.join(out_dir, 'failure.png'))
        with open(os.path.join(out_dir, 'failure.html'), 'w', encoding='utf-8') as fh:
            fh.write(driver.page_source)
        with open(os.path.join(out_dir, 'failure_info.txt'), 'w', encoding='utf-8') as fh:
            fh.write(f'current_url: {driver.current_url}\n')
            fh.write(f'title: {driver.title}\n')
            fh.write(f'window_handles: {driver.window_handles}\n')
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
    # Kill Chrome/Windows autofill -- confirmed during recon that a
    # Windows profile can autofill the username field with the OS account
    # name before our keystrokes land.
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

def _find_login_inputs(driver):
    user_el, pass_el = None, None
    for el in driver.find_elements(By.TAG_NAME, 'input'):
        try:
            autocomplete = (el.get_attribute('autocomplete') or '').lower()
            itype = (el.get_attribute('type') or '').lower()
            if itype == 'password' or autocomplete == 'current-password':
                pass_el = pass_el or el
            elif autocomplete == 'username':
                user_el = user_el or el
        except Exception:
            continue
    return user_el, pass_el


def login(driver):
    """Log into the CLM. Returns True on success. Never assumes selectors
    -- everything is (re-)discovered live, per the non-negotiable spec
    requirement to visit and verify rather than guess."""
    logger.info(f'navigating to {config.SITE_URL}')
    driver.get(config.SITE_URL)
    human_delay(1.5, 2.5)

    # The site can (per spec) sometimes bounce through a Microsoft login
    # page instead of showing its own form -- retry on a fresh tab until
    # it doesn't.
    for attempt in range(4):
        url = driver.current_url.lower()
        title = driver.title.lower()
        if 'login.microsoftonline.com' not in url and 'microsoft' not in title:
            break
        logger.info(f'attempt {attempt}: Microsoft login page detected -> retrying on a new tab')
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

    user_el, pass_el = _find_login_inputs(driver)
    if not user_el or not pass_el:
        logger.error('could not locate login inputs dynamically')
        return False

    click_when_ready(driver, user_el)
    type_like_human(user_el, config.SITE_USERNAME)
    human_delay()
    click_when_ready(driver, pass_el)
    type_like_human(pass_el, config.SITE_PASSWORD, secret=True)
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
    if login_btn is None:
        logger.error('could not find login/submit button dynamically')
        return False

    click_when_ready(driver, login_btn)
    human_delay(2, 3)

    # Detect an explicit "invalid username/password" style error.
    body_text = driver.find_element(By.TAG_NAME, 'body').text.lower()
    if 'invalid user' in body_text or 'invalid username' in body_text:
        logger.error('login rejected: invalid username/password')
        return False

    # The post-login redirect to the dashboard route goes through a
    # loading animation of unpredictable length (network speed, server
    # load, cold cache all vary) -- rather than guess a duration, block on
    # the concrete thing we actually need next. Check the sidebar's Vault
    # link by href, not text: the dashboard's own "deck" Vault button only
    # exists once the dashboard's main content has finished loading (which
    # can fail/stall independently of login succeeding -- confirmed: one
    # run logged in fine but the dashboard body never rendered anything
    # past its bare heading), whereas the sidebar is part of the app's
    # persistent nav frame and mounts immediately. If even that never
    # shows up within the (generous, ceiling-only) timeout, that's a real
    # failure -- surface it rather than silently reporting login as OK.
    try:
        WebDriverWait(driver, config.WAIT_TIMEOUT).until(
            lambda d: find_link_by_href(d, '#/vault') is not None
        )
    except Exception:
        logger.error(f'app shell never loaded (no sidebar Vault link) within {config.WAIT_TIMEOUT}s of logging in')
        return False
    time.sleep(config.PAGE_LOAD_WAIT)
    logger.info(f'login ok, current_url={driver.current_url}')
    return True


# ── Navigation: dashboard -> vault -> operational management -> bulk import ──

def _click_by_text(driver, text, tags, timeout=None, expect_url_contains=None):
    """Poll until an element matching `text` exists, THEN fetch and click
    it -- never trust that a caller's earlier check still holds, since the
    SPA can still be settling (confirmed: the URL itself kept changing for
    a moment after login() had already verified the Vault link existed).
    Every navigation step re-establishes its own precondition.

    If `expect_url_contains` is given, also block until the URL reflects
    the navigation actually happened -- catches a click that lands on a
    dead/decoy element (matched text but nothing real navigated) instead
    of silently moving on to the next step against a page that never
    changed.
    """
    timeout = timeout or config.WAIT_TIMEOUT
    wait_until_findable(driver, text, tags=tags, timeout=timeout)
    el = find_clickable_by_text(driver, text, tags=tags)
    if not el:
        raise RuntimeError(f'{text!r} not found dynamically (tags={tags})')
    click_when_ready(driver, el, timeout=timeout)
    if expect_url_contains:
        WebDriverWait(driver, timeout).until(lambda d: expect_url_contains in d.current_url)


def _click_by_href(driver, href_substring, timeout=None, expect_url_contains=None):
    """Same as _click_by_text but for nav items found by href rather than
    visible text -- for icon-only sidebar links whose text label is
    deliberately CSS-hidden (see find_link_by_href)."""
    timeout = timeout or config.WAIT_TIMEOUT
    WebDriverWait(driver, timeout).until(lambda d: find_link_by_href(d, href_substring) is not None)
    el = find_link_by_href(driver, href_substring)
    if not el:
        raise RuntimeError(f'href containing {href_substring!r} not found dynamically')
    click_when_ready(driver, el, timeout=timeout)
    if expect_url_contains:
        WebDriverWait(driver, timeout).until(lambda d: expect_url_contains in d.current_url)


def goto_bulk_import_upload(driver):
    # The sidebar's Vault entry is part of the app's persistent nav frame
    # and exists as soon as the app mounts -- found by its stable href
    # route rather than visible text (its label is CSS-hidden by design
    # while the sidebar is collapsed/icon-only). This is more reliable
    # than the dashboard's "deck" quick-action Vault button, which only
    # exists once the dashboard's main content has finished loading.
    _click_by_href(driver, '#/vault', expect_url_contains='vault')
    # No expect_url_contains here: clicking "Operational Management" has
    # been observed to sometimes do a real route change
    # (#/vault/?section=operational-management) and other times just an
    # in-page scroll to that section on a single scrollable Vault view
    # (URL stays bare #/vault) -- both land somewhere that makes "Bulk
    # Import Upload" findable, which is the actual precondition for the
    # next step, so that's what's worth asserting instead of a URL shape
    # that isn't consistent.
    _click_by_text(driver, 'operational management', tags=('div', 'a'))
    _click_by_text(driver, 'bulk import upload', tags=('a',),
                    expect_url_contains='bulk-import/upload')
    wait_until_findable(driver, 'upload new file', tags=('button', 'div'))


def open_matched_batch_report(driver, template, uploaded_on, total_count):
    """Find the batch row matching template+uploaded_on+total_count
    (template names repeat across batches -- all three together are
    needed to disambiguate) and open its report page.

    The batch list's page shell (buttons, page-size selector) renders
    before its row data does -- the same "headers before data" race as
    the report table -- so this polls the live DOM rather than scanning
    it once, and also walks pagination pages if the match isn't on the
    first one.
    """
    def _find_row():
        for candidate in driver.find_elements(By.CSS_SELECTOR, 'tr'):
            try:
                t = candidate.text
            except Exception:
                continue
            if template in t and uploaded_on in t and f'\n{total_count}\n' in f'\n{t}\n':
                return candidate
        return None

    row = None
    for page in range(1, config.MAX_REPORT_PAGES + 1):
        try:
            row = WebDriverWait(driver, config.WAIT_TIMEOUT).until(lambda d: _find_row())
            break
        except Exception:
            pass
        if not _goto_next_page(driver):
            break
    if row is None:
        raise RuntimeError(
            f'could not find batch row for template={template!r} '
            f'uploaded_on={uploaded_on!r} total={total_count!r}'
        )

    # Sequence matters here, confirmed by screenshots + a real bug caught
    # mid-development (searched for the button before ever hovering, so
    # it could never be found):
    #   1. scroll the row into view -- a real mouse hover cannot land on
    #      an element that's scrolled outside the viewport.
    #   2. hover the ROW -- this is what makes the Details element exist/
    #      appear in the first place. Only search for it AFTER this.
    #   3. hover the Details element WITHOUT leaving the row first -- a
    #      single ActionChains move-to-row-then-move-to-button (one
    #      .perform() at the end) rather than two separate hovers, since
    #      the button is a descendant of the row and the pointer should
    #      never actually exit the row's bounds on the way to it.
    #      Hovering the row alone leaves Details visible but not yet
    #      active (no underline/link styling, and clicking it hangs); it
    #      only becomes genuinely clickable once the mouse also lands on
    #      it directly.
    #   4. only then click.
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", row)
    human_delay(0.5, 1)

    ActionChains(driver).move_to_element(row).perform()
    human_delay()

    details_btn = None
    for btn in row.find_elements(By.TAG_NAME, 'button'):
        if btn.text.strip().lower() == 'details':
            details_btn = btn
            break
    if details_btn is None:
        raise RuntimeError('Details button not found inside matched batch row (even after hovering it)')

    ActionChains(driver).move_to_element(row).move_to_element(details_btn).perform()
    human_delay()

    # Not click_when_ready -- confirmed by direct diagnosis that its own
    # re-scrollIntoView on this specific hover-revealed, sticky-column
    # button breaks the hover state the click depends on (see
    # click_hovered's docstring).
    click_hovered(driver, details_btn)
    WebDriverWait(driver, config.WAIT_TIMEOUT).until(_safe(
        lambda d: any(th.text.strip() == 'REQUEST ITEM ID' for th in d.find_elements(By.CSS_SELECTOR, 'table th'))
    ))
    _wait_for_table_data(driver)
    set_report_page_size(driver, config.REPORT_PAGE_SIZE)


def set_report_page_size(driver, size):
    """Click the PER PAGE selector (10/50/100) if present. Confirmed the
    site reflects this as a real URL query param (?perPage=100) and
    correctly re-renders with all matching rows on one page -- reduces
    pagination overhead for any batch over 50 records. Best-effort: if
    the selector or the requested size isn't found, just leaves the
    default page size in place rather than failing the run over it."""
    try:
        per_page_uls = [
            ul for ul in driver.find_elements(By.CSS_SELECTOR, 'ul.pagination')
            if 'mb-0' in (ul.get_attribute('class') or '')
        ]
        if not per_page_uls:
            return False
        for li in per_page_uls[0].find_elements(By.CSS_SELECTOR, 'li.page-item'):
            btns = li.find_elements(By.TAG_NAME, 'button')
            if btns and btns[0].text.strip() == str(size):
                click_when_ready(driver, btns[0])
                _wait_for_table_data(driver)
                return True
    except Exception as e:
        logger.warning(f'could not set report page size to {size}: {e}')
    return False


# ── Report table parsing (with pagination + inline expand) ───────────────────

def _read_headers(driver):
    return [th.text.strip() for th in driver.find_elements(By.CSS_SELECTOR, 'table th') if th.text.strip()]


def _read_data_rows(driver):
    """Return the real per-record <tr> elements, skipping the blank
    expand-chevron spacer rows the table interleaves between records and
    a transient single-cell 'Spinning...' placeholder row shown while the
    table's data is still loading."""
    rows = driver.find_elements(By.CSS_SELECTOR, 'table tbody tr')
    out = []
    for r in rows:
        cells = [td.text.strip() for td in r.find_elements(By.CSS_SELECTOR, 'td')]
        if cells and cells != [''] and 'spinning' not in ' '.join(cells).lower():
            out.append(r)
    return out


def _wait_for_table_data(driver, timeout=None):
    """The report table's <th> headers render before its <tbody> actually
    has data (a 'Spinning...' placeholder row shows first) -- wait for
    real rows (or a confirmed-empty table) before reading anything."""
    timeout = timeout or config.WAIT_TIMEOUT

    def _ready(d):
        body_rows = d.find_elements(By.CSS_SELECTOR, 'table tbody tr')
        if not body_rows:
            return False
        text = ' '.join(r.text for r in body_rows).lower()
        return 'spinning' not in text

    WebDriverWait(driver, timeout).until(_safe(_ready))
    time.sleep(config.PAGE_LOAD_WAIT)


def _wait_for_expand(driver, row, timeout=None):
    """Poll until `row`'s detail <tr> (its immediate next sibling) has
    actually rendered its nested table(s) -- a real condition, not a
    guessed sleep. Wrapped in _safe() because the accordion swap (see
    _expand_file_names) can momentarily make the previous row's DOM
    stale while Vue re-renders."""
    timeout = timeout or config.WAIT_TIMEOUT

    def _ready(d):
        try:
            detail_tr = row.find_element(By.XPATH, 'following-sibling::tr[1]')
        except Exception:
            return False
        return len(detail_tr.find_elements(By.TAG_NAME, 'table')) > 0

    WebDriverWait(driver, timeout).until(_safe(_ready))


def _expand_file_names(driver, row):
    """Click the row's chevron to reveal the nested Record Versions /
    Supporting Documents tables and collect every FILENAME column value
    from both (combined, as before) plus -- when
    config.ENABLE_SUPPORTING_DOCUMENTS is on -- a structured per-document
    breakdown from the Supporting Documents table specifically.

    Does NOT collapse the row afterwards. Confirmed live (expanded row 1,
    then row 2 without collapsing row 1 first: the detail table count
    stayed at exactly one) that this list is an accordion -- only one
    row's detail can be expanded at a time, so expanding the NEXT row
    always collapses this one for free. Explicitly collapsing here was
    pure wasted round trips (a second click_when_ready + wait per row,
    roughly doubling this step's cost across a large batch); the very
    last row scraped on the very last page is simply left expanded,
    which is harmless since nothing reads it again.

    The site shows the full vault folder path (e.g. "MGN INDIA
    ATTACHMENTS/DMIN10030 - SOlus/Mashreq Agreement Solus.pdf") but the
    spec's own File Names example ("Ebix NDA - Bilateral (1) (1).pdf") is
    just the filename -- so we keep both: File Names gets the plain
    filename, File Path gets the full string as shown on the site.

    Returns (file_names, file_paths, supporting_docs):
      - file_names, file_paths: comma-joined strings (each possibly
        empty), combining both nested tables, in the same order.
      - supporting_docs: a list of dicts, one per row of the Supporting
        Documents table specifically (empty if the feature is disabled or
        the record has none):
            {'id', 'document_reference_id', 'filename', 'file_path',
             'status', 'error_message'}
        The two tables are told apart by their header set -- Supporting
        Documents has a 'DOCUMENT REFERENCE ID' column that Record
        Versions doesn't (confirmed live: Record Versions headers are ID/
        VERSION NUMBER/FILENAME/IS AI/IS FINAL SIGNED COPY/STATUS/ERROR
        MESSAGE; Supporting Documents' are ID/DOCUMENT REFERENCE ID/
        FILENAME/STATUS/ERROR MESSAGE) -- never by position, since either
        table can be empty/absent for a given record.

    The expansion renders as the record row's immediate next DOM sibling
    <tr> (a single colspan cell containing the two nested <table>s) --
    found via the XPath sibling axis so it's unambiguous even though a
    CSS `table tbody tr` query also matches the nested tables' own rows.
    """
    chevron = row.find_elements(By.CSS_SELECTOR, 'td')[0]
    click_when_ready(driver, chevron)
    _wait_for_expand(driver, row)

    names, paths = [], []
    supporting_docs = []
    try:
        detail_tr = row.find_element(By.XPATH, 'following-sibling::tr[1]')
        for tbl in detail_tr.find_elements(By.TAG_NAME, 'table'):
            headers = [th.text.strip().upper() for th in tbl.find_elements(By.CSS_SELECTOR, 'th')]
            if 'FILENAME' not in headers:
                continue
            fname_idx = headers.index('FILENAME')
            is_supporting = config.ENABLE_SUPPORTING_DOCUMENTS and 'DOCUMENT REFERENCE ID' in headers
            id_idx = headers.index('ID') if is_supporting and 'ID' in headers else None
            doc_ref_idx = headers.index('DOCUMENT REFERENCE ID') if is_supporting else None
            status_idx = headers.index('STATUS') if is_supporting and 'STATUS' in headers else None
            error_idx = headers.index('ERROR MESSAGE') if is_supporting and 'ERROR MESSAGE' in headers else None

            for tr in tbl.find_elements(By.CSS_SELECTOR, 'tbody tr'):
                tds = tr.find_elements(By.TAG_NAME, 'td')
                if len(tds) <= fname_idx:
                    continue
                val = tds[fname_idx].text.strip()
                if not val or val == '-':
                    continue
                name = val.replace('\\', '/').rsplit('/', 1)[-1]
                if val not in paths:
                    paths.append(val)
                if name and name not in names:
                    names.append(name)

                if is_supporting:
                    def _cell(idx):
                        return tds[idx].text.strip() if idx is not None and len(tds) > idx else ''
                    error_msg = _cell(error_idx)
                    if error_msg == '-':
                        error_msg = ''
                    supporting_docs.append({
                        'id': _cell(id_idx),
                        'document_reference_id': _cell(doc_ref_idx),
                        'filename': name,
                        'file_path': val,
                        'status': _cell(status_idx),
                        'error_message': error_msg,
                    })
    except Exception as e:
        logger.warning(f'could not read expanded file names: {e}')

    return ', '.join(names), ', '.join(paths), supporting_docs


def _goto_next_page(driver):
    """Bootstrap-vue pagination: a <ul class="pagination"> of <li
    class="page-item">. Click the enabled 'next' item if present.
    Returns True if it navigated to a new page."""
    candidates = driver.find_elements(By.CSS_SELECTOR, 'ul.pagination li.page-item')
    if not candidates:
        return False
    # Prefer the item explicitly labelled for "next" navigation.
    next_item = None
    for li in candidates:
        classes = (li.get_attribute('class') or '')
        label = (li.text or '').strip().lower()
        aria = ''
        try:
            aria = (li.find_element(By.TAG_NAME, 'button').get_attribute('aria-label') or '').lower()
        except Exception:
            pass
        if 'disabled' in classes:
            continue
        if 'next' in label or 'next' in aria or label in ('>', '»'):
            next_item = li
            break
    if next_item is None:
        return False
    try:
        btn = next_item.find_element(By.TAG_NAME, 'button')
    except Exception:
        return False
    before_text = [r.text for r in driver.find_elements(By.CSS_SELECTOR, 'table tbody tr')]
    click_when_ready(driver, btn)
    try:
        WebDriverWait(driver, config.WAIT_TIMEOUT).until(
            lambda d: [r.text for r in d.find_elements(By.CSS_SELECTOR, 'table tbody tr')] != before_text
        )
    except Exception:
        # Table content never visibly changed. collect_report_records()
        # dedupes by (BATCH ID, RECORD REFERENCE ID) so re-reading the
        # same page is harmless, and the MAX_REPORT_PAGES cap there stops
        # a genuinely stuck "next" control from looping forever -- but
        # this is worth knowing about, not silently swallowing.
        logger.warning('clicked next-page but table content did not change within timeout')
    human_delay(0.5, 1)
    return True


def _collect_report_records_dom(driver):
    """Walk every page of the currently-open Bulk Import Report table and
    return a list of dicts, one per record, with keys matching the table
    headers plus derived 'REQUEST_ID' (RECORD DETAILS number),
    'FILE_NAMES' (plain filenames) and 'FILE_PATHS' (full vault paths),
    both from the inline expand.

    DOM/click-based fallback used only if _find_all_rows_data() can't
    find the live Vue data model (see collect_report_records) -- kept
    working and unmodified from before that JS path existed so there's a
    real fallback, not just a comment claiming one exists."""
    records = []
    seen_keys = set()
    page = 1
    while True:
        _wait_for_table_data(driver)
        headers = _read_headers(driver)
        rows = _read_data_rows(driver)
        logger.info(f'report page {page}: {len(rows)} record row(s)')
        for row in rows:
            cells = [td.text.strip() for td in row.find_elements(By.CSS_SELECTOR, 'td')]
            if cells and cells[0] == '':
                cells = cells[1:]
            if len(cells) != len(headers):
                logger.warning(f'row/header length mismatch, skipping: {cells}')
                continue
            rec = dict(zip(headers, cells))

            dedupe_key = (rec.get('BATCH ID'), rec.get('RECORD REFERENCE ID'))
            if dedupe_key in seen_keys:
                continue
            seen_keys.add(dedupe_key)

            detail_link = None
            for a in row.find_elements(By.TAG_NAME, 'a'):
                if a.text.strip() == rec.get('RECORD DETAILS', ''):
                    detail_link = a
                    break
            # A Failed record has no Request ID at all -- RECORD DETAILS
            # shows a literal '-' with no link, confirmed on a real
            # failed import. Normalize that to '' rather than writing
            # the dash into the workbook as if it were a real value.
            details_val = rec.get('RECORD DETAILS', '').strip()
            rec['REQUEST_ID'] = '' if details_val == '-' else details_val
            rec['_detail_href'] = detail_link.get_attribute('href') if detail_link else None
            rec['FILE_NAMES'], rec['FILE_PATHS'], rec['SUPPORTING_DOCS'] = _expand_file_names(driver, row)
            records.append(rec)

        if not _goto_next_page(driver):
            break
        page += 1
        if page > config.MAX_REPORT_PAGES:
            logger.error(f'exceeded MAX_REPORT_PAGES ({config.MAX_REPORT_PAGES}) -- stopping pagination as a safety net')
            break
    return records


def _find_all_rows_data(driver, timeout=None):
    """Read the ENTIRE batch's row data directly from the live Vue
    component's reactive state via JS, instead of scraping the rendered
    table.

    Confirmed live (MSA_2302, 170-record batch, 2026-09-24): the
    '.cp-datatable' element's Vue instance (`el.__vue__`, Vue 2) has an
    ancestor component -- found by walking `.$parent` -- named
    'ViewBulkImport' whose data has an `allRows` array already
    containing EVERY record of the whole batch (confirmed length == 170,
    matching TOTAL COUNT, even though only 100 are ever rendered/paged
    into the DOM at once), complete with nested `recordVersions` and
    `supportingDocuments` arrays holding real filenames/status/
    errorMessage -- all already loaded before any row is expanded or any
    page beyond the first is visited. This is what makes "expand every
    row" fundamentally unnecessary: the data behind the accordion was
    never lazy-loaded per click in the first place, it's just a
    show/hide toggle over data that's already there.

    Field mapping (JS key -> table column), confirmed against a live
    row: id->REQUEST ITEM ID, batchId->BATCH ID,
    contractReferenceId->RECORD REFERENCE ID, statusName->STATUS,
    errorMessage->ERROR MESSAGE, requestId->RECORD DETAILS number.

    Returns the raw list of row dicts (JSON-safe, via
    JSON.parse(JSON.stringify(...)) so Selenium can transport it), or
    None if 'allRows' wasn't found within `timeout` (e.g. a future site
    update changes this component tree) -- callers fall back to
    _collect_report_records_dom() in that case rather than hard-fail the
    whole run on one internal-API assumption breaking.
    """
    timeout = timeout or config.WAIT_TIMEOUT
    try:
        container = WebDriverWait(driver, timeout).until(
            lambda d: d.find_element(By.CSS_SELECTOR, '.cp-datatable')
        )
    except Exception as e:
        logger.warning(f'could not find .cp-datatable to read allRows from: {e}')
        return None

    try:
        raw = driver.execute_script('''
            var el = arguments[0];
            var v = el.__vue__;
            var depth = 0;
            while (v && depth < 20) {
                if (Array.isArray(v.allRows)) {
                    return JSON.parse(JSON.stringify(v.allRows));
                }
                v = v.$parent;
                depth++;
            }
            return null;
        ''', container)
    except Exception as e:
        logger.warning(f'JS read of allRows failed: {e}')
        return None

    if not raw:
        logger.warning('allRows not found on the Vue component tree (site structure may have changed)')
        return None
    return raw


_PASCAL_CASE_SPLIT_RE = re.compile(r'(?<!^)(?=[A-Z])')
_KNOWN_STATUS_NAMES = {'New', 'In Progress', 'Partially Completed', 'Failed', 'Completed'}


def _normalize_status_name(raw):
    """The DOM's rendered STATUS column text ('Partially Completed', with
    a space) and the JS data model's `statusName` field (confirmed live:
    'PartiallyCompleted', no space -- a real, initially-missed mismatch
    that would have silently broken orchestrator.py's exact-string status
    branching) are NOT the same string. Only 'Completed' and
    'PartiallyCompleted' have been directly observed live (this batch had
    no New/In Progress/Failed records); 'In Progress' is inferred by
    applying the same PascalCase-with-spaces pattern the two confirmed
    values establish, not verified separately. Logs a warning (once per
    distinct value) if the result isn't one of the 5 statuses
    orchestrator.py actually recognizes, so a wrong guess surfaces
    immediately instead of silently misrouting records."""
    spaced = _PASCAL_CASE_SPLIT_RE.sub(' ', raw or '')
    if spaced not in _KNOWN_STATUS_NAMES:
        logger.warning(f"unrecognized status name from JS data model: raw={raw!r} -> {spaced!r} "
                        f"(expected one of {sorted(_KNOWN_STATUS_NAMES)}) -- check live before trusting this run's classification")
    return spaced


def _row_from_js(r):
    """Convert one raw allRows JS object into the same dict shape
    _collect_report_records_dom() has always produced, so orchestrator.py
    doesn't need to know or care which path collected the data."""
    request_id = r.get('requestId')
    # Falsy-safe: a Failed record has no request id at all on the DOM
    # (RECORD DETAILS shows a bare '-'), and we don't have a live Failed
    # example from this JS path to confirm its exact null/0/'' shape --
    # treating every falsy value the same way is the safe default,
    # matching the DOM path's own '-' -> '' normalization.
    request_id_str = str(request_id) if request_id else ''

    names, paths, supporting_docs = [], [], []

    for rv in (r.get('recordVersions') or []):
        val = (rv.get('fileName') or '').strip()
        if not val or val == '-':
            continue
        name = val.replace('\\', '/').rsplit('/', 1)[-1]
        if val not in paths:
            paths.append(val)
        if name and name not in names:
            names.append(name)

    for sd in (r.get('supportingDocuments') or []):
        val = (sd.get('documentName') or '').strip()
        name = val.replace('\\', '/').rsplit('/', 1)[-1] if val and val != '-' else ''
        if name:
            if val not in paths:
                paths.append(val)
            if name not in names:
                names.append(name)
        if config.ENABLE_SUPPORTING_DOCUMENTS:
            supporting_docs.append({
                'id': str(sd.get('id') or ''),
                'document_reference_id': str(sd.get('documentReferenceId') or ''),
                'filename': name,
                'file_path': val,
                'status': sd.get('statusName') or '',
                'error_message': sd.get('errorMessage') or '',
            })

    detail_href = f'{config.BASE_APP_URL}/#/contract-snapshot/{request_id_str}' if request_id_str else None

    return {
        'REQUEST ITEM ID': str(r.get('id') or ''),
        'BATCH ID': r.get('batchId') or '',
        'RECORD REFERENCE ID': str(r.get('contractReferenceId') or ''),
        'STATUS': _normalize_status_name(r.get('statusName')),
        'ERROR MESSAGE': r.get('errorMessage') or '',
        'REQUEST_ID': request_id_str,
        '_detail_href': detail_href,
        'FILE_NAMES': ', '.join(names),
        'FILE_PATHS': ', '.join(paths),
        'SUPPORTING_DOCS': supporting_docs,
    }


def collect_report_records(driver):
    """Return a list of dicts, one per record in the currently-open Bulk
    Import Report, with keys matching the table headers plus derived
    'REQUEST_ID' (RECORD DETAILS number), 'FILE_NAMES', 'FILE_PATHS' and
    'SUPPORTING_DOCS'.

    Tries the direct JS data-model read first (_find_all_rows_data) --
    confirmed live to return the whole batch, already including nested
    Record Versions/Supporting Documents data, in well under a second
    regardless of batch size, vs. minutes of click-and-paginate DOM
    scraping (measured ~3.5s/row before the accordion-collapse fix,
    ~1.2s/row after it, on a 170-record batch). Falls back to the
    DOM-scraping path if that data isn't found."""
    raw_rows = _find_all_rows_data(driver)
    if raw_rows is not None:
        logger.info(f'read {len(raw_rows)} record(s) directly from the live Vue data model (JS) '
                    '-- no clicking/pagination needed')
        seen_keys = set()
        records = []
        for r in raw_rows:
            rec = _row_from_js(r)
            key = (rec['BATCH ID'], rec['RECORD REFERENCE ID'])
            if key in seen_keys:
                continue
            seen_keys.add(key)
            records.append(rec)
        return records

    logger.warning('falling back to DOM-scraping (click/paginate/expand) for the report table')
    return _collect_report_records_dom(driver)


# ── Contract snapshot detail tab (Completed records only) ────────────────────

def confirm_and_get_record_id(driver, request_id):
    """Open contract-snapshot/<request_id> directly by URL in a new tab
    (not by finding-and-clicking a RECORD DETAILS link -- confirmed as a
    real bug: after collect_report_records() pages through a multi-page
    report, the driver is left on the LAST page, so a link for a record
    from an earlier page simply isn't present to click anymore. Since we
    already know the request_id, navigating straight there sidesteps
    report-page pagination state entirely), dismiss the AI-metadata modal
    if it appears, read 'Request ID: n | Record ID: m' from the page,
    confirm n == request_id, close the tab, and return m. Returns None if
    the header never appeared within the timeout."""
    original_window = driver.current_window_handle
    driver.switch_to.new_window('tab')
    driver.get(f"{config.BASE_APP_URL}/#/contract-snapshot/{request_id}")

    match = None
    deadline = time.time() + config.DETAIL_PAGE_TIMEOUT
    while time.time() < deadline:
        dismiss_ai_metadata_modal(driver)
        try:
            body = driver.find_element(By.TAG_NAME, 'body').text
        except Exception:
            body = ''
        match = HEADER_RE.search(body)
        if match:
            break
        time.sleep(2)

    driver.close()
    driver.switch_to.window(original_window)

    if not match:
        logger.error(f'never saw "Request ID: n | Record ID: n" header for request_id={request_id}')
        return None

    confirmed_request_id, record_id = match.group(1), match.group(2)
    if confirmed_request_id != str(request_id):
        logger.warning(
            f'confirmation mismatch: opened request_id={request_id} but '
            f'detail page shows Request ID={confirmed_request_id}'
        )
    return record_id


def confirm_many(driver, request_ids, max_tabs=None, retries=2):
    """Confirm several Completed records' Record IDs concurrently, as
    tabs within THIS ONE authenticated session -- never a second login
    (confirmed: this site invalidates a session's data-fetching the
    moment the same account logs in a second time, even from a totally
    separate browser; cookie injection into a second session doesn't
    authenticate it either). Measured ~1.3-1.7x speedup over calling
    confirm_and_get_record_id in a loop, with real record-to-record
    noise (the AI-metadata modal only appears on some records).

    Whatever times out gets retried as its own (smaller) follow-up batch,
    up to `retries` more attempts -- confirmed on a real 88-record run
    that a handful of records can hit a genuinely transient stuck-page
    load under concurrent strain, and a plain re-open a moment later
    succeeds fine. Retrying inside this one call (same login, same
    scraped data) is far cheaper than only picking stragglers up on a
    whole separate future pipeline run.

    Returns {request_id: record_id_or_None}; None means it never
    succeeded even after all retries.
    """
    results = {}
    to_try = list(request_ids)
    for attempt in range(retries + 1):
        if not to_try:
            break
        if attempt > 0:
            logger.info(f'retrying {len(to_try)} record(s) that timed out '
                        f'(attempt {attempt + 1}/{retries + 1})')
        round_results = _confirm_many_once(driver, to_try, max_tabs)
        results.update(round_results)
        to_try = [rid for rid, record_id in round_results.items() if record_id is None]
    return results


def _confirm_many_once(driver, request_ids, max_tabs=None):
    """One tab-pool pass over request_ids -- see confirm_many, which
    wraps this with retries for whatever times out."""
    max_tabs = max_tabs or config.MAX_CONCURRENT_TABS
    results = {}
    pending = list(request_ids)
    open_tabs = {}    # window_handle -> request_id
    opened_at = {}    # window_handle -> time.time() when opened
    original_window = driver.current_window_handle

    def open_next():
        if not pending:
            return
        rid = pending.pop(0)
        driver.switch_to.new_window('tab')
        driver.get(f"{config.BASE_APP_URL}/#/contract-snapshot/{rid}")
        handle = driver.current_window_handle
        open_tabs[handle] = rid
        opened_at[handle] = time.time()

    while pending and len(open_tabs) < max_tabs:
        open_next()

    while open_tabs:
        for handle in list(open_tabs.keys()):
            rid = open_tabs[handle]
            driver.switch_to.window(handle)
            dismiss_ai_metadata_modal(driver)
            try:
                body = driver.find_element(By.TAG_NAME, 'body').text
            except Exception:
                body = ''
            match = HEADER_RE.search(body)
            timed_out = (time.time() - opened_at[handle]) > config.DETAIL_PAGE_TIMEOUT
            if match or timed_out:
                if match:
                    confirmed_request_id, record_id = match.group(1), match.group(2)
                    if confirmed_request_id != str(rid):
                        logger.warning(
                            f'confirmation mismatch: opened request_id={rid} but '
                            f'detail page shows Request ID={confirmed_request_id}'
                        )
                    results[rid] = record_id
                else:
                    logger.error(f'request_id={rid}: never saw the header within '
                                 f'{config.DETAIL_PAGE_TIMEOUT}s -- giving up on it this run')
                    results[rid] = None
                driver.close()
                del open_tabs[handle]
                del opened_at[handle]
                # Must switch to a still-valid window before opening a
                # new one -- there's no context to open a new tab
                # "relative to" right after closing the active one.
                remaining = list(open_tabs.keys()) or [original_window]
                driver.switch_to.window(remaining[0])
                open_next()
        if open_tabs:
            time.sleep(1)

    driver.switch_to.window(original_window)
    return results
