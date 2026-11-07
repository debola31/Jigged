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
from moonshot.motion.loads import part_pose, vise_load
from moonshot.planning.steps import expand
from moonshot.planning.validate import load_plan
from moonshot.sim import cam
from moonshot.sim.record import Recorder, glbs_in_bodies
from moonshot.world import cell, vf2
from moonshot.world import tooling as TL
from moonshot.world import vise as V

M = 0.001
FPS = 24
EYE = np.array([54.0, -1237.0, 1547.0])        # where the cycle-start take leaves the operator, at the pendant
PARK = np.array([-900.0, 150.0, 1700.0])       # a tool not in the spindle waits in the carousel, out of sight
HOLDER_GLB = "library/tooling/cat40/cat40.glb"
STILL_FROM_MM = (120.0, -330.0, 230.0)          # the still's camera off the part, as pipeline.py's (nist-ftc-10's)


def still_from(size_mm: float, plate: bool) -> np.ndarray:
    """The still's camera off the stock's centre: STILL_FROM_MM for a part nist-ftc-10's size or smaller, farther for
    a bigger one. A plate on the table from in front and to the right, above, at most 430 mm in front of it: farther
    out, the doors' pulls block the view (nist-ftc-09's first still), and from steeply above, the spindle head does."""
    if not plate:
        return np.array(STILL_FROM_MM) * max(1.0, size_mm / 165.1)
    return np.array([0.52 * size_mm, max(-0.96 * size_mm, -430.0), 0.87 * size_mm])


def seconds_for(machine_s: float) -> float:
    """The take's length: a few seconds, longer for a longer operation."""
    return float(np.clip(2.5 + machine_s / 90.0, 3.0, 8.0))


def _quat(R: np.ndarray) -> np.ndarray:
    q = np.zeros(4)
    mujoco.mju_mat2Quat(q, np.asarray(R, float).ravel())
    return q


def clamped(plan: dict, setup_id: str) -> bool:
    """Is the setup a plate clamped to the table (on the spoilboard, no vise)?"""
    return "clamps" in next(s for s in plan["setups"] if s["id"] == setup_id)["workholding"]


def spoilboard_xml(plan: dict, setup_id: str) -> str:
    """What a plate setup bolts to the table, as the plate takes have it (moonshot/world/spoilboard.py bolted): the
    spoilboard, on its riser if the part has one (loads.plate_board_top), and the step clamps clamped on the plate
    (moonshot/motion/plates.py)."""
    from moonshot.motion import plates
    from moonshot.world import spoilboard as SB
    part = plan["part"]
    return SB.bolted(plates.plate(part, setup_id, plan), plates.clamps(part, setup_id, plan), "clamped")


def scene_xml(plan: dict, c: cam.Cycle, stock, tools: list[cam.Tool]) -> str:
    """The VF-2 with the vise on its table as the vise takes build it, the jaw closed on the stock, the parallels
    under it (or, for a plate clamped to the table, the spoilboard), the stock where loads.part_pose puts the part, and
    each tool as a body that follows the spindle."""
    f = lambda v: " ".join(f"{float(x) * M:.5f}" for x in v)            # noqa: E731
    if clamped(plan, c.setup):
        on_table, paras = spoilboard_xml(plan, c.setup), ""
    else:
        load = vise_load(plan, c.setup)
        on_table, _, _ = V.worldbody(load, np.zeros(3), load.parallels(), "vf2_spindle", "vf2_table")
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


def travel_problems(prog: list[tuple]) -> str:
    """Where a program's moves go past the VF-2's axes' travel (as the cycle gate holds them, 0.5 mm over): the worst
    on each axis, or nothing. The machine stops at its limit and never reaches such a move."""
    joints = vf2.record()["joints"]
    out = []
    for i, a in enumerate("xyz"):
        lo, hi = joints[a]["range_mm"]
        v = np.array([p[i] for p in prog])
        past = max(lo - v.min(), v.max() - hi)
        if past > 0.5:
            out.append(f"{a.upper()} {past:.1f} mm past its {'lower' if lo - v.min() > v.max() - hi else 'upper'} "
                       f"limit")
    return ", ".join(out)


def machine_seconds(prog: list[tuple]) -> float:
    rapid = vf2.record()["joints"]["x"]["speed_mm_s"]
    t = 0.0
    for a, b in zip(prog, prog[1:]):
        v = min(rapid, b[4] / 60) if b[4] else rapid
        t += np.linalg.norm(np.subtract(b[:3], a[:3])) / v
    return t


# how the stock looks, by its material (cam.material_of) or its outside finish: (material name, base colour, metallic,
# roughness). aluminium_6061 is the look's milled 6061 (moonshot/render/look.py); a name the look doesn't know keeps
# its own PBR values
LOOKS = {"aluminium": ("aluminium_6061", [0.8, 0.81, 0.82, 1.0], 1.0, 0.33),
         "stainless": ("stainless_304", [0.66, 0.66, 0.68, 1.0], 1.0, 0.3),
         "steel": ("steel_4140", [0.5, 0.51, 0.52, 1.0], 1.0, 0.35),
         "acetal": ("acetal_black", [0.02, 0.02, 0.022, 1.0], 0.0, 0.42),
         "bar": ("steel_bar_cold_finished", [0.06, 0.062, 0.068, 1.0], 0.0, 0.55),  # the sawn blank: bar stock's dark
                                                     # grey (drawn dull: metallic, it mirrors the bright shop, white)
         "black oxide": ("black_oxide", [0.018, 0.018, 0.02, 1.0], 0.5, 0.5),      # dark grey-black, satin
         "zinc": ("zinc_trivalent_clear", [0.74, 0.79, 0.88, 1.0], 1.0, 0.22),     # bright bluish silver
         "bronze": ("aluminium_bronze", [0.77, 0.58, 0.33, 1.0], 1.0, 0.3),        # AMPCO 18 turned: golden
         "carbide": ("carbide_ground", [0.36, 0.37, 0.39, 1.0], 0.75, 0.38)}       # ground tungsten carbide, grey


ROUND_MESH_MM, ROUND_MESH_RAD = 0.01, 0.1     # a round part's mesh: 10 µm off its surface, absolute (tessellate's
                                              # 0.05 is relative: about 30 flats round a Ø63)


def write_glb(shape, path: Path, look: str = "aluminium", round_part: bool = False) -> None:
    """A stock shape as a GLB in its own frame, mm (the take record's meshes), in milled 6061 as vise.render_meshes
    draws the blank, or as LOOKS has the part's material. A round part (turned, or a bar's slug) meshed finer."""
    import trimesh
    from trimesh.visual.material import PBRMaterial
    name, colour, metal, rough = LOOKS[look]
    if round_part:                             # tessellate() keeps a finer mesh it finds
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        BRepMesh_IncrementalMesh(shape.wrapped, ROUND_MESH_MM, False, ROUND_MESH_RAD, True)
    v, f = shape.tessellate(0.05, 0.3)
    mesh = trimesh.Trimesh(np.array([p.toTuple() for p in v]), np.array(f), process=False)
    mesh.visual = trimesh.visual.TextureVisuals(material=PBRMaterial(
        name=name, baseColorFactor=colour, metallicFactor=metal, roughnessFactor=rough))
    mesh.export(path)


def write_cutter_glb(t: cam.Tool, path: Path) -> None:
    """A stand-in for a tool whose 3D model isn't built yet: its record's diameter and stickout as a steel cylinder,
    its tip at the origin, up +z, in metres (as the library's GLBs, which the renderer places by in_body)."""
    import trimesh
    from trimesh.visual.material import PBRMaterial
    body = trimesh.creation.cylinder(radius=t.r * M, height=t.stickout * M, sections=48)
    body.apply_translation([0, 0, t.stickout * M / 2])
    body.visual = trimesh.visual.TextureVisuals(material=PBRMaterial(
        name="tool_steel", baseColorFactor=[0.62, 0.63, 0.65, 1.0], metallicFactor=1.0, roughnessFactor=0.25))
    path.parent.mkdir(parents=True, exist_ok=True)
    body.export(path)


def run_step(plan: dict, planner: cam.Planner, setup: dict, op: dict, stock, log=print):
    """Plan, run and record one cycle step; returns the stock it leaves, or None if there is nothing to cut."""
    part = plan["part"]
    t0 = time.perf_counter()
    if not list(cam.RECORDS.glob(f"*/{op['tool']}/{op['tool']}.json")):
        log(f"[cycle] {setup['id']}-{op['id']}: {op['tool']} has no catalogue record, so nothing says what it "
            f"cuts: not run (a plan gap)")
        return None
    c = planner.cycle(setup, op, stock)
    if not c.passes:
        log(f"[cycle] {c.step}: no hole of the operation's size opens upward in this setup: nothing to cut")
        return None
    prog, starts, cuts = program_of(c)
    if out_of_travel := travel_problems(prog):
        log(f"[cycle] {c.step}: the program leaves the VF-2's travel ({out_of_travel}), so it can't run: not run "
            f"(a plan gap)")
        return None
    tools = [p.tool for p in c.passes]
    turned = before_mill(plan) is not None                     # a round part off the lathe: its GLBs meshed finer
    out = data_root() / "takes" / f"{part}-{c.step}"
    if out.exists():
        shutil.rmtree(out)
    (out / "stock").mkdir(parents=True)

    m = mujoco.MjModel.from_xml_string(scene_xml(plan, c, stock, tools))
    d = mujoco.MjData(m)
    q = {a: m.jnt_qposadr[m.joint(f"vf2_{a}").id] for a in ("x", "y", "z")}
    for a, v in zip("xyz", prog[0][:3]):
        d.qpos[q[a]] = v * M
    plate = clamped(plan, c.setup)
    locked = {}
    if not plate:
        load = vise_load(plan, c.setup)
        jaw = m.jnt_qposadr[m.joint("jaw_slide").id]
        d.qpos[jaw] = (load.opening0 - load.size_mm[1]) * M                  # closed on the part
        crank = m.jnt_qposadr[m.joint("crank").id]
        d.qpos[crank] = np.radians(V.crank_for_opening(load.size_mm[1], load.opening0))
        locked = {jaw: d.qpos[jaw], crank: d.qpos[crank]}
    mujoco.mj_forward(m, d)
    ctl = vf2.Control(m, d, program=prog)
    ctl.press("cycle_start")
    spindle = m.body("vf2_spindle").id
    mocap = [m.body_mocapid[m.body(f"tool_{t.id}").id] for t in tools]

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
    states = {0: stock}                                        # every cut first: meshing a shape for its GLB can
    for i in sorted(range(len(cuts)), key=lambda i: (done_at[i], i)):     # widen its edges' tolerances, which
        stock = (cam.cut_keep if plate else cam.cut)(stock, cuts[i][1])   # the next boolean then trips on; a
                                                               # plate's skeleton stays under its clamps
        states[max(1, done_at[i])] = stock
    stock.exportBrep(str(out / "stock-end.brep"))
    keyframes = sorted(states)
    for k in keyframes:
        write_glb(states[k], out / "stock" / f"{k}.glb", planner.material, round_part=turned)

    glbs = glbs_in_bodies(m, "vf2", vf2.render_links())
    if plate:                                                   # the spoilboard is drawn from its geom
        meshes = {}
    else:
        for body, drawn in V.render_glbs().items():             # the D688, as the vise takes draw it
            glbs.setdefault(body, []).extend(drawn)
        meshes = V.render_meshes(load, out)                     # the parallels; the blank is the stock instead
        shutil.rmtree(out / meshes.pop("blank")["dir"])
    meshes["blank"] = {"dir": "stock", "frames": keyframes}
    for t in tools:
        model = f"library/tooling/{t.id}/{t.id}.glb"
        if not (data_root() / model).exists():                  # its 3D model isn't built yet: its record's shape
            model = f"takes/{out.name}/cutter_{t.id}.glb"
            write_cutter_glb(t, data_root() / model)
        glbs[f"tool_{t.id}"] = [TL.glb_entry(HOLDER_GLB, -cam.GAUGE_MM), TL.glb_entry(model, -t.length)]
    rec.write(out, FPS, 0.0, {}, "vf2", glbs, meshes=meshes)
    if part not in cam.AS_PUBLISHED:                            # the still's camera, framed on the stock
        sb = c.frame.to_world(stock).BoundingBox()
        centre = np.array([sb.center.x, sb.center.y, sb.center.z])
        (out / "still.json").write_text(json.dumps({
            "look_off_mm": (centre - c.frame.origin).round(1).tolist(),
            "from_mm": still_from(max(sb.xlen, sb.ylen), plate).round(1).tolist(),
            "about": "the still's camera (moonshot/orchestrate/pipeline.py --still): it looks at the blank body's "
                     "origin plus look_off_mm (world axes: the stock's centre), from from_mm off that"},
            indent=1), encoding="utf-8")
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
    return cq.Shape.importBrep(str(out / "stock-end.brep"))      # the next step starts from the file, as a resumed run


SHELF_Z = 900.0                                 # a finished part's still: on a grey shelf this high (world mm)


def finish_take(plan: dict, step: dict, log=print) -> Path:
    """An outside vendor's finish (a cycle step: black oxide, zinc), which has no simulation: its take is the finished
    part as the mill's last cycle left it, in that finish, on a shelf, for the still and the 3D view (takes/<part>-<step
    id>/: take.npz, scene.json, stock/0.glb, still.json)."""
    part = plan["part"]
    ends = [(s, data_root() / "takes" / f"{part}-{s['id']}-{o['id']}" / "stock-end.brep") for s, o in cycle_steps(plan)]
    last, end = next((s, e) for s, e in reversed(ends) if e.exists())      # the last cycle that ran
    stock = cq.Shape.importBrep(str(end))
    finish = "black oxide" if "black oxide" in step["caption"].lower() else "zinc" if "zinc" in step["caption"].lower() \
        else None
    if finish is None:
        raise ValueError(f"{step['id']}: no look for this finish: {step['caption']}")
    out = data_root() / "takes" / f"{part}-{step['id']}"
    if out.exists():
        shutil.rmtree(out)
    on_shelf(plan, stock, out, finish)
    log(f"[cycle] {step['id']}: the finished part from {end.parent.name}, in {finish}")
    return out


def on_shelf(plan: dict, stock, out: Path, look: str, R: np.ndarray | None = None, round_part: bool = False) -> None:
    """A take of a part on its own (a cycle step with no simulation): the stock, in look (LOOKS), on a dark shelf,
    set down as the mill held it in its flattest setup (or turned by R), the still's camera close on it: take.npz,
    scene.json, stock/0.glb, still.json in out (only those: the folder may hold another session's files)."""
    (out / "stock").mkdir(parents=True, exist_ok=True)
    finish = look
    if R is not None:
        R_last = np.asarray(R, float)
    else:                     # set down on the shelf as the mill held it in its flattest setup (the last as flat)
        poses = [np.asarray(part_pose(plan, s["id"])["R"], float) for s in plan["setups"] if "workholding" in s]
        R_last = min(reversed(poses), key=lambda R: cam.Frame(R, np.zeros(3)).to_world(stock).BoundingBox().zlen)
    sb = cam.Frame(R_last, np.zeros(3)).to_world(stock).BoundingBox()
    origin = np.array([-(sb.xmin + sb.xmax) / 2, -(sb.ymin + sb.ymax) / 2, SHELF_Z - sb.zmin])
    f = lambda v: " ".join(f"{float(x) * M:.5f}" for x in v)            # noqa: E731
    xml = f"""<mujoco model="finish">
  <worldbody>
{cell.FLOOR}    <body name="shelf" pos="0 0 {(SHELF_Z - 10) * M:.4f}">
      <geom name="shelf" type="box" size="0.25 0.15 0.01" contype="0" conaffinity="0" rgba="0.04 0.045 0.05 1"/>
    </body>
    <body name="blank" pos="{f(origin)}" quat="{" ".join(f"{v:.7f}" for v in _quat(R_last))}">
      <geom name="blank" type="box" size="0.001 0.001 0.001" contype="0" conaffinity="0" rgba="0.8 0.8 0.82 1"/>
    </body>
  </worldbody>
</mujoco>
"""
    m = mujoco.MjModel.from_xml_string(xml)
    d = mujoco.MjData(m)
    mujoco.mj_kinematics(m, d)
    look = np.array([0.0, 0.0, SHELF_Z + sb.zlen / 2])
    rec = Recorder(m, set(), arms=())
    for _ in range(2):
        rec.frame(d, {}, look + np.array(STILL_FROM_MM), look, [0, 0, 1])
    write_glb(stock, out / "stock" / "0.glb", finish, round_part=round_part)
    rec.write(out, FPS, 0.0, {}, "outside", {}, meshes={"blank": {"dir": "stock", "frames": [0]}})
    size = max(sb.xlen, sb.ylen, sb.zlen)                   # close on the part: it fills the view as nist-ftc-10's
    (out / "still.json").write_text(json.dumps({            # blank does in the vise
        "look_off_mm": (look - origin).round(1).tolist(),
        "from_mm": (np.array(STILL_FROM_MM) * size / 165.1 * 0.8).round(1).tolist(),
        "about": "the still's camera (moonshot/orchestrate/pipeline.py --still): it looks at the blank body's origin "
                 "plus look_off_mm (world axes: the part's centre), from from_mm off that"}, indent=1), encoding="utf-8")


def saw_cut_take(plan: dict, step: dict, log=print) -> Path:
    """The band saw's cut (a cycle step: the machine's own work, not simulated): its take is the sawn blank on its own,
    in bar stock's dark grey, on the shelf the finishes stand on; its stock/0.glb is the box the first setup on the
    mill starts from (loads.envelope). Drawn in the saw, the blank was lost against its bare steel (the saw's
    session's cell, moonshot/world/saw_cell.py, 2026-11-05). Writes only its own files into takes/<part>-<step id>/,
    where the saw's session keeps its cut's."""
    from moonshot.motion.loads import envelope
    env = envelope(plan, next(x for x in plan["setups"] if "workholding" in x)["id"])
    out = data_root() / "takes" / f"{plan['part']}-{step['id']}"
    if "bar_dia_mm" in plan["stock"]:            # a round bar's slug (a lathe part's), lying on its end, its axis up
        k = "XYZ".index(plan["stock"].get("axis", "Y"))
        d = np.eye(3)[k]
        base = cq.Vector(*(env.mean(1) * (1 - d) + env[k, 0] * d))
        stock = cq.Solid.makeCylinder(plan["stock"]["bar_dia_mm"] / 2, env[k, 1] - env[k, 0], base, cq.Vector(*d))
        up = np.roll(np.eye(3), -k, axis=0)          # the bar's axis to world z
        on_shelf(plan, stock, out, "bar", R=np.stack([up[1], up[2], up[0]]), round_part=True)
    else:
        stock = cq.Solid.makeBox(*(env[:, 1] - env[:, 0]), cq.Vector(*env[:, 0]))
        on_shelf(plan, stock, out, "bar")
    log(f"[cycle] {step['id']}: the sawn blank, {' x '.join(f'{v:.2f}' for v in env[:, 1] - env[:, 0])} mm")
    return out


def cycle_steps(plan: dict) -> list[tuple[dict, dict]]:
    """The mill's cycle steps, in order (the saw's cut, the lathe's and an outside vendor's finish are cycle steps too,
    but not the mill's)."""
    from moonshot.planning.steps import GRINDERS, LATHES
    setups = {s["id"]: s for s in plan["setups"]}
    out = []
    for s in expand(plan):
        held = setups.get(s.get("setup"), {})
        if s["kind"] == "cycle" and "workholding" in held and held.get("machine") not in LATHES | GRINDERS:
            setup = setups[s["setup"]]
            out.append((setup, next(o for o in setup["operations"] if o["id"] == s["operation"])))
    return out


def before_mill(plan: dict) -> Path | None:
    """The stock the lathe hands the mill (stock-end.brep of the last lathe cycle before the mill's first setup), or
    None for a part that starts on the mill."""
    from moonshot.planning.steps import LATHES
    setups = {s["id"]: s for s in plan["setups"]}
    first = next((s for s, _ in cycle_steps(plan)), None)
    out = None
    for s in expand(plan):
        held = setups.get(s.get("setup"), {})
        if first is not None and s.get("setup") == first["id"]:
            break
        if s["kind"] == "cycle" and held.get("machine") in LATHES:
            end = data_root() / "takes" / f"{plan['part']}-{s['id']}" / "stock-end.brep"
            out = end if end.exists() else out
    return out


def main(argv: list[str]) -> int:
    plan = load_plan(argv[0])
    if "--finish" in argv:                                  # the outside finishes' takes, from the finished stock
        for s in expand(plan):
            if s["kind"] == "cycle" and "station" in s:
                finish_take(plan, s)
        return 0
    if "--saw" in argv:                                     # the band saw's cut: the saw as it leaves the blank
        for s in expand(plan):
            if s["kind"] == "cycle" and s.get("machine") == "bandsaw":
                saw_cut_take(plan, s)
        return 0
    start = argv[argv.index("--from") + 1] if "--from" in argv else None
    planner = cam.Planner(plan)
    steps = cycle_steps(plan)
    ids = [f"{s['id']}-{o['id']}" for s, o in steps]
    i0 = ids.index(start) if start else 0
    stock = planner.stock0()
    if turned := before_mill(plan):                         # the lathe's part, as its last cycle left it
        stock = cq.Shape.importBrep(str(turned))
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
