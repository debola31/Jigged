"""What the whole shop will cost once every asset is built, from what the built ones measured: per asset its class,
triangles, download and GPU bytes (measured where built, estimated where not), and the shop's totals against
budgets.SHOP, including the frame time extrapolated from the page-side check's stress shots.

    python -m moonshot.web.realism project        # prints the table; writes <data>/realism/projection.json
"""
from __future__ import annotations

import json
from collections import Counter

from moonshot.web.export import RECORDS, _json, asset_record, shop_assets, shop_items
from moonshot.web.realism import budgets
from moonshot.web.realism.manifest import entries
from moonshot.web.realism.paths import tiles_dir, work_root

AREA_PER_BOX_AREA = 2.0      # CAD surface area over its bounding box's: the VF-2 measured 71.3 m2 on a 35.7 m2 box
UV1_UTILISATION = 0.45       # the pilot's packed atlases used 0.38-0.55 of the square
DRAWS = {"hero": 10, "large": 6, "small": 3}     # one per library material; the pilot measured 3-16
GPU_GEOMETRY_PER_TRI = 32    # bytes: quantised position, normal, two UVs, 32-bit index (the VF-2: 31.6)


def coefficients(built: dict[str, dict]) -> dict:
    """Bytes per triangle of geometry and bytes per AO texel, from the built assets (the pilot's if none)."""
    geo = [(a["bytes"] - (a["ao"]["bytes"] if a["ao"] else 0), a["triangles"]) for a in built.values()]
    ao = [(a["ao"]["bytes"], a["ao"]["size"][0] * a["ao"]["size"][1]) for a in built.values() if a["ao"]]
    return {"bytes_per_triangle": sum(b for b, _ in geo) / max(sum(t for _, t in geo), 1) if geo else 17.0,
            "ao_bytes_per_texel": sum(b for b, _ in ao) / max(sum(t for _, t in ao), 1) if ao else 0.15}


def frame_model() -> dict | None:
    """ms per million triangles drawn, fitted on the shop shots with static shadows (as the page draws them)."""
    p = work_root() / "checks" / "shop.json"
    if not p.exists():
        return None
    pts = [(r["stats"]["triangles"], r["frame_ms"]) for r in json.loads(p.read_text())
           if r.get("shadow") == "static" and r.get("mode") == "full" and r.get("frame_ms")]
    if len(pts) < 2:
        return None
    n = len(pts)
    mx, my = sum(x for x, _ in pts) / n, sum(y for _, y in pts) / n
    slope = sum((x - mx) * (y - my) for x, y in pts) / sum((x - mx) ** 2 for x, _ in pts)
    light = next((r["frame_ms"] for r in json.loads(p.read_text())
                  if r.get("shadow") == "static" and r.get("mode") == "light"), None)
    return {"ms_per_mtri": slope * 1e6, "intercept_ms": my - slope * mx, "points": pts, "light_shop_ms": light}


def project() -> dict:
    layout = _json(RECORDS / "layout.json")
    items = shop_items(layout)
    count = Counter(i["asset"] for i in items)
    pri = budgets.priorities(items)
    built = entries()
    k = coefficients(built)
    rows = {}
    for a in shop_assets(layout):
        rec = asset_record(a)
        cls = budgets.budget_class(a, rec["bbox"])
        c = budgets.CLASSES[cls]
        if a in built:
            b = built[a]
            rows[a] = {"class": cls, "priority": pri[a], "items": count[a], "built": True, "triangles": b["triangles"],
                       "bytes": b["bytes"], "gpu_texture_bytes": b["gpu_texture_bytes"],
                       "gpu_geometry_bytes": b["gpu_geometry_bytes"], "draw_calls": b["draw_calls"]}
            continue
        size = [(hi - lo) / 1000 for lo, hi in zip(rec["bbox"]["min"], rec["bbox"]["max"])]
        area = 2 * (size[0] * size[1] + size[1] * size[2] + size[0] * size[2]) * AREA_PER_BOX_AREA
        side = budgets.atlas_side(area, UV1_UTILISATION, cls)
        tris = min(rec["triangles"], c["triangles"])
        rows[a] = {"class": cls, "priority": pri[a], "items": count[a], "built": False, "triangles": tris,
                   "bytes": int(tris * k["bytes_per_triangle"] + side * side * k["ao_bytes_per_texel"]),
                   "gpu_texture_bytes": budgets.gpu_texture_bytes(side, side),
                   "gpu_geometry_bytes": tris * GPU_GEOMETRY_PER_TRI, "draw_calls": DRAWS[cls],
                   "placeholder": rec["triangles"] < 1000}
    tiles = json.loads((tiles_dir() / "tiles.json").read_text())
    tot = {
        "assets": len(rows), "built": sum(r["built"] for r in rows.values()),
        "download_bytes": sum(r["bytes"] for r in rows.values()) + tiles["bytes"],
        "tiles_bytes": tiles["bytes"],
        "gpu_texture_bytes": sum(r["gpu_texture_bytes"] for r in rows.values()) + tiles["gpu_bytes"],
        "gpu_geometry_bytes": sum(r["gpu_geometry_bytes"] for r in rows.values()),
        "triangles_drawn": sum(r["triangles"] * r["items"] for r in rows.values()),
        "draw_calls": sum(r["draw_calls"] * r["items"] for r in rows.values()),
        "over_class_budget": [a for a, r in rows.items() if r["bytes"] > budgets.CLASSES[r["class"]]["download_bytes"]],
        "by_class": {cls: {"assets": sum(r["class"] == cls for r in rows.values()),
                           "bytes": sum(r["bytes"] for r in rows.values() if r["class"] == cls),
                           "triangles_drawn": sum(r["triangles"] * r["items"] for r in rows.values() if r["class"] == cls)}
                     for cls in budgets.CLASSES},
    }
    fm = frame_model()
    if fm:
        tot["frame_ms_projected"] = round(fm["intercept_ms"] + fm["ms_per_mtri"] * tot["triangles_drawn"] / 1e6, 1)
    out = {"coefficients": k, "frame_model": fm, "totals": tot, "budgets": budgets.SHOP, "assets": rows}
    (work_root() / "projection.json").write_text(json.dumps(out, indent=1))
    return out
