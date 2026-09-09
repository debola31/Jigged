"""What Ollama has resident, straight from localhost.

Asked directly rather than taken from the worker's status file, because the two
say different things: the worker reports the model it last used, Ollama reports
what is actually loaded and until when. The runbook's health check is the second
one -- 29 GB resident at 32K context, expiring never -- and it drifts on its own,
because OLLAMA_KEEP_ALIVE is set with `launchctl setenv` and does not survive a
reboot.

urllib rather than httpx: this package must stay stdlib-only so it can run when
the worker's own dependencies cannot.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

# /api/ps sits BESIDE /v1, not under it -- OLLAMA_BASE_URL names the chat surface,
# so the /v1 suffix has to come off before appending the native path.
def ps_url(base_url: str) -> str:
    return base_url.split("/v1")[0].rstrip("/") + "/api/ps"


def parse(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    models = payload.get("models")
    if not isinstance(models, list):
        return []
    return [
        {
            "name": m.get("name"),
            "size_gb": round((m.get("size") or 0) / 1e9, 1),
            "context": m.get("context_length"),
            "expires_at": m.get("expires_at"),
        }
        for m in models
        if isinstance(m, dict)
    ]


def resident(base_url: str, timeout: float = 1.5) -> Dict[str, Any]:
    """Never raises. A slow localhost IS the answer, so the timeout is short."""
    try:
        with urllib.request.urlopen(ps_url(base_url), timeout=timeout) as r:
            return {"up": True, "models": parse(json.loads(r.read().decode())), "error": None}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return {"up": False, "models": [], "error": str(exc)}
