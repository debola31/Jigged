"""The page's UX budgets for the realistic models, and how they are estimated. Plain Python.

The user's brief: maximise realism without exploding the download or hurting the page. The first view stays as fast
as today (the light models load first; these stream in afterwards), so the budgets bound what streams in:

    download, all realistic models + shared tiles   <= ~150 MB
    GPU texture memory with everything loaded        <= ~1 GB
    frame time, whole shop, 1080p, GTX 1070           <= 16 ms

Per asset the class sets the download cap, the AO atlas and the triangle cap. Heroes are the stations the live
parts' steps use, kept at full detail; everything else is simplified to what a shop-wide view can show.
"""
from __future__ import annotations

import math

SHOP = dict(download_bytes=150e6, gpu_bytes=1.0e9, frame_ms=16.0)

# Priority: what streams in first. Heroes are the live parts' stations (moonshot/web/export.py LIVE: the VF-2, the
# band saw, the benches, the inspection table) and the vise their VF-2 steps clamp in. The inspection table is
# layout.json furniture (insp-table), drawn by the page as a box, not an asset: it has no model to make realistic.
HERO = {"vf2": "Haas VF-2, bay 1: the live parts' milling steps", "bandsaw": "the live parts' saw steps",
        "bench": "the benches zone's finishing steps", "d688": "the vise the VF-2 steps clamp in"}
NEAR_M = 4.0                 # an item this close (plan distance, m) to a hero's item streams in second

# Budget classes. texel_mm: the AO atlas's target texel size, the atlas side the power of two that reaches it within
# [atlas_min, atlas_max]. AO is low-frequency, so it holds up far coarser than colour would.
CLASSES = {
    "hero": dict(download_bytes=8.0e6, triangles=300_000, texel_mm=2.0, atlas_min=1024, atlas_max=4096),
    "large": dict(download_bytes=3.0e6, triangles=100_000, texel_mm=4.0, atlas_min=512, atlas_max=2048),
    "small": dict(download_bytes=0.5e6, triangles=12_000, texel_mm=0.6, atlas_min=256, atlas_max=1024),
}
SMALL_M = 0.6                # an asset whose longest side is under this is small

# GPU bytes per texel by how the page gets a KTX2: on desktop WebGL (S3TC + BPTC, no ETC/ASTC) three.js's KTX2Loader
# transcodes ETC1S and UASTC alike to BC7, 1 byte a texel; phones get ASTC 4x4 (1 byte) or ETC2 (0.5-1). Mipmaps add
# a third. The spike measured exactly this: ETC1S + UASTC and all-UASTC came out the same 0.43 GB.
GPU_BYTES_PER_TEXEL = 1.0
MIP_FACTOR = 4 / 3


def budget_class(asset: str, bbox: dict) -> str:
    if asset in HERO:
        return "hero"
    side = max(hi - lo for lo, hi in zip(bbox["min"], bbox["max"])) / 1000
    return "large" if side >= SMALL_M else "small"


def atlas_side(area_m2: float, utilisation: float, cls: str) -> int:
    """The AO atlas side for a surface area, at the class's texel size; `utilisation` is the packed UV islands'
    share of the square."""
    c = CLASSES[cls]
    texels = area_m2 / max(utilisation, 0.05) / (c["texel_mm"] / 1000) ** 2
    side = 2 ** math.ceil(math.log2(max(math.sqrt(texels), 1)))
    return int(min(max(side, c["atlas_min"]), c["atlas_max"]))


def gpu_texture_bytes(width: int, height: int) -> int:
    return int(width * height * GPU_BYTES_PER_TEXEL * MIP_FACTOR)


def priorities(items: list[dict]) -> dict[str, str]:
    """hero / near / other per asset: a hero's own; near if any of its items stands within NEAR_M of a hero's item."""
    heroes = [i for i in items if i["asset"] in HERO]
    out = {}
    for i in items:
        a = i["asset"]
        if a in HERO:
            out[a] = "hero"
            continue
        d = min(math.hypot(i["x"] - h["x"], i["y"] - h["y"]) / 1000 for h in heroes) if heroes else math.inf
        rank = "near" if d <= NEAR_M else "other"
        if out.get(a) != "near":
            out[a] = rank
    return out
