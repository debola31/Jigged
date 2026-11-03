"""A cycle step's take (plan §6): the VF-2 runs one operation in MuJoCo with its tool in the spindle, seen from the
operator's place at the pendant, outside the closed doors, and the stock is cut as it goes (moonshot/sim/cam.py).
Each step writes, in the data root's takes/<part>-<step id>/: the take record (moonshot/contracts/take_record.py) with
the stock as the body whose shape changes, program.json (what the machine ran) and stock-end.brep (the stock it
leaves, in the part's model frame), which the next step starts from.

    python -m moonshot.sim.cycle_take nist-ftc-10                   # every cycle step, in order
    python -m moonshot.sim.cycle_take nist-ftc-10 --from op20-pads   # from a step, on the stock the one before left
    python -m moonshot.sim.cycle_take nist-ftc-10 --to op10-pocket   # up to and including a step

Declared shortcut: time-lapse. The machine runs its program at the programmed feeds, 1 ms a step; the take samples
it evenly, so a few seconds show the whole operation, and the stock takes each cut's shape at the first frame after
the move that completes it.
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import cadquery as cq
import mujoco
import numpy as np

from moonshot.config import data_root
from moonshot.motion.loads import vise_load
from moonshot.planning.steps import expand
from moonshot.planning.validate import load_plan
from moonshot.sim import cam
from moonshot.sim.record import Recorder, glbs_in_bodies
from moonshot.world import cell, vf2
from moonshot.world import vise as V

M = 0.001
FPS = 24
EYE = np.array([54.0, -1237.0, 1547.0])        # where the cycle-start take leaves the operator, at the pendant
PARK = np.array([-900.0, 150.0, 1700.0])       # a tool not in the spindle waits in the carousel, out of sight
HOLDER_GLB = "library/tooling/cat40/cat40.glb"


def seconds_for(machine_s: float) -> float:
    """The take's length: a few seconds, longer for a longer operation."""
    return float(np.clip(2.5 + machine_s / 90.0, 3.0, 8.0))


def _quat(R: np.ndarray) -> np.ndarray:
    q = np.zeros(4)
    mujoco.mju_mat2Quat(q, np.asarray(R, float).ravel())
    return q


def scene_xml(plan: dict, c: cam.Cycle, stock, tools: list[cam.Tool]) -> str:
    """The VF-2 with the vise on its table as the vise takes build it, the jaw closed on the stock, the parallels
    under it, the stock where loads.part_pose puts the part, and each tool as a body that follows the spindle."""
    load = vise_load(plan, c.setup)
    on_table, _, _ = V.worldbody(load, np.zeros(3), load.parallels(), "vf2_spindle", "vf2_table")
    f = lambda v: " ".join(f"{float(x) * M:.5f}" for x in v)            # noqa: E731
    paras = "".join(
        f'    <body name="{n}" pos="{f(p + np.array([0, 0, load.parallel_h / 2]))}">\n'
        f'      <geom name="{n}" class="steel" type="box" size="{f([V.PARALLEL_L / 2, V.PARALLEL_T / 2, load.parallel_h / 2])}"/>\n'
        f'    </body>\n' for n, p in load.parallels().items())
    sb = c.frame.to_world(stock).BoundingBox()
    half = np.array([sb.xlen, sb.ylen, sb.zlen]) / 2
    centre_model = c.frame.R.T @ (np.array([sb.center.x, sb.center.y, sb.center.z]) - c.frame.origin)
    q = _quat(c.frame.R)
    blank = (f'    <body name="blank" pos="{f(c.frame.origin)}" quat="{" ".join(f"{v:.7f}" for v in q)}">\n'
             f'      <geom name="blank" type="box" size="{f(np.abs(c.frame.R.T) @ half)}" pos="{f(centre_model)}" '
             f'contype="0" conaffinity="0" rgba="0.8 0.8 0.82 1"/>\n    </body>\n')
    machine, acts = vf2.worldbody(on_table + paras + blank)
    machine = f'    <body name="vf2" pos="{-cell.LOAD_X_MM * M:.4f} 0 0">\n{machine}    </body>\n'
    tool_bodies = "".join(
        f'    <body name="tool_{t.id}" mocap="true" pos="{f(PARK)}">\n'
        f'      <geom name="holder_{t.id}" type="cylinder" size="{f([15.9, cam.GAUGE_MM / 2])}" '
        f'pos="0 0 {-cam.GAUGE_MM / 2 * M:.5f}" contype="0" conaffinity="0" rgba="0.2 0.2 0.22 1"/>\n'
        f'      <geom name="cutter_{t.id}" type="cylinder" size="{f([t.r, t.stickout / 2])}" '
        f'pos="0 0 {-(cam.GAUGE_MM + t.stickout / 2) * M:.5f}" contype="0" conaffinity="0" rgba="0.6 0.6 0.62 1"/>\n'
        f'    </body>\n' for t in tools)
    return f"""<mujoco model="cycle">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" gravity="0 0 -9.81"/>
  <default>
    <joint limited="true"/>
{V.STEEL_DEFAULT}
  </default>
  <worldbody>
{cell.FLOOR}{machine}{tool_bodies}  </worldbody>
  <actuator>
{acts}  </actuator>
</mujoco>
"""


def program_of(c: cam.Cycle) -> tuple[list[tuple], list[int], list[tuple[int, object]]]:
    """The VF-2's program (x, y, z, rpm, feed), where each pass starts in it, and each cut with the program index
    whose move completes it. A tool change goes home in Z first."""
    prog, starts, cuts = [], [], []
    for p in c.passes:
        if prog:
            prog.append((*prog[-1][:2], 0.0, 0.0, None))
        starts.append(len(prog))
        for i, (pt, feed) in enumerate(p.moves):
            prog.append((*cam.joints(pt, p.tool), p.tool.rpm, feed))
            for done, solid in p.cuts:
                if done == i:
                    cuts.append((len(prog) - 1, solid))
    return prog, starts, cuts


def machine_seconds(prog: list[tuple]) -> float:
    rapid = vf2.record()["joints"]["x"]["speed_mm_s"]
    t = 0.0
    for a, b in zip(prog, prog[1:]):
        v = min(rapid, b[4] / 60) if b[4] else rapid
        t += np.linalg.norm(np.subtract(b[:3], a[:3])) / v
    return t


def write_glb(shape, path: Path) -> None:
    """A stock shape as a GLB in its own frame, mm (the take record's meshes), in milled 6061 as vise.render_meshes
    draws the blank."""
    import trimesh
    from trimesh.visual.material import PBRMaterial
    v, f = shape.tessellate(0.05, 0.3)
    mesh = trimesh.Trimesh(np.array([p.toTuple() for p in v]), np.array(f), process=False)
    mesh.visual = trimesh.visual.TextureVisuals(material=PBRMaterial(
        name="aluminium_6061", baseColorFactor=[0.8, 0.81, 0.82, 1.0], metallicFactor=1.0, roughnessFactor=0.33))
    mesh.export(path)


def run_step(plan: dict, planner: cam.Planner, setup: dict, op: dict, stock, log=print):
    """Plan, run and record one cycle step; returns the stock it leaves, or None if there is nothing to cut."""
    part = plan["part"]
    t0 = time.perf_counter()
    c = planner.cycle(setup, op, stock)
    if not c.passes:
        log(f"[cycle] {c.step}: no hole of the operation's size opens upward in this setup: nothing to cut")
        return None
    prog, starts, cuts = program_of(c)
    tools = [p.tool for p in c.passes]
    out = data_root() / "takes" / f"{part}-{c.step}"
    if out.exists():
        shutil.rmtree(out)
    (out / "stock").mkdir(parents=True)

    m = mujoco.MjModel.from_xml_string(scene_xml(plan, c, stock, tools))
    d = mujoco.MjData(m)
    q = {a: m.jnt_qposadr[m.joint(f"vf2_{a}").id] for a in ("x", "y", "z")}
    for a, v in zip("xyz", prog[0][:3]):
        d.qpos[q[a]] = v * M
    load = vise_load(plan, c.setup)
    jaw = m.jnt_qposadr[m.joint("jaw_slide").id]
    d.qpos[jaw] = (load.opening0 - load.size_mm[1]) * M                      # closed on the part
    crank = m.jnt_qposadr[m.joint("crank").id]
    d.qpos[crank] = np.radians(V.crank_for_opening(load.size_mm[1], load.opening0))
    mujoco.mj_forward(m, d)
    ctl = vf2.Control(m, d, program=prog)
    ctl.press("cycle_start")
    spindle = m.body("vf2_spindle").id
    mocap = [m.body_mocapid[m.body(f"tool_{t.id}").id] for t in tools]
    locked = {jaw: d.qpos[jaw], crank: d.qpos[crank]}

    est = machine_seconds(prog)
    frames = int(round(seconds_for(est) * FPS))
    dt_frame = est / (frames - 1)
    rec = Recorder(m, set(), arms=())
    top = c.frame.to_world(stock).BoundingBox().zmax
    look = np.array([-cell.LOAD_X_MM + vf2.record()["joints"]["spindle"]["centre_mm"][0],
                     vf2.record()["joints"]["spindle"]["centre_mm"][1], top])
    stamps, done_at, active = [], {}, -1
    next_t, step_t = 0.0, m.opt.timestep
    while True:
        k = int(np.searchsorted(starts, ctl.step_index, side="right")) - 1
        if k != active:
            for j, mid in enumerate(mocap):
                d.mocap_pos[mid] = PARK * M
            active = k
        d.mocap_pos[mocap[active]] = d.xpos[spindle]
        d.mocap_quat[mocap[active]] = d.xquat[spindle]
        for i, (idx, _) in enumerate(cuts):
            if i not in done_at and ctl.step_index > idx:
                done_at[i] = len(stamps)                     # the stock shows it from the next frame on
        if d.time >= next_t - 1e-9:
            mujoco.mj_kinematics(m, d)
            rec.frame(d, {}, EYE, look, [0, 0, 1])
            stamps.append(float(d.time))
            next_t += dt_frame
        if ctl.state == "idle" and ctl.step_index >= len(prog) and len(stamps) >= 2 and d.time > stamps[-1] + 1e-9:
            mujoco.mj_kinematics(m, d)
            rec.frame(d, {}, EYE, look, [0, 0, 1])
            stamps.append(float(d.time))
            break
        ctl.apply()
        for adr, val in locked.items():
            d.qpos[adr] = val
        mujoco.mj_step(m, d)
        if d.time > 4 * est + 60:
            raise RuntimeError(f"{c.step}: the program didn't finish in {d.time:.0f} s of machine time")
    for i in range(len(cuts)):
        done_at.setdefault(i, len(stamps) - 1)

    # the stock, keyframe by keyframe: each cut lands at its frame
    v0 = stock.Volume()
    write_glb(stock, out / "stock" / "0.glb")
    keyframes = [0]
    for i in sorted(range(len(cuts)), key=lambda i: (done_at[i], i)):
        stock = cam.cut(stock, cuts[i][1])
        k = max(1, done_at[i])
        if k == keyframes[-1]:
            (out / "stock" / f"{k}.glb").unlink()
        else:
            keyframes.append(k)
        write_glb(stock, out / "stock" / f"{k}.glb")
    from OCP.BRepTools import BRepTools
    BRepTools.Clean_s(stock.wrapped)
    stock.exportBrep(str(out / "stock-end.brep"))

    glbs = glbs_in_bodies(m, "vf2", vf2.render_links())
    for body, drawn in V.render_glbs().items():                 # the D688, as the vise takes draw it
        glbs.setdefault(body, []).extend(drawn)
    meshes = V.render_meshes(load, out)                         # the parallels; the blank is the stock instead
    shutil.rmtree(out / meshes.pop("blank")["dir"])
    meshes["blank"] = {"dir": "stock", "frames": keyframes}
    for t in tools:
        glbs[f"tool_{t.id}"] = [{"path": HOLDER_GLB, "in_body": [0, 0, -round(cam.GAUGE_MM, 3), 1, 0, 0, 0]},
                                {"path": f"library/tooling/{t.id}/{t.id}.glb",
                                 "in_body": [0, 0, -round(t.length, 3), 1, 0, 0, 0]}]
    rec.write(out, FPS, 0.0, {}, "vf2", glbs, meshes=meshes)
    passes = [{"tool": p.tool.id, "rpm": p.tool.rpm,
               "moves": [list(map(lambda v: round(float(v), 4), cam.joints(pt, p.tool))) + [feed] for pt, feed in p.moves]}
              for p in c.passes]
    (out / "program.json").write_text(json.dumps({
        "schema": "jigged.cycle-program/1", "part": part, "step": c.step, "setup": c.setup,
        "operation": op["id"], "passes": passes, "stock_mm3": [round(v0, 3), round(stock.Volume(), 3)],
        "machine_s": round(stamps[-1], 3), "frame_machine_s": [round(s, 3) for s in stamps],
        "time_lapse": round(stamps[-1] / (len(stamps) / FPS), 2)}, indent=1), encoding="utf-8")
    log(f"[cycle] {c.step}: {len(stamps)} frames for {stamps[-1]:.0f} s of machining, {len(cuts)} cuts, "
        f"{v0 - stock.Volume():.0f} mm3 removed, {time.perf_counter() - t0:.0f} s")
    return stock


def cycle_steps(plan: dict) -> list[tuple[dict, dict]]:
    setups = {s["id"]: s for s in plan["setups"]}
    out = []
    for s in expand(plan):
        if s["kind"] == "cycle":
            setup = setups[s["setup"]]
            out.append((setup, next(o for o in setup["operations"] if o["id"] == s["operation"])))
    return out


def main(argv: list[str]) -> int:
    plan = load_plan(argv[0])
    start = argv[argv.index("--from") + 1] if "--from" in argv else None
    planner = cam.Planner(plan)
    steps = cycle_steps(plan)
    ids = [f"{s['id']}-{o['id']}" for s, o in steps]
    i0 = ids.index(start) if start else 0
    stock = planner.stock0()
    if i0:
        prev = next(p for p in reversed(ids[:i0])
                    if (data_root() / "takes" / f"{plan['part']}-{p}" / "stock-end.brep").exists())
        stock = cq.Shape.importBrep(str(data_root() / "takes" / f"{plan['part']}-{prev}" / "stock-end.brep"))
    i1 = ids.index(argv[argv.index("--to") + 1]) + 1 if "--to" in argv else len(ids)
    for setup, op in steps[i0:i1]:
        stock = run_step(plan, planner, setup, op, stock) or stock
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
