"""What the model offers next, and which definitions it is shown.

Two changes from 2026-09-09 that share a motive: the assistant answered "how many
open quotes do we have?" three different ways in one afternoon, and a shop owner
had no way to tell which was right or what else to ask. Follow-ups make the surface
suggest its own next step; the semantics tail is what keeps the definitions that
prevent the wrong answer affordable as they multiply.
"""
from __future__ import annotations

import asyncio

import pytest

from services.insights_presentation import (
    FOLLOW_UP_MAX_CHARS,
    MAX_FOLLOW_UPS,
    _extract_follow_ups,
    _strip_code_blocks,
)
from services.insights_pipeline.semantics_retrieval import (
    CORE_HEADING,
    load_sections,
    select_sections,
)
from services.insights_service import (
    _build_chat_system_prompt,
    load_semantics,
    semantics_for,
    semantics_retrieval_enabled,
)


def _fenced(payload: str) -> str:
    return f"We have 6 open quotes.\n```json\n{payload}\n```"


class TestFollowUpsAreAGarnish:
    """Every malformed shape returns [], because none of them may cost the answer."""

    def test_the_happy_path_reads_them_in_order(self):
        got = _extract_follow_ups(
            _fenced('{"follow_ups": ["What are those worth?", "Which expire this month?"]}'),
            "how many open quotes do we have?",
        )
        assert got == ["What are those worth?", "Which expire this month?"]

    @pytest.mark.parametrize(
        "payload",
        [
            '{"follow_ups": "not a list"}',
            '{"follow_ups": {"a": 1}}',
            '{"follow_ups": [1, 2, 3]}',
            '{"follow_ups": []}',
            '{"chart_type": "bar"}',
            "{not json at all",
        ],
        ids=["string", "object", "numbers", "empty", "wrong-key", "unparseable"],
    )
    def test_anything_unexpected_offers_nothing(self, payload):
        assert _extract_follow_ups(_fenced(payload), "q") == []

    def test_no_fence_offers_nothing(self):
        assert _extract_follow_ups("Just a sentence.", "q") == []

    def test_a_restatement_of_the_question_is_dropped(self):
        """Offering the question back is a loop, not a next step."""
        got = _extract_follow_ups(
            _fenced('{"follow_ups": ["How many open quotes do we have?", "What are they worth?"]}'),
            "how many open quotes do we have?",
        )
        assert got == ["What are they worth?"]

    def test_duplicates_collapse(self):
        got = _extract_follow_ups(
            _fenced('{"follow_ups": ["What are they worth?", "what are they WORTH", "Which expire?"]}'),
            "q",
        )
        assert got == ["What are they worth?", "Which expire?"]

    def test_an_overlong_one_is_dropped_and_the_rest_survive(self):
        got = _extract_follow_ups(
            _fenced('{"follow_ups": ["' + "a" * (FOLLOW_UP_MAX_CHARS + 1) + '", "Short one?"]}'),
            "q",
        )
        assert got == ["Short one?"]

    def test_it_never_returns_more_than_the_cap(self):
        many = ", ".join(f'"Question number {i}?"' for i in range(10))
        got = _extract_follow_ups(_fenced('{"follow_ups": [' + many + "]}"), "q")
        assert len(got) == MAX_FOLLOW_UPS

    def test_the_fence_never_reaches_the_reader(self):
        """The scrub the answer already goes through removes every fence, so the
        block costs the reader nothing whether it parses or not."""
        raw = _fenced('{"follow_ups": ["What are they worth?"]}')
        assert "follow_ups" not in _strip_code_blocks(raw)
        assert _strip_code_blocks(raw) == "We have 6 open quotes."


class TestTheSemanticsTail:
    def test_every_section_is_derived_from_the_file(self):
        sections = load_sections()
        headings = [s.heading for s in sections]
        assert CORE_HEADING in headings
        assert "Open quote" in headings, (
            "the section added for the 16-vs-6 bug is not being parsed out"
        )
        # Derived, not listed: the count follows the file.
        assert len(headings) == load_semantics().count("\n## ") + (
            1 if load_semantics().startswith("## ") else 0
        )

    def test_the_core_section_is_never_dropped(self):
        """It carries $1, $2, the refusal of CURRENT_DATE and the archived-rows rule
        -- preconditions for writing any query, not facts about one term."""

        async def only_the_last_wins(texts):
            # Scores every candidate at zero except the final one.
            return [[0.0, 1.0]] + [[1.0 if i == len(texts) - 2 else 0.0, 0.0] for i in range(len(texts) - 1)]

        out = asyncio.run(select_sections("anything", top_k=1, embed_fn=only_the_last_wins))
        assert f"## {CORE_HEADING}" in out

    def test_it_selects_by_similarity_and_renders_in_file_order(self):
        async def quotes_win(texts):
            return [[1.0 if "quote" in t.lower() else 0.0, 1.0] for t in texts]

        out = asyncio.run(
            select_sections("how many open quotes do we have?", top_k=2, embed_fn=quotes_win)
        )
        kept = [line for line in out.splitlines() if line.startswith("## ")]
        assert f"## {CORE_HEADING}" in kept
        assert "## Open quote" in kept
        # File order, not score order: Open quote refers forward to Quote pipeline worth.
        assert kept == sorted(kept, key=lambda h: load_semantics().index(h))
        assert len(out) < len(load_semantics())

    def test_a_bad_embedder_response_asks_for_the_whole_file(self):
        async def too_few(texts):
            return [[1.0, 0.0]]

        assert asyncio.run(select_sections("q", embed_fn=too_few)) == ""


class TestTheTailIsOptional:
    def test_it_is_off_by_default_and_the_prompt_carries_everything(self, monkeypatch):
        monkeypatch.delenv("INSIGHTS_SEMANTICS_RETRIEVAL", raising=False)
        assert semantics_retrieval_enabled() is False
        assert asyncio.run(semantics_for("how many open quotes?")) == load_semantics()
        assert _build_chat_system_prompt().endswith(load_semantics())

    def test_a_failing_retrieval_falls_back_to_the_whole_file(self, monkeypatch):
        """The only direction it is safe to be wrong in: a longer prompt, never a
        missing business rule."""
        monkeypatch.setenv("INSIGHTS_SEMANTICS_RETRIEVAL", "on")
        assert semantics_retrieval_enabled() is True
        import services.insights_pipeline.semantics_retrieval as sr

        async def boom(*a, **k):
            raise RuntimeError("ollama is not running")

        monkeypatch.setattr(sr, "select_sections", boom)
        assert asyncio.run(semantics_for("how many open quotes?")) == load_semantics()

    def test_no_question_means_the_whole_file(self, monkeypatch):
        """report.py builds the prompt with no question and must keep every rule."""
        monkeypatch.setenv("INSIGHTS_SEMANTICS_RETRIEVAL", "on")
        assert asyncio.run(semantics_for(None)) == load_semantics()

    def test_retrieval_is_awaited_not_blocked_on(self):
        """The backend path runs the handler on FastAPI's request loop.

        A blocking .result() there -- which is what the first version of this did,
        so that the prompt builder could stay synchronous -- stalls every other
        request for the length of an embedding round trip. Pinned as a shape: the
        selector is a coroutine function, and the prompt builder takes the finished
        text rather than going and getting it.
        """
        import inspect

        assert inspect.iscoroutinefunction(semantics_for)
        assert not inspect.iscoroutinefunction(_build_chat_system_prompt)
        assert "semantics" in inspect.signature(_build_chat_system_prompt).parameters


class TestThePromptSaysWhatChanged:
    def test_a_question_about_the_conversation_is_answered_from_it(self):
        """The 'why did you say 16 earlier?' failure: the model re-ran the metric and
        re-emitted the same sentence three times."""
        prompt = _build_chat_system_prompt()
        assert "ABOUT THE CONVERSATION" in prompt
        assert "call no tool" in prompt
        assert "word for word" in prompt

    def test_the_follow_up_contract_is_stated_with_its_limits(self):
        prompt = _build_chat_system_prompt()
        assert "follow_ups" in prompt
        assert str(FOLLOW_UP_MAX_CHARS) in prompt
        assert "Offer none at all rather than a weak one" in prompt
