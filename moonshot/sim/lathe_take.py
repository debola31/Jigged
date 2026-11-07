"""A lathe cycle step's take (plan §6): the Haas ST-25 runs one turning operation with its tool on the turret, and the
stock is cut as it goes (moonshot/sim/turn.py). Each step writes, in the data root's takes/<part>-<step id>/, as the
VF-2's cycle steps do (moonshot/sim/cycle_take.py): the take record with the stock as the body whose shape changes
(scene.json, take.npz, stock/<frame>.glb), program.json (what the lathe ran), stock-end.brep (the stock it leaves, in
the part's model frame) and stock-profile.npz (its half-section, which the next lathe step starts from), and
still.json (the still's camera).

    python -m moonshot.sim.lathe_take ll-1011439                    # every lathe cycle step, in order
    python -m moonshot.sim.lathe_take ll-1011439 --from op10-od      # from a step, on the stock the one before left

The machine is drawn from the ST-25's asset (library/machines/st25/st25.glb, one static model) until its station's
model lands: the stock on the spindle's axis in front of the jaws, the tools as stand-ins of their edges.

Declared shortcuts: time-lapse, as the VF-2's (the program at its programmed feeds, sampled evenly over a few
seconds, the stock taking each pass's cut at the first frame after it); the spindle's turning isn't drawn (the stock is
round); the turret's index between tools is 2 s.
"""
from __future__ import annotations

import json
import math
import shutil
import sys
import time
from pathlib import Path

import cadquery as cq
import mujoco
import numpy as np

from moonshot.config import data_root
from moonshot.planning.steps import expand
from moonshot.planning.validate import load_plan
from moonshot.sim import turn as T
from moonshot.sim.cam import material_of
from moonshot.sim.cycle_take import _quat, seconds_for, write_glb
from moonshot.sim.record import Recorder

M = 0.001
FPS = 24
MACHINE = "st25"
Y_UP = [0.7071068, 0.7071068, 0.0, 0.0]            # a catalogue tool is stored Y up: +90 deg about x (take_record.py)
# The ST-25 drawn from its station's links (library/machines/st25/links/, the station's frame, Z up, at joint zero:
# the turret home) until its station model lands. Measured from the links: the spindle's axis along +x at y 0, z 1005.2
# (spindle.glb), the operator at -y (pendant.glb), the turret's centre behind it and above (turret.glb), so its tools
# come in along X_DIR. Each chuck's front face, where the stock comes out: the 5C collet chuck's nose (c5/body.glb)
# and the Kitagawa BR10's jaws (br10/jaw_*.glb), which close to r 18.2 and slide out radially to grip.
LINKS = "library/machines/st25/links"
STATIC = ["base", "spindle", "drawtube", "door", "pendant", "probe_arm", "turret", "xslide", "zslide", "zcover_left",
          "zcover_right"]
AXIS_YZ = np.array([0.0, 1005.2])
TURRET_YZ = np.array([262.3, 1379.2])
X_DIR = np.r_[0.0, (TURRET_YZ - AXIS_YZ) / np.linalg.norm(TURRET_YZ - AXIS_YZ)]   # lathe X (out), world
CHUCKS = {"c5": {"front_x": 192.1, "links": ["c5/body"]},
          "chuck3": {"front_x": 183.5, "links": ["br10/body"], "jaws": {"br10/jaw_0": (0.0, 1.0),
                                                                          "br10/jaw_1": (0.866025, -0.5),
                                                                          "br10/jaw_2": (-0.866025, -0.5)},
                     "jaw_r": 18.2}}
EYE = np.array([300.0, -1000.0, 1600.0])           # the operator at the door, in front of the chuck
MAX_RPM = 3400                                     # Haas ST-25 (st25.json)
PARK_MM = np.array([0.0, 0.0, 3000.0])             # a tool not cutting: out of sight, above the machine
# What the plans leave to the programmer, read from the STEP and the drawing, by (part, setup) and (part, setup, op), in
# the part's model u (mm along its axis). A setup's face_mm: the stock past the part's free end it faces off (its wcs's
# "less ... for the facing"); jaws: the span the collet or jaws hold. An operation's do: what it runs (face, rough,
# finish: an outside tool; plunge, profile, part: a blade; drill, tap: on the axis); span: the stretch an outside pass
# turns, from the free end's side; hold: (u from, u to, r), stock it must leave for a later setup to cut from the other
# side (keep at least r there); at: a blade's centre for its part-off, keep_to: the far side of its cut, past which the
# bar stays; tip, full: a drill's point, a tap's full thread.
SETUPS = {
    # its wcs: the bar's end, less 0.3 for the facing; 20 mm out of the collet (Y -3.3 to 16.7), the rest in it
    ("ll-1011439", "op10"): {"face_mm": 0.3, "jaws": (16.7, 72.9)},
    # the blank's end less 0.5; 17.4 mm out of the soft jaws (Y -0.5 to 16.9), 8 mm in them to their step
    ("ll-1007224", "op10"): {"face_mm": 0.5, "jaws": (16.9, 24.9)},
    # flipped, the flange's faced side (Y 3.2) on the jaws' step, 8 mm of its 9 gripped (to Y 11.2). The plan's
    # stick_out_mm, 21.7, is to the step here, where Op 10's 17.4 is to the jaws' front
    ("ll-1007224", "op20"): {"jaws": (3.2, 11.2)},
}
_PIN_TIP = 7.1 + 1.65 / math.tan(math.radians(59.0))          # Ø3.3 10.1 deep from Y = -3, its 118 deg point: 8.091
OPS = {
    # ll-1011439, the pilot's end out (-Y): the VCGT faces to Y = -3 and turns the pilot, the shoulder and the Ø12.420
    # to just past the R7's start (Y 7.078); the grooving tool takes the R7, the 15 deg lead and the R1 toward the
    # chuck, its centre 1.5 mm past the part's Y = 12 end for the part-off (its chuck side at 15.0, 1.7 from the collet)
    ("ll-1011439", "op10", "turn"): {"do": ["face", "rough", "finish"], "face_at": -3.0, "span": (-3.6, 7.5)},
    ("ll-1011439", "op10", "spot"): {"do": ["drill"], "tip": -3.0 + 1.65},     # 90 deg: Ø3.3 at the mouth
    ("ll-1011439", "op10", "drill"): {"do": ["drill"], "tip": _PIN_TIP},
    ("ll-1011439", "op10", "tap"): {"do": ["tap"], "full": -3.0 + 8.0},        # M4x0.7 8.0 deep
    ("ll-1011439", "op10", "part_off"): {"do": ["plunge", "profile", "part"], "span": (6.9, 13.5), "at": 13.5,
                                         "keep_to": 15.0},
    # ll-1007224, Op 10 the first spigot's end out (-Y): faced to Y = 0, the spigot, the flange's face and the Ø63 out
    # to 2 mm past the flange (Y 14.2); the flange's far chamfer and the stock past it are left for Op 20 (Ø63 to 14.2)
    ("ll-1007224", "op10", "rough"): {"do": ["face", "rough"], "face_at": 0.0, "span": (-1.0, 14.2),
                                      "hold": [(11.7, 14.2, 31.5)]},
    ("ll-1007224", "op10", "finish"): {"do": ["face", "finish"], "face_at": 0.0, "span": (-1.0, 14.2),
                                       "hold": [(11.7, 14.2, 31.5)]},
    # Op 20, flipped (+Y out), the flange's Ø63 in the jaws: faced to Y = 15.4, the second spigot, the flange's other
    # face and its chamfer, down to the finished Ø63 (Y 11.7)
    ("ll-1007224", "op20", "rough"): {"do": ["face", "rough"], "face_at": 15.4, "span": (16.4, 11.7)},
    ("ll-1007224", "op20", "finish"): {"do": ["face", "finish"], "face_at": 15.4, "span": (16.4, 11.7)},
}
ALLOWANCE_MM = 0.25            # a rough pass leaves this for the finish, unless the plan's finish says its depth
JAW_R_MM = 127.0               # what the jaws or collet occupy, out to the chuck's radius: no pass goes there


# --- the part and the stock --------------------------------------------------------------------------------------

class Lathe:
    """Plans a part's lathe operations against the stock as it stands."""

    def __init__(self, plan: dict):
        self.plan = plan
        self.part_shape = cq.importers.importStep(str(data_root() / "parts" / plan["part"] / "part.step")).val()
        self.axis = T.part_axis(self.part_shape)
        self.material = material_of(plan)
        lo, hi = self.part_span()
        st = plan["stock"]
        length = float(st["size_mm"]["XYZ".index(st.get("axis", "Y"))])
        self.u0 = lo - length - 10.0                      # the grid: the part and the stock either side of it
        self.n = int(math.ceil((hi - lo + 2 * length + 20.0) / T.GRID_MM)) + 1
        self.part = T.section(self.part_shape, self.axis, self.u0, self.n)

    def part_span(self) -> tuple[float, float]:
        bb = self.part_shape.BoundingBox()
        corners = np.array(np.meshgrid(*[(bb.xmin, bb.xmax), (bb.ymin, bb.ymax), (bb.zmin, bb.zmax)])).reshape(3, -1).T
        u = (corners - self.axis.origin) @ self.axis.dir
        return float(u.min()), float(u.max())

    def setups(self) -> list[dict]:
        return [s for s in self.plan["setups"] if s.get("machine") == MACHINE]

    def side(self, s: dict) -> float:
        """+1 if the setup's free end (its face_out) lies toward the axis's +u."""
        f = s["face_out"]
        return (1.0 if f[0] == "+" else -1.0) * float(np.sign(self.axis.dir["XYZ".index(f[1])]))

    def setup(self, s: dict) -> T.Setup:
        """The setup's hold: its free end's side, its work zero (the part's finished face there), the jaws' span."""
        side = self.side(s)
        lo, hi = self.part.span()
        return T.Setup(side, hi if side > 0 else lo, SETUPS[(self.plan["part"], s["id"])]["jaws"])

    def stock0(self) -> T.Profile:
        """The plan's blank, a round bar (stock.size_mm across and along its axis) along the part's axis, past the
        part's free end in the first lathe setup by its face_mm, the rest toward the chuck."""
        st = self.plan["stock"]
        k = "XYZ".index(st.get("axis", "Y"))
        dia = float(st.get("bar_dia_mm", st["size_mm"][(k + 1) % 3]))
        length = float(st["size_mm"][k])
        first = self.setups()[0]
        face = SETUPS[(self.plan["part"], first["id"])]["face_mm"]
        lo, hi = self.part.span()
        u_lo, u_hi = (hi + face - length, hi + face) if self.side(first) > 0 else (lo - face, lo - face + length)
        return T.regrid(T.bar(u_lo, u_hi, dia / 2), self.u0, self.n)

    def keep(self, stock: T.Profile, su: T.Setup, span: tuple[float, float], cfg: dict) -> np.ndarray:
        """What an outside pass must leave: the part within the span, the stock outside it, the stock held for a
        later setup (cfg's hold), and the jaws."""
        k = T.keep_for(stock, self.part, span)
        u = stock.u
        for a, b, r in cfg.get("hold", []):
            sel = (u >= a) & (u <= b)
            k[sel] = np.maximum(k[sel], r)
        k[(u >= su.jaws[0]) & (u <= su.jaws[1])] = JAW_R_MM
        return k

    def rpm(self, dia: float, v: float, cap: float) -> float:
        return T.rpm_for(dia, v, min(cap, MAX_RPM))

    # --- an operation's passes ---

    def passes(self, s: dict, op: dict, stock: T.Profile) -> tuple[T.Setup, list[T.Pass]]:
        """The operation's passes, each planned against the stock the one before leaves (the stock isn't changed)."""
        stock = stock.copy()
        su = self.setup(s)
        cfg = OPS[(self.plan["part"], s["id"], op["id"])]
        t = T.tool(op["tool"])
        sp = op.get("speeds", {})
        rough_sp, fin_sp = sp.get("rough", sp), sp.get("finish", sp)
        cap = float(sp.get("rpm_max", MAX_RPM))
        css = bool(sp.get("constant_surface_speed"))
        does, span = cfg["do"], cfg.get("span")
        out: list[T.Pass] = []

        def add(ps: T.Pass, v: float) -> None:
            if not ps.moves:
                return
            top_dia = 2 * float(stock.r_out[stock.solid()].max())
            ps.rpm, ps.css = (min(cap, MAX_RPM), v) if css else (self.rpm(top_dia, v, cap), None)
            out.append(ps)
            T.run(stock, [ps], su)

        both = "rough" in does and "finish" in does
        allowance = float(fin_sp.get("doc_mm", ALLOWANCE_MM)) if both else ALLOWANCE_MM
        if "face" in does:
            v = fin_sp if "finish" in does else rough_sp
            at = cfg["face_at"] + (0.0 if "finish" in does else su.side * allowance)
            add(T.face(stock, su, t, at, float(rough_sp.get("doc_mm", 2.0)), 0.0, float(v["feed_mm_rev"])),
                float(v["vc_m_min"]))
        for kind in ("rough", "finish"):
            if kind in does:
                v = rough_sp if kind == "rough" else fin_sp
                add(T.contour(stock, su, t, self.keep(stock, su, span, cfg), span[0], span[1],
                              allowance if kind == "rough" else 0.0, float(v.get("doc_mm", 2.0)), 0.0,
                              float(v["feed_mm_rev"]), kind == "finish"), float(v["vc_m_min"]))
        if any(k in does for k in ("plunge", "profile", "part")):
            keep = lambda: self.keep(stock, su, (span[0] + 5.0 * su.side, cfg["keep_to"]), cfg)   # noqa: E731
            f, v = float(sp["feed_mm_rev"]), float(sp["vc_m_min"])
            if "plunge" in does:
                add(T.plunge_rough(stock, su, t, keep(), span[0] - su.side * t.width / 2, cfg["at"],
                                   ALLOWANCE_MM / 2, 0.0, f), v)
            if "profile" in does:
                add(T.contour(stock, su, t, keep(), span[0], span[1], 0.0, 1.0, 0.0, f, True), v)
            if "part" in does:
                add(T.plunge(stock, su, t, keep(), cfg["at"], -0.3, 0.0, f), v)
        if "drill" in does:
            ps = T.drill(stock, su, t, cfg["tip"], self.rpm(t.dia, float(sp["vc_m_min"]), cap),
                         float(sp["feed_mm_rev"]), sp.get("peck_mm"))
            out.append(ps)
            T.run(stock, [ps], su)
        if "tap" in does:
            ps = T.tap(stock, su, t, cfg["full"], self.rpm(t.dia, float(sp["vc_m_min"]), cap))
            out.append(ps)
            T.run(stock, [ps], su)
        return su, out


# --- the scene ---------------------------------------------------------------------------------------------------

def machine_glbs(chuck: str, grip_r: float) -> list[dict]:
    """The ST-25's links at joint zero, with the setup's chuck on the spindle: the BR10's jaws slid out to grip at
    grip_r."""
    c = CHUCKS[chuck]
    out = [{"path": f"{LINKS}/{k}.glb", "in_body": [0, 0, 0, 1, 0, 0, 0], "link": k} for k in STATIC + c["links"]]
    for k, (dy, dz) in c.get("jaws", {}).items():
        d = grip_r - c["jaw_r"]
        out.append({"path": f"{LINKS}/{k}.glb", "in_body": [0, round(d * dy, 3), round(d * dz, 3), 1, 0, 0, 0],
                    "link": k})
    return out


def frame_of(su: T.Setup, axis: T.Axis, stock: T.Profile, chuck: str) -> tuple[np.ndarray, np.ndarray]:
    """The part's model frame in the world: R and origin (a model point p stands at origin + R @ p). Its axis on the
    spindle's, the free end toward the turret (+x), the jaws' span's free end at the jaws' front."""
    lo, hi = su.jaws
    u_jf = hi if su.side > 0 else lo                     # the held span's end toward the turret
    d_w = np.array([su.side, 0.0, 0.0])                   # the model's axis direction in the world
    n = np.cross(axis.dir, axis.out)
    Rm = np.stack([axis.dir, axis.out, n])                # model -> (u, out, n)
    Rw = np.stack([d_w, np.array([0.0, 0.0, 1.0]), np.cross(d_w, [0.0, 0.0, 1.0])])
    R = Rw.T @ Rm
    on_axis = np.array([CHUCKS[chuck]["front_x"], *AXIS_YZ])
    origin = on_axis - R @ axis.point(u_jf, 0.0)
    return R, origin


def tool_world(su: T.Setup, axis: T.Axis, R, origin, u: float, r: float) -> np.ndarray:
    """A tool's reference point (u, r) in the world: along the spindle at u, out toward the turret by r."""
    p = origin + R @ axis.point(u, 0.0)
    return p + r * X_DIR


def tool_quat(t: T.Tool) -> np.ndarray:
    """A tool body's frame, the catalogue model's (moonshot/library/generators.py): an outside tool's x along lathe Z
    (world +x, away from the chuck) and z out along its shank (lathe X, toward the turret); a drill's or tap's z, its
    shank, along lathe Z."""
    along = np.array([1.0, 0.0, 0.0])
    x, z = (along, X_DIR) if t.side == "out" else (X_DIR, along)
    return _quat(np.stack([x, np.cross(z, x), z]).T)


# --- a step --------------------------------------------------------------------------------------------------------

def take_xml(tools: list[T.Tool]) -> str:
    bodies = "".join(f'    <body name="tool_{t.id}" mocap="true" pos="0 0 3">\n'
                     f'      <geom type="box" size="0.002 0.002 0.002" contype="0" conaffinity="0" rgba="0.3 0.3 0.3 1"/>\n'
                     f'    </body>\n' for t in tools)
    return f"""<mujoco model="lathe">
  <worldbody>
    <geom name="floor" type="plane" size="3 3 0.1" contype="0" conaffinity="0" rgba="0.25 0.25 0.25 1"/>
    <body name="{MACHINE}" pos="0 0 0">
      <geom type="box" size="0.01 0.01 0.01" contype="0" conaffinity="0" rgba="0.8 0.8 0.8 1"/>
    </body>
    <body name="blank" mocap="true" pos="0 0 0">
      <geom type="box" size="0.001 0.001 0.001" contype="0" conaffinity="0" rgba="0.8 0.8 0.82 1"/>
    </body>
    <body name="bar" mocap="true" pos="0 0 0">
      <geom type="box" size="0.001 0.001 0.001" contype="0" conaffinity="0" rgba="0.8 0.8 0.82 1"/>
    </body>
{bodies}  </worldbody>
</mujoco>
"""


def at_time(moves_t: list[float], moves: list[tuple], t: float) -> tuple[float, float] | None:
    """The reference point (u, r) at time t along a pass's moves, or None outside the pass."""
    if t < moves_t[0] - 1e-9 or t > moves_t[-1] + 1e-9:
        return None
    k = int(np.searchsorted(moves_t, t, side="right"))
    if k >= len(moves):
        return moves[-1][0], moves[-1][1]
    a, b = moves[k - 1], moves[k]
    span = moves_t[k] - moves_t[k - 1]
    f = 0.0 if span <= 0 else (t - moves_t[k - 1]) / span
    return a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])


def run_step(lathe: Lathe, s: dict, op: dict, stock: T.Profile, log=print) -> T.Profile | None:
    """Plan, run and record one lathe cycle step; returns the stock it leaves (the part alone, once parted off)."""
    part = lathe.plan["part"]
    step = f"{s['id']}-{op['id']}"
    t0 = time.perf_counter()
    if not list(T.RECORDS.glob(f"*/{op['tool']}/{op['tool']}.json")):
        log(f"[lathe] {step}: {op['tool']} has no catalogue record, so nothing says what it cuts: not run (a plan gap)")
        return None
    su, passes = lathe.passes(s, op, stock)
    if not passes:
        log(f"[lathe] {step}: nothing to cut")
        return None
    out = data_root() / "takes" / f"{part}-{step}"
    if out.exists():
        shutil.rmtree(out)
    (out / "stock").mkdir(parents=True)

    v0 = stock.volume()
    before = stock.copy()
    cuts = T.run(stock, passes, su)                      # (pass, move, stock after)
    lo, hi = lathe.part.span()
    cut_through = len(stock.pieces()) > len(before.pieces())
    end = stock.keep_piece(lo, hi) if cut_through else stock

    # timing: each move's end, the frames sampled evenly over the program
    ends = T.machine_seconds(passes)
    k = 0
    move_t = []
    for q in passes:
        move_t.append(ends[k:k + len(q.moves)])
        k += len(q.moves)
    total = ends[-1]
    frames = int(round(seconds_for(total) * FPS))
    stamps = np.linspace(0.0, total, frames)
    chuck = s["workholding"]["chuck"]
    R, origin = frame_of(su, lathe.axis, before, chuck)
    held = (before.u >= su.jaws[0]) & (before.u <= su.jaws[1]) & before.solid()
    grip_r = float(before.r_out[held].max()) if held.any() else 10.0
    tools = list({q.tool.id: q.tool for q in passes}.values())
    m = mujoco.MjModel.from_xml_string(take_xml(tools))
    d = mujoco.MjData(m)
    mocap = {t.id: m.body_mocapid[m.body(f"tool_{t.id}").id] for t in tools}
    blank, rest = m.body_mocapid[m.body("blank").id], m.body_mocapid[m.body("bar").id]
    q_blank = _quat(R)
    for mid in (blank, rest):
        d.mocap_pos[mid], d.mocap_quat[mid] = origin * M, q_blank
    if not cut_through:                                  # the bar left in the jaws is drawn only after a part-off
        d.mocap_pos[rest] = PARK_MM * M
    q_tool = {t.id: tool_quat(t) for t in tools}
    sc = origin + R @ lathe.axis.point((lo + hi) / 2, 0.0)
    rec = Recorder(m, set(), arms=())
    for t in stamps:
        for tid, mid in mocap.items():
            d.mocap_pos[mid], d.mocap_quat[mid] = PARK_MM * M, q_tool[tid]
        for q, mt in zip(passes, move_t):
            p = at_time(mt, q.moves, t)
            if p is not None:
                d.mocap_pos[mocap[q.tool.id]] = tool_world(su, lathe.axis, R, origin, *p) * M
        mujoco.mj_kinematics(m, d)
        rec.frame(d, {}, EYE, sc, [0, 0, 1])

    # the stock, keyframe by keyframe: each pass's cut from the first frame at or after it
    states = {0: before}
    for (pi, mi, prof) in cuts:
        fi = int(np.searchsorted(stamps, move_t[pi][mi] - 1e-9))
        states[max(1, min(fi, frames - 1))] = prof
    last = max(states)
    states[last] = end
    keyframes = sorted(states)
    look = lathe.material
    for kf in keyframes:
        write_glb(T.to_brep(states[kf], lathe.axis), out / "stock" / f"{kf}.glb", look)
    meshes = {"blank": {"dir": "stock", "frames": keyframes}}
    if cut_through:                                      # the bar left in the jaws once the part is off it
        (out / "bar").mkdir()
        remnant = stock.copy()
        remnant.r_out[end.solid()] = remnant.r_in[end.solid()]
        write_glb(T.to_brep(remnant, lathe.axis), out / "bar" / "0.glb", look)
        meshes["bar"] = {"dir": "bar", "frames": [0]}
    shape = T.to_brep(end, lathe.axis)
    shape.exportBrep(str(out / "stock-end.brep"))
    end.save(out / "stock-profile.npz")
    glbs = {MACHINE: machine_glbs(chuck, grip_r)}
    for t in tools:                                      # the catalogue's model, stored Y up (generators.py)
        model = f"library/tooling/{t.id}/{t.id}.glb"
        if (data_root() / model).exists():
            glbs[f"tool_{t.id}"] = [{"path": model, "in_body": [0, 0, 0, *Y_UP]}]
    rec.write(out, FPS, 0.0, {}, MACHINE, glbs, meshes=meshes)

    centre_model = lathe.axis.point(sum(end.span()) / 2, 0.0)
    size = max(end.span()[1] - end.span()[0], 2 * float(end.r_out[end.solid()].max()))
    dist = float(np.clip(4.0 * size, 90.0, 260.0))
    (out / "still.json").write_text(json.dumps({
        "look_off_mm": (R @ centre_model).round(2).tolist(),
        "from_mm": (np.array([0.45, -0.8, 0.4]) / np.linalg.norm([0.45, -0.8, 0.4]) * dist).round(1).tolist(),
        "about": "the still's camera (moonshot/orchestrate/pipeline.py --still): it looks at the blank body's origin "
                 "plus look_off_mm (world axes: the stock's centre), from from_mm off that: in front of the part, a "
                 "little toward the turret and above, inside the door"}, indent=1), encoding="utf-8")
    (out / "program.json").write_text(json.dumps({
        "schema": "jigged.lathe-program/1", "part": part, "step": step, "setup": s["id"], "operation": op["id"],
        "machine": MACHINE, "side": su.side, "work_zero_u_mm": round(su.u_zero, 4),
        "jaws_u_mm": [round(v, 3) for v in su.jaws], "passes": T.program(passes, su),
        "stock_mm3": [round(v0, 3), round(end.volume(), 3)], "machine_s": round(total, 3),
        "frame_machine_s": [round(float(v), 3) for v in stamps],
        "time_lapse": round(total / (frames / FPS), 2)}, indent=1), encoding="utf-8")
    log(f"[lathe] {step}: {frames} frames for {total:.0f} s of turning, {len(cuts)} cuts, "
        f"{v0 - end.volume():.0f} mm3 removed{' (parted off)' if cut_through else ''}, {time.perf_counter() - t0:.0f} s")
    return end


def lathe_steps(plan: dict) -> list[tuple[dict, dict]]:
    """The lathe's cycle steps, in the plan's order."""
    setups = {s["id"]: s for s in plan["setups"]}
    out = []
    for st in expand(plan):
        s = setups.get(st.get("setup"), {})
        if st["kind"] == "cycle" and s.get("machine") == MACHINE:
            out.append((s, next(o for o in s["operations"] if o["id"] == st["operation"])))
    return out


def main(argv: list[str]) -> int:
    plan = load_plan(argv[0])
    lathe = Lathe(plan)
    steps = lathe_steps(plan)
    ids = [f"{s['id']}-{o['id']}" for s, o in steps]
    i0 = ids.index(argv[argv.index("--from") + 1]) if "--from" in argv else 0
    i1 = ids.index(argv[argv.index("--to") + 1]) + 1 if "--to" in argv else len(ids)
    stock = lathe.stock0()
    if i0:
        prev = next(p for p in reversed(ids[:i0])
                    if (data_root() / "takes" / f"{plan['part']}-{p}" / "stock-profile.npz").exists())
        stock = T.Profile.load(data_root() / "takes" / f"{plan['part']}-{prev}" / "stock-profile.npz")
    for s, op in steps[i0:i1]:
        stock = run_step(lathe, s, op, stock) or stock
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
