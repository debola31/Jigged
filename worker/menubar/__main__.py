"""Entry point.

    python -m worker.menubar            the status item
    python -m worker.menubar --once     the same state, printed, then exit

--once exists for two reasons. It is the fallback if the status item ever fails to
appear on a future macOS, and it is how the indicator is debugged -- the numbers it
prints are the exact values the glyph was derived from, so a disagreement between
what you see in the menu bar and what you believe is resolvable in one command.
It imports no UI framework, so it runs on a box with no pyobjc at all.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from worker.menubar import launchctl, ollama, repo, state, statusfile

LABEL = "com.jigged.worker"
_REPO = Path(__file__).resolve().parents[2]


def _config() -> dict:
    home = Path.home()
    return {
        "label": LABEL,
        "uid": os.getuid(),
        "plist": str(home / "Library/LaunchAgents/{}.plist".format(LABEL)),
        "repo": os.getenv("JIGGED_REPO") or str(_REPO),
        "log": str(home / "Library/Logs/jigged/worker.log"),
    }


def once(cfg: dict) -> int:
    """Print the state. Exit code IS the summary: 0 healthy, 1 degraded, 2 off."""
    svc = launchctl.read(cfg["label"], cfg["uid"])
    doc = statusfile.load()
    ind = state.derive(svc, doc)
    co = repo.read(cfg["repo"])

    print("{}  {}".format(ind.glyph, ind.headline))
    print()
    if svc.loaded:
        print("  launchd    {} · pid {} · {} starts · last exit {}".format(
            svc.state or "?", svc.pid, svc.runs, svc.last_exit))
    else:
        print("  launchd    not loaded{}".format(" · DISABLED" if svc.disabled else ""))
    for line in ind.detail:
        print("  database   {}".format(line))
    if doc is None:
        print("  status     no document (the worker has not reported in)")

    oll = ollama.resident((doc or {}).get("ollama_base_url") or "http://localhost:11434/v1")
    if oll["up"] and oll["models"]:
        m = oll["models"][0]
        print("  ollama     {} resident · {} GB · {} ctx".format(
            m["name"], m["size_gb"], m["context"] or "?"))
    else:
        print("  ollama     not answering{}".format(
            " — " + str(oll["error"])[:60] if oll["error"] else ""))

    job = (doc or {}).get("last_job")
    if job:
        print("  last job   {} ({}) in {}s".format(
            str(job.get("job_id"))[:8], job.get("feature"), job.get("seconds")))

    print("  checkout   {} @ {} · {} dirty · {} behind origin/main".format(
        co.branch, (co.head or "?")[:8], co.dirty, co.behind))
    if repo.running_code_is_stale(co, doc):
        print("             RUNNING CODE IS NOT THIS CHECKOUT — restart to pick it up")
    blocked = repo.blockers(co, doc)
    print("  pull       {}".format("; ".join(blocked) if blocked else "allowed"))

    return {state.RUNNING: 0, state.BUSY: 0, state.OFF: 2, state.STOPPED: 2}.get(ind.state, 1)


def main(argv=None) -> int:
    p = argparse.ArgumentParser("worker.menubar", description=__doc__)
    p.add_argument("--once", action="store_true",
                   help="print the state and exit instead of showing the status item")
    args = p.parse_args(argv)
    cfg = _config()
    if args.once:
        return once(cfg)
    # Imported here, not at module scope, so --once works on a box with no pyobjc.
    from worker.menubar import ui
    ui.run(cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
