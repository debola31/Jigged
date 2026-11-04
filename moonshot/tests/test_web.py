"""The showcase page's data (moonshot/web): the committed file is what the plans and records give today."""
import json

from moonshot.web.export import OUT, PUBLISHED, build, media_paths, shop_assets, shop_items, _json, RECORDS


def test_the_committed_page_data_is_current():
    """A plan or record changed without re-running `python -m moonshot.web.export` fails here, not on the page."""
    assert json.loads(OUT.read_text(encoding="utf-8")) == build()


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
