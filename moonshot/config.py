"""Where the moonshot's data and the hub live, per machine.

The data root holds everything too big for git (docs/moonshot/shop-and-pipeline-plan.md §10): vendor CAD
originals, the parts' STEP and PDF files, the hand model, reference takes, scene packs and the queue database.
It is outside OneDrive on purpose. Worktrees don't contain git-ignored files, so code reaches data through this
root by absolute path, never relative to the checkout.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HUB_HOST = "desktop-4hvjqis"
HUB_PORT = 8765


def data_root() -> Path:
    """MOONSHOT_DATA if set, else C:\\jigged-data on Windows and ~/jigged-data elsewhere."""
    if env := os.environ.get("MOONSHOT_DATA"):
        return Path(env)
    return Path("C:/jigged-data") if sys.platform == "win32" else Path.home() / "jigged-data"


def hub_url() -> str:
    return os.environ.get("MOONSHOT_HUB", f"http://{HUB_HOST}:{HUB_PORT}")
