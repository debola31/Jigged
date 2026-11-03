"""Each cycle step of a part (moonshot/planning/steps.py, kind "cycle") is a take of the VF-2 running one operation with
its tool in the spindle, seen from the operator's place outside the closed doors, and the machine stays in spec while it
runs (plan §5.1): every axis inside its travel, the spindle under its top speed, and every pass's speed and feed inside
its tool's limits in aluminium and the VF-2's. Protected (plan §6, rule 1).

What a cycle step hands this gate, in the data root's takes/<part>-<step id>/ (moonshot/sim/cycle_take.py writes it):
- take.npz and scene.json, the take record (moonshot/contracts/take_record.py). The stock is the body named
  "blank", as the part is in every take; its scene entry carries "meshes", one GLB per keyframe in the part's model
  frame (mm). Other bodies may carry meshes too (the parallels, drawn as the vise takes draw them).
- stock-end.brep, the stock after the operation, in the part's model frame (mm).
- program.json, what the VF-2 ran:
    {"schema": "jigged.cycle-program/1", "part": ..., "step": ..., "setup": ...,
     "passes": [{"tool": <catalogue id>, "rpm": ..., "moves": [[x, y, z, feed mm/min or null for rapid], ...]}],
     "stock_mm3": [before, after]}
  x, y, z are the VF-2's axes in mm, as its joints read (moonshot/library/stations/vf2.json).

A tool's diameter, teeth, material and thread come from its catalogue record; what kind of tool it is (drill, reamer,
tap or mill) from the record's name, never from the program, so a program can't pick the rules it is held to.
"""
import json
import math
import re
from pathlib import Path

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check as record_problems
from moonshot.contracts.thresholds import threshold
from moonshot.planning.steps import expand
from moonshot.planning.validate import RECORDS, load_plan
from moonshot.world.vf2 import record as vf2_record

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
PART = "nist-ftc-10"
INCH = 25.4
VF2_MAX_RPM = 8100                                      # Haas VF-2 spec, as test_vf2_conformance.py holds the record to


def cycle_steps(part: str = PART) -> list[dict]:
    return [s for s in expand(load_plan(part)) if s["kind"] == "cycle"]


def take_dir(part: str, step: dict) -> Path:
    return data_root() / "takes" / f"{part}-{step['id']}"


# --- the rules a program is held to -------------------------------------------------------------------------------

def tool(tool_id: str) -> dict:
    """Diameter (mm), teeth, material class ("carbide" or "hss"), kind and thread pitch (mm), from the catalogue."""
    rec = json.loads(next(RECORDS.glob(f"*/{tool_id}/{tool_id}.json")).read_text(encoding="utf-8"))
    specs = {s["name"]: s for s in rec.get("key_specs", [])}
    d = specs["Diameter"]
    dia = float(d["value"]) * (INCH if d.get("unit") == "in" else 1.0)
    teeth = specs.get("Flutes", specs.get("Inserts"))
    material = str(specs.get("Material", {}).get("value", "")) or rec["description"]
    name = rec["name"].lower()
    kind = "tap" if " tap" in name else "ream" if "reamer" in name else "drill" if "drill" in name else "mill"
    pitch = None
    if kind == "tap":
        pitch = float(re.search(r"x(\d+(?:\.\d+)?)", specs["Thread"]["value"]).group(1))
    return {"dia": dia, "teeth": int(teeth["value"]) if teeth else None, "kind": kind, "pitch": pitch,
            "material": "carbide" if "carbide" in material.lower() else "hss"}


def program_problems(program: dict) -> list[str]:
    """Everything in a program outside the VF-2's or its tools' limits."""
    out = []
    joints = vf2_record()["joints"]
    feed_max = threshold("machining.vf2_cutting_feed_mm_min").value
    fz_lo, fz_hi = threshold("machining.mill_feed_per_tooth_mm").band
    fr_lo, fr_hi = threshold("machining.drill_feed_per_rev_dia_frac").band
    slow = threshold("machining.ream_speed_feed_factor").value
    v_max = {"carbide": threshold("machining.surface_speed_carbide_m_min").value,
             "hss": threshold("machining.surface_speed_hss_m_min").value}
    for i, p in enumerate(program["passes"]):
        t, rpm, where = tool(p["tool"]), float(p["rpm"]), f"pass {i} ({p['tool']})"
        if not 0 < rpm <= VF2_MAX_RPM:
            out.append(f"{where}: {rpm:.0f} rpm, outside the VF-2's 0-{VF2_MAX_RPM}")
        v = math.pi * t["dia"] * rpm / 1000
        limit = v_max[t["material"]] / (slow if t["kind"] in ("ream", "tap") else 1.0)
        if v > limit:
            out.append(f"{where}: {v:.0f} m/min, past {limit:.0f} for {t['material']} {t['kind']}")
        for k, (x, y, z, feed) in enumerate(p["moves"]):
            for axis, val in zip("xyz", (x, y, z)):
                lo, hi = joints[axis]["range_mm"]
                if not lo - 0.5 <= val <= hi + 0.5:
                    out.append(f"{where} move {k}: {axis.upper()} {val:.1f} mm, outside the VF-2's {lo}-{hi}")
            if feed is None:
                continue
            if feed > feed_max:
                out.append(f"{where} move {k}: {feed:.0f} mm/min, past the VF-2's {feed_max:.0f}")
            per_rev = feed / rpm
            if t["kind"] == "mill":
                fz = per_rev / t["teeth"]
                if not fz_lo <= fz <= fz_hi:
                    out.append(f"{where} move {k}: {fz:.3f} mm per tooth, outside {fz_lo}-{fz_hi}")
            elif t["kind"] == "tap":
                if abs(per_rev - t["pitch"]) > 0.01 * t["pitch"]:
                    out.append(f"{where} move {k}: {per_rev:.3f} mm/rev, off the tap's {t['pitch']} mm pitch")
            else:
                f = slow if t["kind"] == "ream" else 1.0
                lo, hi = fr_lo * f * t["dia"], fr_hi * f * t["dia"]
                if not lo <= per_rev <= hi:
                    out.append(f"{where} move {k}: {per_rev:.3f} mm/rev, outside {lo:.3f}-{hi:.3f}")
    return out


@pytest.mark.parametrize("path", sorted((FIXTURES / "good").glob("cycle_program_*.json")), ids=lambda p: p.stem)
def test_a_program_in_spec_passes(path):
    assert program_problems(json.loads(path.read_text(encoding="utf-8"))) == []


@pytest.mark.parametrize("path", sorted((FIXTURES / "bad").glob("cycle_program_*.json")), ids=lambda p: p.stem)
def test_a_program_out_of_spec_fails(path):
    assert program_problems(json.loads(path.read_text(encoding="utf-8")))


def test_the_tools_read_from_the_catalogue():
    assert tool("facem") == {"dia": pytest.approx(50.8), "teeth": 4, "kind": "mill", "pitch": None,
                             "material": "carbide"}
    assert tool("drill-5p5")["kind"] == "drill" and tool("drill-5p5")["material"] == "hss"
    assert tool("ream-3p5")["kind"] == "ream" and tool("tap-m3")["pitch"] == 0.5


# --- each cycle step's take -----------------------------------------------------------------------------------------

def axes_mm(d, names) -> dict[str, np.ndarray]:
    """The VF-2's axes each frame, from where the take put its bodies (each moving body's origin is the machine's at
    joint zero)."""
    pos = lambda b: d["pos"][:, names.index(b)]                                         # noqa: E731
    base = pos("vf2")
    return {"x": pos("vf2_table")[:, 0] - pos("vf2_saddle")[:, 0], "y": pos("vf2_saddle")[:, 1] - base[:, 1],
            "z": pos("vf2_head")[:, 2] - base[:, 2], "door_left": base[:, 0] - pos("vf2_door_left")[:, 0],
            "door_right": pos("vf2_door_right")[:, 0] - base[:, 0]}


def glb_volume(path: Path) -> float:
    import trimesh
    m = trimesh.load(path, force="mesh")
    m.merge_vertices()
    return abs(float(m.volume))


def brep_volume(path: Path) -> float:
    import cadquery as cq
    return cq.Shape.importBrep(str(path)).Volume()


@pytest.mark.data_root
@pytest.mark.parametrize("step", cycle_steps(), ids=lambda s: s["id"])
def test_a_cycle_take_shows_the_machine_cutting_in_spec(step):
    folder = take_dir(PART, step)
    if not (folder / "program.json").exists():
        pytest.skip(f"no cycle take in {folder}")
    assert record_problems(folder) == []
    d = np.load(folder / "take.npz")
    scene = json.loads((folder / "scene.json").read_text(encoding="utf-8"))
    program = json.loads((folder / "program.json").read_text(encoding="utf-8"))
    names = [str(b) for b in d["bodies"]]

    seconds = len(d["t"]) / float(d["fps"])
    assert 2.0 <= seconds <= 12.0, f"the take runs {seconds:.1f} s, not a few seconds"
    assert len(d["arms"]) == 0, "the operator is outside the doors: no hands in the take"
    r = vf2_record()
    door_front = min(r["colliders"][k]["box_min_mm"][1] for k in ("door_left", "door_right"))
    assert (d["eye"][:, 1] < door_front).all(), "the camera isn't outside the doors"

    assert program_problems(program) == []
    ax = axes_mm(d, names)
    for a in ("x", "y", "z"):
        lo, hi = r["joints"][a]["range_mm"]
        assert lo - 0.5 <= ax[a].min() and ax[a].max() <= hi + 0.5, f"{a.upper()} left its travel"
    for door in ("door_left", "door_right"):
        assert np.abs(ax[door]).max() < r["logic"]["door_closed_mm"], f"the {door} opened during the cycle"

    assert "meshes" in scene["bodies"].get("blank", {}), "the stock, the body named blank, has no meshes"
    meshes = scene["bodies"]["blank"]["meshes"]
    before, after = program["stock_mm3"]
    assert after < before, "the operation removed nothing"
    first = glb_volume(folder / meshes["dir"] / f"{meshes['frames'][0]}.glb")
    last = glb_volume(folder / meshes["dir"] / f"{meshes['frames'][-1]}.glb")
    assert first == pytest.approx(before, rel=0.01), "the first keyframe isn't the stock the step started from"
    assert last == pytest.approx(after, rel=0.01) and brep_volume(folder / "stock-end.brep") == \
        pytest.approx(after, rel=1e-4), "the last keyframe isn't the stock the step ends with"


@pytest.mark.data_root
def test_each_cycle_step_starts_from_the_stock_the_last_one_left():
    """Within a setup and across setups: the stock one operation hands on is the stock the next one cuts."""
    steps = [s for s in cycle_steps() if (take_dir(PART, s) / "program.json").exists()]
    if len(steps) < 2:
        pytest.skip("fewer than two cycle takes")
    vols = [json.loads((take_dir(PART, s) / "program.json").read_text(encoding="utf-8"))["stock_mm3"] for s in steps]
    for (a, va), (b, vb) in zip(zip(steps, vols), zip(steps[1:], vols[1:])):
        assert vb[0] == pytest.approx(va[1], rel=1e-6), f"{b['id']} doesn't start from {a['id']}'s stock"


@pytest.mark.farm
@pytest.mark.data_root
def test_every_cycle_step_has_a_take():
    missing = [s["id"] for s in cycle_steps() if not (take_dir(PART, s) / "program.json").exists()]
    assert not missing, f"cycle steps with no take: {missing}"
