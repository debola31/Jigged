"""G2's three plans, checked before the stations, the cutting simulation and the takes are built against them (plan
§7; track E): each is checked against its part and the shop, runs on the machines its routing names, and every step it
expands to goes to a station of the kind its part's routing names, with the takes that make its video.

- ct-tpg322, the Contour carbide insert: the surface grinder, then a quick check (the shop's own routing: the Harig
  grinder, then a quick check).
- ll-1011439, the L&L bronze centering pin: the ST-25, then the bench and inspection.
- ll-1007224, the L&L 6061 spacer: the band saw, the ST-25 twice, the VF-2, then the bench and inspection.

A step's station kind is its machine's in shop.json (lathe, surface_grinder, vmc, band_saw), or its finishing station
(bench, inspection, outside); its part's record (machines_likely) names the kinds it may go to, the bench aside, where
every part is deburred. A lathe's or a grinder's operation states its own feeds and speeds, as no rule in the cutting
simulation gives them yet (a VF-2 operation's come from moonshot/sim/cam.py tool(), as G1's do), and a tool or fixture
the shop has no record of is listed by the plan, never invented (plan §6). Protected (plan §6, rule 1).
"""
import copy
import json
from pathlib import Path

import pytest

from moonshot.config import data_root
from moonshot.planning.steps import expand
from moonshot.planning.takes import spans
from moonshot.planning.validate import catalogue, check, fits, load_plan, named_assets, record

RECORDS = Path(__file__).resolve().parents[2] / "library" / "records"
SHOP = json.loads((RECORDS / "shop.json").read_text(encoding="utf-8"))
LAYOUT = json.loads((RECORDS / "layout.json").read_text(encoding="utf-8"))
KIND = {m["asset"]: m["kind"] for m in SHOP["machines"]}          # a machine's asset -> its kind
PLACED = {p["asset"] for p in LAYOUT["placements"]}
FINISHING = {"bench", "inspection", "outside"}

G2 = ("ct-tpg322", "ll-1011439", "ll-1007224")
MACHINES = {"ct-tpg322": ["sgrind"], "ll-1011439": ["st25"], "ll-1007224": ["bandsaw", "st25", "st25", "vf2"]}
VF2_SHARED = {"blow-off", "set-parallels", "set-stop", "door-close", "cycle-start", "door-open", "loosen"}


def part_record(part: str) -> dict:
    return json.loads((RECORDS / "parts" / part / "part.json").read_text(encoding="utf-8"))


def kind(step: dict) -> str:
    return KIND[step["machine"]] if "machine" in step else step["station"]


def route(part: str) -> list[str]:
    """The station kinds the part's steps go to, in order, each once for a run of steps there."""
    out = []
    for s in expand(load_plan(part)):
        if not out or out[-1] != kind(s):
            out.append(kind(s))
    return out


@pytest.mark.data_root
@pytest.mark.parametrize("part", G2)
def test_each_plan_matches_its_part_and_the_shop(part):
    if not (data_root() / "parts" / part / "part.step").exists():
        pytest.skip(f"no STEP for {part} in the data root")
    assert check(load_plan(part))["problems"] == []


@pytest.mark.parametrize("part", G2)
def test_each_plan_runs_on_the_machines_its_routing_names(part):
    plan = load_plan(part)
    assert plan["part"] == part
    assert [s["machine"] for s in plan["setups"]] == MACHINES[part]


@pytest.mark.parametrize("part", G2)
def test_every_step_goes_to_a_station_of_a_kind_its_part_names(part):
    """In order: the part's routing (its record's machines_likely), the bench where the part is deburred aside."""
    likely = part_record(part)["machines_likely"]
    assert [k for k in route(part) if k != "bench"] == likely
    for s in expand(load_plan(part)):
        assert kind(s) in set(likely) | {"bench"}, s["id"]
        if "machine" in s:
            assert s["machine"] in PLACED, s["id"]               # the shop has the machine where the page finds it
        else:
            assert s["station"] in FINISHING, s["id"]


@pytest.mark.parametrize("part", G2)
def test_every_step_has_takes_and_none_is_the_vf2_cells(part):
    """A lathe's, a grinder's or a saw's step never plays the VF-2 cell's shared takes (its doors, its vise)."""
    for s in expand(load_plan(part)):
        takes = [t for t, _, _ in spans(part, s)]
        assert takes and all(takes), s["id"]
        if s.get("machine", "vf2") != "vf2":
            assert not VF2_SHARED & set(takes), s["id"]


@pytest.mark.parametrize("part", G2)
def test_every_operation_has_a_step_of_its_own(part):
    """A machine's operation is a machine-only (cycle) step; an operation done by hand on a manual machine ("by":
    "hand") is people's work."""
    plan, steps = load_plan(part), {s["id"]: s for s in expand(load_plan(part))}
    for setup in plan["setups"]:
        for op in setup["operations"]:
            s = steps[f"{setup['id']}-{op['id']}"]
            assert (s["setup"], s["operation"]) == (setup["id"], op["id"])
            assert s["kind"] == ("human" if op.get("by") == "hand" else "cycle"), s["id"]


@pytest.mark.parametrize("part", G2)
def test_a_lathe_or_grinder_operation_states_its_feeds_and_speeds(part):
    """Each with its source, or [proposed] with a reason; a lathe's spindle held to the machine's own top speed."""
    for setup in load_plan(part)["setups"]:
        if KIND[setup["machine"]] not in ("lathe", "surface_grinder"):
            continue
        for op in setup["operations"]:
            sp = op["speeds"]
            assert sp.get("source"), (setup["id"], op["id"])
            assert sp.get("feed_mm_rev") or sp.get("feed_mm_pass") or sp.get("downfeed_mm_pass"), op["id"]
            if KIND[setup["machine"]] == "lathe":
                top = next(s["value"] for s in record(setup["machine"])["key_specs"]
                           if s["name"] == "Max spindle speed")
                assert 0 < sp["rpm_max"] <= top, op["id"]


@pytest.mark.parametrize("part", G2)
def test_a_tool_or_fixture_with_no_record_is_listed_not_invented(part):
    """Every tool, fixture and gauge the plan names is in the catalogue or on the plan's missing list; and nothing on
    that list has a record already (one that has landed comes off it)."""
    plan = load_plan(part)
    listed = {m["id"] for m in plan.get("missing_records", [])}
    have = catalogue()
    assert named_assets(plan) - have <= listed
    assert not listed & have
    for m in plan.get("missing_records", []):
        assert m.get("what") and m.get("why"), m["id"]


def test_stock_wider_than_the_collet_takes_is_refused():
    plan = copy.deepcopy(load_plan("ll-1011439"))
    setup, stock = plan["setups"][0], plan["stock"]
    assert fits(setup, stock) == []
    stock["size_mm"] = [30.0, stock["size_mm"][1], 30.0]          # the 5C collet takes 1-1/16 in (27 mm) round
    assert any("collet" in p or "chuck" in p for p in fits(setup, stock))


def test_a_round_bar_bigger_than_the_saw_is_refused():
    plan = copy.deepcopy(load_plan("ll-1007224"))
    setup, stock = plan["setups"][0], plan["stock"]
    assert fits(setup, stock) == []
    stock["bar_dia_mm"] = 250.0                                   # the band saw takes 9 in round
    assert any("bandsaw" in p for p in fits(setup, stock))


def test_an_insert_bigger_than_the_grinders_chuck_is_refused():
    plan = copy.deepcopy(load_plan("ct-tpg322"))
    setup, stock = plan["setups"][0], plan["stock"]
    assert fits(setup, stock) == []
    stock["size_mm"] = [200.0, 500.0, 3.18]                       # the 6 x 18-1/2 in magnetic chuck
    assert any("chuck" in p for p in fits(setup, stock))
