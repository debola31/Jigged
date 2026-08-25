"""Enqueue: the only thing that creates work, and the caps on it.

A CLIENT-SUPPLIED page_count IS A SPEND MULTIPLIER. Fan-out mints one model call
per page from a single click, so an unverified count turns one button press into
hundreds of calls. Three things bound that, and each alone leaves a hole: a
server-side cap (a buggy client cannot ask for 500), a rate limit counted per
BATCH rather than per row (one package cannot exhaust an hourly cap by itself),
and worker-side reconciliation against the real page count (the cap still trusts
the number until someone opens the file).
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from services import ai_jobs
from services.llm.errors import LLMNotConfigured

pytestmark = pytest.mark.unit


class FakeTable:
    def __init__(self, db, name):
        self._db, self._name = db, name
        self._rows = []

    def insert(self, rows):
        self._rows = rows if isinstance(rows, list) else [rows]
        self._db.inserted.setdefault(self._name, []).extend(self._rows)
        return self

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a):
        return self

    def gte(self, *_a):
        return self

    def execute(self):
        if self._rows:
            return type("R", (), {"data": [{**r, "id": f"job-{i}", "status": "queued"}
                                           for i, r in enumerate(self._rows)]})()
        return type("R", (), {"data": self._db.rows.get(self._name, [])})()


class FakeDb:
    def __init__(self, rows=None):
        self.rows = rows or {}
        self.inserted: dict[str, list] = {}

    def table(self, name):
        return FakeTable(self, name)

    def rpc(self, *_a, **_k):
        return type("R", (), {"execute": lambda s=None: type("X", (), {"data": 0})()})()


@pytest.fixture
def worker_chain():
    """A feature routed to the desktop, with a live worker serving its model."""
    with patch.object(ai_jobs, "resolve_execution", return_value=("drawings", "worker", "qwen3-vl:4b")), \
         patch.object(ai_jobs, "worker_can_serve", return_value=True):
        yield


@pytest.fixture
def backend_chain():
    with patch.object(ai_jobs, "resolve_execution", return_value=("insights", "backend", "claude-sonnet-4-6")):
        yield


class TestFanOut:
    @pytest.mark.parametrize("pages", [1, 2, 12, 60])
    def test_one_job_is_created_per_page(self, pages, worker_chain):
        db = FakeDb()
        rows = ai_jobs.enqueue(db, company_id="co", feature="drawings",
                               payload={"path": "p.pdf"}, page_count=pages)
        assert len(rows) == pages
        created = db.inserted["ai_jobs"]
        assert [r["payload"]["page_number"] for r in created] == list(range(1, pages + 1)) \
            if pages > 1 else True

    def test_the_pages_of_one_package_share_a_batch_key(self, worker_chain):
        db = FakeDb()
        ai_jobs.enqueue(db, company_id="co", feature="drawings",
                        payload={"path": "p.pdf"}, page_count=12)
        keys = {r["batch_key"] for r in db.inserted["ai_jobs"]}
        assert len(keys) == 1 and None not in keys

    def test_a_single_page_job_has_no_batch_key(self, worker_chain):
        """batch_key is what the claim groups on and what the UI counts "3 of 12"
        against. A lone job is not a batch, and giving it a key would make every
        insights question look like one."""
        db = FakeDb()
        ai_jobs.enqueue(db, company_id="co", feature="drawings", payload={}, page_count=1)
        assert db.inserted["ai_jobs"][0]["batch_key"] is None

    def test_each_page_gets_its_own_request_id(self, worker_chain):
        """Each page is a separate logical call with its own ai_calls rows, so
        sharing one request_id across twelve pages would make per-call cost
        unrecoverable. batch_key is what ties them together."""
        db = FakeDb()
        ai_jobs.enqueue(db, company_id="co", feature="drawings", payload={}, page_count=5)
        ids = {r["request_id"] for r in db.inserted["ai_jobs"]}
        assert len(ids) == 5

    def test_a_page_count_past_the_cap_is_refused_and_mints_nothing(self, worker_chain):
        db = FakeDb()
        with pytest.raises(ValueError) as exc:
            ai_jobs.enqueue(db, company_id="co", feature="drawings", payload={},
                            page_count=ai_jobs.MAX_FAN_OUT + 1)
        assert "cap" in str(exc.value)
        assert db.inserted == {}, "a refused enqueue must create nothing"

    def test_the_cap_is_generous_enough_for_a_real_package(self, worker_chain):
        """60 pages. A real drawing package runs to about 31 parts, and a single PDF
        longer than 60 pages is a manual rather than a print."""
        db = FakeDb()
        assert len(ai_jobs.enqueue(db, company_id="co", feature="drawings",
                                   payload={}, page_count=60)) == 60

    def test_zero_or_negative_pages_is_refused(self, worker_chain):
        db = FakeDb()
        for bad in (0, -1):
            with pytest.raises(ValueError):
                ai_jobs.enqueue(db, company_id="co", feature="drawings", payload={}, page_count=bad)

    def test_a_fanned_out_batch_cannot_be_routed_to_the_inline_executor(self, backend_chain):
        """N inline Anthropic calls inside one 60s Vercel wall is not slow, it is
        fatal. A CHECK on the table enforces this too; raising here makes it a clean
        501 rather than a constraint violation."""
        db = FakeDb()
        with pytest.raises(LLMNotConfigured) as exc:
            ai_jobs.enqueue(db, company_id="co", feature="insights", payload={}, page_count=4)
        assert "one job per request" in str(exc.value)
        assert db.inserted == {}


class TestOfflineAndPriority:
    def test_an_offline_box_creates_no_row(self):
        """Checked BEFORE anything is written, so a dead worker leaves nothing to
        poll -- rather than a job that sits queued until the sweep while the user
        watches a spinner."""
        db = FakeDb()
        with patch.object(ai_jobs, "resolve_execution", return_value=("insights", "worker", "qwen3:8b")), \
             patch.object(ai_jobs, "worker_can_serve", return_value=False):
            with pytest.raises(ai_jobs.AiUnavailable):
                ai_jobs.enqueue(db, company_id="co", feature="insights", payload={})
        assert db.inserted == {}

    def test_a_backend_job_is_never_gated_on_a_worker_heartbeat(self, backend_chain):
        """No worker will ever advertise claude-sonnet-4-6. Gating an inline job on
        one would make every unmigrated surface permanently offline."""
        db = FakeDb()
        with patch.object(ai_jobs, "worker_can_serve", return_value=False) as can_serve:
            rows = ai_jobs.enqueue(db, company_id="co", feature="insights", payload={})
        can_serve.assert_not_called()
        assert len(rows) == 1

    def test_an_interactive_feature_outranks_a_batch_one(self, backend_chain):
        """Nothing preempts unless something assigns priority. The claim orders by
        it before its resident-model tie-break, so this value is what buys an
        insights question a model swap ahead of a drawing package."""
        db = FakeDb()
        ai_jobs.enqueue(db, company_id="co", feature="insights", payload={})
        assert db.inserted["ai_jobs"][0]["priority"] == ai_jobs.PRIORITY_INTERACTIVE

    def test_a_batch_feature_takes_the_lower_priority(self, worker_chain):
        db = FakeDb()
        ai_jobs.enqueue(db, company_id="co", feature="drawings", payload={}, page_count=3)
        assert {r["priority"] for r in db.inserted["ai_jobs"]} == {ai_jobs.PRIORITY_BATCH}

    def test_a_dev_profile_feature_keeps_its_interactive_priority(self):
        """resolve_feature turns insights into insights_dev under LLM_PROFILE=dev,
        and a naive exact-match would silently demote it to batch priority."""
        db = FakeDb()
        with patch.object(ai_jobs, "resolve_execution",
                          return_value=("insights_dev", "worker", "qwen3:8b")), \
             patch.object(ai_jobs, "worker_can_serve", return_value=True):
            ai_jobs.enqueue(db, company_id="co", feature="insights", payload={})
        assert db.inserted["ai_jobs"][0]["priority"] == ai_jobs.PRIORITY_INTERACTIVE

    def test_only_a_backend_row_carries_a_deadline(self, backend_chain, worker_chain):
        """A worker row's deadline is heartbeat staleness, never a clock -- a fixed
        TTL would sweep the back half of a healthy long batch."""
        db = FakeDb()
        with patch.object(ai_jobs, "resolve_execution",
                          return_value=("insights", "backend", "claude-sonnet-4-6")):
            ai_jobs.enqueue(db, company_id="co", feature="insights", payload={})
        assert db.inserted["ai_jobs"][0]["expires_at"] is not None

        db2 = FakeDb()
        with patch.object(ai_jobs, "resolve_execution",
                          return_value=("drawings", "worker", "qwen3-vl:4b")), \
             patch.object(ai_jobs, "worker_can_serve", return_value=True):
            ai_jobs.enqueue(db2, company_id="co", feature="drawings", payload={})
        assert db2.inserted["ai_jobs"][0]["expires_at"] is None


class TestRateLimitAccounting:
    def test_a_fanned_out_package_counts_as_one_unit_not_forty(self):
        """Counting rows would let a single import exhaust an hourly cap on its own,
        which would make the drawings surface unusable the first time anyone tried
        it on a real package."""
        rows = [{"id": f"j{i}", "batch_key": "pkg-1", "created_at": "now"} for i in range(40)]
        assert ai_jobs.count_recent(FakeDb({"ai_jobs": rows}), "co", "drawings") == 1

    def test_separate_questions_count_separately(self):
        rows = [{"id": f"j{i}", "batch_key": None, "created_at": "now"} for i in range(3)]
        assert ai_jobs.count_recent(FakeDb({"ai_jobs": rows}), "co", "insights") == 3

    def test_a_mix_counts_batches_once_and_singles_each(self):
        rows = [
            {"id": "a", "batch_key": "pkg", "created_at": "n"},
            {"id": "b", "batch_key": "pkg", "created_at": "n"},
            {"id": "c", "batch_key": None, "created_at": "n"},
        ]
        assert ai_jobs.count_recent(FakeDb({"ai_jobs": rows}), "co", "drawings") == 2
