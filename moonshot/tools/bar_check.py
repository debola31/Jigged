"""A PR moves the bar or meets it, never both (docs/moonshot/shop-and-pipeline-plan.md §6, rule 1).

The bar is what decides whether work is good: the thresholds, the good and bad takes every check is proved
against, the gate tests, reference outputs and the data formats. An agent stuck on a failing check is tempted
to move the check; splitting the change makes moving it a visible decision of its own.

Moving the bar means changing or deleting what is already there: an existing gate test, fixture or reference, or
an existing threshold's value. Adding a new gate, fixture or threshold alongside the code it gates is how the bar
is created in the first place, so it may share a PR with that code.

    python moonshot/tools/bar_check.py [--base <ref>]

The base is --base, else $MOONSHOT_BASE_REF (CI passes github.event.pull_request.base.sha). With no base, as on
a push to main, it says so and passes: like the legal-docs freeze, this is a PR-time control. It also passes
when the base has no moonshot/thresholds.toml, so the PR that first creates the bar can carry both.
"""
from __future__ import annotations

import fnmatch
import os
import subprocess
import sys
import tomllib

THRESHOLDS = "moonshot/thresholds.toml"
BAR = [
    THRESHOLDS,
    "moonshot/tests/fixtures/*",
    "moonshot/tests/gates/*",
    "moonshot/reference/*",
    "moonshot/contracts/schemas/*",
]
CODE = ["moonshot/*.py"]
NOT_CODE = ["moonshot/tests/*", "moonshot/tools/*"]


def _match(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, p) for p in patterns)


def thresholds_moved(base_text: str, head_text: str) -> list[str]:
    """Existing thresholds whose entry changed or vanished. New ones don't count."""
    flat = lambda raw: {f"{s}.{k}": v for s, e in raw.items() for k, v in e.items()}   # noqa: E731
    base, head = flat(tomllib.loads(base_text)), flat(tomllib.loads(head_text))
    return sorted(k for k in base if head.get(k) != base[k])


def classify(changes: list[tuple[str, str]], moved_thresholds: list[str]) -> tuple[list[str], list[str]]:
    """(bar moved, code changed) from (git status letter, path) pairs. Renames arrive as a delete and an add."""
    moved, code = [], []
    for status, path in changes:
        if _match(path, BAR):
            if path == THRESHOLDS:
                moved += [f"{THRESHOLDS}: {k}" for k in moved_thresholds]
            elif status != "A":
                moved.append(path)
        elif _match(path, CODE) and not _match(path, NOT_CODE):
            code.append(path)
    return moved, code


def verdict(changes: list[tuple[str, str]], moved_thresholds: list[str] = ()) -> tuple[bool, str]:
    moved, code = classify(changes, list(moved_thresholds))
    if moved and code:
        return False, ("This PR moves the bar and changes code together. Split it: one PR that moves the bar, which\n"
                       "you review on its own, and one for the code that meets it.\n"
                       "  bar moved: " + "\n             ".join(moved) + "\n  code:      " + "\n             ".join(code))
    return True, f"ok: {len(moved)} bar change(s), {len(code)} code file(s)"


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def changes_since(base: str) -> list[tuple[str, str]]:
    out = []
    for line in _git("diff", "--name-status", f"{base}...HEAD").splitlines():
        status, *paths = line.split("\t")
        if status.startswith("R"):
            out += [("D", paths[0]), ("A", paths[1])]
        else:
            out.append((status[0], paths[-1]))
    return out


def main(argv: list[str]) -> int:
    base = argv[argv.index("--base") + 1] if "--base" in argv else os.environ.get("MOONSHOT_BASE_REF", "")
    if not base:
        print("[bar-check] no base ref: skipped (it runs on pull requests)")
        return 0
    try:
        base_thresholds = _git("show", f"{base}:{THRESHOLDS}")
    except subprocess.CalledProcessError:
        print(f"[bar-check] the base has no {THRESHOLDS}: this PR creates the bar, so it may carry both")
        return 0
    with open(THRESHOLDS, encoding="utf-8") as f:
        moved_t = thresholds_moved(base_thresholds, f.read())
    ok, msg = verdict(changes_since(base), moved_t)
    print(f"[bar-check] {msg}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
