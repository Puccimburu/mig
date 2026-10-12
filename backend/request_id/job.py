"""
Run one Request ID population for the web app.

    python job.py <job_dir>  < settings.json

Settings arrive as one JSON object on stdin (never argv/env/disk, since it
holds the CLM password):
    url, username, password, uploaded_on, total_count,
    template (optional), supporting_docs (bool), headless (bool)

The workbook to fill must already be in <job_dir>/input/. Progress is
written to stdout as JSON lines: {"type": "log", ...} per log record, then
one {"type": "result", ...} with orchestrator.main()'s result.
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


def apply_settings(config, job_dir, settings):
    """Point config at this job's folders and the settings from the UI.
    Every module reads config.X at call time, so overriding here is enough
    (and bypasses config.py's .env lookup and the Windows USERNAME clash)."""
    url = str(settings.get('url') or '').strip()
    config.SITE_URL = url
    config.SITE_USERNAME = str(settings.get('username') or '')
    config.SITE_PASSWORD = str(settings.get('password') or '')
    config.BASE_APP_URL = url.rsplit('/', 1)[0] if url else ''
    config.UPLOADED_ON = str(settings.get('uploaded_on') or '').strip()
    config.TOTAL_COUNT = str(settings.get('total_count') or '').strip()
    config.BULK_IMPORT_TEMPLATE = str(settings.get('template') or '').strip()
    config.ENABLE_SUPPORTING_DOCUMENTS = bool(settings.get('supporting_docs', True))
    config.HEADLESS_MODE = bool(settings.get('headless', False))

    config.INPUT_DIR = os.path.join(job_dir, 'input')
    config.OUTPUT_DIR = os.path.join(job_dir, 'output')
    config.LOGS_DIR = os.path.join(job_dir, 'logs')
    config.DEBUG_DIR = os.path.join(job_dir, 'debug')
    for d in (config.INPUT_DIR, config.OUTPUT_DIR, config.LOGS_DIR, config.DEBUG_DIR):
        os.makedirs(d, exist_ok=True)


def main():
    if len(sys.argv) != 2:
        print('usage: python job.py <job_dir>  < settings.json', file=sys.stderr)
        return 2
    job_dir = os.path.abspath(sys.argv[1])
    settings = json.loads(sys.stdin.read() or '{}')

    import config
    apply_settings(config, job_dir, settings)
    del settings  # nothing below needs the raw settings (or the password in them)

    # file_generator.setup_logging() adds its own console/file handlers to the
    # root logger; the console one would duplicate our JSON lines on stderr,
    # which is harmless. Ours goes first so the web app sees every record.
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(JsonLineHandler())

    import orchestrator
    try:
        result = orchestrator.main()
    except Exception as e:  # orchestrator catches its own errors; this is a last resort
        logging.getLogger('job').exception('run crashed')
        result = {'success': False, 'errors': [str(e)]}
    emit({'type': 'result', **result})
    return 0 if result.get('success') else 1


if __name__ == '__main__':
    sys.exit(main())
