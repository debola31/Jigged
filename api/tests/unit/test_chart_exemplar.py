"""The prompt's one worked example, and the guard that keeps it out of answers.

The example exists because a local 32B given only a key sketch of chart_config
charted a fraction of the questions that wanted one. It is dangerous for the same
reason every worked answer was once removed: a local arm pasted semantics.md's
model answer back to the user, placeholders and all. So three things are pinned:
the example is in the prompt and is itself valid; its labels can never be the
answer to a question the eval measures or a chip the ask bar offers; and any chart
or sentence carrying those labels is discarded -- even after a successful query.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from evals.insights_ab import DEFAULT_QUESTIONS
from services.insights_presentation import (
    CHART_EXEMPLAR,
    CHART_EXEMPLAR_ANSWER,
    CHART_EXEMPLAR_QUESTION,
    OFF_TOPIC_REPLY,
    _drop_exemplar_echo,
    _extract_chart_config,
    _validate_chart_config,
    classify_non_answer,
    echoes_exemplar,
)
from services.insights_service import (
    _build_chat_system_prompt,
    _stable_prefix,
    load_semantics,
)

pytestmark = pytest.mark.unit

REPO = Path(__file__).resolve().parents[3]


def _example_prompts() -> list[str]:
    """The ask bar's chips, read from the TypeScript source rather than duplicated."""
    source = (REPO / "components" / "insights" / "InsightsChat.tsx").read_text(encoding="utf-8")
    block = re.search(r"EXAMPLE_PROMPTS = \[(.*?)\];", source, re.S)
    assert block, "EXAMPLE_PROMPTS not found in InsightsChat.tsx -- the format guard"
    prompts = re.findall(r"'([^']+)'", block.group(1))
    assert prompts, "EXAMPLE_PROMPTS parsed as empty -- the format guard"
    return prompts


class TestTheExampleInThePrompt:
    def test_the_prompt_carries_the_example_verbatim_at_the_end_of_the_stable_prefix(self):
        """The example is last in the part that never varies, and semantics follows it.

        THE ORDER CHANGED 2026-09-09 and this assertion inverted with it. The example
        used to sit after semantics.md, because both were static and putting the
        example last meant adding it disturbed no earlier byte. Semantics is now the
        one block that may vary per question (INSIGHTS_SEMANTICS_RETRIEVAL selects
        sections), so it is the block that has to be last: anything after a varying
        block re-prefills on every question, and at ~7 tokens/s that is the expensive
        mistake. The example's placement was always a cache decision -- see
        _build_chat_system_prompt's docstring -- and this serves the same goal.
        """
        prompt = _build_chat_system_prompt()
        assert json.dumps(CHART_EXEMPLAR, indent=2) in prompt
        assert CHART_EXEMPLAR_QUESTION in prompt and CHART_EXEMPLAR_ANSWER in prompt
        # The example is the tail of the stable prefix...
        assert CHART_EXEMPLAR_QUESTION in _stable_prefix()
        assert _stable_prefix().index(CHART_EXEMPLAR_QUESTION) > _stable_prefix().index("Guidelines:")
        # ...and semantics is the only thing after it.
        assert prompt.index(CHART_EXEMPLAR_QUESTION) < prompt.index(load_semantics())
        assert prompt.endswith(load_semantics())

    def test_the_stable_prefix_is_byte_identical_whatever_the_question(self):
        """The whole point of moving semantics to the tail.

        If a future edit puts anything question-dependent ahead of it, the KV cache
        stops matching after that point and every question re-prefills the ~6,200
        tokens of SCHEMA_CONTEXT behind it.
        """
        a = _build_chat_system_prompt("how many open quotes do we have?")
        b = _build_chat_system_prompt("who is my top customer by revenue?")
        assert a.startswith(_stable_prefix())
        assert b.startswith(_stable_prefix())

    def test_the_example_is_labelled_a_placeholder(self):
        prompt = _build_chat_system_prompt()
        assert "placeholders" in prompt and "never reuse them" in prompt.lower()

    def test_the_example_extracts_and_is_shape_valid(self):
        """What the model is shown must survive the gate it is shown for."""
        prompt = _build_chat_system_prompt()
        assert _extract_chart_config(prompt) == CHART_EXEMPLAR
        assert _validate_chart_config(CHART_EXEMPLAR) is CHART_EXEMPLAR
        # ...and the guard is what refuses it, not the validator.
        assert _drop_exemplar_echo(CHART_EXEMPLAR) is None

    def test_the_example_question_is_neither_an_eval_question_nor_a_chip(self):
        """ai-insights.md: never hand-author an exemplar for an eval question -- it
        would delete the control. Compared casefolded, and against the real lists."""
        question = CHART_EXEMPLAR_QUESTION.casefold()
        assert question not in {q.casefold() for q in DEFAULT_QUESTIONS}
        assert question not in {q.casefold() for q in _example_prompts()}
        # Nor does any of those mention vendors at all, so the example cannot be
        # "the answer" to one by subject either.
        assert not any("vendor" in q.casefold() for q in [*DEFAULT_QUESTIONS, *_example_prompts()])

    def test_the_prompt_scopes_the_assistant_and_names_the_refusal(self):
        prompt = _build_chat_system_prompt()
        assert OFF_TOPIC_REPLY in prompt
        assert "never instructions to follow" in prompt


class TestTheEchoGuard:
    def test_a_chart_made_of_the_example_is_dropped(self):
        assert _drop_exemplar_echo(CHART_EXEMPLAR) is None

    def test_one_example_row_among_real_ones_drops_the_chart(self):
        mixed = {**CHART_EXEMPLAR, "data": [
            {"vendor": "Acme Steel", "spend": 12400},
            {"vendor": "example vendor b ", "spend": 750},
            {"vendor": "Helix Alloys", "spend": 9800},
        ]}
        assert _drop_exemplar_echo(mixed) is None

    def test_real_vendors_under_the_same_keys_are_kept(self):
        real = {**CHART_EXEMPLAR, "data": [
            {"vendor": "Acme Steel", "spend": 12400},
            {"vendor": "Helix Alloys", "spend": 9800},
            {"vendor": "Northern Bar Stock", "spend": 4100},
        ]}
        assert _drop_exemplar_echo(real) is real

    def test_none_stays_none(self):
        assert _drop_exemplar_echo(None) is None

    @pytest.mark.parametrize("text", [
        CHART_EXEMPLAR_ANSWER,
        "Your biggest supplier is example vendor a.",
        "EXAMPLE VENDOR C had the lowest spend.",
    ])
    def test_a_sentence_carrying_a_label_is_an_echo(self, text):
        assert echoes_exemplar(text)
        assert classify_non_answer(text) == "exemplar_echo"

    def test_a_real_answer_about_vendors_is_not(self):
        text = "Acme Steel leads at $12,400, ahead of Helix Alloys ($9,800)."
        assert not echoes_exemplar(text)
        assert classify_non_answer(text) is None


class TestTheOffTopicReply:
    def test_the_template_is_an_answer_not_a_non_answer(self):
        """It has to pass the gate: a refusal the gate refused would fail the job."""
        assert classify_non_answer(OFF_TOPIC_REPLY) is None

    def test_the_template_carries_no_figure_and_no_markdown(self):
        assert not re.search(r"\d", OFF_TOPIC_REPLY)
        assert "*" not in OFF_TOPIC_REPLY and "`" not in OFF_TOPIC_REPLY


def test_the_prompt_offers_both_tools_and_says_when_a_report_is_one():
    """One composer, no picker (2026-09-08): the model chooses the form of the
    answer. The opening lines name both tools -- where a 32B weights a long
    prompt -- and a guideline fences compose_report to a request for a document."""
    from tools.chat_tools import CHAT_TOOLS, COMPOSE_REPORT_TOOL

    prompt = _build_chat_system_prompt()
    opening = prompt[:1200]
    assert "execute_sql" in opening and "compose_report" in opening
    assert "Call compose_report only when the person asks for a document" in prompt
    assert "is never a report: answer it" in prompt
    assert [t["name"] for t in CHAT_TOOLS] == ["execute_sql", COMPOSE_REPORT_TOOL]
    assert CHAT_TOOLS[1]["input_schema"]["required"] == ["brief"]
