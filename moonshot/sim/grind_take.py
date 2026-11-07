"""The surface grinder's work on a part (moonshot/sim/grind.py), step by step: what each hand-ground operation leaves,
and the picture of it. A grind on the manual grinder is people's work at its handwheels (the plan's "by": "hand"), so
its video is a person's take; this writes, for each such step, in the data root:

- takes/<part>-<step id>/: stock-end.brep (the stock after it, the part's model frame, as every cutting step hands
  on), stock/<k>.glb (the stock after its k-th down-feed, 0 the stock it starts from) and grind.json (its passes);
- takes/<part>-<step id>-still/: a short take record of the grinder as the step leaves it, the wheel lifted just clear
  of the part, its slot under the wheel's rim, and still.json for the camera (moonshot/sim/step_still.py's
  convention), whose picture goes to takes/<part>-<step id>/still.png.

    python -m moonshot.sim.grind_take ct-tpg322             # every ground step, in order

The grinder is drawn from its station's links (library/machines/sgrind/links/, its frame at joint zero) until its
station model lands: the saddle (with the table, the chuck and their handwheels) slid in by the cross feed and the
wheelhead lowered, by translation; the keepers as the plan's three 1/8 x 1/2 in parallels laid flat round the insert.
"""
from __future__ import annotations

import json
import math
import shutil
import sys
import time

import cadquery as cq
import mujoco
import numpy as np

from moonshot.config import data_root
from moonshot.planning.steps import GRINDERS, expand
from moonshot.planning.validate import load_plan
from moonshot.sim import grind as G
from moonshot.sim.cycle_take import _quat, write_glb
from moonshot.sim.record import Recorder

INCH = 25.4
M = 0.001
FPS = 24
LINKS = "library/machines/sgrind/links"
STATIC = ["base", "controls", "downfeed_handwheel", "downfeed_dial"]
SADDLE = ["saddle", "table", "chuck", "chuck_lever", "table_handwheel", "cross_handwheel"]   # slid in y by the cross feed
HEAD = ["wheelhead", "spindle"]                                                             # lowered in z with the wheel
# the station's record (moonshot/library/stations/sgrind.json, the grinder's agent): the chuck's face and its back edge,
# the wheels' rims' mid-plane at y 0 and their centre's height at joint zero
CHUCK_FACE_Z, CHUCK_BACK_Y = 1059.9, 48.7
WHEEL_CENTRE_Z = 1350.0
# a wheel's diameter and rim width (mm), from its record, or the plan's until it lands: dwheel-1a1r, Butler Bros' 6 x
# .035 x 1-1/4 in 1A1R resin diamond wheel (ct-tpg322's plan, missing_records)
WHEELS = {"dwheel-1a1r": (6.0 * INCH, 0.035 * INCH)}
KEEPER_MM = (6.0 * INCH, 0.5 * INCH, 0.125 * INCH)        # a 1/8 x 1/2 in parallel laid flat (para: 6 in long)
CLEAR_MM = 50.0                                            # the wheel lifted this far off the part for the still
EYE = np.array([0.0, -900.0, 1650.0])                      # the operator at the handwheels
# what the plans leave to the programmer, by part: the insert's IC, its top and its groove's floor (the STEP's)
PARTS = {"ct-tpg322": {"ic_mm": 0.375 * INCH, "top_z": 3.175, "floor_z": 2.972, "look": "carbide"}}


def ground_steps(plan: dict) -> list[tuple[dict, dict, dict]]:
    """The grinder's steps in order: (step, setup, operation)."""
    setups = {s["id"]: s for s in plan["setups"]}
    out = []
    for st in expand(plan):
        s = setups.get(st.get("setup"), {})
        if s.get("machine") in GRINDERS and st.get("operation"):
            out.append((st, s, next(o for o in s["operations"] if o["id"] == st["operation"])))
    return out


def edge_passes(op: dict, top_z: float) -> list[G.Pass]:
    sp = op["speeds"]
    w = WHEELS[op["tool"]][1]
    land = 0.010 * INCH                                    # the plan's datum: the wheel's side .010 inside the edge
    return G.passes(0, land, w, float(sp["cross_step_mm"]), top_z, float(sp["downfeed_mm_pass"]), int(sp["passes"]),
                    int(sp["spark_out_passes"]))


def run_step(plan: dict, step: dict, op: dict, k_edge: int, stock, log=print):
    """Grind one edge: its passes, its stock by down-feed, stock-end.brep; returns the stock it leaves."""
    part, cfg = plan["part"], PARTS[plan["part"]]
    t0 = time.perf_counter()
    e = G.insert_edges(cfg["ic_mm"])[k_edge]
    dia, w = WHEELS[op["tool"]]
    stroke = tuple(op["region"]["wheel_centre_stroke_mm"])
    out = data_root() / "takes" / f"{part}-{step['id']}"
    out.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(out / "stock", ignore_errors=True)
    (out / "stock").mkdir()
    ps = edge_passes(op, cfg["top_z"])
    v0 = stock.Volume()
    write_glb(stock, out / "stock" / "0.glb", cfg["look"], round_part=True)
    start, levels = stock, sorted({p.bottom_z for p in ps}, reverse=True)
    for k, z in enumerate(levels, start=1):                  # each down-feed: both cross positions to its depth
        s = start
        for p in (q for q in ps if q.bottom_z == z and not q.spark_out):
            s = G.cut(s, G.pass_solid(e, p.n0, w, z, stroke, dia / 2, cfg["top_z"]))
        stock = s
        write_glb(stock, out / "stock" / f"{k}.glb", cfg["look"], round_part=True)
    stock.exportBrep(str(out / "stock-end.brep"))
    (out / "grind.json").write_text(json.dumps({
        "schema": "jigged.grind-passes/1", "part": part, "step": step["id"], "operation": op["id"],
        "tool": op["tool"], "wheel_mm": [round(dia, 3), round(w, 4)], "edge": k_edge + 1,
        "edge_start_mm": e.start.round(4).tolist(), "edge_along": e.along.round(6).tolist(),
        "stroke_mm": list(stroke), "stock_mm3": [round(v0, 4), round(stock.Volume(), 4)],
        "stock_glbs": {str(k): {"floor_z_mm": round(z, 4)} for k, z in enumerate(levels, start=1)},
        "passes": [{"cross": p.cross, "wheel_side_in_mm": round(p.n0, 4), "floor_z_mm": round(p.bottom_z, 4),
                    "spark_out": p.spark_out} for p in ps],
        "about": "The passes of the wheel's rim along the edge (moonshot/sim/grind.py): each down-feed at the outer "
                 "cross position then the inner, the spark-outs at the last depth; stock/<k>.glb is the stock after "
                 "the k-th down-feed (0: as the step finds it)"}, indent=1), encoding="utf-8")
    log(f"[grind] {step['id']}: edge {k_edge + 1}, {len(ps)} passes, {v0 - stock.Volume():.3f} mm3 removed, "
        f"{time.perf_counter() - t0:.0f} s")
    return stock


def still_record(plan: dict, step: dict, op: dict, k_edge: int, stock) -> None:
    """The grinder as the step leaves it, for its still (see the module's doc)."""
    part, cfg = plan["part"], PARTS[plan["part"]]
    out = data_root() / "takes" / f"{part}-{step['id']}-still"
    shutil.rmtree(out, ignore_errors=True)
    (out / "stock").mkdir(parents=True)
    land = 0.010 * INCH
    groove = op.get("region", {})
    width = 0.055 * INCH
    dy = -(CHUCK_BACK_Y - KEEPER_MM[1] - land - width / 2)     # the slot's middle under the rim's mid-plane (y 0)
    dia = WHEELS[op["tool"]][0]
    dz = (CHUCK_FACE_Z + cfg["top_z"] + CLEAR_MM) - (WHEEL_CENTRE_Z - dia / 2)
    # the insert: the edge ground, its outward normal toward the back keeper (+y), its middle under the wheel
    theta = 120.0 * k_edge
    phi = math.radians(90.0 - theta)
    R = np.array([[math.cos(phi), -math.sin(phi), 0.0], [math.sin(phi), math.cos(phi), 0.0], [0.0, 0.0, 1.0]])
    r_ic = cfg["ic_mm"] / 2
    origin = np.array([0.0, CHUCK_BACK_Y - KEEPER_MM[1] + dy - r_ic, CHUCK_FACE_Z])
    L, Wk, Hk = KEEPER_MM
    bars = []
    for e in G.insert_edges(cfg["ic_mm"]):
        # laid as a pinwheel: each from its edge's start corner on past its end corner, where its end lies clear of
        # the next keeper's (which starts at that corner), so no two cross; drawn as a mesh in steel's look
        corners = [e.start, e.start + e.along * L, e.start + e.along * L + e.out * Wk, e.start + e.out * Wk]
        face = cq.Face.makeFromWires(cq.Wire.makePolygon([cq.Vector(p[0], p[1], 0.0) for p in corners], close=True))
        bars.append(cq.Solid.extrudeLinear(face, cq.Vector(0, 0, Hk)))
    (out / "keepers").mkdir()
    write_glb(cq.Compound.makeCompound(bars), out / "keepers" / "0.glb", "steel")
    qi = " ".join(f"{v:.7f}" for v in _quat(R))
    xml = f"""<mujoco model="grind">
  <worldbody>
    <geom name="floor" type="plane" size="3 3 0.1" contype="0" conaffinity="0" rgba="0.25 0.25 0.25 1"/>
    <body name="sgrind" pos="0 0 0">
      <geom type="box" size="0.01 0.01 0.01" contype="0" conaffinity="0" rgba="0.8 0.8 0.8 1"/>
    </body>
    <body name="blank" pos="{origin[0] * M:.5f} {origin[1] * M:.5f} {origin[2] * M:.5f}" quat="{qi}">
      <geom type="box" size="0.001 0.001 0.001" contype="0" conaffinity="0" rgba="0.5 0.5 0.5 1"/>
    </body>
    <body name="keepers" pos="{origin[0] * M:.5f} {origin[1] * M:.5f} {origin[2] * M:.5f}" quat="{qi}">
      <geom type="box" size="0.001 0.001 0.001" contype="0" conaffinity="0" rgba="0.4 0.4 0.42 1"/>
    </body>
  </worldbody>
</mujoco>
"""
    m = mujoco.MjModel.from_xml_string(xml)
    d = mujoco.MjData(m)
    mujoco.mj_kinematics(m, d)
    centre = origin + R @ np.array([0.0, 0.0, cfg["top_z"] / 2])
    rec = Recorder(m, set(), arms=())
    for _ in range(2):
        rec.frame(d, {}, EYE, centre, [0, 0, 1])
    write_glb(stock, out / "stock" / "0.glb", cfg["look"], round_part=True)
    link = lambda k, off: {"path": f"{LINKS}/{k}.glb", "in_body": [*off, 1, 0, 0, 0], "link": k}   # noqa: E731
    wheel = f"wheel_{op['tool']}"
    glbs = {"sgrind": [link(k, [0, 0, 0]) for k in STATIC] + [link(k, [0, round(dy, 3), 0]) for k in SADDLE]
            + [link(k, [0, 0, round(dz, 3)]) for k in HEAD + [wheel]]}
    rec.write(out, FPS, 0.0, {}, "sgrind", glbs, meshes={"blank": {"dir": "stock", "frames": [0]},
                                                         "keepers": {"dir": "keepers", "frames": [0]}})
    (out / "still.json").write_text(json.dumps({
        "look_off_mm": (R @ np.array([0.0, 0.0, cfg["top_z"] / 2])).round(2).tolist(),
        "from_mm": (np.array([0.1, -0.35, 0.93]) / np.linalg.norm([0.1, -0.35, 0.93]) * 34.0).round(1).tolist(),
        "region": groove.get("along_edge_mm"),
        "about": "the still's camera (moonshot/orchestrate/pipeline.py --still): it looks at the blank body's origin "
                 "plus look_off_mm (world axes: the insert's centre), from from_mm off that: in front of the chuck, "
                 "above, the wheel lifted clear behind"}, indent=1), encoding="utf-8")


def main(argv: list[str]) -> int:
    plan = load_plan(argv[0])
    cfg = PARTS[plan["part"]]
    if "--stills" in argv:                          # only the stills' records, from each step's stock-end.brep
        for k, (step, s, op) in enumerate(ground_steps(plan)):
            end = data_root() / "takes" / f"{plan['part']}-{step['id']}" / "stock-end.brep"
            still_record(plan, step, op, k, cq.Shape.importBrep(str(end)))
        return 0
    part = cq.importers.importStep(str(data_root() / "parts" / plan["part"] / "part.step")).val()
    stock = G.blank(part, cfg["top_z"], cfg["floor_z"])
    for k, (step, s, op) in enumerate(ground_steps(plan)):
        stock = run_step(plan, step, op, k, stock)
        still_record(plan, step, op, k, stock)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
