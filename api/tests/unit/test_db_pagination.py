"""fetch_all_by_company must page past PostgREST's 1000-row cap."""

import pytest

from utils.db_pagination import fetch_all_by_company

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
