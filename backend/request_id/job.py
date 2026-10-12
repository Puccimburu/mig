"""
Run one Request ID population for the web app.

    python job.py <job_dir>  < settings.json

Settings (JSON on stdin): url, username, password, uploaded_on, total_count,
template (optional), supporting_docs (bool), headless (bool).
The workbook to fill must already be in <job_dir>/input/.
See backend/job_runtime.py for the stdin/stdout protocol.
"""
import os
import sys

sys.path.insert(1, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from job_runtime import apply_site_settings, run, use_job_dirs  # noqa: E402


def configure(config, job_dir, settings):
    """Every module reads config.X at call time, so overriding here is enough (and
    bypasses config.py's .env lookup and the Windows USERNAME clash)."""
    apply_site_settings(config, settings)
    config.UPLOADED_ON = str(settings.get('uploaded_on') or '').strip()
    config.TOTAL_COUNT = str(settings.get('total_count') or '').strip()
    config.BULK_IMPORT_TEMPLATE = str(settings.get('template') or '').strip()
    config.ENABLE_SUPPORTING_DOCUMENTS = bool(settings.get('supporting_docs', True))
    use_job_dirs(config, job_dir)


if __name__ == '__main__':
    sys.exit(run(configure))
