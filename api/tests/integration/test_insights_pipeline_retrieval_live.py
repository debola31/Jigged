"""Retrieval against the real embedding model. Skipped wherever Ollama is not up.

WHY THIS FILE IS SEPARATE FROM THE UNIT TESTS. Everything in
tests/unit/test_insights_pipeline_retrieval.py runs on synthetic vectors whose
cosines the test chose, which makes the LOGIC assertions real and any assertion
about MEANING vacuous. "Does nomic-embed-text put 'work centre' near work_centers"
is a fact about the model. It cannot be tested against a fixture I wrote, and it
is the fact the whole schema-linking stage rests on.

CI HAS NO OLLAMA -- .github/workflows/test.yml provisions Supabase and an
AI_READONLY_DATABASE_URL and nothing else -- so this skips there. It is for the
box that is about to run the eval, and it is the cheapest way to find out that the
0.70 floor has moved before spending an hour of model time discovering it.

WHY THE ASSERTIONS ARE DIRECTIONAL, NOT EXACT. The floor was measured at 0.70
against a payroll-to-gross-profit score of 0.620 and an overdue-phrasing score of
0.637. Pinning those digits would fail on a re-quantised model tag for no reason.
What has to hold is the ORDERING they imply: payroll must stay under the floor and
a real shop phrasing of a covered question must clear it. The scores are printed
so a drift is visible even when the test passes.
"""
from __future__ import annotations

import math
import os

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.slow]

PAYROLL = "What is our net profit margin after payroll?"
OVERDUE = "how many jobs are overdue"
WORK_CENTRE = "Which work centre has the most operations queued?"
REVENUE = "What is my revenue trend over time?"


@pytest.fixture(scope="module")
async def index():
    from services.insights_pipeline.embeddings import EmbeddingUnavailable, embed_texts
    from services.insights_pipeline.retrieval import build_index

    try:
        return await build_index(embed_texts)
    except EmbeddingUnavailable as exc:
        pytest.skip(f"no embedding model reachable: {exc}")


async def _vector(question: str):
    from services.insights_pipeline.embeddings import embed_texts
    from services.insights_pipeline.retrieval import embed_question

    return await embed_question(embed_texts, question)


async def test_the_model_returns_the_dimensions_the_floor_was_measured_at(index):
    """A different embedding size means a different model, and every tuned number
    in data/pairs.json was measured against this one."""
    assert len(index.card_vectors[0]) == 768


async def test_every_vector_is_unit_length(index):
    """embeddings.l2_normalize does this rather than trusting the server, because
    Ollama returns raw vectors for nomic-bert on the legacy path and the /v1 path
    has not been consistent across versions. Cosine over unnormalised vectors ranks
    wrongly and never errors."""
    for vec in index.card_vectors:
        assert math.isclose(math.sqrt(sum(v * v for v in vec)), 1.0, abs_tol=1e-6)


async def test_the_payroll_question_retrieves_nothing(index):
    """THE CASE THE FLOOR WAS SET FOR. The nearest exemplar is gross profit, which
    is the exact proxy that produced 'net profit margin after payroll: 67.9%' in the
    Gate 1 eval. An exemplar just under the bar is worse than no exemplar."""
    from services.insights_pipeline.embeddings import cosine
    from services.insights_pipeline.retrieval import RETRIEVAL_FLOOR, retrieve_pairs

    vector = await _vector(PAYROLL)
    best = {
        pair.id: max(cosine(vector, v) for v in vecs)
        for pair, vecs in zip(index.pairs, index.pair_vectors)
    }
    print("\npayroll scores:", {k: round(v, 3) for k, v in sorted(best.items(), key=lambda kv: -kv[1])})

    assert retrieve_pairs(vector, index) == [], (
        f"payroll retrieved an exemplar. Top scores: {best}. The floor is "
        f"{RETRIEVAL_FLOOR}."
    )


async def test_a_real_shop_phrasing_still_reaches_its_exemplar(index):
    """The reason aliases exist: 'overdue' sits under the floor against the
    canonical wording and well over it against a natural alias."""
    from services.insights_pipeline.retrieval import retrieve_pairs

    hits = retrieve_pairs(await _vector(OVERDUE), index)
    print(f"\n{OVERDUE!r} -> {[(h.pair.id, round(h.score, 3), h.matched) for h in hits]}")

    assert any(h.pair.id == "late_jobs" for h in hits)


async def test_a_paraphrase_that_is_not_a_registered_alias_still_reaches_its_exemplar(index):
    """If the test phrasing were an alias this would measure string identity. These
    are deliberately absent from data/pairs.json."""
    from services.insights_pipeline.retrieval import load_pairs, retrieve_pairs

    registered = {p for pair in load_pairs() for p in pair.phrasings}
    cases = {
        "who buys the most from us": "top_customer_by_revenue",
        "which jobs have missed their deadline": "late_jobs",
    }
    for phrasing, expected in cases.items():
        assert phrasing not in registered, f"{phrasing!r} is a registered alias"
        if expected is None:
            continue
        hits = retrieve_pairs(await _vector(phrasing), index)
        print(f"\n{phrasing!r} -> {[(h.pair.id, round(h.score, 3)) for h in hits]}")
        assert any(h.pair.id == expected for h in hits), (
            f"{phrasing!r} did not reach {expected}; got "
            f"{[(h.pair.id, round(h.score, 3)) for h in hits]}"
        )


async def test_the_british_spelling_reaches_the_work_centers_card(index):
    """The eval asks 'which work CENTRE has the most operations queued' and an
    earlier arm answered by inventing job_operations.work_centre. If the linker
    cannot cross that spelling, the one table the question is about never reaches
    the prompt."""
    from services.insights_pipeline.retrieval import link_tables

    linked = link_tables(await _vector(WORK_CENTRE), index)
    print(f"\n{WORK_CENTRE!r} -> {linked}")

    assert "work_centers" in linked
    assert "job_operations" in linked


async def test_revenue_earns_the_shipment_tables_that_are_not_in_the_spine(index):
    """shipments and shipment_line_items are deliberately left out of CORE_SPINE so
    that stage 1 can be observed to fail on the question that most depends on it.
    This is that observation."""
    from services.insights_pipeline.retrieval import link_tables

    linked = link_tables(await _vector(REVENUE), index)
    print(f"\n{REVENUE!r} -> {linked}")

    assert "shipments" in linked


async def test_the_linked_tables_for_every_eval_question_are_recorded(index):
    """Not a pass/fail on any single question -- a printed record of what stage 1
    actually does on the eleven, so a drift in the model shows up here rather than
    as an unexplained drop in the arm's score."""
    from evals.insights_ab import DEFAULT_QUESTIONS
    from services.insights_pipeline.retrieval import CORE_SPINE, link_tables

    for question in DEFAULT_QUESTIONS:
        linked = link_tables(await _vector(question), index)
        print(f"\n{question:<52} {linked}")
        assert set(CORE_SPINE) <= set(linked)
