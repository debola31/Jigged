"""The status file must be honest about production, and must never take the box down.

Two properties earn these tests. First, `reachable` is PRODUCTION's verdict and not
an aggregate over every database served: 79 of 132 heartbeat failures in a measured
19-hour window were dead preview branches, so an aggregate would sit amber almost
permanently for a reason no shop can feel. Second, publishing is best-effort -- a
full disk or a bad permission on a convenience file is not a reason to stop
answering questions, so write() swallows OSError and the loop never learns.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from worker import status as worker_status


def _db(ref: str, *, default: bool, reachable: bool, last_ok: str | None = None) -> dict:
    return {
        "ref": ref, "label": ref, "is_default": default,
        "reachable": reachable, "last_ok_at": last_ok, "error": None if reachable else "boom",
    }


def _snap(databases: list[dict], **over) -> dict:
    kwargs = dict(
        worker_id="macbook-1", version="1", models=["qwen3:32b"],
        resident_model="qwen3:32b", ollama_base_url="http://localhost:11434/v1",
        heartbeat_seconds=15, repo=Path("/repo"), commit="abc1234",
        started_at="2026-09-09T10:00:00+00:00", databases=databases,
        busy=False, held=0,
    )
    kwargs.update(over)
    return worker_status.snapshot(**kwargs)


class TestProductionIsTheVerdict:
    def test_a_dead_preview_branch_does_not_make_the_box_unreachable(self) -> None:
        """The failure that dominates the log must not read as the failure that matters."""
        snap = _snap([_db("prod", default=True, reachable=True),
                      _db("dead-preview", default=False, reachable=False)])
        assert snap["reachable"] is True

    def test_production_down_is_unreachable_even_when_every_branch_is_fine(self) -> None:
        snap = _snap([_db("prod", default=True, reachable=False),
                      _db("preview", default=False, reachable=True)])
        assert snap["reachable"] is False

    def test_no_production_row_is_not_reachable(self) -> None:
        """Absence is not health. Serving nothing must never render as serving well."""
        assert _snap([_db("preview", default=False, reachable=True)])["reachable"] is False


class TestSchema:
    def test_it_carries_no_staleness_threshold(self) -> None:
        """The 60s offline rule is pinned elsewhere and this must not become a copy.

        `reachable` is "did the last beat land", which needs no clock. If a future
        reader wants the product's verdict it must cite the real constant, not find
        a number here and trust it.
        """
        snap = _snap([_db("prod", default=True, reachable=True)])
        assert "stale_after_s" not in snap
        assert not any("stale" in k for k in snap)

    def test_it_records_the_commit_it_was_given_not_the_one_on_disk(self) -> None:
        """The gap between the two IS the forgot-to-restart bug; snapshot must not close it."""
        assert _snap([], commit="deadbee")["commit"] == "deadbee"

    def test_pid_is_this_process(self) -> None:
        assert _snap([])["pid"] == os.getpid()

    def test_a_finished_job_survives_into_the_document(self) -> None:
        job = {"job_id": "abc", "feature": "insights", "model": "qwen3:32b", "seconds": 19.8}
        assert _snap([], last_job=job)["last_job"] == job


class TestWrite:
    def test_it_round_trips(self, tmp_path: Path) -> None:
        dest = tmp_path / "nested" / "status.json"
        snap = _snap([_db("prod", default=True, reachable=True, last_ok="2026-09-09T11:00:00+00:00")])
        worker_status.write(snap, dest)
        assert json.loads(dest.read_text()) == snap

    def test_it_leaves_no_temp_files_behind(self, tmp_path: Path) -> None:
        """A reader globbing the directory must not trip over debris."""
        dest = tmp_path / "status.json"
        for _ in range(3):
            worker_status.write(_snap([]), dest)
        assert [p.name for p in tmp_path.iterdir()] == ["status.json"]

    def test_a_reader_never_sees_a_half_written_document(self, tmp_path: Path) -> None:
        """Replace is atomic, so the previous document stands until the new one is whole."""
        dest = tmp_path / "status.json"
        worker_status.write(_snap([], commit="first"), dest)
        worker_status.write(_snap([], commit="second"), dest)
        assert json.loads(dest.read_text())["commit"] == "second"

    def test_an_unwritable_destination_is_swallowed(self, tmp_path: Path) -> None:
        """THE POINT: losing this file must never propagate into the worker loop."""
        locked = tmp_path / "locked"
        locked.mkdir()
        locked.chmod(0o500)
        try:
            worker_status.write(_snap([]), locked / "status.json")  # must not raise
        finally:
            locked.chmod(0o700)

    def test_an_unserialisable_payload_raises_but_leaves_no_debris(
        self, tmp_path: Path
    ) -> None:
        """Only OSError is swallowed, and that asymmetry is deliberate.

        A full disk is the environment failing and must not reach the loop. A
        payload json cannot encode is THIS code being wrong, and a silent status
        file that stopped updating is exactly the wedged state the reader is meant
        to detect -- so it surfaces. Either way the temp file is cleaned up.
        """
        dest = tmp_path / "status.json"
        with pytest.raises(TypeError):
            worker_status.write({"bad": object()}, dest)
        assert not dest.exists()
        assert list(tmp_path.iterdir()) == []


class TestPath:
    def test_the_env_var_wins(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setenv("JIGGED_STATUS_FILE", str(tmp_path / "x.json"))
        assert worker_status.path() == tmp_path / "x.json"

    def test_the_default_is_not_the_log_directory(self, monkeypatch) -> None:
        """Logs are an append sink a rotation may clear; state does not live there."""
        monkeypatch.delenv("JIGGED_STATUS_FILE", raising=False)
        assert "Library/Logs" not in str(worker_status.path())


class TestTheSuiteCannotEscape:
    """A regression guard for the conftest fixture, not for status.py.

    The first run of these tests wrote fixture data over the real file in
    ~/Library/Application Support. Nothing failed, because nothing was looking.
    This looks.
    """

    def test_the_autouse_fixture_redirects_the_path(self, tmp_path: Path) -> None:
        assert worker_status.path().parent == tmp_path

    def test_no_test_can_reach_the_real_location(self) -> None:
        assert "Application Support" not in str(worker_status.path())
