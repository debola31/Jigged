"""`<think>` blocks are stripped unconditionally, before validation and before return.

WHY THIS IS ITS OWN FILE. Qwen3 emits reasoning by default and the suppression
knobs are unreliable: `think: false` is Ollama's NATIVE-API parameter and does
nothing on the `/v1` OpenAI-compatible path this layer uses, and DeepInfra does
not document `enable_thinking` at all. Both are sent as best-effort extra body
keys, and neither is the guarantee. This function is the guarantee.

What goes wrong without it is not cosmetic. A `<think>` block reaching a JSON
validator turns a correct answer into a schema failure and burns the one retry;
a `<think>` block reaching a shop owner turns a product into a debug log.
"""
from __future__ import annotations

import json

import pytest

from services.llm.postprocess import strip_think

pytestmark = pytest.mark.unit


class TestStripping:
    def test_a_single_block_is_removed_with_its_tags(self):
        assert strip_think("<think>weighing options</think>Answer") == "Answer"

    def test_multiple_blocks_are_all_removed(self):
        assert strip_think("<think>a</think>One<think>b</think>Two") == "OneTwo"

    def test_nested_tags_leave_no_stray_closing_tag(self):
        """A naive non-greedy regex stops at the FIRST </think> and leaves the
        outer block's tail — 'outer</think>' — sitting in the answer."""
        out = strip_think("<think>outer<think>inner</think>outer</think>Answer")
        assert out == "Answer"
        assert "</think>" not in out

    def test_an_unclosed_block_swallows_the_rest_of_the_response(self):
        """A model that hits max_tokens mid-thought emits an opening tag with no
        close. Everything after it is reasoning by construction, so returning it
        would leak the chain of thought as though it were the answer."""
        assert strip_think("Prefix<think>reasoning that never ends") == "Prefix"

    def test_a_closing_tag_with_no_opening_tag_is_removed_but_the_text_survives(self):
        """The opposite call from the unclosed case, deliberately. A stray
        </think> is a token-emission artefact, not a signal that everything
        before it was reasoning."""
        assert strip_think("Answer</think> more") == "Answer more"

    def test_the_tag_match_is_case_insensitive_and_tolerates_attributes(self):
        assert strip_think("<Think>x</Think>Answer") == "Answer"
        assert strip_think('<think type="reasoning">x</think>Answer') == "Answer"
        assert strip_think("<think>x</think >Answer") == "Answer"

    def test_whitespace_is_normalised_after_the_strip(self):
        """Without this every stripped response arrives with a leading blank line
        and every downstream `.startswith('{')` check fails."""
        assert strip_think("<think>x</think>\n\n  Answer  \n") == "Answer"
        assert strip_think("<think>a</think>\n<think>b</think>\nAnswer") == "Answer"

    def test_a_response_with_no_block_is_returned_unchanged(self):
        text = '{"headline":"x","confidence":0.9}'
        assert strip_think(text) == text


class TestTheCasesThatCostSomething:
    def test_json_inside_a_think_block_does_not_leak_into_the_validated_text(self):
        """THE RETRY-LOOP KILLER. A reasoning model drafts the object inside its
        thinking, then emits the real one. Strip naively and the DRAFT is what
        validates — schema-valid, confidently wrong, and indistinguishable from a
        correct answer downstream."""
        raw = '<think>{"headline":"draft","confidence":0.1}</think>{"headline":"final","confidence":0.9}'
        assert json.loads(strip_think(raw))["headline"] == "final"

    def test_a_think_tag_inside_a_legitimate_json_string_value_is_left_alone(self):
        """A blind regex corrupts valid JSON here. The strip only fires on a block
        at the START of the response, which is where a reasoning model actually
        emits one — a model quoting the literal string mid-value must survive."""
        raw = '{"headline":"the model wrote <think> in its answer","confidence":0.5}'
        out = strip_think(raw)
        assert out == raw
        assert json.loads(out)["headline"].endswith("in its answer")

    def test_a_response_that_is_entirely_reasoning_becomes_empty_rather_than_wrong(self):
        """strip_think returns '' and does not raise: the caller decides. The
        gateway turns an empty result into LLMEmptyResponse, because an empty
        string returned as an answer is the exact silent-degradation shape the
        whole layer exists to refuse."""
        assert strip_think("<think>all of it</think>") == ""
        assert strip_think("<think>never closes") == ""
        assert strip_think("   \n  ") == ""
