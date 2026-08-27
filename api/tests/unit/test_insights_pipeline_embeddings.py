"""The embeddings client: keyless, /v1, normalised in Python, and typed on failure.

WHY THIS IS NOT A METHOD ON OpenAICompatProvider. services/llm/base.py opens with
an explicit list of what a provider does NOT do, and the stated value of that seam
is that complete() is one method. An embedding has no messages, no json_schema, no
max_tokens and no tools; bolting it on would widen the Protocol for a caller that
shares none of its shape.

WHAT THE NORMALISATION TEST IS FOR. Ollama's own docs record that nomic-bert
models return RAW, non-normalised vectors on the legacy embeddings path, and the
/v1 compatibility path has not been consistent about it across versions. Cosine
over unnormalised vectors is not cosine, and the failure is silent: retrieval
still returns SOMETHING, just ranked wrong, which reads as "the linker is bad" and
not as "the arithmetic is wrong". So this layer normalises rather than trusting.
"""
from __future__ import annotations

import json
import math

import httpx
import pytest

pytestmark = pytest.mark.unit


def _client(handler=None, **over):
    """An embeddings client over MockTransport, plus the requests it saw.

    MockTransport rather than patching AsyncClient, for the reason
    test_llm_providers.py gives: the handler gets a real, fully-built Request, so a
    test can assert the URL shape and the ABSENCE of an Authorization header.
    Patching the client could only assert the arguments we passed to it.
    """
    seen: list[httpx.Request] = []

    def default(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        n = len(json.loads(request.content)["input"])
        return httpx.Response(200, json={"data": [{"embedding": [3.0, 4.0]} for _ in range(n)]})

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    kwargs = dict(base_url="http://localhost:11434/v1", transport=httpx.MockTransport(recording if handler else default))
    kwargs.update(over)
    return kwargs, seen


async def test_the_request_goes_to_the_v1_embeddings_endpoint():
    from services.insights_pipeline.embeddings import embed_texts

    kwargs, seen = _client()
    await embed_texts(["hello"], **kwargs)

    assert str(seen[0].url) == "http://localhost:11434/v1/embeddings"


async def test_a_keyless_embedder_sends_no_authorization_header():
    """Ollama is keyless by design; sending `Bearer ` is worse than sending nothing."""
    from services.insights_pipeline.embeddings import embed_texts

    kwargs, seen = _client()
    await embed_texts(["hello"], **kwargs)

    assert "authorization" not in {k.lower() for k in seen[0].headers}


async def test_a_batch_is_one_request_carrying_every_text():
    """35 cards and pairs at load is one round trip, not 35."""
    from services.insights_pipeline.embeddings import embed_texts

    kwargs, seen = _client()
    await embed_texts(["a", "b", "c"], **kwargs)

    assert len(seen) == 1
    assert json.loads(seen[0].content)["input"] == ["a", "b", "c"]


async def test_vectors_are_normalised_even_when_the_server_returns_raw_ones():
    from services.insights_pipeline.embeddings import embed_texts

    kwargs, _ = _client()  # the default handler returns [3.0, 4.0], norm 5
    [vec] = await embed_texts(["hello"], **kwargs)

    assert math.isclose(math.hypot(*vec), 1.0, abs_tol=1e-9)
    assert math.isclose(vec[0], 0.6, abs_tol=1e-9)


async def test_the_order_of_the_returned_vectors_follows_the_input():
    """The whole retrieval layer indexes by position. A provider that returned an
    `index` field out of order, honoured naively, would silently pair every card
    with someone else's vector."""
    from services.insights_pipeline.embeddings import embed_texts

    def handler(_request):
        return httpx.Response(200, json={"data": [
            {"index": 1, "embedding": [0.0, 1.0]},
            {"index": 0, "embedding": [1.0, 0.0]},
        ]})

    kwargs, _ = _client(handler)
    vecs = await embed_texts(["first", "second"], **kwargs)

    assert vecs[0] == [1.0, 0.0]
    assert vecs[1] == [0.0, 1.0]


async def test_a_short_count_fails_loudly_rather_than_pairing_the_wrong_vectors():
    from services.insights_pipeline.embeddings import EmbeddingUnavailable, embed_texts

    def handler(_request):
        return httpx.Response(200, json={"data": [{"embedding": [1.0, 0.0]}]})

    kwargs, _ = _client(handler)
    with pytest.raises(EmbeddingUnavailable, match="2 texts"):
        await embed_texts(["first", "second"], **kwargs)


async def test_an_http_error_is_typed_and_names_the_model():
    from services.insights_pipeline.embeddings import EmbeddingUnavailable, embed_texts

    def handler(_request):
        return httpx.Response(404, json={"error": {"message": 'model "nomic-embed-text" not found'}})

    kwargs, _ = _client(handler)
    with pytest.raises(EmbeddingUnavailable, match="not found"):
        await embed_texts(["hello"], **kwargs)


async def test_an_unreachable_box_is_typed_rather_than_an_httpx_error():
    from services.insights_pipeline.embeddings import EmbeddingUnavailable, embed_texts

    def handler(_request):
        raise httpx.ConnectError("nothing listening")

    kwargs, _ = _client(handler)
    with pytest.raises(EmbeddingUnavailable):
        await embed_texts(["hello"], **kwargs)


async def test_an_empty_input_never_reaches_the_wire():
    from services.insights_pipeline.embeddings import embed_texts

    kwargs, seen = _client()
    assert await embed_texts([], **kwargs) == []
    assert seen == []


def test_cosine_is_one_for_identical_and_zero_for_orthogonal():
    from services.insights_pipeline.embeddings import cosine

    assert math.isclose(cosine([1.0, 0.0], [1.0, 0.0]), 1.0, abs_tol=1e-12)
    assert math.isclose(cosine([1.0, 0.0], [0.0, 1.0]), 0.0, abs_tol=1e-12)
    assert math.isclose(cosine([3.0, 4.0], [3.0, 4.0]), 1.0, abs_tol=1e-12)


def test_cosine_of_a_zero_vector_is_zero_rather_than_a_division_error():
    from services.insights_pipeline.embeddings import cosine

    assert cosine([0.0, 0.0], [1.0, 0.0]) == 0.0


def test_the_task_prefixes_are_the_ones_nomic_was_trained_with():
    """nomic-embed-text v1.5 was contrastively trained with these exact strings.
    Unprefixed input lands in a region the objective never optimised, and the
    measured 0.70 retrieval floor is only meaningful under the prefix it was
    measured with -- so they are pinned, not spelled inline at each call site."""
    from services.insights_pipeline.embeddings import DOCUMENT_PREFIX, QUERY_PREFIX

    assert QUERY_PREFIX == "search_query: "
    assert DOCUMENT_PREFIX == "search_document: "
