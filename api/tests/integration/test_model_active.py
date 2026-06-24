"""Live early-warning: the pinned Anthropic model is still active.

Hits the real Anthropic Models API (`GET /v1/models`) — free metadata, NOT
billed inference. Skips when ANTHROPIC_API_KEY is unset. When this test FAILS,
the pinned model is being retired: update DEFAULT_ANTHROPIC_MODEL in
api/services/ai/model_config.py to a current model from the printed active list.
"""

import os

import pytest

from services.ai.model_config import DEFAULT_ANTHROPIC_MODEL, check_model_health

pytestmark = pytest.mark.integration


@pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set; skipping live model-deprecation check",
)
def test_pinned_model_is_active():
    result = check_model_health()
    assert result["checked"] is True, f"Models API call failed: {result['error']}"
    assert result["active"] is True, (
        f"Pinned model '{DEFAULT_ANTHROPIC_MODEL}' is not in the active model "
        f"list — it is likely being retired. Update DEFAULT_ANTHROPIC_MODEL. "
        f"Active: {result['active_model_ids']}"
    )
