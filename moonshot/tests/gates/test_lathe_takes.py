"""Each lathe cycle step of a part (moonshot/planning/steps.py, kind "cycle" on the ST-25) is a take of the lathe
running one operation, and the machine stays in spec while it runs (plan §5.1): the spindle under the ST-25's and its
chuck's top speeds, the edge under its material's surface speed, every move inside the lathe's cutting diameter and
clear of the jaws, and the stock one step hands on the stock the next one cuts. Protected (plan §6, rule 1).

What a lathe cycle step hands this gate, in the data root's takes/<part>-<step id>/ (moonshot/sim/lathe_take.py):
- take.npz and scene.json, the take record (moonshot/contracts/take_record.py), the stock the body named "blank"
  with one GLB per keyframe in the part's model frame (mm);
- stock-end.brep, the stock after the operation (a part-off's: the part), in the part's model frame (mm);
- program.json, what the ST-25 ran:
    {"schema": "jigged.lathe-program/1", "machine": "st25", "jaws_u_mm": [lo, hi], "side": +1 | -1,
     "work_zero_u_mm": u, "passes": [{"tool": <catalogue id>, "rpm": cap or fixed, "css_m_min": m/min or null,
     "feed_mm_rev": ..., "moves": [[X diameter, Z, feed mm/rev or null for a rapid], ...]}], "stock_mm3": [in, out]}
  X and Z as the lathe reads them: X the diameter of the tool's reference point, Z along the spindle from the part's
  finished face toward the turret.

A tool's material and kind come from its catalogue record, never from the program, so a program can't pick the limit
it's held to. A tap's step may remove nothing: the STEP models a tapped hole at its thread's minor diameter, the tap
drill's (moonshot/sim/turn.py's declared shortcut, as the VF-2's).
"""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check as record_problems
from moonshot.contracts.thresholds import threshold
from moonshot.planning.steps import LATHES, expand
from moonshot.planning.validate import RECORDS, load_plan

pytestmark = [pytest.mark.farm, pytest.mark.data_root]

PARTS = ["ll-1011439", "ll-1007224"]
ST25_MAX_RPM = 3400                 # Haas ST-25 (moonshot/library/records/assets/machines/st25/st25.json)
ST25_MAX_DIA_MM = 13.0 * 25.4       # its largest cutting diameter, the BOT turret's 13 in
CHUCK_MAX_RPM = {"chuck3": 4500, "c5": 4500}     # the Kitagawa BR10's 4,500 (chuck3.json); the Royal 5C's [proposed]
PAST_CENTRE_MM = 1.0                # a facing or parting tool goes this far past the centre at most (in X, diameter)


def lathe_steps(part: str) -> list[dict]:
    plan = load_plan(part)
    setups = {s["id"]: s for s in plan["setups"]}
    return [s for s in expand(plan) if s["kind"] == "cycle" and setups.get(s.get("setup"), {}).get("machine")
            in LATHES]


def chuck_of(part: str, step: dict) -> str:
    return next(s for s in load_plan(part)["setups"] if s["id"] == step["setup"])["workholding"]["chuck"]


def _record(tool_id: str) -> dict:
    return json.loads(next(RECORDS.glob(f"*/{tool_id}/{tool_id}.json")).read_text(encoding="utf-8"))


def material(tool_id: str) -> str:
    rec = _record(tool_id)
    specs = {s["name"]: str(s["value"]) for s in rec.get("key_specs", [])}
    text = " ".join([specs.get("Material", ""), specs.get("Insert", ""), rec["name"]]).lower()
    return "carbide" if "carbide" in text else "hss"


def tool_dia_mm(tool_id: str) -> float:
    """A drill's or tap's own diameter (its record's), where its edge's surface speed is."""
    s = {x["name"]: x for x in _record(tool_id).get("key_specs", [])}["Diameter"]
    return float(s["value"]) * (25.4 if s.get("unit") == "in" else 1.0)


def program_problems(program: dict, chuck: str) -> list[str]:
    """Everything in a lathe program outside the ST-25's, its chuck's or its tools' limits."""
    out = []
    cap = min(ST25_MAX_RPM, CHUCK_MAX_RPM[chuck])
    v_max = {"carbide": threshold("machining.surface_speed_carbide_m_min").value,
             "hss": threshold("machining.surface_speed_hss_m_min").value}
    jaw_lo, jaw_hi = program["jaws_u_mm"]
    side, zero = program["side"], program["work_zero_u_mm"]
    for i, p in enumerate(program["passes"]):
        where, rpm = f"pass {i} ({p['tool']})", float(p["rpm"])
        if not 0 < rpm <= cap:
            out.append(f"{where}: {rpm:.0f} rpm, past the {cap} the ST-25 and its {chuck} allow")
        moves = np.array([[m[0], m[1]] for m in p["moves"]], float)
        feeds = [m[2] for m in p["moves"]]
        fed = [k for k, f in enumerate(feeds) if f is not None]
        cutting = np.abs(moves[sorted({j for k in fed for j in (k - 1, k) if j >= 0}), 0])
        name = _record(p["tool"])["name"].lower()
        on_axis = "drill" in name or " tap" in name                 # its edge at its own diameter, on the axis
        if on_axis and cutting.max(initial=0.0) > 1e-6:
            out.append(f"{where}: a {name} cutting off the spindle's axis")
        dia = float(moves[:, 0].max())
        v = p["css_m_min"] if p["css_m_min"] else \
            math.pi * (tool_dia_mm(p["tool"]) if on_axis else float(cutting.max(initial=0.0))) * rpm / 1000
        limit = v_max[material(p["tool"])]
        if v > limit + 1e-6:
            out.append(f"{where}: {v:.0f} m/min, past {limit:.0f} for {material(p['tool'])}")
        if moves[:, 0].min() < -PAST_CENTRE_MM or dia > ST25_MAX_DIA_MM:
            out.append(f"{where}: X {moves[:, 0].min():.2f} to {dia:.2f}, outside 0-{ST25_MAX_DIA_MM:.0f} mm")
        u = zero + side * moves[:, 1]
        cut = [k for k, f in enumerate(feeds) if f is not None]
        if any(jaw_lo <= u[k] <= jaw_hi for k in cut):
            out.append(f"{where}: a feed move ends inside the jaws' span ({jaw_lo:.1f}-{jaw_hi:.1f} mm)")
        if any(f is not None and not 0 < f <= 1.0 for f in feeds):
            out.append(f"{where}: a feed outside 0-1 mm/rev")
    return out


def glb_volume(path: Path) -> float:
    import trimesh
    m = trimesh.load(path, force="mesh")
    m.merge_vertices()
    return abs(float(m.volume))


def test_a_program_in_spec_passes_and_one_past_the_spindle_fails():
    ok = {"jaws_u_mm": [16.7, 72.9], "side": -1, "work_zero_u_mm": -3.0, "passes": [
        {"tool": "turn-vcgt", "rpm": 3400, "css_m_min": 150, "feed_mm_rev": 0.15,
         "moves": [[16.0, 1.0, None], [12.4, 0.0, 0.15], [12.4, -10.0, 0.15], [16.0, -10.0, None]]}]}
    assert program_problems(ok, "c5") == []
    fast = json.loads(json.dumps(ok))
    fast["passes"][0]["rpm"] = 4000
    assert program_problems(fast, "c5")
    into = json.loads(json.dumps(ok))
    into["passes"][0]["moves"][2] = [12.4, -21.0, 0.15]                   # Z -21: u 18, inside the collet
    assert program_problems(into, "c5")
    drill = {"jaws_u_mm": [16.7, 72.9], "side": -1, "work_zero_u_mm": -3.0, "passes": [
        {"tool": "drill-3p3-118", "rpm": 1930, "css_m_min": None, "feed_mm_rev": 0.05,
         "moves": [[0.0, 6.0, None], [0.0, 1.0, None], [0.0, -11.1, 0.05], [0.0, 6.0, None]]}]}
    assert program_problems(drill, "c5") == []                              # 20 m/min at its Ø3.3
    slow = json.loads(json.dumps(ok))
    slow["passes"][0] |= {"tool": "drill-3p3-118", "css_m_min": None, "rpm": 3400}  # HSS at Ø16: 171 m/min
    assert program_problems(slow, "c5")
    past = json.loads(json.dumps(ok))
    past["passes"][0]["moves"][1] = [-2.0, 0.0, 0.15]                     # 1 mm past the centre
    assert program_problems(past, "c5")


@pytest.mark.parametrize("part", PARTS)
def test_each_lathe_cycle_take_shows_the_lathe_cutting_in_spec(part):
    steps = [s for s in lathe_steps(part) if (data_root() / "takes" / f"{part}-{s['id']}" / "program.json").exists()]
    if not steps:
        pytest.skip(f"no lathe cycle has run on {part}")
    import cadquery as cq
    prev = None
    for s in steps:
        folder = data_root() / "takes" / f"{part}-{s['id']}"
        assert record_problems(folder) == [], s["id"]
        program = json.loads((folder / "program.json").read_text(encoding="utf-8"))
        assert program["schema"] == "jigged.lathe-program/1" and program["machine"] == "st25"
        assert program_problems(program, chuck_of(part, s)) == [], s["id"]
        scene = json.loads((folder / "scene.json").read_text(encoding="utf-8"))
        meshes = scene["bodies"]["blank"]["meshes"]
        before, after = program["stock_mm3"]
        tapping = all(" tap" in _record(p["tool"])["name"].lower() for p in program["passes"])
        assert after < before or tapping, f"{s['id']} removed nothing"    # a tap's thread isn't in the STEP
        first = glb_volume(folder / meshes["dir"] / f"{meshes['frames'][0]}.glb")
        last = glb_volume(folder / meshes["dir"] / f"{meshes['frames'][-1]}.glb")
        assert first == pytest.approx(before, rel=0.01), f"{s['id']}'s first keyframe isn't the stock it started from"
        assert last == pytest.approx(after, rel=0.01), f"{s['id']}'s last keyframe isn't the stock it ends with"
        assert cq.Shape.importBrep(str(folder / "stock-end.brep")).Volume() == pytest.approx(after, rel=1e-3)
        if prev is not None:                         # within a setup and across: the stock is handed on
            assert before == pytest.approx(prev, rel=1e-6), f"{s['id']} doesn't start from the stock before it"
        prev = after
