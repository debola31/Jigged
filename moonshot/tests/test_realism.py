"""The realistic shop models (moonshot/web/realism): the material library and the per-asset mappings are well-formed,
the heroes are the live parts' stations, and the budgets' arithmetic holds; with the data root, every built model
is valid and the shop stays inside its budgets."""
import json
import re
import threading
import time

import pytest

from moonshot.config import data_root
from moonshot.web.export import RECORDS, _json, asset_record, build, shop_assets
from moonshot.web.media import GLTF_TRANSFORM
from moonshot.web.realism import budgets, locks, matlib
from moonshot.web.realism.paths import HERE
from moonshot.web.realism.pipeline import MAPPINGS, mapped_assets

ALLOWANCE_MAX = 1.5          # a justified download allowance may exceed its class's cap by half, no more
RULE_KEYS = {"why", "material", "links", "cads", "from", "inside", "outside", "normal", "toward", "part_inside",
             "part_size", "parts"}
MAPPING_KEYS = {"asset", "about", "reviewed", "source", "fallback", "cad", "rules", "ops", "smooth_deg", "triangles",
                "atlas", "bbox_tolerance_mm", "bbox_why", "unsure", "fallback_ok", "views", "check_views", "materials",
                "simplify_error", "simplify_why", "triangles_why", "download_bytes", "download_why", "drop_links",
                "drop_links_why", "simplify_positions_only", "double_sided",
                # A self-made model's provenance and the reasons for its settings.
                "sources_used", "atlas_why", "double_sided_why"}


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
        # a library asset with a record; placed in the shop, or about to be (the ratchet wrench's placement is on
        # 2ea6a104, not merged here yet): an unplaced asset's model just isn't in the manifest until it is
        assert mp["asset"] == asset and (asset in shop_assets(layout) or asset_record(asset)["id"] == asset)
        assert set(mp) <= MAPPING_KEYS, set(mp) - MAPPING_KEYS
        assert mp["about"].strip() and mp["reviewed"].strip(), asset
        local = mp.get("materials", {})
        assert matlib.check(local, asset) == [], asset
        known = set(matlib.library(local))
        assert _materials_named(mp) <= known, _materials_named(mp) - known
        for rule in mp.get("rules", []):
            assert set(rule) <= RULE_KEYS and rule.get("why"), (asset, set(rule) - RULE_KEYS)
        for op in mp.get("ops", []):
            assert op["op"] == "pane" and op.get("why"), asset
        if mp.get("bbox_tolerance_mm", 10) > 10:
            assert mp.get("bbox_why"), f"{asset}: a looser frame check says why"
        cls = budgets.budget_class(asset, asset_record(asset)["bbox"])
        if mp.get("triangles", 0) > budgets.CLASSES[cls]["triangles"]:
            assert mp.get("triangles_why"), f"{asset}: a cap above its class's says why"
        if "download_bytes" in mp:
            assert mp.get("download_why"), f"{asset}: a download allowance says why"
            assert mp["download_bytes"] <= ALLOWANCE_MAX * budgets.CLASSES[cls]["download_bytes"],                 f"{asset}: an allowance is a modest overage, not a new class"
        if mp.get("drop_links"):
            assert mp.get("drop_links_why"), f"{asset}: dropping links says why"


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


def test_a_black_or_collapsed_ao_bake_fails_its_check(tmp_path, monkeypatch):
    """edgef's spring shattered into thousands of islands, its pack fell to 0.000 and it baked black: that must
    fail, and a healthy bake pass."""
    import numpy as np
    from PIL import Image
    from moonshot.web.realism import pipeline
    monkeypatch.setattr(pipeline, "work_dir", lambda asset: tmp_path / asset)
    for name, util, img in (("black", 0.0, np.zeros((64, 64))), ("dark", 0.35, np.full((64, 64), 0.1)),
                            ("healthy", 0.35, np.where(np.arange(64)[None, :] < 24, 0.8, 0.0) * np.ones((64, 1)))):
        (tmp_path / name).mkdir()
        Image.fromarray((img * 255).astype(np.uint8)).save(tmp_path / name / "ao.png")
        assert pipeline.ao_health(name, {"uv1_utilisation": util})["ok"] == (name == "healthy"), name


@pytest.fixture
def fast_locks(monkeypatch):
    monkeypatch.setattr(locks, "POLL_S", 0.02)
    monkeypatch.setattr(locks, "HOLD_POLL_S", 0.02)


def test_a_lock_is_a_directory_with_its_owner_and_goes_when_released(tmp_path, fast_locks):
    lock = tmp_path / "gpu-lock.d"
    with locks.dir_lock(lock, "bake vf2"):
        owner = json.loads((lock / "owner.json").read_text())
        assert owner["job"] == "bake vf2" and owner["started_epoch"] <= time.time()
    assert not lock.exists()
    with pytest.raises(RuntimeError), locks.dir_lock(lock, "bake vf2"):
        raise RuntimeError("the bake failed")
    assert not lock.exists(), "a failed job still releases the GPU"


def test_only_one_worker_holds_the_lock_at_a_time(tmp_path, fast_locks):
    """Four workers in their own threads: their jobs never overlap, and every one gets its turn."""
    lock, inside, spans = tmp_path / "gpu-lock.d", [], []

    def worker(i):
        with locks.dir_lock(lock, f"job {i}"):
            inside.append(i)
            assert len(inside) == 1
            t = time.perf_counter()
            time.sleep(0.05)
            spans.append((t, time.perf_counter()))
            inside.remove(i)
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    spans.sort()
    assert len(spans) == 4 and all(a[1] <= b[0] for a, b in zip(spans, spans[1:]))


def test_a_stale_lock_is_broken_and_a_fresh_one_waited_for(tmp_path, fast_locks):
    lock = tmp_path / "gpu-lock.d"
    lock.mkdir()
    (lock / "owner.json").write_text(json.dumps({"token": "dead", "started_epoch": time.time() - 2 * locks.STALE_S}))
    with locks.dir_lock(lock, "after a crash") as waited:
        assert waited < 1 and json.loads((lock / "owner.json").read_text())["job"] == "after a crash"
    assert not list(tmp_path.glob("gpu-lock.d.stale-*"))
    lock.mkdir()
    (lock / "owner.json").write_text(json.dumps({"token": "alive", "started_epoch": time.time()}))
    threading.Timer(0.2, lambda: __import__("shutil").rmtree(lock)).start()
    with locks.dir_lock(lock, "next") as waited:
        assert waited >= 0.15


def test_the_gpu_waits_while_gpu_hold_exists(tmp_path, fast_locks):
    hold = tmp_path / "gpu-hold"
    hold.write_text("measuring")
    threading.Timer(0.2, hold.unlink).start()
    with locks.dir_lock(tmp_path / "gpu-lock.d", "bake", hold=hold) as waited:
        assert waited >= 0.15 and not hold.exists()


def test_a_lock_taken_over_is_not_removed_by_its_old_holder(tmp_path, fast_locks):
    lock = tmp_path / "gpu-lock.d"
    with locks.dir_lock(lock, "slow"):
        (lock / "owner.json").write_text(json.dumps({"token": "someone else", "started_epoch": time.time()}))
    assert lock.exists()


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


def test_a_web_made_model_is_read_from_outside_the_library():
    # A placeholder's web model never replaces the library's file, which the step videos render from.
    from moonshot.web.realism.pipeline import sources
    rec = {"category": "machines", "file": "fadal.glb"}
    made = sources("fadal", {"source": {"path": "realism/sources/fadal/fadal.glb"}}, rec)
    assert made == [{"path": str(data_root() / "realism/sources/fadal/fadal.glb"), "link": None, "undo_y_up": False}]
    assert "library" not in made[0]["path"]
    assert sources("fadal", {}, rec)[0]["path"] == str(data_root() / "library" / "machines" / "fadal" / "fadal.glb")
