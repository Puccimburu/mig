
import os
import csv
import shutil
import logging
from datetime import datetime

import config

logger = logging.getLogger(__name__)

CSV_FIELDS = [
    'timestamp', 'record_reference_id', 'request_id', 'record_id',
    'file_names', 'file_path', 'status', 'error_message', 'detail_url',
]


def new_run_paths():
    """Create output/<timestamp>/ for this run and ensure output/latest/
    exists (cleared so it only ever holds the current run's files)."""
    run_id = datetime.now().strftime('%Y%m%d_%H%M%S')
    run_dir = os.path.join(config.OUTPUT_DIR, run_id)
    latest_dir = os.path.join(config.OUTPUT_DIR, 'latest')
    os.makedirs(run_dir, exist_ok=True)
    if os.path.isdir(latest_dir):
        for name in os.listdir(latest_dir):
            p = os.path.join(latest_dir, name)
            if os.path.isfile(p):
                os.remove(p)
    else:
        os.makedirs(latest_dir, exist_ok=True)
    return run_id, run_dir, latest_dir


def setup_logging(run_id):
    """Console + a fresh per-run log file, both at INFO by default.

    Note: undetected_chromedriver's own logger (name "uc") resets itself
    to match the ROOT logger's effective level the moment it's imported
    (`logger.setLevel(logging.getLogger().getEffectiveLevel())` in its
    __init__.py) -- so root cannot be left at DEBUG "just for our file
    handler" without also reopening the flood of per-HTTP-command
    Selenium/urllib3/uc debug lines that drowns out our own log lines
    (confirmed: one run produced a 2MB log file this way). We don't use
    logger.debug() ourselves, so there's nothing lost by keeping root at
    INFO. Set VERBOSE_SELENIUM_LOGS=true to opt into full DEBUG transport
    logging when actually diagnosing a driver/network issue.
    """
    log_path = os.path.join(config.LOGS_DIR, f'{run_id}.log')
    verbose = os.environ.get('VERBOSE_SELENIUM_LOGS', 'false').lower() == 'true'
    level = logging.DEBUG if verbose else logging.INFO

    root = logging.getLogger()
    root.setLevel(level)

    fmt = logging.Formatter('%(asctime)s  %(levelname)-8s  %(name)s  %(message)s',
                             datefmt='%Y-%m-%d %H:%M:%S')

    file_handler = logging.FileHandler(log_path, encoding='utf-8')
    file_handler.setLevel(level)
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(fmt)
    root.addHandler(console_handler)

    return log_path


class CsvReport:
    """Appends one row per record as it's processed and flushes
    immediately, so the report is genuinely real-time / crash-safe. Also
    keeps output/latest/<name> in sync after every write."""

    def __init__(self, run_dir, latest_dir, filename='detailed_report.csv'):
        self.run_path = os.path.join(run_dir, filename)
        self.latest_path = os.path.join(latest_dir, filename)
        self._fh = open(self.run_path, 'w', newline='', encoding='utf-8-sig')
        self._writer = csv.DictWriter(self._fh, fieldnames=CSV_FIELDS)
        self._writer.writeheader()
        self._fh.flush()

    def add(self, *, record_reference_id, request_id, record_id, file_names, file_path,
             status, detail_url, error_message=''):
        self._writer.writerow({
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'record_reference_id': record_reference_id,
            'request_id': request_id or '',
            'record_id': record_id or '',
            'file_names': file_names or '',
            'file_path': file_path or '',
            'status': status or '',
            'error_message': error_message or '',
            'detail_url': detail_url or '',
        })
        self._fh.flush()
        os.fsync(self._fh.fileno())
        shutil.copyfile(self.run_path, self.latest_path)

    def close(self):
        self._fh.close()


def snapshot_workbook(src_path, run_dir, latest_dir):
    """Copy the (possibly still-partial) edited workbook into this run's
    output folders."""
    name = os.path.basename(src_path)
    run_copy = os.path.join(run_dir, name)
    shutil.copyfile(src_path, run_copy)
    shutil.copyfile(src_path, os.path.join(latest_dir, name))
    return run_copy


def cleanup_input(path):
    """Remove a fully-processed workbook from input/ so it isn't
    reprocessed. Only called once every target cell is populated -- a
    partially-processed file is deliberately left in place so the next
    run resumes it (the workbook itself is the checkpoint)."""
    try:
        os.remove(path)
        logger.info(f'removed fully-processed input file: {path}')
    except OSError as e:
        logger.warning(f'could not remove processed input file {path}: {e}')
