"""Every physics and realism check registers here, with the takes that prove it works.

A check that has never failed can't be told apart from a broken one (plan §5.4), so registering one requires at
least one bad take it must fail and one good take it must pass. moonshot/tests/gates/test_checks_prove_themselves.py
runs them all; the fixtures live under moonshot/tests/fixtures/ and are protected (plan §6, rule 1).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures"


@dataclass(frozen=True)
class Result:
    passed: bool
    worst: float
    detail: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Check:
    name: str
    run: Callable[[dict], Result]
    good: tuple[Path, ...]
    bad: tuple[Path, ...]


CHECKS: dict[str, Check] = {}


def check(name: str, good: list[str], bad: list[str]):
    """Register a check. good/bad are fixture paths relative to moonshot/tests/fixtures/."""
    if not good or not bad:
        raise ValueError(f"check {name!r} needs at least one good and one bad take")

    def register(fn: Callable[[dict], Result]) -> Callable[[dict], Result]:
        if name in CHECKS:
            raise ValueError(f"check {name!r} registered twice")
        CHECKS[name] = Check(name, fn, tuple(FIXTURES / g for g in good), tuple(FIXTURES / b for b in bad))
        return fn

    return register


def load_all() -> dict[str, Check]:
    """Import every check module so it registers itself."""
    from moonshot.validate import penetration  # noqa: F401
    return CHECKS
