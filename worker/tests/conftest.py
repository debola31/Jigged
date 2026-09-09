"""Suite-wide guards for the worker tests.

There is one, and it exists because a test already escaped into a real user path.
When Worker gained a status file, `_publish()` started firing from _keepalive,
_run_one and _shutdown -- all of which test_worker_loop.py drives -- and the suite
promptly overwrote ~/Library/Application Support/Jigged/worker-status.json with
fixture data (worker_id "desktop-1", a job called "job-1"). Every test still
passed, because nothing asserted on the file; the damage was to the developer's
own box, where a menu bar reading that file would have shown a worker that does
not exist.

Redirecting the path here rather than in the tests that happen to trip it is the
point: the next test to construct a Worker inherits the protection without knowing
it needs it.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolate_status_file(tmp_path, monkeypatch):
    """No worker test may write to the real status file."""
    monkeypatch.setenv("JIGGED_STATUS_FILE", str(tmp_path / "worker-status.json"))
