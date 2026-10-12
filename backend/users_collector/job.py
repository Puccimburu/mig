"""
Collect the CLM users list for the web app.

    python job.py <job_dir>  < settings.json

Settings (JSON on stdin): url, username, password, headless (bool).
Writes <job_dir>/output/latest/users.xlsx.
See backend/job_runtime.py for the stdin/stdout protocol.
"""
import os
import sys

sys.path.insert(1, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from job_runtime import apply_site_settings, run, use_job_dirs  # noqa: E402


def configure(config, job_dir, settings):
    apply_site_settings(config, settings)
    use_job_dirs(config, job_dir, names=('OUTPUT_DIR', 'LOGS_DIR', 'DEBUG_DIR'))


if __name__ == '__main__':
    sys.exit(run(configure))
