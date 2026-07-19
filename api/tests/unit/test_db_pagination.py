"""fetch_all_by_company / fetch_all_in must page past PostgREST's 1000-row cap."""

import pytest

from utils.db_pagination import fetch_all_by_company, fetch_all_in

pytestmark = pytest.mark.unit


class _FakeQuery:
    """Records the requested range and returns the matching slice of a backing list."""

    def __init__(self, rows):
        self._rows = rows
        self._start = 0
        self._end = None

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def range(self, start, end):
        self._start, self._end = start, end
        return self

    def execute(self):
        class _Resp:
            pass

        r = _Resp()
        r.data = self._rows[self._start : self._end + 1]
        return r


class _FakeClient:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _name):
        return _FakeQuery(self._rows)


def test_returns_everything_when_under_one_page():
    client = _FakeClient([{"id": i} for i in range(42)])
    assert len(fetch_all_by_company(client, "parts", "id", "c")) == 42


def test_pages_past_the_1000_row_cap():
    # 2,350 rows — three pages (1000 + 1000 + 350). A single un-ranged read would cap at 1000.
    rows = [{"id": i, "part_name": f"P{i}"} for i in range(2350)]
    got = fetch_all_by_company(_FakeClient(rows), "parts", "id, part_name", "c")
    assert len(got) == 2350
    assert got[0]["id"] == 0 and got[-1]["id"] == 2349


def test_exact_multiple_of_page_size_stops_cleanly():
    # 2000 rows: after the 2nd full page, a 3rd read returns empty and the loop ends.
    rows = [{"id": i} for i in range(2000)]
    assert len(fetch_all_by_company(_FakeClient(rows), "parts", "id", "c")) == 2000


class _FakeInQuery:
    """Filters by `column IN values`, then range-slices — models fetch_all_in's per-chunk paging."""

    def __init__(self, rows):
        self._rows = rows
        self._col = None
        self._vals = set()
        self._start = 0
        self._end = None

    def select(self, *a, **k):
        return self

    def in_(self, col, vals):
        self._col, self._vals = col, set(vals)
        return self

    def range(self, start, end):
        self._start, self._end = start, end
        return self

    def execute(self):
        matched = [r for r in self._rows if r.get(self._col) in self._vals]

        class _Resp:
            pass

        r = _Resp()
        r.data = matched[self._start : self._end + 1]
        return r


class _FakeInClient:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _name):
        return _FakeInQuery(self._rows)


def test_fetch_all_in_filters_to_requested_values():
    rows = [{"parent_part_id": f"p{i}", "child_part_id": f"c{i}"} for i in range(5)]
    got = fetch_all_in(
        _FakeInClient(rows), "parts_bom", "parent_part_id, child_part_id", "parent_part_id", ["p1", "p3"]
    )
    assert sorted(r["parent_part_id"] for r in got) == ["p1", "p3"]


def test_fetch_all_in_chunks_large_value_lists():
    # 700 distinct ids (> the 300 chunk size → 3 chunks). Each id matched exactly once, no dups.
    rows = [{"parent_part_id": f"p{i}"} for i in range(700)]
    ids = [f"p{i}" for i in range(700)]
    got = fetch_all_in(_FakeInClient(rows), "parts_bom", "parent_part_id", "parent_part_id", ids)
    assert len(got) == 700
    assert len({r["parent_part_id"] for r in got}) == 700
