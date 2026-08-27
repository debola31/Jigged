"""Golden-pair retrieval: the floor, max-over-aliases, and leave-one-out.

WHAT THESE TESTS DELIBERATELY DO NOT MEASURE. Every vector here is synthetic --
two-dimensional, built from an angle, so the cosine between any two texts is
exactly what the test asked for. That makes the LOGIC assertions real (does the
floor cut, is the score the max over phrasings, does leave-one-out fall through to
the runner-up) and makes any assertion about MEANING vacuous. "Does nomic-embed-text
put 'work centre' near work_centers" is a fact about the model, not about this
module, and asserting it against a fixture I wrote would only prove I can write a
fixture. Those live in tests/integration/test_insights_pipeline_embeddings_live.py,
gated on a reachable Ollama.

THE RUNNER-UP RULE IS THE ONE WORTH READING TWICE. Leave-one-out exists to ask
"what would this arm do on a question it has no exemplar for", and the tempting
implementation -- drop the true match, take whatever is next -- answers a different
and much easier question. With the revenue-trend pair removed, the nearest
neighbour to "what is my revenue trend over time" is the TOP-CUSTOMER pair: same
three tables, same joins, different question. Handing that over is precisely the
cross-question displacement the Gate 2 run already produced four times. So a
held-out question that has nothing else above the floor gets NOTHING.
"""
from __future__ import annotations

import math

import pytest

pytestmark = pytest.mark.unit

# Angles chosen so cos(a - b) is the similarity the test wants. 0 deg is the
# reference direction; cos(45.57 deg) == 0.70, the floor.
LATE = 0.0
COST = 0.0


def _emb(angle_deg: float) -> list[float]:
    r = math.radians(angle_deg)
    return [math.cos(r), math.sin(r)]


def _angles_to_embedder(angles: dict[str, float]):
    """A fake embed_fn over a text->angle map, prefixes stripped.

    Unknown text gets a vector orthogonal to everything rather than a KeyError, so
    a test that adds a phrasing without an angle fails on the assertion it cares
    about instead of on setup.
    """
    from services.insights_pipeline.embeddings import DOCUMENT_PREFIX, QUERY_PREFIX

    async def embed(texts):
        out = []
        for t in texts:
            bare = t.removeprefix(QUERY_PREFIX).removeprefix(DOCUMENT_PREFIX)
            out.append(_emb(angles[bare]) if bare in angles else [0.0, 0.0, 1.0][:2])
        return out

    return embed


def _degrees_for(similarity: float) -> float:
    return math.degrees(math.acos(similarity))


async def _index(angles: dict[str, float]):
    from services.insights_pipeline.retrieval import build_index

    return await build_index(_angles_to_embedder(angles))


def _all_phrasings_at(angle: float) -> dict[str, float]:
    """Park every card and pair phrasing far away, so a test only has to name the
    handful of texts it actually cares about."""
    from services.insights_pipeline.retrieval import load_cards, load_pairs

    angles = {c.embed_text: 90.0 for c in load_cards()}
    for p in load_pairs():
        for phrasing in p.phrasings:
            angles[phrasing] = angle
    return angles


# --------------------------------------------------------------- the pairs file


def test_every_pair_resolves_to_sql_that_is_actually_in_semantics():
    """The pairs file holds no SQL. If a section is renamed in semantics.md, this
    fails at load rather than silently retrieving an exemplar with an empty body."""
    from services.insights_pipeline.retrieval import load_pairs

    pairs = load_pairs()
    assert pairs, "no golden pairs loaded"
    for pair in pairs:
        assert pair.sql.strip(), f"{pair.id} resolved to empty SQL"
        assert pair.sql.lstrip().upper().startswith(("SELECT", "WITH")), (
            f"{pair.id} resolved to something that is not a query: {pair.sql[:60]!r}"
        )


def test_the_two_revenue_blocks_resolve_to_different_queries():
    """Revenue is the one section with two ```sql blocks -- the monthly trend and
    the top-customer roll-up. Indexing by section alone would give both pairs the
    first one, and 'who is my top customer' would retrieve a trend query."""
    from services.insights_pipeline.retrieval import load_pairs

    by_id = {p.id: p for p in load_pairs()}
    assert by_id["revenue_trend"].sql != by_id["top_customer_by_revenue"].sql
    assert "DATE_TRUNC('month'" in by_id["revenue_trend"].sql
    # Groups on jobs.customer_name, the SNAPSHOT column, rather than joining
    # customers: the sandbox now hides archived rows, so an inner join to a
    # customer who has since been archived would drop their revenue history.
    assert "customer_name" in by_id["top_customer_by_revenue"].sql


def test_the_three_control_questions_have_no_exemplar():
    """Q5/Q6/Q7 are the within-experiment control and must stay bare. A pair added
    for any of them deletes the only part of the run that measures this pipeline
    without retrieval's help."""
    from evals.insights_ab import DEFAULT_QUESTIONS
    from services.insights_pipeline.retrieval import load_pairs

    sourced = {p.source_question for p in load_pairs()}
    for control in (
        "Which work centre has the most operations queued?",
        "What did we quote last month versus the month before?",
        "Which parts have no routing yet?",
        "What is our net profit margin after payroll?",
    ):
        assert control in DEFAULT_QUESTIONS, f"{control!r} is no longer an eval question"
        assert control not in sourced, (
            f"{control!r} has acquired a golden pair. It is a control question; "
            "seeding it destroys the comparison the arm exists to make."
        )


def test_the_pairs_that_do_answer_an_eval_question_name_it_verbatim():
    """source_question is an exact key -- leave-one-out excludes on it. A pair that
    paraphrases its own eval question would never be held out."""
    from evals.insights_ab import DEFAULT_QUESTIONS
    from services.insights_pipeline.retrieval import load_pairs

    matched = {p.source_question for p in load_pairs()} & set(DEFAULT_QUESTIONS)
    assert len(matched) == 7, f"expected 7 eval-question pairs, got {sorted(matched)}"


# ------------------------------------------------------------------ the floor


async def test_nothing_below_the_floor_is_retrieved():
    """The payroll question must reach the generator with no exemplar at all. An
    exemplar just under the bar is worse than none: gross-profit SQL is exactly the
    proxy that produced 'net profit margin after payroll: 67.9%' in Gate 1."""
    from services.insights_pipeline.retrieval import RETRIEVAL_FLOOR, retrieve_pairs

    angles = _all_phrasings_at(90.0)
    just_under = _degrees_for(RETRIEVAL_FLOOR - 0.01)
    for phrasing in ("What is our gross profit on booked work?",):
        angles[phrasing] = just_under

    index = await _index(angles)
    hits = retrieve_pairs(_emb(0.0), index)

    assert hits == [], f"retrieved {[h.pair.id for h in hits]} from under the floor"


async def test_something_at_the_floor_is_retrieved():
    from services.insights_pipeline.retrieval import RETRIEVAL_FLOOR, retrieve_pairs

    angles = _all_phrasings_at(90.0)
    angles["What is our gross profit on booked work?"] = _degrees_for(RETRIEVAL_FLOOR + 0.01)

    index = await _index(angles)
    hits = retrieve_pairs(_emb(0.0), index)

    assert [h.pair.id for h in hits] == ["cost_and_gross_profit"]


async def test_a_pairs_score_is_the_best_of_its_phrasings_not_its_canonical_one():
    """The reason aliases exist. A real shop phrasing can sit under the floor
    against the canonical question and well over it against a natural alias;
    scoring only the canonical wording would drop it and scoring with a lower floor
    would let the payroll case through."""
    from services.insights_pipeline.retrieval import RETRIEVAL_FLOOR, retrieve_pairs

    angles = _all_phrasings_at(90.0)
    angles["How many jobs are late right now?"] = _degrees_for(RETRIEVAL_FLOOR - 0.06)
    angles["which jobs are past their promised date"] = _degrees_for(RETRIEVAL_FLOOR + 0.16)

    index = await _index(angles)
    hits = retrieve_pairs(_emb(0.0), index)

    assert [h.pair.id for h in hits] == ["late_jobs"]
    assert hits[0].matched == "which jobs are past their promised date"
    assert hits[0].score > RETRIEVAL_FLOOR


async def test_retrieval_is_capped_at_top_k():
    from services.insights_pipeline.retrieval import retrieve_pairs

    index = await _index(_all_phrasings_at(0.0))  # everything identical to the question
    hits = retrieve_pairs(_emb(0.0), index)

    assert len(hits) == 2


async def test_a_hit_carries_the_source_question_that_names_displacement():
    """The single highest-value field in the dump. A question answered from a pair
    whose source_question is a DIFFERENT eval question is the displacement case,
    and it says so itself instead of needing someone to notice the same sentence
    three times."""
    from services.insights_pipeline.retrieval import retrieve_pairs

    angles = _all_phrasings_at(90.0)
    angles["Who is my top customer by revenue?"] = 0.0

    index = await _index(angles)
    [hit] = retrieve_pairs(_emb(0.0), index)

    assert hit.pair.source_question == "Who is my top customer by revenue?"


# ------------------------------------------------------------ leave-one-out


async def test_leave_one_out_excludes_the_questions_own_pair():
    from services.insights_pipeline.retrieval import retrieve_pairs

    angles = _all_phrasings_at(90.0)
    angles["What is my revenue trend over time?"] = 0.0

    index = await _index(angles)
    hits = retrieve_pairs(_emb(0.0), index, exclude_source_question="What is my revenue trend over time?")

    assert hits == []


async def test_leave_one_out_returns_nothing_rather_than_the_runner_up():
    """With revenue-trend held out, top-customer is the nearest neighbour: same
    three tables, same joins, different question. Falling through to it would hand
    the model the wrong question's answer and score it as a retrieval success."""
    from services.insights_pipeline.retrieval import RETRIEVAL_FLOOR, retrieve_pairs

    angles = _all_phrasings_at(90.0)
    angles["What is my revenue trend over time?"] = 0.0
    angles["Who is my top customer by revenue?"] = _degrees_for(RETRIEVAL_FLOOR - 0.02)

    index = await _index(angles)
    hits = retrieve_pairs(_emb(0.0), index, exclude_source_question="What is my revenue trend over time?")

    assert hits == [], f"fell through to {[h.pair.id for h in hits]}"


async def test_leave_one_out_still_returns_a_genuinely_similar_other_pair():
    """Not a blanket mute: if another pair clears the floor on its own merits it is
    still the right exemplar, and suppressing it would overstate the held-out cost."""
    from services.insights_pipeline.retrieval import retrieve_pairs

    angles = _all_phrasings_at(90.0)
    angles["What is my revenue trend over time?"] = 0.0
    angles["Who is my top customer by revenue?"] = 0.0

    index = await _index(angles)
    hits = retrieve_pairs(_emb(0.0), index, exclude_source_question="What is my revenue trend over time?")

    assert [h.pair.id for h in hits] == ["top_customer_by_revenue"]


async def test_leave_one_out_is_a_no_op_for_a_control_question():
    """Q5/Q6/Q7 have nothing to hold out, so the full and held-out arms must agree
    on them exactly -- which is what makes them a control rather than a third
    condition."""
    from services.insights_pipeline.retrieval import retrieve_pairs

    angles = _all_phrasings_at(90.0)
    angles["Who is my top customer by revenue?"] = 0.0
    control = "Which work centre has the most operations queued?"

    index = await _index(angles)
    full = retrieve_pairs(_emb(0.0), index)
    held = retrieve_pairs(_emb(0.0), index, exclude_source_question=control)

    assert [h.pair.id for h in full] == [h.pair.id for h in held]


# --------------------------------------------------------------- schema linking


async def test_the_core_spine_is_always_linked():
    from services.insights_pipeline.retrieval import CORE_SPINE, link_tables

    index = await _index(_all_phrasings_at(90.0))
    linked = link_tables(_emb(0.0), index)

    assert set(CORE_SPINE) <= set(linked)


async def test_linking_adds_the_nearest_cards_to_the_spine():
    from services.insights_pipeline.retrieval import CORE_SPINE, link_tables, load_cards

    by_name = {c.name: c for c in load_cards()}
    angles = _all_phrasings_at(90.0)
    angles[by_name["shipments"].embed_text] = 0.0
    angles[by_name["shipment_line_items"].embed_text] = 1.0

    index = await _index(angles)
    linked = link_tables(_emb(0.0), index)

    assert "shipments" in linked
    assert "shipment_line_items" in linked
    assert set(CORE_SPINE) <= set(linked)


async def test_a_spine_table_never_spends_one_of_the_top_k_slots():
    """The spine is free, so ranking over it wastes slots on tables the question was
    getting anyway. It did: "who is my top customer by revenue" ranked `customers`
    first and `quotes` seventh, both already in the spine, so two of four slots
    bought nothing and `shipments` -- the table that answer needs -- fell out."""
    from services.insights_pipeline.retrieval import CORE_SPINE, link_tables, load_cards

    by_name = {c.name: c for c in load_cards()}
    angles = _all_phrasings_at(90.0)
    # A spine table is the single best match; one non-spine table trails it.
    angles[by_name["jobs"].embed_text] = 0.0
    angles[by_name["shipments"].embed_text] = 1.0

    index = await _index(angles)
    linked = link_tables(_emb(0.0), index, top_k=1)

    assert "shipments" in linked, "the spine ate the only slot"
    assert set(CORE_SPINE) <= set(linked)


async def test_shipments_is_not_in_the_spine_and_has_to_be_earned():
    """If shipments were in the spine the linker could never be wrong about the one
    table revenue actually needs, and stage 1 would be untestable."""
    from services.insights_pipeline.retrieval import CORE_SPINE, link_tables

    assert "shipments" not in CORE_SPINE

    index = await _index(_all_phrasings_at(90.0))
    linked = link_tables(_emb(0.0), index, top_k=0)

    assert "shipments" not in linked


async def test_linked_tables_come_back_in_schema_context_order():
    """The prompt is a cache prefix; ordering by score would give two questions that
    linked the same tables two different prompts."""
    from services.insights_pipeline.retrieval import link_tables, load_cards

    order = [c.name for c in load_cards()]
    index = await _index(_all_phrasings_at(90.0))
    linked = link_tables(_emb(0.0), index)

    assert linked == sorted(linked, key=order.index)
