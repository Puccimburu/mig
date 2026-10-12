"""
Shared plumbing for the per-run entry points (request_id/job.py, users_collector/job.py).

A run reads its settings as one JSON object on stdin (never argv/env/disk, since it
holds the CLM password) and reports on stdout as JSON lines: {"type": "log", ...} per
log record, then one {"type": "result", ...}. backend/jobs.py reads those lines.
"""
import json
import logging
import os
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, default=str) + '\n')
    sys.stdout.flush()


class JsonLineHandler(logging.Handler):
    def emit(self, record):
        try:
            emit({
                'type': 'log',
                'level': record.levelname,
                'logger': record.name,
                'message': record.getMessage(),
                'time': record.created,
            })
        except Exception:
            self.handleError(record)


def apply_site_settings(config, settings):
    """CLM login and browser settings shared by every scraper's config module."""
    url = str(settings.get('url') or '').strip()
    config.SITE_URL = url
    config.SITE_USERNAME = str(settings.get('username') or '')
    config.SITE_PASSWORD = str(settings.get('password') or '')
    config.BASE_APP_URL = url.rsplit('/', 1)[0] if url else ''
    config.HEADLESS_MODE = bool(settings.get('headless', False))


def use_job_dirs(config, job_dir, names=('INPUT_DIR', 'OUTPUT_DIR', 'LOGS_DIR', 'DEBUG_DIR')):
    """Point the config's folders at subfolders of this run's folder."""
    for name in names:
        path = os.path.join(job_dir, name[:-4].lower())
        setattr(config, name, path)
        os.makedirs(path, exist_ok=True)


def run(configure):
    """Entry point body: python job.py <job_dir> < settings.json

    `configure(config, job_dir, settings)` applies the settings to the module's config;
    then the module's orchestrator.main() runs and its result is emitted.
    """
    if len(sys.argv) != 2:
        print('usage: python job.py <job_dir>  < settings.json', file=sys.stderr)
        return 2
    job_dir = os.path.abspath(sys.argv[1])
    settings = json.loads(sys.stdin.read() or '{}')

    import config
    configure(config, job_dir, settings)
    del settings  # nothing below needs the raw settings (or the password in them)

    # orchestrator's setup_logging() adds console/file handlers too; the console one
    # only duplicates our lines on stderr. Ours goes first so every record is seen.
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(JsonLineHandler())

    import orchestrator
    try:
        result = orchestrator.main()
    except Exception as e:  # orchestrators catch their own errors; this is a last resort
        logging.getLogger('job').exception('run crashed')
        result = {'success': False, 'errors': [str(e)]}
    emit({'type': 'result', **result})
    return 0 if result.get('success') else 1
