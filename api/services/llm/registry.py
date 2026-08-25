"""feature -> ordered provider chain, resolved from the environment per call.

READ ENV INSIDE THE FUNCTION, NEVER AT IMPORT. This is the repo's stated
convention (routes/company_auth.py: "Built PER REQUEST, reading env at call time.
That is what lets the integration tests re-point the backend with
monkeypatch.setenv") and a module-level registry captured at import is exactly
the bug that comment exists to prevent. Construction is a few attribute
assignments; the HTTP client is per-call anyway.

TWO RULES THAT ARE POLICY, NOT PLUMBING:

  * A PRODUCTION CHAIN IS ollama-ONLY OR anthropic-ONLY. Never mixed. A migrated
    surface fails VISIBLE when the desktop is down -- the user is told the AI box
    is offline -- rather than silently falling back to a hosted model at 40x the
    cost. "It still worked" is the failure mode, not the happy path.
  * DEEPINFRA NEVER ENTERS A PRODUCTION CHAIN. It exists for the eval harness and
    as a per-feature emergency toggle that ships off, and its key never goes to
    Vercel. Naming it in a production chain raises rather than being quietly
    honoured.
"""
from __future__ import annotations

import logging
import os
from decimal import Decimal

from services.llm.base import LLMProvider
from services.llm.errors import LLMNotConfigured
from services.llm.pricing import DEEPINFRA_PRICES

logger = logging.getLogger(__name__)

# Dark by default: every chain is anthropic, so merging this layer changes no
# production behaviour at all. Each surface flips to a local model by setting its
# LLM_CHAIN_* variable, one surface at a time, after its golden check passes --
# and reverts with one env change.
_DEFAULT_CHAINS: dict[str, tuple[str, ...]] = {
    "insights": ("anthropic",),
    "insights_dev": ("ollama:qwen3:8b",),
    "drawings": ("anthropic",),
    "drawings_dev": ("ollama:qwen3-vl:4b",),
}

_DEFAULT_TIMEOUTS = {"anthropic": 30.0, "deepinfra": 30.0, "ollama": 120.0}


def _env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    return value if value else default


def _is_production() -> bool:
    return _env("VERCEL_ENV") == "production"


def resolve_feature(feature: str) -> str:
    """Map a feature to its dev variant when LLM_PROFILE says so.

    AN EXPLICIT LLM_PROFILE, NEVER INFERRED FROM THE ENVIRONMENT. index.py:31-43
    documents the incident where an inferred environment made local, pytest,
    preview and production all report as "development"; deriving the AI chain
    from the same signal would repeat it, and the blast radius here is "which
    model answered a customer".

    The RESOLVED name is what lands in ai_calls.feature, so a dev row can never be
    mistaken for a production one in a cost rollup.
    """
    if _env("LLM_PROFILE") != "dev":
        return feature
    dev = f"{feature}_dev"
    if _chain_spec(dev):
        return dev
    logger.info("LLM_PROFILE=dev but no chain for %s; using %s", dev, feature)
    return feature


def _chain_spec(feature: str) -> tuple[str, ...]:
    raw = _env(f"LLM_CHAIN_{feature.upper()}")
    if raw:
        return tuple(part.strip() for part in raw.split(",") if part.strip())
    return _DEFAULT_CHAINS.get(feature, ())


def _split_entry(entry: str) -> tuple[str, str | None]:
    # maxsplit=1 is load-bearing: an Ollama tag contains a colon ("qwen3:8b"), and
    # a naive split silently truncates the model to "qwen3".
    slug, _, model = entry.partition(":")
    return slug.strip(), (model.strip() or None)


def _build(slug: str, model: str | None) -> LLMProvider | None:
    """Construct one provider, or return None if it should be skipped.

    Skipping is only ever for a MISSING KEY, and it is logged. The chain is an
    ordered preference, so losing a preferred provider quietly-but-logged is
    acceptable; losing the FEATURE quietly is not, which is why an empty chain
    raises in chain_for().
    """
    if slug == "anthropic":
        if not _env("ANTHROPIC_API_KEY"):
            logger.warning("skipping anthropic in this chain: ANTHROPIC_API_KEY is unset")
            return None
        from services.llm.anthropic_provider import AnthropicProvider

        return AnthropicProvider(model=model, timeout_s=_DEFAULT_TIMEOUTS["anthropic"])

    if slug == "deepinfra":
        if _is_production():
            raise LLMNotConfigured(
                "deepinfra is not permitted in a production chain. It exists for the eval "
                "harness and as an emergency per-feature toggle on a non-production "
                "deployment; its key does not belong in Vercel."
            )
        key = _env("DEEPINFRA_API_KEY")
        if not key:
            logger.warning("skipping deepinfra in this chain: DEEPINFRA_API_KEY is unset")
            return None
        from services.llm.openai_compat import OpenAICompatProvider

        model = model or "Qwen/Qwen3-32B"
        price_in, price_out = DEEPINFRA_PRICES.get(model, (Decimal("0"), Decimal("0")))
        return OpenAICompatProvider(
            base_url=_env("DEEPINFRA_BASE_URL", "https://api.deepinfra.com/v1/openai"),
            api_key=key,
            model=model,
            price_in_per_mtok=_env("DEEPINFRA_PRICE_IN_PER_MTOK") or price_in,
            price_out_per_mtok=_env("DEEPINFRA_PRICE_OUT_PER_MTOK") or price_out,
            name="deepinfra",
            timeout_s=_DEFAULT_TIMEOUTS["deepinfra"],
            # vLLM's convention, undocumented on DeepInfra and possibly rejected.
            # It lives here as config so a 400 is a one-line fix rather than a
            # deploy -- and strip_think is the actual guarantee either way.
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )

    if slug == "ollama":
        # NO KEY CHECK. Ollama is keyless BY DESIGN, so the skip-on-missing-key rule
        # is per-provider-kind rather than blanket -- applying it here would skip
        # the only provider a migrated surface has.
        from services.llm.openai_compat import OpenAICompatProvider

        return OpenAICompatProvider(
            base_url=_env("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
            api_key=None,
            model=model or "qwen3:8b",
            price_in_per_mtok=Decimal("0"),
            price_out_per_mtok=Decimal("0"),
            name="ollama",
            timeout_s=_DEFAULT_TIMEOUTS["ollama"],
            # `think: false` is the NATIVE /api/chat parameter and does nothing on
            # this /v1 path. reasoning_effort is the knob that works here.
            extra_body={"reasoning_effort": "none"},
        )

    raise LLMNotConfigured(
        f"unknown provider slug {slug!r} in the chain for this feature. A typo that "
        f"silently degraded to the rest of the chain would be exactly the expensive, "
        f"invisible failure ai_calls exists to expose."
    )


def chain_for(feature: str) -> list[LLMProvider]:
    """The ordered providers for a feature. Raises rather than returning empty."""
    spec = _chain_spec(feature)
    if not spec:
        raise LLMNotConfigured(f"no chain configured for feature {feature!r}", feature=feature)

    providers = [p for p in (_build(*_split_entry(e)) for e in spec) if p is not None]
    if not providers:
        raise LLMNotConfigured(
            f"every provider in the chain for {feature!r} was skipped for a missing "
            f"key (chain: {', '.join(spec)})",
            feature=feature,
        )
    return providers


__all__ = ["chain_for", "resolve_feature"]
