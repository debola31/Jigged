"""The showcase page's data (moonshot/web): the committed file is what the plans and records give today."""
import json

from moonshot.web.export import OUT, PUBLISHED, build, shop_assets, shop_items, _json, RECORDS


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
    """People's work is shown as video and a machine cycle as one still; either shows only once the upload has
    recorded it in published.json."""
    items = {i["item"] for i in build()["shop"]["items"]}
    published = set(_json(PUBLISHED)["media"])
    for part in build()["parts"]:
        steps = part.get("steps", [])
        assert len({s["media"]["path"] for s in steps}) == len(steps)
        for s in steps:
            if s["kind"] == "cycle":
                assert s["media"] == {"type": "still", "path": f"still/{part['id']}/{s['id']}.webp"}
            else:
                assert s["media"] == {"type": "video", "path": f"video/{part['id']}/{s['id']}.mp4"}
            assert s["published"] == (s["media"]["path"] in published)
            if "item" in s["where"]:
                assert s["where"]["item"] in items
            assert s["group"] in {g["id"] for g in part["groups"]}
