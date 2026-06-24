"""Central Anthropic model selection + a free deprecation early-warning.

Single source of truth for which Claude model the backend uses, plus a helper
that checks — using the **free Models API metadata endpoint, never billed
inference** — whether the pinned model is still active. The check powers an
on-demand admin diagnostic and a test, so a future model retirement surfaces as
an advance warning instead of a production 404 (which is exactly how
``claude-sonnet-4-20250514`` broke chat/chart after its 2026-06-15 retirement).

Why a pinned constant rather than auto-resolving the newest model at runtime:
the resolved model has to actually be callable by this org's key, and the
dashboard chat path constructs ``ClaudeProvider()`` directly (no factory), so a
runtime resolver added latency + a 24h-stale-cache footgun without covering the
broken feature. Pinning here keeps a human in the loop on cost/quality drift;
the check below provides the missing "this model is going away" signal.
"""

import logging
import os
from typing import Optional

import anthropic

logger = logging.getLogger(__name__)

# The model every backend AI path uses. Update this one line (after the
# deprecation check below flags it) when migrating to a newer Sonnet.
# claude-sonnet-4-6 is the documented drop-in replacement for retired Sonnet 4.
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6"


def list_active_anthropic_model_ids(api_key: Optional[str] = None) -> list[str]:
    """Return the IDs of all currently-active Anthropic models.

    Uses the Models API (``GET /v1/models``) — free metadata, NOT billed
    inference. Retired models do not appear in this list, which is what makes it
    a usable deprecation signal. The SDK auto-paginates on iteration.
    """
    api_key = api_key or os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY is required")

    client = anthropic.Anthropic(api_key=api_key)
    return [model.id for model in client.models.list()]


def check_model_health(
    model: str = DEFAULT_ANTHROPIC_MODEL,
    api_key: Optional[str] = None,
) -> dict:
    """Report whether ``model`` is still active per the Models API.

    Never raises — designed to back an admin diagnostic endpoint and a test.

    Returns a dict with:
        model:            the model id that was checked
        active:           True/False if the check ran, None if it could not
        active_model_ids: the active id list (empty if the check failed)
        checked:          whether the Models API call succeeded
        error:            error string when checked is False, else None
    """
    try:
        active_ids = list_active_anthropic_model_ids(api_key=api_key)
    except Exception as e:  # noqa: BLE001 — diagnostic must not raise
        logger.warning(f"Model health check failed for {model}: {e}")
        return {
            "model": model,
            "active": None,
            "active_model_ids": [],
            "checked": False,
            "error": str(e),
        }

    is_active = model in active_ids
    if not is_active:
        logger.warning(
            f"Anthropic model '{model}' is NOT in the active model list — "
            f"it may be deprecated or retired. Update DEFAULT_ANTHROPIC_MODEL. "
            f"Active ids: {active_ids}"
        )

    return {
        "model": model,
        "active": is_active,
        "active_model_ids": active_ids,
        "checked": True,
        "error": None,
    }
