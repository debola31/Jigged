"""Embeddings for the pipeline's retrieval stages. Ollama, keyless, over /v1.

NOT ON THE PROVIDER SEAM, and deliberately. services/llm/base.py opens with the
list of things an LLMProvider does not do, and its stated value is that
complete() is one method; an embedding has no messages, no json_schema, no
max_tokens and no tools. This is a sibling, not a subclass.

/v1/embeddings RATHER THAN THE NATIVE /api/embed. OLLAMA_BASE_URL is already the
/v1 form everywhere in this repo, and openai_compat.py states the convention that
base_url carries the vendor's version prefix and never the endpoint. Deriving
/api/embed from it would mean string surgery on someone's environment variable,
and it would be the only place that did.

NO ai_calls ROW IS WRITTEN. That table is the cost ledger, and evals/insights_ab.py
reads its row count as `attempts` with the stated interpretation "a number well
above the question count is an arm quietly costing double". A local embedding
costs nothing; ~40 free rows at load would destroy the one thing that column says.
The pipeline counts embedding calls in its own diagnostics instead. A PAID hosted
embedder would be a different case and should route through audit.build_row.
"""
from __future__ import annotations

import json
import logging
import math
import os
from typing import Any, Sequence

import httpx

logger = logging.getLogger(__name__)

DEFAULT_EMBED_MODEL = "nomic-embed-text"

# The exact strings nomic-embed-text v1.5 was contrastively trained with. Not
# decorative: unprefixed input lands in a region the training objective never
# optimised, and the measured 0.70 retrieval floor only means anything under the
# prefixes it was measured with.
QUERY_PREFIX = "search_query: "
DOCUMENT_PREFIX = "search_document: "

# Same split as openai_compat: a box that is off should cost 5 seconds, not the
# read timeout an embedding batch is allowed.
_CONNECT_TIMEOUT_S = 5.0
_READ_TIMEOUT_S = 60.0


class EmbeddingUnavailable(RuntimeError):
    """Retrieval could not be built. Typed so a caller can tell it from a bug.

    Every failure mode here is "the local box is not answering the way it must" --
    off, wrong model, malformed body, short batch -- and none of them is
    recoverable by asking again differently.
    """


def l2_normalize(vec: Sequence[float]) -> list[float]:
    """Unit-length, or the zero vector unchanged.

    Applied to everything on the way in rather than trusted from the server:
    Ollama returns raw, non-normalised vectors for nomic-bert models on the legacy
    path, and the /v1 path has not been consistent across versions. Cosine over
    unnormalised vectors ranks wrongly and never errors.
    """
    norm = math.sqrt(math.sumprod(vec, vec))
    if norm == 0.0:
        return list(vec)
    return [v / norm for v in vec]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Full cosine, not a bare dot product.

    Vectors are normalised on ingest, so the denominator is 1.0 in practice and
    this costs one extra multiply-add per comparison at ~35 vectors per question.
    Paying it means a caller that hands over an un-normalised vector -- a test
    fixture, a future second source -- gets the right answer instead of a
    plausible wrong one.
    """
    if len(a) != len(b):
        raise ValueError(f"cosine over vectors of different length: {len(a)} vs {len(b)}")
    denom = math.sqrt(math.sumprod(a, a)) * math.sqrt(math.sumprod(b, b))
    if denom == 0.0:
        return 0.0
    return math.sumprod(a, b) / denom


def _base_url() -> str:
    return os.getenv("OLLAMA_BASE_URL") or "http://localhost:11434/v1"


async def embed_texts(
    texts: Sequence[str],
    *,
    base_url: str | None = None,
    model: str = DEFAULT_EMBED_MODEL,
    timeout_s: float = _READ_TIMEOUT_S,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[list[float]]:
    """Embed a batch in ONE request, normalised, in the order given.

    Batching is the whole point of the signature: the cards and pairs are embedded
    once at load, and doing that as ~35 sequential round trips would put an
    avoidable minute on the front of every eval run.
    """
    if not texts:
        return []

    url = f"{(base_url or _base_url()).rstrip('/')}/embeddings"
    body: dict[str, Any] = {"model": model, "input": list(texts)}

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_s, connect=_CONNECT_TIMEOUT_S),
            transport=transport,
        ) as client:
            # No Authorization header at all. Ollama is keyless by design and
            # sending "Bearer " is worse than sending nothing.
            resp = await client.post(url, headers={"Content-Type": "application/json"}, json=body)
    except httpx.HTTPError as exc:
        raise EmbeddingUnavailable(
            f"could not reach the embedding model at {url}: {type(exc).__name__}. "
            f"Is Ollama running, and has `ollama pull {model}` been done?"
        ) from exc

    if resp.status_code >= 400:
        # Not raise_for_status(): it discards the body, and the body is where the
        # server says the model is not pulled.
        detail = ""
        try:
            payload = resp.json()
            err = payload.get("error") if isinstance(payload, dict) else None
            detail = (err.get("message") if isinstance(err, dict) else str(err or "")) or ""
        except Exception:  # noqa: BLE001 - a non-JSON error body is common
            detail = resp.text[:300]
        raise EmbeddingUnavailable(f"embedding model {model} returned {resp.status_code}: {detail}")

    try:
        data = resp.json()["data"]
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingUnavailable(f"embedding response from {url} had no data array") from exc

    # HONOUR `index` WHEN IT IS THERE. The retrieval layer pairs vectors with
    # cards by POSITION, so a server that returned them out of order would silently
    # give every card someone else's meaning -- a failure that looks exactly like a
    # bad linker and not at all like a transport bug.
    if all(isinstance(d, dict) and isinstance(d.get("index"), int) for d in data):
        data = sorted(data, key=lambda d: d["index"])

    vectors = [l2_normalize(d["embedding"]) for d in data]
    if len(vectors) != len(texts):
        raise EmbeddingUnavailable(
            f"asked {model} for {len(texts)} texts and got {len(vectors)} vectors back; "
            f"refusing to pair them up by position."
        )
    return vectors


__all__ = [
    "DEFAULT_EMBED_MODEL",
    "DOCUMENT_PREFIX",
    "QUERY_PREFIX",
    "EmbeddingUnavailable",
    "cosine",
    "embed_texts",
    "l2_normalize",
]
