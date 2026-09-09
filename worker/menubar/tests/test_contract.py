"""The writer and the reader are separate modules; this is what keeps them honest.

worker/status.py writes the document and worker/menubar/statusfile.py reads it.
They duplicate the path and the schema number rather than sharing them, because
importing worker.status is fine but worker/__main__.py drags psycopg2 and the
whole provider layer, and the indicator must stay able to run when the worker's
dependencies cannot. Duplication is acceptable only while something checks it.
"""
from __future__ import annotations

from pathlib import Path

from worker import status as writer
from worker.menubar import state as st
from worker.menubar import statusfile as reader
from worker.menubar.launchctl import Service


def test_both_sides_name_the_same_file() -> None:
    assert writer.DEFAULT_PATH == reader.DEFAULT_PATH


def test_both_sides_agree_on_the_schema_number() -> None:
    assert writer.SCHEMA == reader.SCHEMA


def test_both_sides_honour_the_same_override() -> None:
    """Otherwise a test isolating one of them would silently not isolate the other."""
    import os
    os.environ["JIGGED_STATUS_FILE"] = "/tmp/contract-probe.json"
    try:
        assert writer.path() == reader.path()
    finally:
        del os.environ["JIGGED_STATUS_FILE"]


def test_a_real_document_survives_the_round_trip(tmp_path: Path) -> None:
    """Write with the worker's own snapshot(), read with the indicator's parser.

    This is the test that makes the two-module split safe: a field renamed on one
    side and not the other fails here rather than in a menu bar that quietly stops
    showing something.
    """
    doc = writer.snapshot(
        worker_id="macbook-1", version="1", models=["qwen3:32b"],
        resident_model="qwen3:32b", ollama_base_url="http://localhost:11434/v1",
        heartbeat_seconds=15, repo=Path("/repo"), commit="abc123",
        started_at="2026-09-09T11:00:00+00:00",
        databases=[
            {"ref": "p", "label": "production", "is_default": True,
             "reachable": True, "last_ok_at": "2026-09-09T11:59:56+00:00", "error": None},
            {"ref": "b", "label": "feature/x", "is_default": False,
             "reachable": False, "last_ok_at": None, "error": "ENOTFOUND"},
        ],
        busy=True, held=2,
        last_job={"job_id": "j", "feature": "insights", "model": "qwen3:32b", "seconds": 19.8},
    )
    dest = tmp_path / "s.json"
    writer.write(doc, dest)

    back = reader.load(dest)
    assert back is not None, "the reader rejected a document the writer just produced"
    assert reader.production(back)["label"] == "production"
    assert len(reader.databases(back)) == 2

    # And it must survive all the way to a rendered indicator.
    svc = Service(loaded=True, state="running", pid=back["pid"], runs=1,
                  last_exit=0, disabled=False)
    ind = st.derive(svc, back)
    assert ind.state == st.BUSY and ind.title == "2"
