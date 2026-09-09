"""launchd's answers, parsed exactly as narrowly as they deserve.

The fixtures are real output captured from this machine, coalition blocks and all.
"""
from __future__ import annotations

from worker.menubar import launchctl as lc

# Real `launchctl print gui/501/com.jigged.worker`, trimmed but with indentation
# preserved byte for byte. The two `state = active` lines are the whole point.
PRINT_RUNNING = """gui/501/com.jigged.worker = {
\tactive count = 1
\tpath = /Users/adebolaakeredolu/Library/LaunchAgents/com.jigged.worker.plist
\ttype = LaunchAgent
\tstate = running

\tprogram = /usr/bin/caffeinate
\tworking directory = /Users/adebolaakeredolu/Jigged

\tminimum runtime = 30
\texit timeout = 5
\truns = 6
\tpid = 98246
\tlast exit code = 0

\tresource coalition = {
\t\tID = 83137
\t\ttype = resource
\t\tstate = active
\t\tactive count = 1
\t}

\tjetsam coalition = {
\t\ttype = jetsam
\t\tstate = active
\t}

\tproperties = keepalive | runatload | inferred program
}"""

LIST_RUNNING = """{
\t"LimitLoadToSessionType" = "Aqua";
\t"Label" = "com.jigged.worker";
\t"OnDemand" = false;
\t"LastExitStatus" = 0;
\t"PID" = 98246;
\t"Program" = "/usr/bin/caffeinate";
};"""

DISABLED_BLOCK = """
\tdisabled services = {
\t\t"com.docker.helper" => enabled
\t\t"com.ollama.ollama" => enabled
\t\t"com.jigged.worker" => disabled
\t}
"""


class TestPrintParsing:
    def test_it_reads_the_job_state_not_a_coalition_state(self) -> None:
        """THE FALSE-GREEN TEST.

        `state = running` sits at one tab; the resource and jetsam coalitions each
        carry `state = active` at two. A parser that drops the anchor reports a
        live coalition as a live worker, in the one tool whose entire job is to not
        be wrongly green.
        """
        assert lc.parse_print(PRINT_RUNNING)["state"] == "running"

    def test_a_nested_key_never_overwrites_the_top_level_one_it_shadows(self) -> None:
        """`type` appears at BOTH levels, and that is the sharper version of the trap.

        Top level says `type = LaunchAgent`; the resource coalition says
        `type = resource` two tabs in. A parser without the anchor would not merely
        add noise, it would overwrite a real answer with a wrong one -- and later
        keys win, so the wrong one would be the survivor.
        """
        top = lc.parse_print(PRINT_RUNNING)
        assert top["type"] == "LaunchAgent"
        assert "ID" not in top
        assert top["runs"] == "6" and top["last exit code"] == "0"

    def test_multiword_keys_survive(self) -> None:
        assert lc.parse_print(PRINT_RUNNING)["exit timeout"] == "5"


class TestListParsing:
    def test_pid_and_last_exit(self) -> None:
        assert lc.parse_list(LIST_RUNNING) == {"pid": 98246, "last_exit": 0}

    def test_a_quoted_program_is_not_mistaken_for_a_number(self) -> None:
        assert lc.parse_list('{\n\t"PID" = "nonsense";\n}')["pid"] is None


class TestDisabledParsing:
    def test_an_explicit_disabled_row_is_read(self) -> None:
        assert lc.parse_disabled(DISABLED_BLOCK, "com.jigged.worker") is True

    def test_absence_means_enabled(self) -> None:
        """The override database lists only labels someone set by hand.

        A worker that has never been disabled has NO row, and reading that as
        disabled would render the indicator permanently off.
        """
        assert lc.parse_disabled(DISABLED_BLOCK, "com.jigged.never-touched") is False

    def test_an_enabled_row_is_not_disabled(self) -> None:
        assert lc.parse_disabled(DISABLED_BLOCK, "com.ollama.ollama") is False


class TestRead:
    def _runner(self, responses):
        def runner(argv):
            for needle, resp in responses:
                if needle in " ".join(argv):
                    return resp
            return lc.Completed(0, "")
        return runner

    def test_exit_113_is_not_running(self) -> None:
        """113 is launchd's "no such label", verified on this machine."""
        svc = lc.read("com.jigged.worker", 501, self._runner([
            ("launchctl list", lc.Completed(lc.NOT_FOUND, "")),
            ("print-disabled", lc.Completed(0, DISABLED_BLOCK)),
        ]))
        assert svc.loaded is False and svc.pid is None and svc.disabled is True

    def test_a_running_service_reads_whole(self) -> None:
        svc = lc.read("com.jigged.worker", 501, self._runner([
            ("launchctl list", lc.Completed(0, LIST_RUNNING)),
            ("launchctl print gui", lc.Completed(0, PRINT_RUNNING)),
            ("print-disabled", lc.Completed(0, DISABLED_BLOCK)),
        ]))
        assert (svc.loaded, svc.state, svc.pid, svc.runs, svc.last_exit) == (
            True, "running", 98246, 6, 0)


class TestVerbOrdering:
    """The ordering is the correctness, so it is asserted rather than assumed."""

    def test_start_enables_before_bootstrapping(self) -> None:
        """bootstrap on a disabled label fails with a bare errno. enable is the fix."""
        cmds = lc.argv_start("com.jigged.worker", 501, "/p.plist")
        assert cmds[0][1] == "enable" and cmds[1][1] == "bootstrap"

    def test_turning_off_disables_before_booting_out(self) -> None:
        """If bootout then fails, the worker is at least off at next login.

        Reversed, a failed bootout leaves it running AND re-enabled -- the exact
        state the person was trying to leave.
        """
        cmds = lc.argv_turn_off("com.jigged.worker", 501)
        assert cmds[0][1] == "disable" and cmds[1][1] == "bootout"

    def test_stop_until_login_does_not_write_a_persistent_override(self) -> None:
        cmds = lc.argv_stop_until_login("com.jigged.worker", 501)
        assert [c[1] for c in cmds] == ["bootout"]

    def test_restart_is_a_single_kickstart(self) -> None:
        cmds = lc.argv_restart("com.jigged.worker", 501)
        assert cmds == [["/bin/launchctl", "kickstart", "-k", "gui/501/com.jigged.worker"]]

    def test_nothing_ever_kills(self) -> None:
        """KeepAlive=true means a kill is a restart, so a Kill button would look broken."""
        every = (lc.argv_start("l", 1, "/p") + lc.argv_restart("l", 1)
                 + lc.argv_stop_until_login("l", 1) + lc.argv_turn_off("l", 1))
        assert not any("kill" in part for cmd in every for part in cmd)
