"""Arm resolution in the A/B harness, and the env-clobber that invalidated a run.

THE BUG THIS FILE EXISTS TO STOP REPEATING. run_arm used to do

    os.environ[f"LLM_CHAIN_EVAL_{arm.upper()}"] = ARMS[arm]

unconditionally, immediately before chain_for() read that variable back. So an
exported LLM_CHAIN_EVAL_OLLAMA was overwritten before it could take effect, and
the module's own load_dotenv(..., override=False) -- written so "an exported var
still wins" -- was defeated for the one value that decides WHICH MODEL RAN.

It is not hypothetical. insights.txt line 4 exports
`ollama:a-kore/Arctic-Text2SQL-R1-7B`; line 33 of the same transcript logs
`llm ollama/qwen3:8b failed`. ARMS["ollama"] has never held anything but
qwen3:8b in git history, so every run ever taken through `--arms ollama` measured
qwen3:8b, whatever the operator exported. Three runs of findings were attributed
to a model that was never loaded.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for arm in ("ANTHROPIC", "DEEPINFRA", "OLLAMA", "OLLAMA_PIPELINE",
                "OLLAMA_PIPELINE_LOO", "OLLAMA_PIPELINE_BARE", "NARRATOR"):
        monkeypatch.delenv(f"LLM_CHAIN_EVAL_{arm}", raising=False)


def test_an_exported_chain_wins_over_the_built_in_default():
    """The whole point. Without this the eval cannot be pointed at a different
    model at all, and says nothing about the one you exported."""
    import os
    from evals import insights_ab

    os.environ["LLM_CHAIN_EVAL_OLLAMA"] = "ollama:a-kore/Arctic-Text2SQL-R1-7B"
    try:
        assert insights_ab.spec_for("ollama") == "ollama:a-kore/Arctic-Text2SQL-R1-7B"
    finally:
        del os.environ["LLM_CHAIN_EVAL_OLLAMA"]


def test_the_built_in_default_applies_when_nothing_is_exported():
    from evals import insights_ab

    assert insights_ab.spec_for("ollama") == insights_ab.ARMS["ollama"]


def test_the_pipeline_arms_default_to_the_sql_specialist():
    from evals import insights_ab

    for arm in insights_ab.PIPELINE_ARMS:
        assert insights_ab.spec_for(arm) == "ollama:a-kore/Arctic-Text2SQL-R1-7B"


def test_every_pipeline_arm_is_a_selectable_arm():
    from evals import insights_ab

    assert set(insights_ab.PIPELINE_ARMS) <= set(insights_ab.ARMS)


def test_the_three_pipeline_arms_are_the_three_retrieval_conditions():
    """full / held-out / none. The three columns ARE the measurement: `none`
    isolates what retrieval buys at all, and full-versus-loo separates copying an
    exemplar from generalising past one."""
    from evals import insights_ab

    assert set(insights_ab.PIPELINE_ARMS.values()) == {"full", "loo", "none"}


def test_the_narrator_is_resolved_through_the_same_mechanism_as_an_arm():
    """One way to point the harness at a model, not two."""
    import os
    from evals import insights_ab

    assert insights_ab.spec_for("narrator").startswith("ollama:")
    os.environ["LLM_CHAIN_EVAL_NARRATOR"] = "ollama:something-else"
    try:
        assert insights_ab.spec_for("narrator") == "ollama:something-else"
    finally:
        del os.environ["LLM_CHAIN_EVAL_NARRATOR"]


def test_a_request_id_is_stable_across_processes():
    """run_arm built these from abs(hash(question)). Python salts string hashing per
    process, so the same question produced a different id on every run and nothing
    could be traced from an ai_calls row back to the question that caused it."""
    from evals.insights_ab import request_id_for

    assert request_id_for("ollama", "How many jobs are late right now?") == \
        request_id_for("ollama", "How many jobs are late right now?")
    assert request_id_for("ollama", "a") != request_id_for("ollama", "b")
    assert request_id_for("ollama", "a") != request_id_for("anthropic", "a")


def test_the_greedy_provider_asks_for_deterministic_decoding():
    """No Ollama call in this repo has ever been greedy: OpenAICompatProvider._body
    sends model, messages, max_tokens and stream, and the registry's ollama branch
    adds only reasoning_effort. A non-deterministic generator makes a pinned
    expectation meaningless and two runs incomparable."""
    from evals.insights_ab import greedy_ollama

    provider = greedy_ollama("ollama:qwen3:8b")

    assert provider.model == "qwen3:8b"
    assert provider._extra_body["temperature"] == 0
    assert provider._extra_body["seed"] == 0


def test_the_greedy_provider_keeps_the_whole_ollama_tag():
    """`ollama:qwen3:8b` splits on the FIRST colon only. A naive split truncates the
    model to `qwen3`, which is a different model and would silently answer."""
    from evals.insights_ab import greedy_ollama

    assert greedy_ollama("ollama:a-kore/Arctic-Text2SQL-R1-7B").model == \
        "a-kore/Arctic-Text2SQL-R1-7B"


def test_a_non_ollama_spec_for_a_pipeline_arm_is_refused_rather_than_coerced():
    from evals.insights_ab import greedy_ollama

    with pytest.raises(ValueError, match="ollama"):
        greedy_ollama("anthropic")


def test_the_sidecar_sits_beside_the_dump_rather_than_behind_a_new_flag():
    from pathlib import Path
    from evals.insights_ab import stages_path

    assert stages_path(Path("insights_ab.json")) == Path("insights_ab_stages.json")
    assert stages_path(Path("/tmp/run7.json")) == Path("/tmp/run7_stages.json")


def test_the_dump_keeps_its_eight_key_per_arm_shape():
    """The blind side-by-side read depends on it. Stage detail goes to the sidecar
    precisely so that one arm does not visibly carry SQL while the others do not."""
    from evals.insights_ab import Outcome, dump_entry

    entry = dump_entry(Outcome(arm="ollama_pipeline", question="q", ok=True, answer="a"))

    assert set(entry) == {"ok", "answered", "answer", "error", "latency_ms",
                          "cost_usd", "tool_calls", "chart_valid"}


def test_tool_calls_stays_a_count_in_the_dump_even_though_the_handler_returns_names():
    """Both handlers return a LIST of tool names; the dump has always stored the
    length. Keeping it an int is what makes a pipeline run comparable to the Claude
    baseline already on disk."""
    from evals.insights_ab import Outcome, dump_entry

    entry = dump_entry(Outcome(arm="ollama_pipeline", question="q", ok=True,
                               answer="4 jobs are late.", tool_calls=2))
    assert entry["tool_calls"] == 2


@pytest.mark.parametrize("arm", ["anthropic", "ollama", "ollama_pipeline"])
async def test_every_arm_is_told_what_day_it_is(arm, monkeypatch):
    """OMITTING `today` WOULD INVALIDATE A RUN WITHOUT FAILING IT. The validator now
    refuses CURRENT_DATE, so a date-bounded question has to arrive as $2 -- and
    sql_executor binds whatever it is handed, turning `None` into SQL NULL rather
    than into an error. `due_date < $2::date` is then NULL, the WHERE keeps nothing,
    and the arm reports zero late jobs with no error on any layer. Four of the
    eleven questions are date-bounded.
    """
    import datetime

    from evals import insights_ab

    seen: dict = {}

    async def fake_handler(ctx):
        seen.update(ctx.payload)
        return {"answer": "ok", "tool_calls": [], "provider": "p", "model": "m",
                "tokens_used": 1, "not_permitted": 0, "chart_config": None}

    monkeypatch.setattr(insights_ab, "handler_for", lambda _f: fake_handler)
    monkeypatch.setattr(insights_ab, "chain_for", lambda _f: ["chain"], raising=False)
    monkeypatch.setattr("services.llm.registry.chain_for", lambda _f: ["chain"])
    monkeypatch.setattr(
        "services.insights_pipeline.pipeline.run", fake_handler, raising=False
    )
    monkeypatch.setattr("services.insights_pipeline.run", fake_handler, raising=False)

    await insights_ab.run_arm(arm, "45a29b26-317e-483a-8cc4-10fb676f1273", "q", index=object())

    assert seen.get("today") == datetime.date.today().isoformat()
