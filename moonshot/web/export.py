"""Write the showcase page's data, app/(marketing)/showcase/showcase.json (plan §1 "Website"; track F).

The page reads only this file: the 20 parts in plan order, each live part's steps exactly as the plan expands them
(title and caption included, so a caption can only name the plan's facts, plan §2 O8), and the shop as laid out by
layout.json and shop.json. moonshot/ never reaches a Vercel build, so the data is copied out rather than imported.
Videos, stills and models aren't in it: it names their paths in Supabase Storage (`media.py`), and marks a step
`published` only once its media is in published.json, which the upload writes; the page shows the others as coming.
Only people's work is rendered as video: a machine cycle is shown by the part after the cut, as one still and, on a
desktop, as its 3D model. A person's step published as a still and no video is shown as that still and its caption.

    python -m moonshot.web.export          # rewrites the file; the gate test_web_steps.py checks it
"""
from __future__ import annotations

import json
from pathlib import Path

from moonshot.planning.steps import LATHES, TOOL_NAMES, expand
from moonshot.planning.validate import load_plan

REPO = Path(__file__).resolve().parents[2]
RECORDS = REPO / "moonshot" / "library" / "records"
OUT = REPO / "app" / "(marketing)" / "showcase" / "showcase.json"
PUBLISHED = Path(__file__).resolve().parent / "published.json"

# Plan §7, in order. A part is live once it is being rendered: its plan's steps are on the page, and each shows once
# its media is published.
PARTS = ["nist-ftc-10", "nist-ftc-09", "ll-1005337", "ct-slbeam", "ll-1007223", "ct-tpg322", "ll-1011439",
         "ll-1007224", "mcm-8017t3", "nist-ctc-05", "mcm-8492a054", "mcm-91259a544", "ct-8848hn", "nist-ctc-01",
         "ll-1011443", "ll-1011604", "ct-brmb0143", "ct-107w-ngd-3r", "ll-1006941", "ct-10004-bcrm"]
# The user's decision (2026-11-06): five parts on the page, G1's. G2-G5 are dropped; G2's published media stays in the
# bucket, unlisted.
LIVE = {"nist-ftc-10", "nist-ftc-09", "ll-1005337", "ct-slbeam", "ll-1007223"}
# Where a finishing station's steps happen: its zone in layout.json.
STATION_ZONES = {"bench": "benches", "inspection": "inspection", "outside": "shipping"}
# shop.json's lists of things, in the order the page lists them.
CATEGORIES = ["machines", "workholding", "holders", "tools", "inspection", "consumables", "hand_tools", "support",
              "outside_processes"]
# What a setup step uses besides its machine, by the shop.json kind that holds it, after the step's id
# (moonshot/planning/steps.py). The vise, a cutter and a loaded tool are named by the plan itself.
STEP_KINDS = {"xy": ["edge_finder"], "z": ["tool_setter"]}
FINISH_KINDS = {"deburr": ["deburring_kit"]}
# A machine step happens at its table (inside the door), or at its pendant: loading tools and starting the cycle.
AT_PENDANT = {"tools", "start"}
# shop.json fields that are bookkeeping or shown elsewhere, not facts about the thing.
NOT_FACTS = {"id", "name", "kind", "asset", "make", "model", "description", "guide_support", "note", "location"}


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


def entries(shop_json: dict) -> dict[str, dict]:
    """Every shop.json thing by id, with its list's name as its category."""
    return {e["id"]: e | {"category": c} for c in CATEGORIES for e in shop_json.get(c, [])}


def _humanize(v) -> str:
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, list):
        return ", ".join(_humanize(x) for x in v)
    return str(v).replace("_", " ")


def entry_facts(entry: dict) -> list[list[str]]:
    """A shop.json thing's own facts as label and value rows; a capability's basis and source are dropped."""
    rows = []

    def walk(obj: dict, prefix: str):
        for k, v in obj.items():
            if k in NOT_FACTS or k in ("category", "basis", "source"):
                continue
            label = f"{prefix} {_humanize(k)}".strip()
            if isinstance(v, dict):
                walk(v, label)
            else:
                label = label.removesuffix(" values").removesuffix(" value")   # "Materials values" reads "Materials"
                rows.append([label[:1].upper() + label[1:], _humanize(v)])

    walk(entry, "")
    return rows


def item_name(entry: dict, asset: dict) -> str:
    return entry.get("name") or entry.get("description") or asset["name"]


def shop(layout: dict, shop_json: dict) -> dict:
    assets = {}
    for a in shop_assets(layout):
        rec = asset_record(a)
        assets[a] = {"name": rec["name"], "model": f"models/{a}.glb", "bbox": rec["bbox"],
                     "description": rec["description"], "key_specs": rec["key_specs"]}
    things, zones = entries(shop_json), {}
    for p in layout["placements"]:
        zones[p["item"]] = (p["zone"], p.get("on"))
    for s in layout["surfaces"]:
        if s.get("item"):
            zones.setdefault(s["item"], (s["zone"], None))
    items = []
    for i in shop_items(layout):
        e = things[i["item"]]
        zone, on = zones[i["item"]]
        items.append(i | {"name": item_name(e, assets[i["asset"]]), "category": e["category"], "kind": e["kind"],
                          "zone": zone, **({"on": on} if on else {}),
                          **{k: e[k] for k in ("make", "model") if k in e}, "facts": entry_facts(e)})
    return {"name": shop_json["shop"]["name"], "fictional": shop_json["shop"]["fictional"],
            "categories": CATEGORIES, "building": layout["building"], "zones": layout["zones"],
            "aisles": layout["aisles"],
            "furniture": [{k: s[k] for k in ("id", "kind", "name", "x", "y", "rot", "size")}
                          for s in layout["surfaces"] if not s.get("item")],
            "surfaces": {s["id"]: s["name"] for s in layout["surfaces"]},
            "items": items, "assets": assets}


def uses(step: dict, setups: dict, shop_json: dict, layout: dict) -> list[dict]:
    """What a step uses besides its station, each with the shop item that holds it when the shop has one placed:
    the setup's vise and parallels (or stop, or clamps), the edge finder and tool setter, and the plan's cutters."""
    placed = {i["item"] for i in shop_items(layout)}
    things = [e for e in entries(shop_json).values() if e["id"] in placed]
    by_asset = {e["asset"]: e for e in reversed(things)}
    by_kind = {e["kind"]: e for e in reversed(things)}

    def thing(e: dict | None, name: str | None = None) -> list[dict]:
        if e is None:
            return [{"name": name}] if name else []
        return [{"name": name or item_name(e, asset_record(e["asset"])), "item": e["id"]}]

    def tool(asset: str) -> list[dict]:
        return thing(by_asset.get(asset), TOOL_NAMES.get(asset, asset).removeprefix("the "))

    if "setup" not in step:
        return [u for k in FINISH_KINDS.get(step["id"], []) for u in thing(by_kind.get(k))]
    setup = setups[step["setup"]]
    what = step["id"].removeprefix(f"{setup['id']}-")
    if "operation" in step:                     # a cycle, or an operation done by hand on a manual machine
        op = next(o for o in setup["operations"] if o["id"] == step["operation"])
        # A saw's blade is the saw: the station itself.
        return [] if op["tool"] == setup["machine"] else tool(op["tool"])
    if what == "tools":
        return [u for t in step["facts"]["tool_ids"] for u in tool(t)]
    if what == "touch":                         # a grinder's wheel, touched down on the part
        return [u for t in dict.fromkeys(op["tool"] for op in setup["operations"]) for u in tool(t)]
    if what in STEP_KINDS and setup["machine"] not in LATHES:     # a lathe's Z is touched off with its own tool
        return [u for k in STEP_KINDS[what] for u in thing(by_kind.get(k))]
    # A saw holds the bar in its own vise.
    if what not in ("clean", "load", "seat", "check", "shift") or "workholding" not in setup:
        return []
    w = setup["workholding"]
    if "chuck" in w:                            # a lathe's chuck or collet; a grinder's magnetic chuck and keepers
        return [u for k in ("chuck", "keepers") if k in w and w[k] != setup["machine"]   # its own chuck: the station
                for u in thing(by_asset.get(w[k]))]
    if "vise" in w:
        held = thing(by_asset.get(w["vise"])) + thing(by_kind.get("parallel_set" if w["parallels_in"] else "vise_stop"))
        return held + (thing(by_kind.get("test_indicator")) if what == "check" and not w["parallels_in"] else [])
    return thing(by_kind.get("clamp_kit")) + (thing(by_kind.get("test_indicator")) if what == "check" else [])


def where_machine(machine: str, layout: dict, shop_json: dict) -> dict:
    """A machine step happens at the shop's one item of that asset."""
    [p] = [p for p in layout["placements"] if p["asset"] == machine]
    name = next(m["name"] for m in shop_json["machines"] if m["id"] == p["item"])
    return {"name": name, "item": p["item"], "x": p["x"], "y": p["y"]}


def where_zone(zone_id: str, layout: dict) -> dict:
    z = next(z for z in layout["zones"] if z["id"] == zone_id)
    x0, y0, x1, y1 = z["rect"]
    return {"name": z["name"], "x": (x0 + x1) / 2, "y": (y0 + y1) / 2}


def step_media(part: str, step: dict, published: set[str] | frozenset[str] = frozenset()) -> dict:
    """What the page shows for a step: people's work as a video, a machine cycle as the part after it (a still,
    and the model a desktop can turn). A person's step whose still is published and its video isn't is shown as
    that still with its caption (the user's decision, 2026-11-06: G1's deferred loads and lift-outs, its inspects
    and ct-slbeam's cleans); once its video is published, the video."""
    if step["kind"] == "cycle":
        return {"type": "cut", "still": f"still/{part}/{step['id']}.webp", "model": f"cut/{part}/{step['id']}.glb"}
    video, still = f"video/{part}/{step['id']}.mp4", f"still/{part}/{step['id']}.webp"
    if video not in published and still in published:
        return {"type": "still", "still": still}
    return {"type": "video", "path": video}


def media_paths(media: dict) -> list[str]:
    if media["type"] == "cut":
        return [media["still"], media["model"]]
    return [media["still"]] if media["type"] == "still" else [media["path"]]


def live_part(part: str, layout: dict, shop_json: dict) -> dict:
    plan = load_plan(part)
    published = set(_json(PUBLISHED)["media"])
    setups = {s["id"]: s for s in plan["setups"]}
    groups = [{"id": s["id"], "title": s["title"], "where": where_machine(s["machine"], layout, shop_json)["name"]}
              for s in plan["setups"]]
    if plan.get("finish"):
        groups.append({"id": "finish", "title": "Finishing"})
    steps = []
    for s in expand(plan):
        if "setup" in s:
            at = "pendant" if s["id"].removeprefix(f"{s['setup']}-") in AT_PENDANT else "table"
            where = where_machine(setups[s["setup"]]["machine"], layout, shop_json) | {"at": at}
        else:
            where = where_zone(STATION_ZONES[s["station"]], layout)
        media = step_media(part, s, published)
        steps.append({"id": s["id"], "title": s["title"], "caption": s["caption"], "kind": s["kind"],
                      "group": s.get("setup", "finish"), "where": where,
                      "uses": uses(s, setups, shop_json, layout), "media": media,
                      "published": all(p in published for p in media_paths(media))})
    stock = plan["stock"]
    return {"material": stock["material"],
            "stock": {"material": stock["material"], "size": stock["size_in"], "from": stock["from"]},
            "groups": groups, "steps": steps}


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
