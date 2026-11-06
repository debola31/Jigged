"""<data>/web/models-full/manifest.json: what the page needs to stream the realistic models in and swap them for the
light ones, per asset, plus the shop's totals against budgets.SHOP. Only assets whose model is built are listed;
every other asset keeps its light model. SPEC.md (beside this file) is copied next to it."""
from __future__ import annotations

import json
import shutil
from collections import Counter
from pathlib import Path

from moonshot.web.export import RECORDS, _json, asset_record, shop_assets, shop_items
from moonshot.web.realism import budgets
from moonshot.web.realism.paths import HERE, models_dir, tiles_dir, work_dir

RANK = {"hero": 0, "near": 1, "other": 2}


def entries() -> dict[str, dict]:
    layout = _json(RECORDS / "layout.json")
    items = shop_items(layout)
    count = Counter(i["asset"] for i in items)
    pri = budgets.priorities(items)
    out = {}
    for asset in shop_assets(layout):
        rep, glb = work_dir(asset) / "report.json", models_dir() / f"{asset}.glb"
        if not rep.exists() or not glb.exists():
            continue
        r = json.loads(rep.read_text())
        tm = work_dir(asset) / "timings.json"
        out[asset] = {
            "name": asset_record(asset)["name"], "priority": pri[asset], "class": r["class"], "items": count[asset],
            "light": f"models/{asset}.glb", "full": f"models-full/{asset}.glb", "bytes": glb.stat().st_size,
            "triangles": r["triangles"], "draw_calls": r["draw_calls"],
            "gpu_texture_bytes": r["gpu_texture_bytes"], "gpu_geometry_bytes": r["gpu_geometry_bytes"],
            "ao": {"size": r["ao"]["size"], "bytes": r["ao"]["bytes"]} if r["ao"] else None,
            "tiles": sorted(r["tiles"]), "materials": r["materials"],
            "validation": {"status": r["status"], **r["validator"], "checks": r["checks"]},
            "timings_s": {k: v["seconds"] for k, v in json.loads(tm.read_text()).items()} if tm.exists() else {},
        }
    return out


def write() -> Path:
    assets = entries()
    tiles = json.loads((tiles_dir() / "tiles.json").read_text())
    order = sorted(assets, key=lambda a: (RANK[assets[a]["priority"]], assets[a]["bytes"]))
    for i, a in enumerate(order):
        assets[a]["load_order"] = i
    used = sorted({t for a in assets.values() for t in a["tiles"]})
    tile_bytes = {f["file"]: f for fam in tiles["families"].values() for f in fam["files"].values()}
    used_files = [u.split("/")[-1] for u in used]
    totals = {
        "assets": len(assets),
        "download_bytes": sum(a["bytes"] for a in assets.values()) + sum(tile_bytes[f]["bytes"] for f in used_files),
        "tiles_bytes": sum(tile_bytes[f]["bytes"] for f in used_files),
        "gpu_texture_bytes": sum(a["gpu_texture_bytes"] for a in assets.values())
        + sum(tile_bytes[f]["gpu_bytes"] for f in used_files),
        "gpu_geometry_bytes": sum(a["gpu_geometry_bytes"] for a in assets.values()),
        "triangles_drawn": sum(a["triangles"] * a["items"] for a in assets.values()),
        "draw_calls": sum(a["draw_calls"] * a["items"] for a in assets.values()),
    }
    doc = {
        "schema": "jigged.realism-models/1",
        "about": "Realistic shop models, streamed in after the light ones and swapped in per asset, in load_order "
                 "(heroes first). Paths are relative to the media root, as the light models' are. The contract is "
                 "SPEC.md beside this file. Written by python -m moonshot.web.realism manifest; don't edit.",
        "tiles": {"base": "tiles/", "files": used_files},
        "assets": {a: assets[a] for a in order},
        "totals": totals,
        "budgets": {"shop": budgets.SHOP, "classes": budgets.CLASSES},
    }
    models_dir().mkdir(parents=True, exist_ok=True)
    p = models_dir() / "manifest.json"
    p.write_text(json.dumps(doc, indent=1) + "\n")
    if (HERE / "SPEC.md").exists():
        shutil.copyfile(HERE / "SPEC.md", models_dir() / "SPEC.md")
    return p
