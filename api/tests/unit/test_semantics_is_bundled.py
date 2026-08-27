"""The semantics file has to ship INSIDE the function bundle, not merely exist on disk.

WHAT THIS CAUGHT, AFTER THE FACT. SEMANTICS_PATH used to be
`parents[2] / "docs" / "ai" / "semantics.md"` -- it walked up out of the package
to reach docs/. That resolves on a laptop and it resolves in CI, where the whole
repo is checked out. It does not resolve on Vercel: `excludeFiles` in
vercel.json drops `docs/**` from every `api/**` function bundle, so insights
answered every question locally and raised
`FileNotFoundError: /var/task/docs/ai/semantics.md` in production.

SO "THE FILE EXISTS" IS THE WRONG ASSERTION. Every environment that runs this
test has the whole repo, which is exactly why the old path was green everywhere
that could have caught it. What has to hold is that the path resolves RELATIVE
TO THE api PACKAGE, because api/ is the directory the bundle is built from. A
future path edit or packaging change that reaches back outside api/ fails here
instead of on a shop owner's screen.
"""
from __future__ import annotations

from pathlib import Path

import pytest

pytestmark = pytest.mark.unit


def _api_package_root() -> Path:
    """api/, derived from the module under test rather than from this file's own
    location -- so moving the tests does not quietly change what is asserted."""
    from services import insights_service

    return Path(insights_service.__file__).resolve().parents[1]


def test_semantics_resolves_relative_to_the_api_package():
    from services.insights_service import SEMANTICS_PATH

    api_root = _api_package_root()
    assert SEMANTICS_PATH.is_relative_to(api_root), (
        f"SEMANTICS_PATH is {SEMANTICS_PATH}, which is outside the api package at "
        f"{api_root}. Anything outside api/ is excluded from the Vercel function "
        "bundle: this passes in CI and raises FileNotFoundError in production."
    )
    assert SEMANTICS_PATH.is_file(), f"{SEMANTICS_PATH} is not a file"


def test_load_semantics_returns_the_definitions():
    from services.insights_service import load_semantics

    text = load_semantics()
    assert text.strip(), (
        "load_semantics() returned nothing -- the insights system prompt would ship "
        "with no definition of late, revenue or this quarter."
    )
