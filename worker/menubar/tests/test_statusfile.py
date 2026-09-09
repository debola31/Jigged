"""Every way the document can be unusable is ordinary, and none may raise."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from worker.menubar import statusfile as sf

NOW = datetime(2026, 9, 9, 12, 0, 0, tzinfo=timezone.utc)


class TestLoadNeverRaises:
    def test_a_missing_file_is_none(self, tmp_path: Path) -> None:
        assert sf.load(tmp_path / "nope.json") is None

    def test_a_truncated_file_is_none(self, tmp_path: Path) -> None:
        """os.replace makes this near-impossible; depending on that would be the bug."""
        p = tmp_path / "s.json"
        p.write_text('{"schema": 1, "pid": 12')
        assert sf.load(p) is None

    def test_an_unknown_schema_is_none(self, tmp_path: Path) -> None:
        """A document we cannot interpret must degrade to 'no information'.

        Guessing at an unknown shape would produce a confident wrong answer, which
        is worse than the honest fallback of trusting launchd alone.
        """
        p = tmp_path / "s.json"
        p.write_text(json.dumps({"schema": 99, "pid": 1}))
        assert sf.load(p) is None

    def test_a_json_scalar_is_none(self, tmp_path: Path) -> None:
        p = tmp_path / "s.json"
        p.write_text("42")
        assert sf.load(p) is None


class TestAge:
    def test_it_measures_from_an_iso_timestamp(self) -> None:
        assert sf.age_seconds((NOW - timedelta(seconds=90)).isoformat(), NOW) == 90.0

    def test_a_naive_timestamp_is_read_as_utc(self) -> None:
        """The worker always writes tz-aware, but a naive value must not crash."""
        assert sf.age_seconds("2026-09-09T11:59:00", NOW) == 60.0

    def test_junk_is_none_not_an_exception(self) -> None:
        assert sf.age_seconds("not a date", NOW) is None
        assert sf.age_seconds(None, NOW) is None


class TestAbandonment:
    def test_four_missed_publications_is_abandoned(self) -> None:
        doc = {"heartbeat_seconds": 15,
               "written_at": (NOW - timedelta(seconds=61)).isoformat()}
        assert sf.is_abandoned(doc, NOW) is True

    def test_three_is_not(self) -> None:
        doc = {"heartbeat_seconds": 15,
               "written_at": (NOW - timedelta(seconds=44)).isoformat()}
        assert sf.is_abandoned(doc, NOW) is False

    def test_the_window_follows_the_documents_own_heartbeat(self) -> None:
        """The threshold is derived from the file, so a retuned worker stays correct."""
        doc = {"heartbeat_seconds": 60,
               "written_at": (NOW - timedelta(seconds=100)).isoformat()}
        assert sf.is_abandoned(doc, NOW) is False


class TestItHoldsNoOfflineRule:
    def test_the_module_never_mentions_sixty(self) -> None:
        """A guard, not a style check.

        The product's offline rule is 60 seconds and is pinned in places that must
        agree. If this module ever grows its own 60 it has silently become another
        one of them, and this test is what says so.
        """
        source = Path("worker/menubar/statusfile.py").read_text()
        code = [l for l in source.splitlines()
                if not l.strip().startswith("#") and "60" in l]
        assert code == [], code
