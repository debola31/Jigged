"""nist-ftc-10's cutting steps stay as published while the cut simulation grows for the other parts (moonshot/sim/cam.py
AS_PUBLISHED): its tools run at the speeds its programs ran, and, from each published step's starting stock, every
cycle plans the program the published take ran, move for move; so each cut, and the stock and still each step left,
is the published one. The web shows those stills and stock (takes/nist-ftc-10-<step>/still.png and stock/*.glb)."""
import json

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.sim import cam

PART = "nist-ftc-10"
# each tool's (diameter, length below the gauge line, rpm, feed) as nist-ftc-10's programs ran them
TOOLS = {"facem": (50.8, 88.138, 2300.0, 1380.0), "em12": (12.7, 93.98, 8000.0, 2400.0),
         "em38": (9.525, 85.725, 8000.0, 2400.0), "em14": (6.35, 85.725, 8000.0, 2400.0),
         "bem14": (6.35, 85.725, 8000.0, 1600.0), "drill-2p5": (2.5, 81.5, 8000.0, 320.0),
         "drill-6": (6.0, 107.45, 6000.0, 540.0), "drill-7": (7.0, 123.45, 5500.0, 550.0),
         "drill-5p5": (5.5, 107.45, 7000.0, 560.0), "ream-3p5": (3.5, 89.95, 3000.0, 300.0),
         "tap-m3": (3.0, 80.85, 1000.0, 500.0)}


@pytest.mark.parametrize("tool_id", sorted(cam.SPEEDS))
def test_nist_ftc_10s_tools_run_as_published(tool_id):
    t = cam.tool(tool_id)
    assert (t.dia, t.length, t.rpm, t.feed) == pytest.approx(TOOLS[tool_id], abs=1e-3)


def test_nist_ftc_10_is_planned_as_published():
    assert PART in cam.AS_PUBLISHED


@pytest.mark.farm
@pytest.mark.data_root
def test_every_cycle_plans_the_published_program():
    import cadquery as cq
    from moonshot.planning.validate import load_plan
    from moonshot.sim.cycle_take import cycle_steps, program_of
    plan = load_plan(PART)
    planner = cam.Planner(plan)
    takes = data_root() / "takes"
    stock = planner.stock0()
    for setup, op in cycle_steps(plan):
        folder = takes / f"{PART}-{setup['id']}-{op['id']}"
        if not (folder / "program.json").exists():
            pytest.skip(f"{folder.name} isn't in the data root")
        published = json.loads((folder / "program.json").read_text(encoding="utf-8"))
        c = planner.cycle(setup, op, stock)
        assert [p.tool.id for p in c.passes] == [p["tool"] for p in published["passes"]], folder.name
        for p, q in zip(c.passes, published["passes"]):
            moves = [list(map(lambda v: round(float(v), 4), cam.joints(pt, p.tool))) + [feed] for pt, feed in p.moves]
            assert p.tool.rpm == q["rpm"] and len(moves) == len(q["moves"]), folder.name
            assert np.allclose([m[:3] for m in moves], [m[:3] for m in q["moves"]], atol=1e-3), folder.name
            assert [m[3] for m in moves] == [m[3] for m in q["moves"]], folder.name
        program_of(c)
        stock = cq.Shape.importBrep(str(folder / "stock-end.brep"))      # the next starts from the published stock
