"""No value a database can return may kill a turn.

THE REGRESSION THIS EXISTS TO STOP REPEATING. A UUID in a result row crashed
"Who is my top customer by revenue?" with `TypeError: Object of type UUID is not
JSON serializable`. It was fixed. It came back -- because the fix went into
`_json_serializable`, a helper the failing path never reached: that helper shapes
rows as they are BUILT, and the crash was in a separate `json.dumps` in the tool
loop. Two conversion points, one of them taught about types.

So the guarantee is no longer "the helper knows about UUID". It is:

  * ONE mapping (`to_json_safe`), used both when rows are built and as the
    `default=` of the one dumps, so there is nothing left to keep in sync; and
  * that mapping ENDS IN A CATCH-ALL, so an unforeseen type degrades to its
    string form instead of ending the conversation.

The catch-all is the load-bearing part. Enumerating types is how this bug
happened twice -- UUID was simply not on the list. A test that pins the
enumeration would have passed both times.

Whether the real path USES any of this is a different question, and no test in
this file answers it. tests/integration/test_sql_executor.py and
test_insights_loop_integrity.py do.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

import pytest

from tools.tool_json import dumps_tool_result, to_json_safe

pytestmark = pytest.mark.unit


class Unforeseen:
    """Stands in for whatever type nobody has thought of yet -- which is exactly
    what a UUID was, twice."""

    def __str__(self) -> str:
        return "unforeseen-value"


EXOTIC = [
    pytest.param(uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
                 "6ba7b810-9dad-11d1-80b4-00c04fd430c8", id="uuid"),
    pytest.param(datetime(2026, 8, 26, 14, 30, tzinfo=timezone.utc),
                 "2026-08-26T14:30:00+00:00", id="timestamptz"),
    pytest.param(date(2026, 8, 26), "2026-08-26", id="date"),
    pytest.param(time(14, 30), "14:30:00", id="time"),
    pytest.param(b"\x01\x02", None, id="bytes"),
    pytest.param(Unforeseen(), "unforeseen-value", id="a-type-nobody-listed"),
]


@pytest.mark.parametrize("value,expected", EXOTIC)
def test_no_value_survives_as_something_json_cannot_encode(value, expected):
    converted = to_json_safe(value)

    json.dumps(converted)  # the assertion: this must not raise
    if expected is not None:
        assert converted == expected


@pytest.mark.parametrize("value,expected", EXOTIC)
def test_the_same_mapping_backs_the_dumps(value, expected):
    """Not a second implementation that happens to agree today. If the dumps had
    its own list of types, the two would drift and one of them would be the one
    the real path uses -- which is the whole shape of this regression."""
    assert json.loads(dumps_tool_result({"v": value}))["v"] == to_json_safe(value)


def test_numbers_stay_numbers():
    """A revenue figure stringified is a figure the model cannot compare, sort or
    total -- a quieter failure than a crash and a worse one."""
    payload = to_json_safe({"revenue": Decimal("7749.24"), "n": Decimal("100"),
                            "f": 1.5, "i": 3, "b": True, "nothing": None})

    assert payload == {"revenue": 7749.24, "n": 100, "f": 1.5, "i": 3,
                       "b": True, "nothing": None}
    assert isinstance(payload["n"], int), "a whole Decimal should not become 100.0"
    assert payload["b"] is True, "bool is an int subclass -- it must not become 1"


def test_a_non_finite_decimal_does_not_explode_the_int_check():
    """`int(Decimal('NaN'))` raises. The old helper's `value == int(value)` was
    one NaN away from turning a serialiser into a crash of its own."""
    assert json.dumps(to_json_safe(Decimal("NaN")))
    assert json.dumps(to_json_safe(Decimal("Infinity")))


def test_nesting_is_converted_all_the_way_down():
    """A jsonb column arrives as a dict, and asyncpg hands back UUIDs inside it.
    The old helper returned dicts and lists untouched, so anything nested kept
    its exotic types and the dumps died on them."""
    out = dumps_tool_result({
        "rows": [{"id": uuid.uuid4(), "tags": [uuid.uuid4()],
                  "meta": {"at": datetime(2026, 1, 1)}}]
    })

    row = json.loads(out)["rows"][0]
    assert isinstance(row["id"], str)
    assert isinstance(row["tags"][0], str)
    assert row["meta"]["at"] == "2026-01-01T00:00:00"


def test_dumps_returns_a_string_the_message_layer_can_carry():
    assert isinstance(dumps_tool_result({"rows": []}), str)
