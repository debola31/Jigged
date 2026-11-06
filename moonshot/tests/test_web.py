"""The showcase page's data (moonshot/web): the committed file is what the plans and records give today."""
import json

import pytest

from moonshot.web.export import OUT, PUBLISHED, build, media_paths, shop_assets, shop_items, _json, RECORDS


def test_the_committed_page_data_is_current():
    """A plan or record changed without re-running `python -m moonshot.web.export` fails here, not on the page."""
    assert json.loads(OUT.read_text(encoding="utf-8")) == build()


def test_a_step_is_published_by_its_part_and_id():
    """Every live part has an op10-load, so the upload names the part, and each step's media is its own."""
    from moonshot.web.media import live_steps
    steps = live_steps()
    assert sum(i == "op10-load" for _, i in steps) == len({part for part, _ in steps}) > 1
    paths = [p for s in steps.values() for p in media_paths(s["media"])]
    assert len(set(paths)) == len(paths)
    for (part, i), s in steps.items():
        assert all(p.split("/")[1] == part and p.split("/")[2].rsplit(".", 1)[0] == i for p in media_paths(s["media"]))


def test_every_placed_item_has_its_asset_and_model():
    layout = _json(RECORDS / "layout.json")
    shop = build()["shop"]
    assert {i["asset"] for i in shop_items(layout)} == set(shop["assets"]) == set(shop_assets(layout))
    for a, rec in shop["assets"].items():
        assert rec["model"] == f"models/{a}.glb"


def test_each_step_has_its_own_media_and_a_place_in_the_shop():
    """People's work is shown as video and a machine cycle as the part after it, a still and its model; either shows
    only once the upload has recorded all of it in published.json."""
    items = {i["item"] for i in build()["shop"]["items"]}
    published = set(_json(PUBLISHED)["media"])
    for part in build()["parts"]:
        steps = part.get("steps", [])
        paths = [p for s in steps for p in media_paths(s["media"])]
        assert len(set(paths)) == len(paths)
        for s in steps:
            if s["kind"] == "cycle":
                assert s["media"] == {"type": "cut", "still": f"still/{part['id']}/{s['id']}.webp",
                                      "model": f"cut/{part['id']}/{s['id']}.glb"}
            else:
                assert s["media"] == {"type": "video", "path": f"video/{part['id']}/{s['id']}.mp4"}
            assert s["published"] == all(p in published for p in media_paths(s["media"]))
            if "item" in s["where"]:
                assert s["where"]["item"] in items
            assert s["group"] in {g["id"] for g in part["groups"]}


def _realism_root(tmp_path, monkeypatch, status="ok"):
    """A data root holding two realistic models, their tiles and manifest, as moonshot/web/realism writes them."""
    monkeypatch.setenv("MOONSHOT_DATA", str(tmp_path))
    web = tmp_path / "web"
    (web / "models-full").mkdir(parents=True)
    (web / "tiles").mkdir()
    manifest = {"tiles": {"base": "tiles/", "files": ["paint_mr.ktx2", "paint_nrm.ktx2"]},
                "assets": {a: {"full": f"models-full/{a}.glb", "validation": {"status": status}} for a in ("vf2", "d688")}}
    (web / "models-full" / "manifest.json").write_text(json.dumps(manifest))
    for p in ["tiles/paint_mr.ktx2", "tiles/paint_nrm.ktx2", "tiles/tiles.json", "models-full/vf2.glb",
              "models-full/d688.glb"]:
        (web / p).write_bytes(b"x")
    return web


def test_the_realistic_models_publish_tiles_first_and_their_manifest_last(tmp_path, monkeypatch):
    """The page reads the manifest to find the models and the models to find the tiles: published in that order's
    reverse, it never meets a path that isn't there yet. Each goes with the type the browser needs to read it."""
    from moonshot.web.media import CONTENT_TYPES, realism_paths
    _realism_root(tmp_path, monkeypatch)
    paths = realism_paths()
    assert paths == ["tiles/paint_mr.ktx2", "tiles/paint_nrm.ktx2", "tiles/tiles.json", "models-full/vf2.glb",
                     "models-full/d688.glb", "models-full/manifest.json"]
    types = {p: CONTENT_TYPES["." + p.rsplit(".", 1)[1]] for p in paths}
    assert types["tiles/paint_mr.ktx2"] == "image/ktx2" and types["models-full/vf2.glb"] == "model/gltf-binary"
    assert types["models-full/manifest.json"] == types["tiles/tiles.json"] == "application/json"


def test_a_failed_or_missing_realistic_model_is_not_published(tmp_path, monkeypatch):
    from moonshot.web.media import realism_paths
    web = _realism_root(tmp_path, monkeypatch, status="failed: download")
    with pytest.raises(SystemExit, match="failed validation"):
        realism_paths()
    web = _realism_root(tmp_path / "again", monkeypatch)
    (web / "tiles" / "paint_nrm.ktx2").unlink()
    with pytest.raises(SystemExit, match="paint_nrm.ktx2 missing"):
        realism_paths()
