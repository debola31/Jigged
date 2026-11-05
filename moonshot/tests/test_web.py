"""The showcase page's data (moonshot/web): the committed file is what the plans and records give today."""
import json

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


def test_what_a_step_uses_is_a_placed_item_or_only_a_name():
    """A step's vise, gauges and cutters link to the shop item that holds them, so the page can fly there; a cutter
    the shop hasn't placed is named and nothing more. A saw's steps use only the saw, which holds the bar and is the
    blade."""
    data = build()
    items = {i["item"] for i in data["shop"]["items"]}
    parts = {p["id"]: {s["id"]: s for s in p["steps"]} for p in data["parts"] if p["status"] == "live"}
    for pid, steps in parts.items():
        for s in steps.values():
            for u in s["uses"]:
                assert u["name"] and set(u) <= {"name", "item"}, (pid, s["id"])
                assert u.get("item", next(iter(items))) in items, (pid, s["id"], u)
    by_id = parts["nist-ftc-10"]
    assert [u.get("item") for u in by_id["op10-xy"]["uses"]] == ["edge-finder-1"]
    assert [u.get("item") for u in by_id["op10-z"]["uses"]] == ["tool-setter-1"]
    assert [u.get("item") for u in by_id["op10-load"]["uses"]] == ["vise-6in-1", "parallels-1"]
    assert by_id["op10-face"]["uses"] == [{"name": "2 in face mill", "item": "fm-2000"}]
    assert (by_id["op10-tools"]["where"]["at"], by_id["op10-face"]["where"]["at"]) == ("pendant", "table")
    saw = parts["ct-slbeam"]
    assert [saw[i]["uses"] for i in ("saw-load", "saw-cut", "saw-unload")] == [[], [], []]
    assert saw["saw-cut"]["where"]["item"] != saw["op10-face"]["where"]["item"]
