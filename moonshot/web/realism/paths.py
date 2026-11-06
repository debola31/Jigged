"""Where the realism pipeline reads and writes. Everything big is in the data root, never the checkout.

    <data>/web/models-full/<asset>.glb      the realistic models and manifest.json: what the page fetches
    <data>/web/tiles/                       the shared tile library (tiles.py)
    <data>/realism/<asset>/                 per-asset work: the Blender scene, the bake, the raw export, reports
    <data>/realism/node/                    pack/'s package.json installed (npm install), its scripts beside it
    <data>/realism/tools/ktx/bin/ktx.exe    KTX-Software 4.4.2 (KTX env var overrides)
    <data>/web/gpu-hold                     while it exists another session needs the GPU idle: GPU jobs wait
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from moonshot.config import data_root

HERE = Path(__file__).resolve().parent


def web_root() -> Path:
    return data_root() / "web"


def models_dir() -> Path:
    return web_root() / "models-full"


def tiles_dir() -> Path:
    return web_root() / "tiles"


def work_root() -> Path:
    return data_root() / "realism"


def work_dir(asset: str) -> Path:
    return work_root() / asset


def node_dir() -> Path:
    return work_root() / "node"


def gpu_hold() -> Path:
    return web_root() / "gpu-hold"


def ktx() -> Path:
    if env := os.environ.get("KTX"):
        return Path(env)
    exe = work_root() / "tools" / "ktx" / "bin" / ("ktx.exe" if os.name == "nt" else "ktx")
    return exe if exe.exists() else Path(shutil.which("ktx") or exe)
