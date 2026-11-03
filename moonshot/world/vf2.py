"""The Haas VF-2 as a MuJoCo station, with its control logic (plan §3.2): built from moonshot/library/stations/vf2.json.

Bodies: the saddle (Y) carries the table (X); the head (Z) carries the spindle; the doors slide open by hand. The
axes are position servos capped at the rapid speed, gravity-compensated as a real servo with its counterbalance
holds its axis exactly; the spindle is a velocity servo; the doors are passive slides
with friction, so a hand has to pull them. Colliders are the record's boxes (the CAD shells aren't closed); render
geometry is the per-link GLBs, drawn by Blender, not by MuJoCo.

`Control` is the machine's state machine: Cycle Start runs the program only with both doors closed; opening a door
while running puts the machine in feed hold and stops the spindle; the spindle turns only while running.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import mujoco
import numpy as np

RECORD = Path(__file__).resolve().parents[1] / "library" / "stations" / "vf2.json"
LINKS = RECORD.with_name("vf2.links.json")
MOVING = {"saddle", "table", "head", "spindle", "door_left", "door_right"}
M = 0.001
INCH = 25.4


def record() -> dict:
    return json.loads(RECORD.read_text(encoding="utf-8"))


def render_links(root: str = "vf2") -> dict[str, tuple[str, str]]:
    """Each link's GLB (moonshot/library/stations/extract.py) and the body that carries it: a moving link its own, a
    link on the head the head's, the rest the machine's `root`."""
    parents = {k: v["parent"] for k, v in record()["links"].items()}
    body = lambda k: f"vf2_{k}" if k in MOVING else body(parents[k]) if parents.get(k) else root     # noqa: E731
    return {k: (body(k), f"library/machines/vf2/links/{k}.glb") for k in json.loads(LINKS.read_text(encoding="utf-8"))}


def _box(name, c_rec, cls="steel"):
    lo, hi = np.array(c_rec["box_min_mm"], float), np.array(c_rec["box_max_mm"], float)
    c, h = (lo + hi) / 2, (hi - lo) / 2
    fr = f' friction="{c_rec["friction"]} 0.004 0.0001"' if "friction" in c_rec else ""
    return (f'<geom name="{name}" class="{cls}" type="box" size="{h[0] * M:.5f} {h[1] * M:.5f} {h[2] * M:.5f}" '
            f'pos="{c[0] * M:.5f} {c[1] * M:.5f} {c[2] * M:.5f}"{fr}/>')


def _site(name, at, origin=(0, 0, 0)):
    p = (np.array(at, float) - np.array(origin, float)) * M
    return f'<site name="{name}" pos="{p[0]:.5f} {p[1]:.5f} {p[2]:.5f}" size="0.006"/>'


def worldbody(on_table: str = "") -> tuple[str, str]:
    """(worldbody XML, actuator XML). Each moving body's origin is the world origin at joint zero, so the record's
    world coordinates are used directly, and so are on_table's: XML for what is bolted to the table (a vise)."""
    r = record()
    J, C, A = r["joints"], r["colliders"], r["affordances"]
    L = r["links"]
    rng = lambda j: f'{J[j]["range_mm"][0] * M:.4f} {J[j]["range_mm"][1] * M:.4f}'      # noqa: E731
    ax = lambda j: " ".join(str(v) for v in J[j]["axis"])                               # noqa: E731
    sp = J["spindle"]["centre_mm"]
    body = f"""    <body name="vf2_saddle" gravcomp="1">
      <joint name="vf2_y" type="slide" axis="{ax('y')}" range="{rng('y')}" damping="2000"/>
      <inertial pos="-0.381 -0.34 0.6" mass="{L['saddle']['mass_kg']}" diaginertia="20 20 20"/>
      <body name="vf2_table" gravcomp="1">
        <joint name="vf2_x" type="slide" axis="{ax('x')}" range="{rng('x')}" damping="2000"/>
        <inertial pos="-0.381 -0.34 0.8" mass="{L['table']['mass_kg']}" diaginertia="15 15 15"/>
        {_box("vf2_table_top", C["table_top"])}
        <site name="vf2_table_ref" pos="-0.3815 -0.3407 0.853" size="0.005"/>
{on_table}      </body>
    </body>
    <body name="vf2_head" gravcomp="1">
      <joint name="vf2_z" type="slide" axis="{ax('z')}" range="{rng('z')}" damping="2000"/>
      <inertial pos="0 -0.13 1.8" mass="{L['head']['mass_kg']}" diaginertia="20 20 20"/>
      {_box("vf2_spindle_nose", C["spindle_nose"])}
      <body name="vf2_spindle" gravcomp="1" pos="{sp[0] * M:.4f} {sp[1] * M:.4f} {sp[2] * M:.4f}">
        <joint name="vf2_spindle" type="hinge" axis="0 0 1" limited="false" damping="0.05"/>
        <geom name="vf2_spindle_gauge" type="cylinder" size="0.022 0.005" contype="0" conaffinity="0" mass="5"/>
      </body>
    </body>
"""
    for side in ("left", "right"):
        d = f"door_{side}"
        body += f"""    <body name="vf2_{d}">
      <joint name="vf2_{d}" type="slide" axis="{ax(d)}" range="{rng(d)}" frictionloss="{J[d]['friction_n']}" damping="20"/>
      <inertial pos="0 -0.83 1.16" mass="{L[d]['mass_kg']}" diaginertia="2 2 2"/>
      {_box(f"vf2_{d}_panel", C[d])}
      {_site(f"vf2_{d}_handle", A[f"{d}_handle"]["at_mm"])}
    </body>
"""
    body += pendant()
    rapid = J["x"]["speed_mm_s"]
    acts = "".join(
        f'    <position name="a_vf2_{a}" joint="vf2_{a}" kp="2e6" dampratio="1" ctrllimited="true" '
        f'ctrlrange="{rng(a)}"/>\n' for a in ("x", "y", "z"))
    acts += '    <velocity name="a_vf2_spindle" joint="vf2_spindle" kv="5" ctrllimited="true" ' \
            f'ctrlrange="0 {J["spindle"]["max_rpm"] * 2 * math.pi / 60:.2f}"/>\n'
    det = A["jog_handle"]["detent_torque_nm"]
    acts += f'    <motor name="a_vf2_jog_detent" joint="vf2_jog" ctrllimited="true" ctrlrange="{-det} {det}"/>\n'
    _ = rapid
    return body, acts


def _cylinder_y(name, c_rec, cls="steel"):
    """A cylinder along Y: the pendant's buttons and E-stop stand out of its face toward the operator."""
    c = np.array(c_rec["centre_mm"], float) * M
    return (f'<geom name="{name}" class="{cls}" type="cylinder" size="{c_rec["radius_mm"] * M:.5f} '
            f'{c_rec["half_mm"] * M:.5f}" pos="{c[0]:.5f} {c[1]:.5f} {c[2]:.5f}" quat="0.7071068 0.7071068 0 0"/>')


def pendant() -> str:
    """The pendant's face, E-stop and buttons as fixed colliders; the jog handle as a dial on a hinge, held in its
    detents by a motor the control drives (`Control.apply`); a site on each button and key, on the face."""
    r = record()
    C, A = r["colliders"], r["affordances"]
    out = "    " + _box("vf2_pendant_face", C["pendant_face"]) + "\n"
    for g in ("estop", "cycle_start_button", "feed_hold_button"):
        out += "    " + _cylinder_y(f"vf2_{g}", C[g]["cylinder"]) + "\n"
    for b in ("cycle_start", "feed_hold"):
        out += "    " + _site(f"vf2_{b}", A[b]["at_mm"]) + "\n"
    h = A["jog_handle"]
    half = h["depth_mm"] / 2 * M
    c = np.array(h["at_mm"], float) * M + np.array(h["axis"], float) * half
    out += f"""    <body name="vf2_jog_handle" pos="{c[0]:.5f} {c[1]:.5f} {c[2]:.5f}">
      <joint name="vf2_jog" type="hinge" axis="{' '.join(str(v) for v in h['axis'])}" limited="false" damping="{h['damping_nms']}"/>
      <geom name="vf2_jog_handle" class="steel" type="cylinder" size="{h['radius_mm'] * M:.5f} {half:.5f}"
            quat="0.7071068 0.7071068 0 0" mass="{h['mass_kg']}" friction="0.8 0.004 0.0001" rgba="0.1 0.1 0.1 1"/>
      <site name="vf2_jog_rim" pos="0 {-half:.5f} {(h['radius_mm'] - 3) * M:.5f}" size="0.002"/>
    </body>
"""
    k = A["keys"]
    for name, (x, z) in k["at_mm"].items():
        out += "    " + _site(f"vf2_key_{name}", (x, k["face_y_mm"], z)) + "\n"
    return out


def standalone_xml() -> str:
    """The station alone, for its conformance tests."""
    body, acts = worldbody()
    return f"""<mujoco model="vf2">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" gravity="0 0 -9.81"/>
  <default>
    <joint limited="true"/>
    <default class="steel"><geom contype="1" conaffinity="3" friction="0.25 0.004 0.0001" rgba="0.3 0.35 0.6 1"/></default>
  </default>
  <worldbody>
{body}  </worldbody>
  <actuator>
{acts}  </actuator>
</mujoco>
"""


@dataclass
class Control:
    """The VF-2's control: its state, the program it runs, and the interlocks."""
    model: mujoco.MjModel
    data: mujoco.MjData
    program: list[tuple[float, float, float, float]] = field(default_factory=list)   # (x, y, z mm, rpm) per move
    state: str = "idle"
    step_index: int = 0
    events: list[str] = field(default_factory=list)
    tool: int = 0                     # the tool in the spindle
    setup_mode: bool = False          # the pendant's setup key switch

    def __post_init__(self):
        r = record()
        self.closed_mm = r["logic"]["door_closed_mm"]
        self.setup_rpm = r["logic"]["setup_max_rpm"]
        self.rapid = r["joints"]["x"]["speed_mm_s"]
        A = r["affordances"]
        self.actuation = A["keys"]["actuation_n"]
        self.detents, self.detent_nm = A["jog_handle"]["detents_per_turn"], A["jog_handle"]["detent_torque_nm"]
        m = self.model
        self.q = {n: m.jnt_qposadr[m.joint(f"vf2_{n}").id] for n in ("x", "y", "z", "door_left", "door_right", "jog")}
        self.act = {n: m.actuator(f"a_vf2_{n}").id for n in ("x", "y", "z", "spindle", "jog_detent")}
        self.setpoint = np.array([self.data.qpos[self.q[a]] for a in ("x", "y", "z")])
        # the pendant: its mode, the handle's axis and increment, the page and cursor shown, what has been typed
        self.mode, self.jog_axis, self.increment_mm = "", "x", 0.001 * INCH
        self.page, self.cursor, self.typed, self.mdi_line = "", 0, "", ""
        self.work = {"G54": np.zeros(3)}
        self.tool_length: dict[int, float] = {}
        self.spindle_rpm = 0.0            # turning after M03 from MDI
        self.pressed: list[tuple[float, str]] = []
        self._force: dict[str, float] = {}
        self._down: set[str] = set()
        self._jog_clicks = self.clicks()
        self._jog_goal = self.setpoint.copy()

    def doors_closed(self) -> bool:
        d = self.data
        return all(d.qpos[self.q[k]] * 1000 < self.closed_mm for k in ("door_left", "door_right"))

    def machine_mm(self) -> np.ndarray:
        """Machine X, Y, Z (mm) as Haas counts them: 0 at home; +X moves the table left (the tool right across the
        part), +Y moves it toward the operator, +Z raises the head."""
        d = self.data
        return np.array([-d.qpos[self.q["x"]], -d.qpos[self.q["y"]], d.qpos[self.q["z"]]]) / M

    def clicks(self) -> int:
        """The jog handle's position in detents, clockwise from the operator positive."""
        return round(self.data.qpos[self.q["jog"]] * self.detents / (2 * math.pi))

    def touch(self, forces: dict[str, float]) -> None:
        """How hard a hand pushes on each key or button now (N): a key registers once as its force rises past the
        actuation force, and not again until let go."""
        self._force = forces

    def press(self, button: str) -> None:
        self.pressed.append((round(float(self.data.time), 4), button))
        doors_ok = self.doors_closed() or self.setup_mode
        if button == "cycle_start":
            if self.mode == "mdi" and self.mdi_line and doors_ok:
                self._mdi(self.mdi_line)
            elif self.state in ("idle", "feed_hold") and doors_ok and self.program:
                self.state = "running"
                self.events.append("cycle_start")
            else:
                self.events.append("cycle_start_refused")
        elif button == "feed_hold" and self.state == "running":
            self.state = "feed_hold"
            self.events.append("feed_hold")
        else:
            self._key(button)

    def _key(self, k: str) -> None:
        """The pendant's other keys: modes, the handle's increment and axis, the offset pages and typing."""
        if k in ("handle_jog", "mdi", "memory"):
            self.mode = k
            self._jog_clicks = self.clicks()
            if k == "mdi":
                self.page = "program"
        elif k.startswith("inc_"):
            self.increment_mm = float(k[4:]) * INCH
        elif k in ("+x", "-x", "+y", "-y", "+z", "-z") and self.mode == "handle_jog":
            self.jog_axis = k[1]
        elif k == "offset":
            self.page = "tool" if self.page == "work" else "work"
        elif k in ("left", "right") and self.page == "work":
            self.cursor = int(np.clip(self.cursor + (1 if k == "right" else -1), 0, 2))
        elif k == "part_zero_set" and self.page == "work":
            self.work["G54"][self.cursor] = self.machine_mm()[self.cursor]
        elif k == "tool_offset_measure" and self.page == "tool":
            self.tool_length[self.tool] = float(self.machine_mm()[2])
        elif k in ("enter", "f1"):
            if self.page == "work" and self.typed:
                v = float(self.typed)
                self.work["G54"][self.cursor] = v if k == "f1" else self.work["G54"][self.cursor] + v
            elif self.page == "program":
                self.mdi_line = self.typed
            self.typed = ""
        elif k == "cancel":
            self.typed = self.typed[:-1]
        elif k == "reset":
            self.state, self.spindle_rpm, self.typed = "idle", 0.0, ""
            self.events.append("reset")
        elif len(k) == 1 or k in ("space", "eob"):
            self.typed += {"space": " ", "eob": ";"}.get(k, k.upper())

    def _mdi(self, line: str) -> None:
        """Run a typed MDI line: S sets the speed, M03 starts the spindle and M05 stops it."""
        words = line.split()
        s = next((float(w[1:]) for w in words if w.startswith("S")), self.spindle_rpm)
        if "M03" in words:
            self.spindle_rpm = s
        if "M05" in words:
            self.spindle_rpm = 0.0
        self.mdi_line = ""
        self.events.append(f"mdi {line}")

    def open_doors(self) -> None:
        """Both doors fully open, as an operator leaves them while loading."""
        m, d = self.model, self.data
        for k in ("door_left", "door_right"):
            d.qpos[self.q[k]] = m.jnt_range[m.joint(f"vf2_{k}").id][1]

    def step(self) -> None:
        self.apply()
        mujoco.mj_step(self.model, self.data)

    def apply(self) -> None:
        """Apply the interlocks, then set the axes' controls toward the program's current move at no more than rapid
        speed. For a scene that steps the simulation itself (a take): call this before each mj_step."""
        d, dt = self.data, self.model.opt.timestep
        down = {k for k, f in self._force.items() if f >= self.actuation}
        for k in sorted(down - self._down):
            self.press(k)
        self._down = down
        if self.state == "running" and not (self.doors_closed() or self.setup_mode):
            self.state = "feed_hold"
            self.events.append("door_opened_feed_hold")
        if not self.doors_closed() and not self.setup_mode:
            self.spindle_rpm = 0.0
        self._handle(dt)
        rpm = 0.0
        if self.state == "running" and self.step_index < len(self.program):
            x, y, z, rpm = self.program[self.step_index]
            goal = np.array([x, y, z]) * M
            delta = goal - self.setpoint
            dist = np.linalg.norm(delta)
            stepmax = self.rapid * M * dt
            self.setpoint = goal if dist <= stepmax else self.setpoint + delta / dist * stepmax
            pos = np.array([d.qpos[self.q[a]] for a in ("x", "y", "z")])
            if dist <= stepmax and np.linalg.norm(goal - pos) < 0.0005:
                self.step_index += 1
                if self.step_index == len(self.program):
                    self.state, rpm = "idle", 0.0
                    self.events.append("program_end")
        for i, a in enumerate(("x", "y", "z")):
            d.ctrl[self.act[a]] = self.setpoint[i]
        rpm = rpm if self.state == "running" else self.spindle_rpm
        if not self.doors_closed():
            rpm = min(rpm, self.setup_rpm) if self.setup_mode else 0.0
        d.ctrl[self.act["spindle"]] = rpm * 2 * math.pi / 60

    def _handle(self, dt: float) -> None:
        """The jog handle: its detents, and in handle jog each click moves the selected axis by the increment, no
        faster than rapid."""
        d = self.data
        d.ctrl[self.act["jog_detent"]] = -self.detent_nm * math.sin(self.detents * d.qpos[self.q["jog"]])
        if self.mode != "handle_jog" or self.state == "running":
            self._jog_clicks, self._jog_goal = self.clicks(), self.setpoint.copy()
            return
        c = self.clicks()
        i = "xyz".index(self.jog_axis)
        self._jog_goal[i] += (1.0 if i == 2 else -1.0) * (c - self._jog_clicks) * self.increment_mm * M
        self._jog_clicks = c
        delta = self._jog_goal - self.setpoint
        dist, stepmax = np.linalg.norm(delta), self.rapid * M * dt
        self.setpoint = self._jog_goal.copy() if dist <= stepmax else self.setpoint + delta / dist * stepmax
