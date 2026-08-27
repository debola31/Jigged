"""Table cards are DERIVED from SCHEMA_CONTEXT, never a second list of table names.

THE BUG THIS FILE EXISTS TO STOP REPEATING. api/tools/sql_validator.py used to
carry a hand-written ALLOWED_TABLES list, and migration 20260826010319 deleted it
because it had drifted: 19 names in Python against 21 grants in the database. A
schema linker needs a card per table, and the lazy way to get one is another
hand-written list -- which would rot exactly the same way, except that this time
the symptom is a table the linker can never surface, so the model is asked a
question about data it is silently never shown.

So the only hand-written thing in a card is its one-line purpose. The NAME set
and the schema BLOCK both come out of SCHEMA_CONTEXT, and the first test below
fails the build the moment the two disagree in either direction.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit


def _schema_context_tables() -> set[str]:
    """The table names in SCHEMA_CONTEXT, found the same way a reader would.

    Deliberately re-derived here with its own regex rather than imported from the
    module under test: a pin that calls the implementation to decide what it
    should equal is a mirror, and would pass however the parser broke.
    """
    from tools.schema_context import SCHEMA_CONTEXT

    return set(re.findall(r"^###\s+(\w+)", SCHEMA_CONTEXT, re.M))


def test_every_schema_context_table_has_a_card_and_no_card_invents_one():
    from services.insights_pipeline.retrieval import load_cards

    cards = {c.name for c in load_cards()}
    schema = _schema_context_tables()

    assert cards == schema, (
        f"cards and SCHEMA_CONTEXT disagree. Missing a card: {sorted(schema - cards)}. "
        f"Card for a table that is not in the schema: {sorted(cards - schema)}. "
        "Fix data/purposes.json -- the table names are not editable here, they are "
        "whatever SCHEMA_CONTEXT says."
    )


def test_every_card_carries_a_purpose_written_for_a_shop_owner():
    from services.insights_pipeline.retrieval import load_cards

    for card in load_cards():
        assert card.purpose.strip(), f"{card.name} has an empty purpose"
        # A purpose that is just the table name back again embeds to nothing useful.
        assert card.purpose.strip().lower() != card.name.lower(), (
            f"{card.name}'s purpose is its own name; the question is scored against "
            "this string, so it has to say what the table is FOR."
        )


def test_a_cards_block_is_the_verbatim_schema_context_slice():
    """Not a paraphrase. The block is what goes into the generation prompt, and a
    summarised column list is how a model comes to believe in `due_at`."""
    from tools.schema_context import SCHEMA_CONTEXT
    from services.insights_pipeline.retrieval import load_cards

    for card in load_cards():
        assert card.block in SCHEMA_CONTEXT, (
            f"{card.name}'s block is not a literal substring of SCHEMA_CONTEXT"
        )
        assert card.block.startswith(f"### {card.name}"), (
            f"{card.name}'s block starts with {card.block[:40]!r}"
        )


def test_a_block_stops_before_the_next_table():
    """jobs must not carry job_parts' columns: an over-long slice would put every
    later table back in the prompt and quietly undo the linking."""
    from services.insights_pipeline.retrieval import load_cards

    by_name = {c.name: c for c in load_cards()}
    assert "### job_parts" not in by_name["jobs"].block
    # The last table before the prose sections must not swallow them.
    assert "## Key Relationships" not in by_name["inventory_transactions"].block


def test_schema_for_returns_only_the_named_tables():
    from services.insights_pipeline.retrieval import schema_for

    rendered = schema_for(["jobs", "customers"])
    assert "### jobs" in rendered
    assert "### customers" in rendered
    assert "### shipments" not in rendered
    assert "### quotes" not in rendered


def test_schema_for_is_stable_in_schema_context_order():
    """The prompt is a cache prefix. Ordering by the caller's argument list would
    make two questions that linked the same tables produce two different prompts."""
    from services.insights_pipeline.retrieval import schema_for

    assert schema_for(["jobs", "customers"]) == schema_for(["customers", "jobs"])


def test_the_purposes_file_ships_inside_the_api_package():
    """The rule test_semantics_is_bundled.py exists to enforce, applied to this
    package's own data. Anything outside api/ is dropped from the Vercel function
    bundle by vercel.json's excludeFiles: it resolves on a laptop and in CI, and
    raises FileNotFoundError in production."""
    from services import insights_service
    from services.insights_pipeline import retrieval

    api_root = Path(insights_service.__file__).resolve().parents[1]
    assert retrieval.PURPOSES_PATH.is_relative_to(api_root), (
        f"{retrieval.PURPOSES_PATH} is outside the api package at {api_root}"
    )
    assert retrieval.PURPOSES_PATH.is_file()
