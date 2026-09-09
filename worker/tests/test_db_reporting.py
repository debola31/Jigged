"""Reporting an outcome must never resurrect a row the sweep already closed.

A laptop that sleeps mid-job resumes the frozen Ollama call on wake and usually
completes it -- minutes after its lease lapsed and sweep_ai_jobs() marked the row
timed_out. An unguarded UPDATE then flipped a terminal row back to succeeded,
behind a UI that had already told the user the question failed. Both report
statements now touch only a row that is still claimed or running, and say so in
the log when they find nothing to touch.
"""
from __future__ import annotations

import json
import logging

from worker.db import WorkerDb


class _Cursor:
    def __init__(self, rowcount: int) -> None:
        self.rowcount = rowcount
        self.executed: list[tuple[str, tuple]] = []

    def execute(self, sql: str, params: tuple = ()) -> None:
        self.executed.append((sql, params))

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> bool:
        return False


class _Conn:
    closed = False

    def __init__(self, cursor: _Cursor) -> None:
        self._cursor = cursor

    def cursor(self, cursor_factory=None):
        return self._cursor


def _db(rowcount: int) -> tuple[WorkerDb, _Cursor]:
    db = WorkerDb("postgresql://unused")
    cur = _Cursor(rowcount)
    db._conn = _Conn(cur)
    return db, cur


def test_mark_succeeded_touches_only_a_row_still_in_flight():
    db, cur = _db(rowcount=1)

    db.mark_succeeded("job-1", {"answer": "x"})

    sql, params = cur.executed[0]
    assert "status = 'succeeded'" in sql
    assert "status IN ('claimed', 'running')" in sql
    assert params[-1] == "job-1"


def test_mark_failed_touches_only_a_row_still_in_flight():
    db, cur = _db(rowcount=1)

    db.mark_failed("job-1", "boom", "internal")

    sql, params = cur.executed[0]
    assert "status = 'failed'" in sql
    assert "status IN ('claimed', 'running')" in sql
    assert params == ("boom", "internal", "job-1")


def test_a_report_that_finds_no_in_flight_row_warns_instead_of_writing(caplog):
    """The sweep won; the log says so rather than the row silently changing."""
    db, _ = _db(rowcount=0)

    with caplog.at_level(logging.WARNING, logger="worker.db"):
        db.mark_succeeded("job-1", {"answer": "x"})
        db.mark_failed("job-1", "boom", "internal")

    assert caplog.text.count("already terminal") == 2


def test_mark_succeeded_re_kinds_the_row_only_when_told_to():
    """A question the model answered by composing a report settles as one (the
    caller passes result_kind(result)); None leaves the column as enqueued."""
    db, cur = _db(rowcount=1)

    db.mark_succeeded("job-1", {"kind": "report", "report": {}}, "report")
    db.mark_succeeded("job-2", {"answer": "x"})

    sql, params = cur.executed[0]
    assert "kind = COALESCE(%s, kind)" in sql
    assert params == (json.dumps({"kind": "report", "report": {}}), "report", "job-1")
    assert cur.executed[1][1] == (json.dumps({"answer": "x"}), None, "job-2")
