"""Asking launchd what it thinks, without believing more than it said.

launchd knows exactly one thing worth having: whether a process exists, and what
happened to the last one. It does NOT know whether the worker is reaching
Supabase, which is why nothing here returns a health verdict -- state.py combines
this with the worker's own status file, and the disagreement between them is the
interesting part.
"""
from __future__ import annotations

import re
import subprocess
from typing import Callable, Dict, List, NamedTuple, Optional, Sequence

# `launchctl list <label>` and `launchctl print <target>` both exit 113 when the
# label is not in the domain. That is the authoritative "not running" and it beats
# any status file, however fresh -- a SIGKILLed worker leaves its last document
# behind looking perfectly healthy.
NOT_FOUND = 113


class Completed(NamedTuple):
    code: int
    out: str


Runner = Callable[[Sequence[str]], Completed]


def run(argv: Sequence[str], timeout: float = 10.0) -> Completed:
    try:
        p = subprocess.run(list(argv), capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        return Completed(127, str(exc))
    return Completed(p.returncode, (p.stdout or "") + (p.stderr or ""))


class Service(NamedTuple):
    loaded: bool
    state: str
    pid: Optional[int]
    runs: Optional[int]
    last_exit: Optional[int]
    disabled: bool


# EXACTLY ONE LEADING TAB, and this is not style. `launchctl print` emits
# `state = running` for the job at one tab and `state = active` for its resource
# and jetsam coalitions at two. A regex that forgets the anchor reports a live
# coalition as a live worker -- a false green in the one tool whose job is to not
# be falsely green. Verified against real output: line 5 vs lines 56 and 64.
_TOP_LEVEL = re.compile(r"^\t([a-z][a-z ]*) = (.*)$")

_LIST_INT = r'^\s*"{key}"\s*=\s*(-?\d+);'


def parse_print(out: str) -> Dict[str, str]:
    """Top-level keys only. Nested blocks are deliberately invisible."""
    found = {}
    for line in out.splitlines():
        m = _TOP_LEVEL.match(line)
        if m:
            found[m.group(1).strip()] = m.group(2).strip()
    return found


def _list_int(out: str, key: str) -> Optional[int]:
    m = re.search(_LIST_INT.format(key=key), out, re.MULTILINE)
    return int(m.group(1)) if m else None


def parse_list(out: str) -> Dict[str, Optional[int]]:
    """`launchctl list <label>`: cheaper than print, and enough for the icon."""
    return {"pid": _list_int(out, "PID"), "last_exit": _list_int(out, "LastExitStatus")}


def parse_disabled(out: str, label: str) -> bool:
    """`launchctl print-disabled <domain>`.

    ABSENCE MEANS ENABLED. The override database lists only labels someone has
    explicitly set, so a worker that has never been disabled has no row at all --
    reading a missing row as "disabled" would show the indicator permanently off.
    """
    m = re.search(r'"%s"\s*=>\s*(\w+)' % re.escape(label), out)
    return bool(m) and m.group(1).lower() in ("disabled", "true")


def read(label: str, uid: int, runner: Runner = run) -> Service:
    target = "gui/{}/{}".format(uid, label)
    listed = runner(["/bin/launchctl", "list", label])
    if listed.code == NOT_FOUND:
        dis = runner(["/bin/launchctl", "print-disabled", "gui/{}".format(uid)])
        return Service(False, "", None, None, None, parse_disabled(dis.out, label))

    fields = parse_list(listed.out)
    printed = runner(["/bin/launchctl", "print", target])
    top = parse_print(printed.out) if printed.code == 0 else {}
    runs = top.get("runs")
    exit_code = top.get("last exit code")
    dis = runner(["/bin/launchctl", "print-disabled", "gui/{}".format(uid)])
    return Service(
        loaded=True,
        state=top.get("state", ""),
        pid=fields["pid"],
        runs=int(runs) if runs and runs.isdigit() else None,
        last_exit=int(exit_code) if exit_code and exit_code.lstrip("-").isdigit()
        else fields["last_exit"],
        disabled=parse_disabled(dis.out, label),
    )


# --------------------------------------------------------------------- verbs
# Each returns a LIST of argvs run in order, because the ordering is the
# correctness and a single command cannot express it.

def argv_start(label: str, uid: int, plist: str) -> List[List[str]]:
    """ENABLE BEFORE BOOTSTRAP.

    `bootstrap` on a label carrying a disabled override fails with
    `Load failed: 5: Input/output error` -- an errno, not an explanation, and the
    most common "why won't it start" on this setup. `enable` is the entire fix,
    and it is harmless when nothing was disabled.
    """
    return [
        ["/bin/launchctl", "enable", "gui/{}/{}".format(uid, label)],
        ["/bin/launchctl", "bootstrap", "gui/{}".format(uid), plist],
    ]


def argv_restart(label: str, uid: int) -> List[List[str]]:
    """kickstart -k: kill and respawn in one call, no unload window, no race.

    IT DOES NOT RE-READ THE PLIST -- launchd holds the job config from bootstrap
    time. So this is the right verb after a code change and the WRONG one after a
    plist change, which needs stop-then-start to take effect.
    """
    return [["/bin/launchctl", "kickstart", "-k", "gui/{}/{}".format(uid, label)]]


def argv_stop_until_login(label: str, uid: int) -> List[List[str]]:
    """Off now, back at next login -- because ~/Library/LaunchAgents is
    bootstrapped at login and a bare bootout does not survive that."""
    return [["/bin/launchctl", "bootout", "gui/{}/{}".format(uid, label)]]


def argv_turn_off(label: str, uid: int) -> List[List[str]]:
    """DISABLE BEFORE BOOTOUT, so a failure leaves you off rather than on.

    If bootout fails after disable, the worker is still running but will not come
    back at login. Reverse the order and a failed bootout leaves it running AND
    re-enabled, which is the state the person was trying to leave.
    """
    return [
        ["/bin/launchctl", "disable", "gui/{}/{}".format(uid, label)],
        ["/bin/launchctl", "bootout", "gui/{}/{}".format(uid, label)],
    ]
