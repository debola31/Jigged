"""Usage cards (plan §4) are well formed: each validates against the card schema, names assets that exist, cites
sources that exist, and points at planner code that exists."""
import importlib.util
import json
from pathlib import Path

import jsonschema
import pytest

CARDS = Path(__file__).resolve().parents[1] / "cards"
RECORDS = Path(__file__).resolve().parents[1] / "library" / "records" / "assets"
STATIONS = Path(__file__).resolve().parents[1] / "library" / "stations"
REPO = Path(__file__).resolve().parents[2]
SCHEMA = json.loads((CARDS / "card.schema.json").read_text(encoding="utf-8"))
ALL = sorted(p for p in CARDS.glob("*.json") if p.name != "card.schema.json")


def test_there_are_cards():
    assert ALL


@pytest.mark.parametrize("path", ALL, ids=lambda p: p.stem)
def test_card_is_well_formed(path):
    card = json.loads(path.read_text(encoding="utf-8"))
    jsonschema.validate(card, SCHEMA)
    assert card["id"] == path.stem
    assets = {p.stem for p in RECORDS.glob("*/*/*.json")} | {p.stem for p in STATIONS.glob("*.json")}
    assert set(card["assets"]) <= assets, set(card["assets"]) - assets
    for ph in card["phases"]:
        assert ph.get("source", 0) < len(card["sources"])
    for s in card["sources"]:
        if "file" in s:
            assert (REPO / s["file"]).exists(), s["file"]
    if "motion" in card:
        module, _, fn = card["motion"].partition(":")
        assert importlib.util.find_spec(module) is not None, module
