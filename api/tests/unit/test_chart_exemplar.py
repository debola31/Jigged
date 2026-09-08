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
from services.insights_service import _build_chat_system_prompt, load_semantics

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
    def test_the_prompt_carries_the_example_verbatim_at_the_tail(self):
        prompt = _build_chat_system_prompt()
        assert json.dumps(CHART_EXEMPLAR, indent=2) in prompt
        assert CHART_EXEMPLAR_QUESTION in prompt and CHART_EXEMPLAR_ANSWER in prompt
        # AFTER semantics.md: the bytes before it are the prefix the KV cache reuses.
        assert prompt.index(load_semantics()) < prompt.index(CHART_EXEMPLAR_QUESTION)

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
