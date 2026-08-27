"""Table cards and golden-pair exemplars: what goes into the generation prompt.

CARDS ARE DERIVED, NOT LISTED. A card is (name, purpose, block). The name set and
the block both come out of tools/schema_context.SCHEMA_CONTEXT; only the one-line
purpose is hand-written, in data/purposes.json. That split is the whole design:
api/tools/sql_validator.py used to hold a hand-written ALLOWED_TABLES and
migration 20260826010319 deleted it for drifting -- 19 names against 21 grants --
and a second hand-maintained table list here would rot the same way, except the
symptom would be a table the linker can never surface.

THE BLOCK IS VERBATIM. Not a summary of the columns, not a rewrite. The block is
what reaches the model, and every SQL failure in the Gate 2 run was an invented
column -- due_at, jp.true_cost, job_operations.work_centre -- against a table
whose real columns were already in the prompt. Paraphrasing the one authoritative
list of column names is not a risk worth taking to save tokens.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
PURPOSES_PATH = DATA_DIR / "purposes.json"

# `^###[ \t]` matches a table heading and NOT a `## ` prose heading: "### x" has a
# third '#' where this pattern wants whitespace, so the two never collide.
_TABLE_HEADING = re.compile(r"^###[ \t]+(\w+)", re.M)
_PROSE_HEADING = re.compile(r"^##[ \t]", re.M)


@dataclass(frozen=True)
class TableCard:
    name: str
    purpose: str
    block: str

    @property
    def embed_text(self) -> str:
        """What the question is scored against. Name AND purpose, because half the
        eval questions name their table almost outright ("which work centre...")
        and the other half describe it ("what did we quote last month")."""
        return f"{self.name}: {self.purpose}"


def _schema_blocks() -> dict[str, str]:
    """Every `### <table>` slice of SCHEMA_CONTEXT, keyed by table name.

    A block ends at the next table heading OR at the next prose heading
    (`## Key Relationships`), whichever comes first. Without the second bound the
    last table swallows three sections of prose and puts them in every prompt.
    """
    from tools.schema_context import SCHEMA_CONTEXT

    heads = list(_TABLE_HEADING.finditer(SCHEMA_CONTEXT))
    prose = [m.start() for m in _PROSE_HEADING.finditer(SCHEMA_CONTEXT)]

    blocks: dict[str, str] = {}
    for i, head in enumerate(heads):
        start = head.start()
        next_table = heads[i + 1].start() if i + 1 < len(heads) else len(SCHEMA_CONTEXT)
        next_prose = next((p for p in prose if p > start), len(SCHEMA_CONTEXT))
        # rstrip only: the result stays a contiguous substring of SCHEMA_CONTEXT,
        # which is what test_a_cards_block_is_the_verbatim_schema_context_slice pins.
        blocks[head.group(1)] = SCHEMA_CONTEXT[start : min(next_table, next_prose)].rstrip()
    return blocks


@lru_cache(maxsize=1)
def load_cards() -> tuple[TableCard, ...]:
    """One card per SCHEMA_CONTEXT table, in SCHEMA_CONTEXT order.

    RAISES on any disagreement between the purposes file and the schema, in either
    direction. A missing purpose could default to "" and a stray one could be
    ignored, and both would be the silent degradation this repo refuses: the first
    hides a table from the linker, the second means someone edited a name that is
    not theirs to edit.
    """
    blocks = _schema_blocks()
    purposes: dict[str, str] = json.loads(PURPOSES_PATH.read_text(encoding="utf-8"))["purposes"]

    missing = sorted(set(blocks) - set(purposes))
    invented = sorted(set(purposes) - set(blocks))
    if missing or invented:
        raise ValueError(
            f"data/purposes.json disagrees with SCHEMA_CONTEXT. "
            f"No purpose for: {missing or 'none'}. "
            f"Purpose for a table that does not exist: {invented or 'none'}. "
            f"The table names are not editable in that file -- they are whatever "
            f"SCHEMA_CONTEXT says."
        )

    return tuple(
        TableCard(name=name, purpose=purposes[name].strip(), block=block)
        for name, block in blocks.items()
    )


def schema_for(names) -> str:
    """The schema blocks for `names`, always in SCHEMA_CONTEXT order.

    Order is deliberate rather than the caller's. The assembled prompt is a cache
    prefix (see semantics.md's editing rules), and ordering by the argument list
    would give two questions that linked the same four tables two different
    prompts, and two cache misses.
    """
    wanted = set(names)
    return "\n\n".join(c.block for c in load_cards() if c.name in wanted)


__all__ = ["DATA_DIR", "PURPOSES_PATH", "TableCard", "load_cards", "schema_for"]


# ============================================================ golden pairs

PAIRS_PATH = DATA_DIR / "pairs.json"

# `^##[ \t]` matches a section heading and not a `### ` sub-heading: "### Payroll
# is the case this rule was written for" has a '#' where this wants whitespace, so
# it stays part of its parent section rather than becoming one.
_SEMANTICS_SECTION = re.compile(r"^##[ \t]+(.+?)[ \t]*$", re.M)
_SQL_FENCE = re.compile(r"```sql\n(.*?)```", re.S)


@dataclass(frozen=True)
class GoldenPair:
    """One question paired with a reference query that answers it.

    `sql` is RESOLVED, never stored: it comes out of the named semantics.md section
    at load time. See data/pairs.json's note for why -- briefly, semantics.md is
    already the runtime prompt and every block in it is already executed under
    jigged_ai_readonly on every CI run, and a copy here would be a second source of
    truth that nothing checks.
    """

    id: str
    section: str
    block: int
    source_question: str
    aliases: tuple[str, ...]
    sql: str

    @property
    def phrasings(self) -> tuple[str, ...]:
        """Everything this pair is scored against, canonical question first."""
        return (self.source_question, *self.aliases)


def _semantics_sql_blocks() -> dict[str, list[str]]:
    """Every ```sql block in semantics.md, grouped by the `## ` section above it.

    A list per section rather than one block, because Revenue carries two -- the
    monthly trend and the top-customer roll-up. Collapsing them would give "who is
    my top customer" a trend query, which is the same wrong-question failure the
    retrieval floor exists to prevent.
    """
    from services.insights_service import load_semantics

    text = load_semantics()
    heads = list(_SEMANTICS_SECTION.finditer(text))

    sections: dict[str, list[str]] = {}
    for i, head in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        body = text[head.end() : end]
        sections[head.group(1).strip()] = [m.group(1).strip() for m in _SQL_FENCE.finditer(body)]
    return sections


@lru_cache(maxsize=1)
def load_pairs() -> tuple[GoldenPair, ...]:
    """The exemplar index, with each pair's SQL resolved out of semantics.md.

    RAISES on a section or block that no longer exists. A renamed heading would
    otherwise resolve to an empty exemplar, and an empty exemplar is invisible: the
    arm would quietly become the no-retrieval arm and score as though retrieval had
    been tested.
    """
    spec = json.loads(PAIRS_PATH.read_text(encoding="utf-8"))
    blocks = _semantics_sql_blocks()

    pairs: list[GoldenPair] = []
    for entry in spec["pairs"]:
        available = blocks.get(entry["section"])
        if available is None:
            raise ValueError(
                f"golden pair {entry['id']!r} names semantics.md section "
                f"{entry['section']!r}, which does not exist. Sections are: "
                f"{sorted(k for k, v in blocks.items() if v)}"
            )
        if entry["block"] >= len(available):
            raise ValueError(
                f"golden pair {entry['id']!r} wants ```sql block {entry['block']} of "
                f"{entry['section']!r}, which has {len(available)}."
            )
        pairs.append(
            GoldenPair(
                id=entry["id"],
                section=entry["section"],
                block=entry["block"],
                source_question=entry["source_question"],
                aliases=tuple(entry.get("aliases") or ()),
                sql=available[entry["block"]],
            )
        )
    return tuple(pairs)


def _pairs_spec() -> dict:
    return json.loads(PAIRS_PATH.read_text(encoding="utf-8"))


# Measured, not guessed, and only meaningful under the task prefixes it was
# measured with: the payroll question must NOT reach the gross-profit exemplar
# (0.620) while a real shop phrasing of the late-jobs question still must (0.637
# against the canonical wording, lifted over the bar by an alias).
RETRIEVAL_FLOOR: float = _pairs_spec()["floor"]
TOP_K: int = _pairs_spec()["top_k"]

# Tables every question gets regardless of what the linker scores, derived from
# the eval set: 7 of 11 questions need jobs/job_parts, 3 need quotes or its line
# items, 2 need customers. shipments and shipment_line_items are deliberately NOT
# here -- revenue's tables have to be EARNED by retrieval, or stage 1 can never be
# observed to fail on the one question that most depends on it.
CORE_SPINE: tuple[str, ...] = ("jobs", "job_parts", "quotes", "customers")


# ============================================================ the index


@dataclass(frozen=True)
class RetrievalIndex:
    cards: tuple[TableCard, ...]
    card_vectors: tuple[list[float], ...]
    pairs: tuple[GoldenPair, ...]
    # One vector per PHRASING, per pair -- the shape max-over-aliases needs.
    pair_vectors: tuple[tuple[list[float], ...], ...]
    embed_calls: int = 0


@dataclass(frozen=True)
class PairHit:
    pair: GoldenPair
    score: float
    matched: str  # which phrasing actually scored; a diagnostic, not a tiebreak


async def build_index(embed_fn) -> RetrievalIndex:
    """Embed every card and every pair phrasing in ONE call.

    `embed_fn` is injected rather than imported for the same reason JobContext
    takes `chain` and `audit_writer`: it is the seam that lets the whole retrieval
    layer be tested with exact, chosen cosines and no network. CI has no Ollama, so
    a live-embedding unit test would either fail or skip into meaninglessness.

    ASYMMETRIC PREFIXES FOR CARDS, SYMMETRIC FOR PAIRS. A question against a table
    card is a query-to-document lookup, so the card gets `search_document: ` and the
    question gets `search_query: `. A question against a pair's phrasings is
    question-to-question, so BOTH sides get `search_query: ` -- mixing them there
    would score a symmetric comparison on an asymmetric objective.
    """
    from services.insights_pipeline.embeddings import DOCUMENT_PREFIX, QUERY_PREFIX

    cards = load_cards()
    pairs = load_pairs()

    card_texts = [f"{DOCUMENT_PREFIX}{c.embed_text}" for c in cards]
    pair_texts = [f"{QUERY_PREFIX}{p}" for pair in pairs for p in pair.phrasings]

    vectors = await embed_fn(card_texts + pair_texts)

    card_vectors = vectors[: len(card_texts)]
    rest = iter(vectors[len(card_texts) :])
    pair_vectors = tuple(tuple(next(rest) for _ in pair.phrasings) for pair in pairs)

    return RetrievalIndex(
        cards=cards,
        card_vectors=tuple(card_vectors),
        pairs=pairs,
        pair_vectors=pair_vectors,
        embed_calls=1,
    )


async def embed_question(embed_fn, question: str) -> list[float]:
    from services.insights_pipeline.embeddings import QUERY_PREFIX

    [vec] = await embed_fn([f"{QUERY_PREFIX}{question}"])
    return vec


def retrieve_pairs(
    question_vector,
    index: RetrievalIndex,
    *,
    exclude_source_question: str | None = None,
    floor: float | None = None,
    top_k: int | None = None,
) -> list[PairHit]:
    """The exemplars for one question. Possibly none, and that is a real answer.

    LEAVE-ONE-OUT EXCLUDES ON source_question, NOT ON SIMILARITY, and does not fall
    through to the runner-up. The point of holding a pair out is to ask what this
    arm does on a question it has no exemplar for; handing over the next-nearest
    pair answers an easier question and flatters the arm. With the revenue-trend
    pair removed the nearest neighbour is TOP CUSTOMER -- same three tables, same
    joins, different question -- which is exactly the cross-question displacement
    the Gate 2 run produced four times. If nothing else clears the floor on its own
    merits, the model gets nothing.
    """
    from services.insights_pipeline.embeddings import cosine

    floor = RETRIEVAL_FLOOR if floor is None else floor
    top_k = TOP_K if top_k is None else top_k

    hits: list[tuple[int, PairHit]] = []
    for position, (pair, vectors) in enumerate(zip(index.pairs, index.pair_vectors)):
        if exclude_source_question is not None and pair.source_question == exclude_source_question:
            continue
        scored = [(cosine(question_vector, v), phrasing) for v, phrasing in zip(vectors, pair.phrasings)]
        score, matched = max(scored, key=lambda s: s[0])
        if score >= floor:
            hits.append((position, PairHit(pair=pair, score=score, matched=matched)))

    # Ties break on the pairs file's own order, so a run is reproducible rather
    # than dependent on dict iteration or float noise.
    hits.sort(key=lambda item: (-item[1].score, item[0]))
    return [hit for _, hit in hits[:top_k]]


def link_tables(question_vector, index: RetrievalIndex, *, top_k: int = 5) -> list[str]:
    """The tables whose schema reaches the generation prompt.

    Top-k by cosine, unioned with CORE_SPINE, returned in SCHEMA_CONTEXT order --
    order, again, because the prompt is a cache prefix.

    THE ASYMMETRY IS DELIBERATE: including a table costs tokens, excluding one
    costs a wrong answer. That is the argument for the spine, and for erring high
    on k.

    k IS 5 BECAUSE IT WAS MEASURED, not chosen. The design said 4. Against the real
    embedding model, card scores across 22 tables sit in a narrow 0.50-0.63 band --
    nomic has little to separate one-line purposes with -- and at k=4 "which parts
    have no routing yet" loses `parts` to `shipment_line_items` by 0.003, which is
    noise deciding whether the question can be answered at all. Sweeping k over the
    eleven: k=3 misses two required tables, k=4 misses one, k=5 misses none, k=6
    adds a table per question and fixes nothing. Re-run tests/integration/
    test_insights_pipeline_retrieval_live.py after any change to the purposes file.
    """
    from services.insights_pipeline.embeddings import cosine

    # RANKED OVER NON-SPINE CARDS ONLY. The spine is free, so a spine table
    # ranking highly must not spend one of the k slots on a table the question was
    # going to get anyway. It did, and it cost real coverage: "who is my top
    # customer by revenue" ranked `customers` first and `quotes` seventh -- both
    # already in the spine -- so two of four slots bought nothing and `shipments`,
    # the table the answer actually needs, fell out at rank five.
    scored = sorted(
        (
            (cosine(question_vector, vec), position)
            for position, vec in enumerate(index.card_vectors)
            if index.cards[position].name not in CORE_SPINE
        ),
        key=lambda s: (-s[0], s[1]),
    )
    chosen = {index.cards[position].name for _, position in scored[:top_k]}
    chosen.update(CORE_SPINE)
    return [c.name for c in index.cards if c.name in chosen]


__all__ += [
    "CORE_SPINE",
    "GoldenPair",
    "PAIRS_PATH",
    "PairHit",
    "RETRIEVAL_FLOOR",
    "RetrievalIndex",
    "TOP_K",
    "build_index",
    "embed_question",
    "link_tables",
    "load_pairs",
    "retrieve_pairs",
]
