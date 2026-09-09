"""The checkout, and whether it is safe to move it.

Two different questions live here and only one of them costs a network call:

  running code vs checkout   the worker imports its handlers at startup, so it
                             runs the commit it started on however far the
                             checkout moves. Comparing the status file's `commit`
                             to HEAD-on-disk detects "you pulled and forgot to
                             restart" with NO fetch at all, and it is the more
                             useful of the two.
  checkout vs origin/main    needs a periodic fetch to mean anything, which is
                             why fetch runs on a background thread and its failure
                             is reported rather than rounded down to "up to date".
"""
from __future__ import annotations

import os
import time
from typing import Any, Dict, List, NamedTuple, Optional, Sequence

from worker.menubar.launchctl import Completed, Runner, run

GIT = "/usr/bin/git"


class Checkout(NamedTuple):
    toplevel: Optional[str]
    branch: Optional[str]
    head: Optional[str]
    dirty: int
    behind: Optional[int]
    ahead: Optional[int]
    fetched_age_s: Optional[float]


def _git(repo: str, args: Sequence[str], runner: Runner) -> Optional[str]:
    r = runner([GIT, "-C", repo] + list(args))
    return r.out.strip() if r.code == 0 else None


def _int(text: Optional[str]) -> Optional[int]:
    return int(text) if text and text.isdigit() else None


def read(repo: str, runner: Runner = run, now: Optional[float] = None) -> Checkout:
    # --porcelain -uno skips the untracked walk: faster on a tree carrying several
    # worktrees, and MORE correct for the gate below, since untracked files never
    # block a fast-forward.
    porcelain = _git(repo, ["status", "--porcelain", "-uno"], runner) or ""
    try:
        fetched = (now or time.time()) - os.path.getmtime(os.path.join(repo, ".git/FETCH_HEAD"))
    except OSError:
        fetched = None
    return Checkout(
        toplevel=_git(repo, ["rev-parse", "--show-toplevel"], runner),
        branch=_git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], runner),
        head=_git(repo, ["rev-parse", "HEAD"], runner),
        dirty=len([l for l in porcelain.splitlines() if l.strip()]),
        behind=_int(_git(repo, ["rev-list", "--count", "HEAD..origin/main"], runner)),
        ahead=_int(_git(repo, ["rev-list", "--count", "origin/main..HEAD"], runner)),
        fetched_age_s=fetched,
    )


def running_code_is_stale(checkout: Checkout, doc: Optional[Dict[str, Any]]) -> bool:
    """Did someone pull without restarting? Costs nothing; needs no remote."""
    if not doc or not doc.get("commit") or not checkout.head:
        return False
    return str(doc["commit"]) != checkout.head


def blockers(
    checkout: Checkout, doc: Optional[Dict[str, Any]], fetch_ok: bool = True
) -> List[str]:
    """Every reason a pull must not happen, phrased for a menu item.

    An empty list is the only thing that enables the action. Each string names the
    blocker rather than saying "blocked", because a disabled menu item that will
    not say why is a menu item people click twice and then distrust.
    """
    out = []
    if checkout.branch != "main":
        out.append("on {}".format(checkout.branch or "an unknown branch"))
    if checkout.dirty:
        out.append("{} modified file{}".format(checkout.dirty, "" if checkout.dirty == 1 else "s"))
    if checkout.ahead:
        out.append("{} local commit{} not on origin/main".format(
            checkout.ahead, "" if checkout.ahead == 1 else "s"))
    # THE WORKTREE GUARD. This box carries several worktrees under .claude/, and
    # the plist names exactly one of them as the worker's WorkingDirectory. Pulling
    # into whichever tree this process happens to run from would update a checkout
    # the worker never reads, and report success.
    if doc and doc.get("repo") and checkout.toplevel and doc["repo"] != checkout.toplevel:
        out.append("the worker runs from {}".format(doc["repo"]))
    if not fetch_ok:
        out.append("update check failed")
    return out


def argv_fetch(repo: str) -> List[str]:
    # Bounded twice: an overall timeout at the call site, and git's own low-speed
    # abort, because a half-open socket on dead Wi-Fi does not time out on its own
    # -- and dead Wi-Fi is precisely the condition this app exists to display.
    return [GIT, "-C", repo, "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=10",
            "fetch", "--quiet", "origin", "main"]


def argv_pull(repo: str) -> List[List[str]]:
    """merge --ff-only, NEVER `git pull`.

    Two different protections. `git pull` on a non-main branch would pull THAT
    branch's upstream, and with a merge strategy configured it could create a merge
    commit on a checkout that is serving production. Naming origin/main and
    refusing anything but a fast-forward makes "refuse rather than merge" a
    property of the command, not of the checks above it.
    """
    return [[GIT, "-C", repo, "merge", "--ff-only", "origin/main"]]
