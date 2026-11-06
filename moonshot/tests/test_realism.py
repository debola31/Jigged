"""The realistic shop models (moonshot/web/realism): the material library and the per-asset mappings are well-formed,
the heroes are the live parts' stations, and the budgets' arithmetic holds; with the data root, every built model
is valid and the shop stays inside its budgets."""
import json
import re

import pytest

from moonshot.config import data_root
from moonshot.web.export import RECORDS, _json, build, shop_assets
from moonshot.web.media import GLTF_TRANSFORM
from moonshot.web.realism import budgets, matlib
from moonshot.web.realism.paths import HERE
from moonshot.web.realism.pipeline import MAPPINGS, mapped_assets

RULE_KEYS = {"why", "material", "links", "cads", "from", "inside", "outside", "normal", "toward", "part_inside",
             "part_size", "parts"}
MAPPING_KEYS = {"asset", "about", "reviewed", "source", "fallback", "cad", "rules", "ops", "smooth_deg", "triangles",
                "atlas", "bbox_tolerance_mm", "bbox_why", "unsure", "fallback_ok", "views", "check_views"}


def test_the_material_library_is_consistent():
    assert matlib.check() == []


def test_every_material_resolves_to_factors_a_gltf_accepts():
    means = {s: [0.5, 0.5, 0.5] for s in matlib.SOURCES}
    for name in matlib.MATERIALS:
        r = matlib.resolved(name, means)
        assert all(0 <= c <= 1 for c in r["baseColorFactor"]), name
        assert 0 < r["roughnessFactor"] <= 1 and 0 <= r["metallicFactor"] <= 1, name
        assert r["tile_m"] > 0, name


def _materials_named(mp: dict) -> set[str]:
    names = {mp["fallback"]} | {m for table in mp.get("cad", {}).values() for m in table.values()}
    return names | {r["material"] for r in mp.get("rules", []) + mp.get("ops", [])}


def test_every_mapping_names_real_assets_materials_and_rule_keys():
    layout = _json(RECORDS / "layout.json")
    assert mapped_assets(), "no mappings"
    for asset in mapped_assets():
        mp = json.loads((MAPPINGS / f"{asset}.json").read_text(encoding="utf-8"))
        assert mp["asset"] == asset and asset in shop_assets(layout)
        assert set(mp) <= MAPPING_KEYS, set(mp) - MAPPING_KEYS
        assert mp["about"].strip() and mp["reviewed"].strip(), asset
        assert _materials_named(mp) <= set(matlib.MATERIALS), _materials_named(mp) - set(matlib.MATERIALS)
        for rule in mp.get("rules", []):
            assert set(rule) <= RULE_KEYS and rule.get("why"), (asset, set(rule) - RULE_KEYS)
        for op in mp.get("ops", []):
            assert op["op"] == "pane" and op.get("why"), asset
        if mp.get("bbox_tolerance_mm", 10) > 10:
            assert mp.get("bbox_why"), f"{asset}: a looser frame check says why"


def test_the_heroes_are_the_live_parts_stations():
    """Every machine a live step happens at, and the benches its finishing steps use, stream in first."""
    stations = {s["where"]["item"] for p in build()["parts"] for s in p.get("steps", []) if "item" in s["where"]}
    layout = _json(RECORDS / "layout.json")
    asset_of = {p["item"]: p["asset"] for p in layout["placements"]}
    assert {asset_of[i] for i in stations} <= set(budgets.HERO)
    assert set(budgets.HERO) <= set(shop_assets(layout))
    items = [{"asset": p["asset"], "x": p["x"], "y": p["y"]} for p in layout["placements"]]
    pri = budgets.priorities(items)
    assert {a for a, p in pri.items() if p == "hero"} == set(budgets.HERO) & set(pri)


def test_the_budget_arithmetic():
    assert budgets.gpu_texture_bytes(4096, 4096) == 22_369_621          # 16 Mi texels, BC7, plus mips
    for cls, c in budgets.CLASSES.items():
        sides = [budgets.atlas_side(a, 0.45, cls) for a in (0.001, 0.1, 1, 10, 100, 1000)]
        assert sides == sorted(sides) and sides[0] == c["atlas_min"] and sides[-1] == c["atlas_max"], cls
        assert all(s & (s - 1) == 0 for s in sides), cls
    assert budgets.budget_class("vf2", {"min": [0, 0, 0], "max": [1, 1, 1]}) == "hero"
    assert budgets.budget_class("x", {"min": [0, 0, 0], "max": [100, 50, 20]}) == "small"


def test_the_node_tools_are_pinned_as_the_spike_found_them_working():
    """Exact versions only (the repo ignores package-lock.json); gltf-transform as media.py's CLI; sharp 0.35.5,
    since 0.34 breaks gltf-transform 4.5.1."""
    pkg = json.loads((HERE / "pack" / "package.json").read_text())
    assert all(re.fullmatch(r"\d+\.\d+\.\d+(-[\w.]+)?", v) for v in pkg["dependencies"].values()), pkg
    assert pkg["dependencies"]["@gltf-transform/core"] == GLTF_TRANSFORM.rsplit("@", 1)[1]
    assert pkg["overrides"]["sharp"] == "0.35.5"


@pytest.mark.data_root
def test_every_built_model_is_valid_and_the_shop_stays_in_budget():
    manifest = data_root() / "web" / "models-full" / "manifest.json"
    if not manifest.exists():
        pytest.skip("no realistic models in the data root")
    m = json.loads(manifest.read_text())
    for asset, a in m["assets"].items():
        assert a["validation"]["status"] == "ok", (asset, a["validation"])
        assert (data_root() / "web" / a["full"]).exists() and (data_root() / "web" / a["light"]).exists()
        for t in a["tiles"]:
            assert (data_root() / "web" / "tiles" / t.split("/")[-1]).exists(), (asset, t)
    t = m["totals"]
    assert t["download_bytes"] <= budgets.SHOP["download_bytes"]
    assert t["gpu_texture_bytes"] + t["gpu_geometry_bytes"] <= budgets.SHOP["gpu_bytes"]
