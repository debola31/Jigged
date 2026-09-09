"""One test per way a single source would have been believed too readily."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from worker.menubar import state as st
from worker.menubar.launchctl import Service

NOW = datetime(2026, 9, 9, 12, 0, 0, tzinfo=timezone.utc)


def _iso(seconds_ago: float) -> str:
    return (NOW - timedelta(seconds=seconds_ago)).isoformat()


def _svc(**over) -> Service:
    base = dict(loaded=True, state="running", pid=98246, runs=6, last_exit=0, disabled=False)
    base.update(over)
    return Service(**base)


def _db(label, default, reachable, last_ok=4.0, error=None):
    return {"ref": label, "label": label, "is_default": default, "reachable": reachable,
            "last_ok_at": _iso(last_ok) if last_ok is not None else None, "error": error}


def _doc(**over) -> dict:
    base = dict(
        schema=1, pid=98246, worker_id="macbook-1", heartbeat_seconds=15,
        written_at=_iso(2), reachable=True, busy=False, held=0, stopped=False,
        commit="abc", repo="/Users/adebolaakeredolu/Jigged",
        databases=[_db("production", True, True)],
    )
    base.update(over)
    return base


class TestLaunchdAloneWouldLie:
    def test_a_live_pid_with_production_down_is_not_running(self) -> None:
        """THE REASON THIS EXISTS.

        launchd reports state=running and a pid; the worker's own beats to
        production are failing. An indicator sourced from launchd would show green
        through exactly the window in which the shop cannot be served.
        """
        doc = _doc(reachable=False,
                   databases=[_db("production", True, False, None, "No route to host")])
        ind = st.derive(_svc(), doc, now=NOW)
        assert ind.state == st.UNREACHABLE
        assert not ind.healthy
        assert "No route to host" in ind.headline


class TestTheStatusFileAloneWouldLie:
    def test_launchd_absence_beats_a_perfectly_healthy_document(self) -> None:
        """A SIGKILLed worker cannot write a farewell.

        Its last publication still says reachable and busy, and it stays that way
        forever. Believing the file here renders a dead worker as a working one.
        """
        ind = st.derive(_svc(loaded=False, pid=None), _doc(busy=True, held=3), now=NOW)
        assert ind.state == st.STOPPED

    def test_a_previous_runs_document_is_not_this_process(self) -> None:
        """After a restart the file lingers with the old pid until the first tick."""
        ind = st.derive(_svc(pid=99999), _doc(pid=98246), now=NOW)
        assert ind.state == st.STARTING

    def test_a_pid_that_stopped_publishing_is_wedged(self) -> None:
        """Neither source catches this alone: launchd sees a pid, the file is stale.

        KeepAlive only restarts a process that EXITS; one stuck in its run loop is
        invisible to it.
        """
        ind = st.derive(_svc(), _doc(written_at=_iso(120)), now=NOW)
        assert ind.state == st.WEDGED

    def test_a_document_just_under_the_abandonment_window_is_still_trusted(self) -> None:
        ind = st.derive(_svc(), _doc(written_at=_iso(59)), now=NOW)
        assert ind.state == st.RUNNING


class TestBranchNoiseIsNotTheHeadline:
    def test_a_dead_preview_branch_leaves_the_indicator_healthy(self) -> None:
        """79 of 132 failures in a measured window were torn-down preview branches.

        If those drove the glyph it would sit amber almost permanently, for a
        condition no shop can feel, and would stop being read.
        """
        doc = _doc(databases=[_db("production", True, True),
                              _db("chore/remove-backpay", False, False, None, "ENOTFOUND")])
        ind = st.derive(_svc(), doc, now=NOW)
        assert ind.healthy and ind.state == st.RUNNING

    def test_but_it_is_still_said_out_loud(self) -> None:
        """Not the headline is not the same as hidden."""
        doc = _doc(databases=[_db("production", True, True),
                              _db("chore/remove-backpay", False, False, None, "ENOTFOUND")])
        ind = st.derive(_svc(), doc, now=NOW)
        assert "1 branch unreachable" in ind.headline
        assert any("ENOTFOUND" in line for line in ind.detail)


class TestOffIsTwoDifferentThings:
    def test_booted_out_says_it_comes_back(self) -> None:
        ind = st.derive(_svc(loaded=False, pid=None), None, now=NOW)
        assert ind.state == st.STOPPED and "next login" in ind.headline

    def test_disabled_says_it_will_not(self) -> None:
        ind = st.derive(_svc(loaded=False, pid=None, disabled=True), None, now=NOW)
        assert ind.state == st.OFF and "will not start at login" in ind.headline

    def test_a_clean_stop_is_distinguishable_from_a_crash(self) -> None:
        ind = st.derive(_svc(loaded=False, pid=None), _doc(stopped=True), now=NOW)
        assert "cleanly" in ind.headline


class TestPrecedence:
    def test_crash_looping_outranks_everything(self) -> None:
        """A box respawning twice a minute is not 'running', whatever one sample says."""
        ind = st.derive(_svc(), _doc(), crash_looping=True, now=NOW)
        assert ind.state == st.CRASHLOOP and not ind.healthy

    def test_busy_reports_the_count(self) -> None:
        ind = st.derive(_svc(), _doc(busy=True, held=3), now=NOW)
        assert ind.state == st.BUSY and ind.title == "3"


class TestAgesAreNumbersNotVerdicts:
    def test_a_reachable_database_shows_its_beat_age(self) -> None:
        """No threshold is applied, because the offline rule is owned elsewhere."""
        ind = st.derive(_svc(), _doc(databases=[_db("production", True, True, 4.0)]), now=NOW)
        assert ind.detail == ["production  beat 4s ago"]

    def test_no_line_ever_claims_offline(self) -> None:
        doc = _doc(databases=[_db("production", True, True, 3600.0)])
        ind = st.derive(_svc(), doc, now=NOW)
        assert "offline" not in " ".join(ind.detail + [ind.headline]).lower()


class TestRestartWatcher:
    def test_a_single_sample_is_never_a_loop(self) -> None:
        assert st.RestartWatcher().observe(6, now=0.0) is False

    def test_three_restarts_inside_the_window_is_a_loop(self) -> None:
        w = st.RestartWatcher(window_s=120.0, threshold=3)
        assert w.observe(1, 0.0) is False
        assert w.observe(2, 30.0) is False
        assert w.observe(4, 60.0) is True

    def test_the_same_restarts_spread_wide_are_not(self) -> None:
        """Samples age out, so a worker restarted daily never trips it."""
        w = st.RestartWatcher(window_s=120.0, threshold=3)
        w.observe(1, 0.0)
        w.observe(2, 500.0)
        assert w.observe(4, 1000.0) is False

    def test_a_steady_worker_never_trips_it(self) -> None:
        w = st.RestartWatcher()
        assert not any(w.observe(6, t) for t in (0.0, 30.0, 60.0, 90.0, 120.0))
