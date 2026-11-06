"""A first mapping for an asset, from its source's CAD colours, to be reviewed by eye and corrected before it is
trusted (the spike's lesson: a CAD name or colour means nothing on its own). Greys go to the generic paints by
lightness, cyan-ish to glass, a saturated colour to a paint of its own in the mapping (<asset>_cad_<n>), toned down
from CAD's full-strength colours. A source with no colours gets its fallback only: map it by part.

    python -m moonshot.web.realism draft <asset> [--fallback paint_mid_grey]     # writes mappings/<asset>.json
"""
from __future__ import annotations

import colorsys
import json
import struct

from moonshot.config import data_root
from moonshot.web.export import asset_record
from moonshot.web.realism.pipeline import MAPPINGS


def cad_colours(asset: str) -> dict[str, list[float]]:
    rec = asset_record(asset)
    b = (data_root() / "library" / rec["category"] / asset / rec["file"]).read_bytes()
    j = json.loads(b[20:20 + struct.unpack_from("<I", b, 12)[0]])
    return {m.get("name", f"mat_{i}"): m.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])[:3]
            for i, m in enumerate(j.get("materials", []))}


def guess(name: str, rgb: list[float], asset: str, local: dict) -> str:
    h, lum, sat = colorsys.rgb_to_hls(*rgb)
    if sat < 0.18 or max(rgb) < 0.06:
        y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
        return ("paint_white" if y > 0.6 else "paint_light_grey" if y > 0.3 else "paint_mid_grey" if y > 0.1
                else "paint_dark_grey" if y > 0.025 else "paint_black")
    if 0.45 < h < 0.56 and rgb[1] > 0.6 and rgb[2] > 0.6:
        return "glass_clear"
    local[f"{asset}_cad_{name.split('_')[-1]}"] = {
        "family": "paint", "color": toned(rgb), "rough": 0.38,
        "about": f"the CAD's {name} colour {[round(c, 2) for c in rgb]}, toned to an enamel"}
    return f"{asset}_cad_{name.split('_')[-1]}"


def toned(rgb: list[float]) -> list[float]:
    """CAD's full-strength colours brought down to what paint reflects; a dark colour stays dark."""
    k = 0.85 if max(rgb) <= 0.7 else 0.6 / max(rgb)
    return [round(c * k, 3) for c in rgb]


def draft(asset: str, fallback: str = "paint_mid_grey") -> dict:
    out = MAPPINGS / f"{asset}.json"
    if out.exists():
        raise SystemExit(f"{out} exists: edit it")
    local: dict = {}
    cols = cad_colours(asset)
    table = {name: guess(name, rgb, asset, local) for name, rgb in cols.items()}
    mp = {"asset": asset, "about": f"{asset_record(asset)['name']}: draft from the CAD's colours",
          "reviewed": "draft: not reviewed", "fallback": fallback, "cad": {"*": table or {"none": fallback}},
          "rules": []}
    if local:
        mp["materials"] = local
    out.write_text(json.dumps(mp, indent=1) + "\n", encoding="utf-8")
    return mp
