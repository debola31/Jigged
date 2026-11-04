"""Write the showcase page's data, app/(marketing)/showcase/showcase.json (plan §1 "Website"; track F).

The page reads only this file: the 20 parts in plan order, each live part's steps exactly as the plan expands them
(title and caption included, so a caption can only name the plan's facts, plan §2 O8), and the shop as laid out by
layout.json and shop.json. moonshot/ never reaches a Vercel build, so the data is copied out rather than imported.
Videos, stills and models aren't in it: it names their paths in Supabase Storage (`media.py`), and marks a step
`published` only once its media is in published.json, which the upload writes; the page shows the others as coming.
Only people's work is rendered as video: a machine cycle is shown by the part after the cut, as one still and, on a
desktop, as its 3D model.

    python -m moonshot.web.export          # rewrites the file; the gate test_web_steps.py checks it
"""
from __future__ import annotations

import json
from pathlib import Path

from moonshot.planning.steps import expand
from moonshot.planning.validate import load_plan

REPO = Path(__file__).resolve().parents[2]
RECORDS = REPO / "moonshot" / "library" / "records"
OUT = REPO / "app" / "(marketing)" / "showcase" / "showcase.json"
PUBLISHED = Path(__file__).resolve().parent / "published.json"

# Plan §7, in order. A part is live once its steps are rendered, checked and published.
PARTS = ["nist-ftc-10", "nist-ctc-01", "ll-1005337", "ct-slbeam", "ll-1007223", "ct-tpg322", "ll-1011439",
         "ll-1007224", "mcm-8017t3", "nist-ctc-05", "mcm-8492a054", "mcm-91259a544", "ct-8848hn", "nist-ftc-09",
         "ll-1011443", "ll-1011604", "ct-brmb0143", "ct-107w-ngd-3r", "ll-1006941", "ct-10004-bcrm"]
LIVE = {"nist-ftc-10"}
# Where a finishing station's steps happen: its zone in layout.json.
STATION_ZONES = {"bench": "benches", "inspection": "inspection"}


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def asset_record(asset: str) -> dict:
    return _json(next(RECORDS.glob(f"assets/*/{asset}/{asset}.json")))


def shop_items(layout: dict) -> list[dict]:
    """Every drawn thing in the shop: the placements, then the surfaces that are shop.json items (the benches)."""
    items = [{k: p[k] for k in ("item", "asset", "x", "y", "z", "rot")} for p in layout["placements"]]
    items += [{"item": s["item"], "asset": s["asset"], "x": s["x"], "y": s["y"], "z": 0, "rot": s["rot"]}
              for s in layout["surfaces"] if s.get("item")]
    return items


def shop_assets(layout: dict) -> list[str]:
    return sorted({i["asset"] for i in shop_items(layout)})


def shop(layout: dict, shop_json: dict) -> dict:
    assets = {}
    for a in shop_assets(layout):
        rec = asset_record(a)
        assets[a] = {"name": rec["name"], "model": f"models/{a}.glb", "bbox": rec["bbox"]}
    return {"name": shop_json["shop"]["name"], "fictional": shop_json["shop"]["fictional"],
            "building": layout["building"], "zones": layout["zones"], "aisles": layout["aisles"],
            "furniture": [{k: s[k] for k in ("id", "kind", "x", "y", "rot", "size")}
                          for s in layout["surfaces"] if not s.get("item")],
            "items": shop_items(layout), "assets": assets}


def where_machine(machine: str, layout: dict, shop_json: dict) -> dict:
    """A machine step happens at the shop's one item of that asset."""
    [p] = [p for p in layout["placements"] if p["asset"] == machine]
    name = next(m["name"] for m in shop_json["machines"] if m["id"] == p["item"])
    return {"name": name, "item": p["item"], "x": p["x"], "y": p["y"]}


def where_zone(zone_id: str, layout: dict) -> dict:
    z = next(z for z in layout["zones"] if z["id"] == zone_id)
    x0, y0, x1, y1 = z["rect"]
    return {"name": z["name"], "x": (x0 + x1) / 2, "y": (y0 + y1) / 2}


def step_media(part: str, step: dict) -> dict:
    """What the page shows for a step: people's work as a video, a machine cycle as the part after it (a still,
    and the model a desktop can turn)."""
    if step["kind"] == "cycle":
        return {"type": "cut", "still": f"still/{part}/{step['id']}.webp", "model": f"cut/{part}/{step['id']}.glb"}
    return {"type": "video", "path": f"video/{part}/{step['id']}.mp4"}


def media_paths(media: dict) -> list[str]:
    return [media["still"], media["model"]] if media["type"] == "cut" else [media["path"]]


def live_part(part: str, layout: dict, shop_json: dict) -> dict:
    plan = load_plan(part)
    published = set(_json(PUBLISHED)["media"])
    machine = {s["id"]: s["machine"] for s in plan["setups"]}
    groups = [{"id": s["id"], "title": s["title"]} for s in plan["setups"]]
    if plan.get("finish"):
        groups.append({"id": "finish", "title": "Finishing"})
    steps = []
    for s in expand(plan):
        where = (where_machine(machine[s["setup"]], layout, shop_json) if "setup" in s
                 else where_zone(STATION_ZONES[s["station"]], layout))
        media = step_media(part, s)
        steps.append({"id": s["id"], "title": s["title"], "caption": s["caption"], "kind": s["kind"],
                      "group": s.get("setup", "finish"), "where": where, "media": media,
                      "published": all(p in published for p in media_paths(media))})
    return {"material": plan["stock"]["material"], "groups": groups, "steps": steps}


def build() -> dict:
    layout, shop_json = _json(RECORDS / "layout.json"), _json(RECORDS / "shop.json")
    parts = []
    for pid in PARTS:
        rec = _json(RECORDS / "parts" / pid / "part.json")
        p = {"id": pid, "name": rec["name"], "size": rec["size"], "status": "live" if pid in LIVE else "coming"}
        if pid in LIVE:
            p |= live_part(pid, layout, shop_json)
        parts.append(p)
    return {"schema": "jigged.showcase/1",
            "note": "Written by python -m moonshot.web.export from the plans and moonshot/library/records; don't edit.",
            "parts": parts, "shop": shop(layout, shop_json)}


def main() -> None:
    text = json.dumps(build(), indent=1, ensure_ascii=False) + "\n"
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(REPO)} ({len(text) / 1000:.0f} kB)")


if __name__ == "__main__":
    main()
