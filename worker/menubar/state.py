"""One indicator, from three sources that are allowed to disagree.

THE DISAGREEMENT IS THE PRODUCT. launchd knows whether a pid exists. The status
file knows whether the worker's own beats are landing. Neither alone is the truth:
a SIGKILLed worker leaves a perfectly healthy-looking document behind, and a
worker whose Wi-Fi has dropped holds a perfectly valid pid. Every rule below
exists because one source would have been believed too readily.

Nothing here decides that the product is "offline". That rule is 60 seconds of
missed beats and it is owned elsewhere; this reports what the worker observed and
prints ages as numbers.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from worker.menubar import statusfile
from worker.menubar.launchctl import Service

# Ordered by severity: an earlier entry outranks a later one.
CRASHLOOP = "crashloop"
OFF = "off"            # disabled: will not come back at login
STOPPED = "stopped"    # booted out: comes back at next login
STARTING = "starting"
WEDGED = "wedged"      # pid alive, publications stopped
UNREACHABLE = "unreachable"
BUSY = "busy"
RUNNING = "running"

# Text glyphs, not images: no asset catalogs can be built without Xcode, and a
# text status item inherits menu bar tinting and dark mode for free. These
# characters are text-presentation by default -- the likes of U+23FA would render
# as emoji and need a variation selector.
GLYPH = {
    CRASHLOOP: "!",
    OFF: "⊘",       # circled slash
    STOPPED: "○",   # hollow circle
    STARTING: "◌",  # dotted circle
    WEDGED: "△",    # hollow triangle
    UNREACHABLE: "▲",  # filled triangle
    BUSY: "●",
    RUNNING: "●",   # filled circle
}


class Indicator(NamedTuple):
    state: str
    glyph: str
    title: str
    headline: str
    detail: List[str]

    @property
    def healthy(self) -> bool:
        return self.state in (RUNNING, BUSY)


class RestartWatcher:
    """Spots a respawn loop, which no single reading of `runs` can show.

    KeepAlive=true plus ThrottleInterval=30 means a worker that cannot start is
    restarted forever, roughly twice a minute, and every individual sample of it
    looks like a healthy running process. Only the RATE gives it away.
    """

    def __init__(self, window_s: float = 120.0, threshold: int = 3) -> None:
        self.window_s = window_s
        self.threshold = threshold
        self._seen: List[Tuple[float, int]] = []

    def observe(self, runs: Optional[int], now: float) -> bool:
        if runs is None:
            return False
        self._seen.append((now, runs))
        self._seen = [(t, r) for t, r in self._seen if now - t <= self.window_s]
        if len(self._seen) < 2:
            return False
        return (self._seen[-1][1] - self._seen[0][1]) >= self.threshold


def _beat_line(db: Dict[str, Any], now: Optional[datetime]) -> str:
    age = statusfile.age_seconds(db.get("last_ok_at"), now)
    if db.get("reachable"):
        # A NUMBER, NOT A VERDICT. "beat 4s ago" lets a person judge; "healthy"
        # would be this module inventing a threshold it does not own.
        return "{}  beat {}".format(db.get("label"), _ago(age))
    return "{}  {}".format(db.get("label"), (db.get("error") or "unreachable")[:70])


def _ago(seconds: Optional[float]) -> str:
    if seconds is None:
        return "never"
    s = int(seconds)
    if s < 90:
        return "{}s ago".format(s)
    if s < 5400:
        return "{}m ago".format(s // 60)
    return "{}h ago".format(s // 3600)


def derive(
    service: Service,
    doc: Optional[Dict[str, Any]],
    crash_looping: bool = False,
    now: Optional[datetime] = None,
) -> Indicator:
    """Combine the sources. Order of the checks IS the precedence."""
    # A box that is respawning is not "running", whatever a single sample says.
    if crash_looping:
        return Indicator(
            CRASHLOOP, GLYPH[CRASHLOOP], "restarting",
            "Restarting repeatedly - last exit code {}".format(service.last_exit),
            ["The worker cannot stay up. Open the log."],
        )

    # LAUNCHD'S ABSENCE BEATS ANY DOCUMENT. A SIGKILLed worker cannot write a
    # farewell, so its last publication still says reachable and busy. Trusting the
    # file here is how a stopped worker renders as a healthy one.
    if not service.loaded or service.pid is None:
        if service.disabled:
            return Indicator(OFF, GLYPH[OFF], "off",
                             "Off. It will not start at login until you switch it back on.", [])
        clean = bool(doc and doc.get("stopped"))
        return Indicator(
            STOPPED, GLYPH[STOPPED], "",
            "Stopped cleanly. It starts again at next login."
            if clean else "Not running. It starts again at next login.",
            [],
        )

    if doc is None or doc.get("pid") != service.pid:
        # The document belongs to a previous run, so nothing in it describes the
        # process now holding the pid.
        return Indicator(STARTING, GLYPH[STARTING], "",
                         "Starting - waiting for it to report in.", [])

    if statusfile.is_abandoned(doc, now):
        age = statusfile.age_seconds(doc.get("written_at"), now)
        return Indicator(
            WEDGED, GLYPH[WEDGED], "?",
            "Process is up but stopped reporting {}".format(_ago(age)),
            ["Its heartbeat task may be stuck. Open the log."],
        )

    dbs = statusfile.databases(doc)
    detail = [_beat_line(d, now) for d in dbs]
    prod = statusfile.production(doc)

    if not doc.get("reachable"):
        err = (prod or {}).get("error") or "unknown error"
        return Indicator(UNREACHABLE, GLYPH[UNREACHABLE], "no net",
                         "Worker up, production queue unreachable - {}".format(err[:80]), detail)

    # Only branches are failing. Real, worth showing, and NOT the headline: a
    # torn-down preview branch is a developer's problem and no shop can feel it.
    down = [d for d in dbs if not d.get("reachable")]
    suffix = " - {} branch{} unreachable".format(len(down), "" if len(down) == 1 else "es") if down else ""

    if doc.get("busy"):
        held = doc.get("held") or 0
        return Indicator(BUSY, GLYPH[BUSY], str(held),
                         "Running {} job{}{}".format(held, "" if held == 1 else "s", suffix), detail)

    return Indicator(RUNNING, GLYPH[RUNNING], "",
                     "Serving {} database{}{}".format(
                         len(dbs), "" if len(dbs) == 1 else "s", suffix), detail)
