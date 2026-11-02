"""A PR moves the bar or meets it, never both (docs/moonshot/shop-and-pipeline-plan.md §6, rule 1).

The bar is what decides whether work is good: the thresholds, the good and bad takes every check is proved
against, the gate tests, reference outputs and the data formats. An agent stuck on a failing check is tempted
to move the check; splitting the change makes moving it a visible decision of its own.

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

BAR = [
    "moonshot/thresholds.toml",
    "moonshot/tests/fixtures/*",
    "moonshot/tests/gates/*",
    "moonshot/reference/*",
    "moonshot/contracts/schemas/*",
]
CODE = ["moonshot/*.py"]
NOT_CODE = ["moonshot/tests/*", "moonshot/tools/*"]


def _match(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, p) for p in patterns)


def classify(paths: list[str]) -> tuple[list[str], list[str]]:
    """(bar files, code files) among the changed paths."""
    bar = [p for p in paths if _match(p, BAR)]
    code = [p for p in paths if _match(p, CODE) and not _match(p, NOT_CODE) and p not in bar]
    return bar, code


def verdict(paths: list[str]) -> tuple[bool, str]:
    bar, code = classify(paths)
    if bar and code:
        return False, ("This PR changes the bar and the code together. Split it: one PR for the bar, which you\n"
                       "review on its own, and one for the code that meets it.\n"
                       "  bar:  " + "\n        ".join(bar) + "\n  code: " + "\n        ".join(code))
    return True, f"ok: {len(bar)} bar file(s), {len(code)} code file(s)"


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def main(argv: list[str]) -> int:
    base = argv[argv.index("--base") + 1] if "--base" in argv else os.environ.get("MOONSHOT_BASE_REF", "")
    if not base:
        print("[bar-check] no base ref: skipped (it runs on pull requests)")
        return 0
    try:
        _git("cat-file", "-e", f"{base}:moonshot/thresholds.toml")
    except subprocess.CalledProcessError:
        print("[bar-check] the base has no moonshot/thresholds.toml: this PR creates the bar, so it may carry both")
        return 0
    paths = _git("diff", "--name-only", f"{base}...HEAD").split()
    ok, msg = verdict(paths)
    print(f"[bar-check] {msg}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
