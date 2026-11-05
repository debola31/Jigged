"""The showcase page says what the plan says, before anyone watches it (plan §1 "Website", §2 O1 and O8; track F).

Every step a live part's plan expands to is in the page's data, in order, with the plan's own title and caption, and
each caption names only that step's facts. The page's caption is checked against the facts from the plan, not any the
page carries, so the page can't vouch for itself (plan §6, rule 2). The page lists all 20 parts and nist-ftc-10 is
live. Protected (plan §6, rule 1)."""
import json
from pathlib import Path

import pytest

from moonshot.planning.steps import caption_names_only_facts, expand
from moonshot.planning.validate import PLANS, load_plan

REPO = Path(__file__).resolve().parents[3]
PAGE_DATA = REPO / "app" / "(marketing)" / "showcase" / "showcase.json"
PART_RECORDS = REPO / "moonshot" / "library" / "records" / "parts"
FIRST = "nist-ftc-10"


@pytest.fixture(scope="module")
def page():
    return json.loads(PAGE_DATA.read_text(encoding="utf-8"))


def live(page):
    return [p for p in page["parts"] if p["status"] == "live"]


def test_the_page_lists_all_20_parts_and_the_first_is_live(page):
    assert sorted(p["id"] for p in page["parts"]) == sorted(d.name for d in PART_RECORDS.iterdir() if d.is_dir())
    assert len(page["parts"]) == 20
    assert FIRST in {p["id"] for p in live(page)}


def test_only_a_live_part_carries_steps(page):
    for p in page["parts"]:
        assert ("steps" in p) == (p["status"] == "live"), p["id"]
        assert p["status"] in ("live", "coming"), p["id"]


def test_every_live_part_has_a_plan(page):
    assert {p["id"] for p in live(page)} <= {f.stem for f in PLANS.glob("*.json")}


def test_every_planned_step_is_on_the_page_in_order(page):
    for p in live(page):
        assert [s["id"] for s in p["steps"]] == [s["id"] for s in expand(load_plan(p["id"]))], p["id"]


def test_each_step_carries_the_plans_title_and_caption(page):
    for p in live(page):
        planned = {s["id"]: s for s in expand(load_plan(p["id"]))}
        for s in p["steps"]:
            assert (s["title"], s["caption"]) == (planned[s["id"]]["title"], planned[s["id"]]["caption"]), s["id"]


def test_each_caption_names_only_the_plans_facts(page):
    for p in live(page):
        facts = {s["id"]: s["facts"] for s in expand(load_plan(p["id"]))}
        for s in p["steps"]:
            assert caption_names_only_facts({"caption": s["caption"], "facts": facts[s["id"]]}), s["id"]


def test_a_page_caption_inventing_a_number_is_caught(page):
    """The bad take: one caption on the page names a torque the plan never set."""
    p = next(p for p in live(page) if p["id"] == FIRST)
    s = next(s for s in p["steps"] if s["id"] == "op10-seat")
    facts = next(x["facts"] for x in expand(load_plan(FIRST)) if x["id"] == s["id"])
    assert not caption_names_only_facts({"caption": s["caption"] + " Tighten to 40 N m.", "facts": facts})
