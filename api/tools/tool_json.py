"""The ONE serializer every tool result goes through.

WHY THIS IS A MODULE AND NOT A HELPER NEXT TO ITS CALLER. A UUID in a result row
crashed the insights loop with `TypeError: Object of type UUID is not JSON
serializable`. It was fixed, and it came back identically -- because the repo had
TWO places that turned a database value into something JSON could carry:

  * `_json_serializable` in sql_executor, applied as result rows were BUILT; and
  * a bare `json.dumps` in the tool loop, applied as the row was wired into the
    conversation.

The fix taught the first one about UUIDs. The crash was in the second. The unit
test passed, the eval died, and the traceback pointed at the same line before and
after -- the file had changed and the path had not.

So there is one mapping now, and it is used in both places: `to_json_safe` shapes
the rows, and it is also the `default=` of `dumps_tool_result`, which is the only
thing allowed to serialise a tool result. Nothing is left to keep in sync.

AND IT ENDS IN A CATCH-ALL, which is the part that actually matters. Every
version of this bug has been a type nobody listed -- so the last branch is
`str(value)` rather than a raise. An `inet` column rendering as "10.0.0.1"
instead of crashing is a trade this layer should always take: the model can read
a wrong-looking string and say so, and it cannot read a dead conversation.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any

__all__ = ["dumps_tool_result", "to_json_safe"]


def to_json_safe(value: Any) -> Any:
    """One database value -> something `json` can encode.

    Used two ways, on purpose: directly when result rows are built, and as the
    `default=` of dumps_tool_result. `default=` only ever sees types json cannot
    handle, so the passthrough branch is dead weight there -- and it is what lets
    the same function shape a whole row without stringifying the numbers.
    """
    # Numbers stay numbers. A revenue figure stringified is one the model cannot
    # compare, sort or total -- quieter than a crash and worse. `bool` is checked
    # by being an `int` subclass, so True does not become 1.
    if value is None or isinstance(value, (str, bool, int, float)):
        return value

    if isinstance(value, Decimal):
        # NaN and Infinity are real Postgres numerics, and `int(Decimal('NaN'))`
        # raises -- the old helper's `value == int(value)` was one of those away
        # from being a crash of its own.
        if not value.is_finite():
            return str(value)
        return int(value) if value == value.to_integral_value() else float(value)

    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).decode("utf-8", "replace")

    # Containers recurse. The old helper returned dicts and lists UNTOUCHED,
    # so a jsonb column or an array kept whatever exotic types were inside it
    # and the dumps died one level down.
    if isinstance(value, dict):
        return {str(k): to_json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_json_safe(v) for v in value]

    # THE CATCH-ALL. Not a fallthrough that forgot to convert -- the reason this
    # function cannot fail. See the module docstring.
    return str(value)


def dumps_tool_result(payload: Any) -> str:
    """Serialise one tool result for the turn that carries it back to the model.

    The only json.dumps on this path. `default=` makes it total: there is no
    value it can be handed that ends the conversation instead of the turn.
    """
    return json.dumps(payload, default=to_json_safe)
