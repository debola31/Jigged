"""Which business-term definitions this question needs, instead of all of them.

WHAT THIS IS FOR. semantics.md is documentation and runtime in one, and until
2026-09-09 every section of it shipped on every question: ~3,600 tokens against a
32,768-token window that also carries ~6,200 of SCHEMA_CONTEXT, the tool schema, a
5,000-token history budget and the answer reserve. That arithmetic is why
`context_overflow` is an error kind. A file whose whole job is to grow -- one
section per business term the model gets wrong -- cannot stay fully resident, and
the tenth definition is paid for by every question that has nothing to do with it.

THE SAME SHAPE AS retrieval.py, DELIBERATELY, AND NOT THE SAME CODE. That module
retrieves table cards and golden pairs for the five-stage pipeline arm; this
retrieves prose sections for the tool-calling arm that actually serves production.
They share embeddings.py and nothing else, because the two index different things
and merging them would give one call site a say over the other's scoring.

SECTIONS ARE DERIVED, NEVER LISTED. The headings come out of semantics.md at load.
A hand-written list here would be a second copy of the file's structure, and
migration 20260826010319 deleted ALLOWED_TABLES for being exactly that -- except
the symptom would be worse: a definition the retriever can never surface reads,
from the model's side, as a business rule that does not exist.

THE CORE SECTION IS NEVER DROPPED. "How to use these definitions" carries $1, $2,
the refusal of CURRENT_DATE and the archived-rows rule. Those are preconditions for
writing any query at all rather than facts about one term, so they are not eligible
to lose a similarity contest.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from functools import lru_cache

logger = logging.getLogger(__name__)

# `^## ` and not `^#+ `: the file's H1 is its own title and the H3s inside a section
# are part of that section's body.
_SECTION_HEADING = re.compile(r"^##[ \t]+(.+)$", re.M)

CORE_HEADING = "How to use these definitions"


@dataclass(frozen=True)
class SemanticsSection:
    heading: str
    body: str

    @property
    def embed_text(self) -> str:
        """What the question is scored against: the heading plus the DEFINITION
        line, not the whole section.

        The SQL block is the bulk of a section and is the least discriminating part
        of it -- every block selects from the same dozen tables with the same $1 --
        so including it pulls every section towards every question. The heading is
        the term and the definition sentence is what the term means, which is what a
        question actually resembles.
        """
        first = ""
        for line in self.body.splitlines():
            if line.startswith("**Definition.**"):
                first = line.replace("**Definition.**", "").strip()
                break
        return f"{self.heading}: {first}" if first else self.heading

    def render(self) -> str:
        return f"## {self.heading}\n{self.body}".strip()


@lru_cache(maxsize=1)
def load_sections() -> tuple[SemanticsSection, ...]:
    """Every `## ` section of semantics.md, in file order, with the preamble kept.

    The text ABOVE the first heading is the file's title and its note about being
    runtime; it is not a definition and is not returned.
    """
    from services.insights_service import load_semantics

    text = load_semantics()
    heads = list(_SECTION_HEADING.finditer(text))
    out: list[SemanticsSection] = []
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        body = text[m.end():end].strip()
        # The `---` rules between sections belong to the file's layout, not to any
        # one section, and re-emitting them around a subset reads as a gap.
        body = body.rstrip("- \n").strip()
        out.append(SemanticsSection(heading=m.group(1).strip(), body=body))
    return tuple(out)


async def select_sections(question: str, *, top_k: int = 3, embed_fn=None) -> str:
    """The core section plus the top-k most similar, rendered in FILE order.

    File order, not score order: the sections were written to be read in sequence
    (Open quote refers forward to Quote pipeline worth), and reordering them by
    cosine would break references the model then has to guess at.

    RETURNS "" RATHER THAN A PARTIAL ANSWER when anything is off -- no sections, no
    embedder, a shape it did not expect. The caller reads "" as "send the whole
    file", so every uncertainty spends tokens instead of risking a missing rule.
    """
    sections = load_sections()
    if not sections:
        return ""

    if embed_fn is None:
        from services.insights_pipeline.embeddings import embed_texts

        embed_fn = embed_texts

    candidates = [s for s in sections if s.heading != CORE_HEADING]
    if not candidates:
        return "\n\n---\n\n".join(s.render() for s in sections)

    # One request: the question and every candidate together, so this is a single
    # local round trip rather than one per section.
    vectors = await embed_fn([question] + [s.embed_text for s in candidates])
    if len(vectors) != len(candidates) + 1:
        logger.warning(
            "semantics retrieval: embedder returned %d vectors for %d texts; sending all sections",
            len(vectors), len(candidates) + 1,
        )
        return ""

    from services.insights_pipeline.embeddings import cosine

    qv = vectors[0]
    scored = sorted(
        zip((cosine(qv, v) for v in vectors[1:]), candidates),
        key=lambda pair: pair[0],
        reverse=True,
    )
    keep = {s.heading for _, s in scored[:top_k]}
    keep.add(CORE_HEADING)

    logger.info(
        "semantics retrieval: kept %s", ", ".join(sorted(keep)),
    )
    return "\n\n---\n\n".join(s.render() for s in sections if s.heading in keep)
