"""Every error_kind the code can write must be one the CHECK will accept.

WHY THIS IS A TEST AND NOT A CODE REVIEW. `ai_jobs.error_kind` is an allowlist in
a CHECK constraint, and the two mappers that fill it are ordinary Python in two
different processes. Adding a kind on one side and not the other does not fail to
compile, does not fail a type check, and does not fail until a job actually takes
that failure path in production -- at which point mark_failed raises 23514, the
UPDATE is lost, and the row sits `running` until the sweep collects it as a
timeout. The user sees "offline" for a failure that had nothing to do with the
box being off.

This is the allowlist-by-omission trap the repo has been bitten by before, so the
constraint is read from the NEWEST migration that defines it rather than from the
one that created it.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

_ROOT = Path(__file__).resolve().parents[3]
_MIGRATIONS = _ROOT / "supabase" / "migrations"

# The two files that write ai_jobs.error_kind: the backend route (inline jobs)
# and the desktop worker (claimed jobs).
_MAPPERS = (
    _ROOT / "api" / "routes" / "insights_routes.py",
    _ROOT / "worker" / "__main__.py",
)

_CONSTRAINT = "ai_jobs_error_kind_check"


def _allowed_kinds() -> set[str]:
    """The kinds the live constraint accepts, from its newest definition.

    Sorted by filename, which is the 14-digit timestamp the CLI mints, so the
    last file mentioning the constraint is the one whose text is in force.
    """
    defining = sorted(p for p in _MIGRATIONS.glob("*.sql") if _CONSTRAINT in p.read_text())
    assert defining, f"no migration defines {_CONSTRAINT}"

    text = defining[-1].read_text()
    # The IN (...) list that follows the constraint name.
    block = text.split(_CONSTRAINT, 1)[1].split(")", 1)[0]
    kinds = set(re.findall(r"'([a-z_]+)'", block))
    assert kinds, f"parsed no kinds out of {defining[-1].name} -- the format changed"
    return kinds


def _kinds_the_code_writes() -> dict[str, set[str]]:
    """Every literal that can reach error_kind, per file.

    Three shapes, which is all of them: a `return` inside _error_kind, a literal
    argument to mark_failed, and the `kind = "a" if ... else "b"` the worker uses
    before passing it on.
    """
    found: dict[str, set[str]] = {}

    for path in _MAPPERS:
        tree = ast.parse(path.read_text())
        kinds: set[str] = set()

        def literals(node) -> set[str]:
            return {
                n.value for n in ast.walk(node)
                if isinstance(n, ast.Constant) and isinstance(n.value, str)
            }

        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "_error_kind":
                for ret in ast.walk(node):
                    if isinstance(ret, ast.Return) and ret.value is not None:
                        kinds |= literals(ret.value)
            if isinstance(node, ast.Call):
                args = list(node.args) + [kw.value for kw in node.keywords]
                # Either `x.mark_failed(...)` or the worker's
                # `asyncio.to_thread(self.db.mark_failed, ..., "internal")`,
                # where the function is an argument rather than the callee.
                referenced = {
                    getattr(ref, "attr", None) or getattr(ref, "id", None)
                    for ref in [node.func] + args
                }
                if "mark_failed" in referenced:
                    kinds |= {
                        a.value for a in args
                        if isinstance(a, ast.Constant) and isinstance(a.value, str)
                    }
            if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "kind" for t in node.targets
            ):
                kinds |= literals(node.value)

        found[path.name] = kinds

    return found


def test_the_mappers_are_actually_parsed():
    """A test that finds nothing passes silently, and this one would be the only
    thing standing between a new kind and a 23514 in production."""
    found = _kinds_the_code_writes()

    for name, kinds in found.items():
        assert kinds, f"parsed no error_kind literals out of {name} -- the shape changed"
    assert "error_echo" in set().union(*found.values()), (
        "the new kind is not reachable from either mapper"
    )


def test_every_kind_the_code_writes_is_one_the_constraint_accepts():
    allowed = _allowed_kinds()
    problems = [
        f"{name} writes {sorted(kinds - allowed)}"
        for name, kinds in _kinds_the_code_writes().items()
        if kinds - allowed
    ]

    assert not problems, (
        "ai_jobs_error_kind_check would reject these with a 23514, losing the "
        "failure and leaving the job running: " + "; ".join(problems)
        + f" (allowed: {sorted(allowed)})"
    )
