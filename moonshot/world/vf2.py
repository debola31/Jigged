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
from typing import Callable

import mujoco
import numpy as np

RECORD = Path(__file__).resolve().parents[1] / "library" / "stations" / "vf2.json"
LINKS = RECORD.with_name("vf2.links.json")
MOVING = {"saddle", "table", "head", "spindle", "door_left", "door_right"}
M = 0.001
# the doors run on their own tracks, one behind the other, so they never touch each other: their geoms collide with
# everything else (a hand, the machine) but not with a door
DOOR = ' conaffinity="2"'
INCH = 25.4
PROBE_FAST_MM_S, PROBE_SLOW_MM_S, PROBE_BACK_MM = 8.0, 0.5, 1.0   # Renishaw's cycles find fast, back off, measure slow [proposed]


def record() -> dict:
    return json.loads(RECORD.read_text(encoding="utf-8"))


def render_links(root: str = "vf2") -> dict[str, tuple[str, str]]:
    """Each link's GLB (moonshot/library/stations/extract.py) and the body that carries it: a moving link its own, a
    link on the head the head's, the rest the machine's `root`."""
    parents = {k: v["parent"] for k, v in record()["links"].items()}
    body = lambda k: f"vf2_{k}" if k in MOVING else body(parents[k]) if parents.get(k) else root     # noqa: E731
    return {k: (body(k), f"library/machines/vf2/links/{k}.glb") for k in json.loads(LINKS.read_text(encoding="utf-8"))}


def _box(name, c_rec, cls="steel", extra=""):
    lo, hi = np.array(c_rec["box_min_mm"], float), np.array(c_rec["box_max_mm"], float)
    c, h = (lo + hi) / 2, (hi - lo) / 2
    fr = f' friction="{c_rec["friction"]} 0.004 0.0001"' if "friction" in c_rec else ""
    return (f'<geom name="{name}" class="{cls}" type="box" size="{h[0] * M:.5f} {h[1] * M:.5f} {h[2] * M:.5f}" '
            f'pos="{c[0] * M:.5f} {c[1] * M:.5f} {c[2] * M:.5f}"{fr}{extra}/>')


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
      {_box(f"vf2_{d}_panel", C[d], extra=DOOR)}
      {_box(f"vf2_{d}_pull", C[f"{d}_pull"], extra=DOOR)}
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
            quat="0.7071068 0.7071068 0 0" mass="{h['mass_kg']}" friction="{h['friction']} 0.004 0.0001" rgba="0.1 0.1 0.1 1"/>
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
    tool_length: dict[int, float] = field(default_factory=dict)       # mm, by tool number
    sensor: Callable[[], bool] | None = None                           # the probe or tool setter touching, now
    vps_queue: list[dict] = field(default_factory=list)                # the cycles chosen in VPS, in order, output by F4

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
        self.cycle: list = []             # a probing cycle from VPS, run by Cycle Start
        self._cycle_ready, self._touches, self._done = False, [], None
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
            if self._cycle_ready and self.state in ("idle", "feed_hold") and doors_ok:
                self.state, self._cycle_ready = "running", False
                self.events.append("cycle_start")
            elif self.mode == "mdi" and self.mdi_line and doors_ok:
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
        elif k == "edit":
            self.page = "vps"
        elif k == "f4" and self.page == "vps" and self.vps_queue:
            self.vps(**self.vps_queue.pop(0))
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
        try:
            s = next((float(w[1:]) for w in words if w.startswith("S")), self.spindle_rpm)
        except ValueError:                        # a mistyped line: the control alarms and runs nothing
            self.mdi_line = ""
            self.events.append(f"mdi_alarm {line}")
            return
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
        # a key or button switches on at its actuation force and off below 30% of it, so it can't chatter about one
        down = {k for k, f in self._force.items() if f >= self.actuation or (k in self._down and f >= 0.3 * self.actuation)}
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
        if self.state == "running" and self.cycle:
            self._run_cycle(dt)
        elif self.state == "running" and self.step_index < len(self.program):
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

    # --- probing (the vf2-tool-setter card, and the spindle probe) -------------------------------------------
    def _joint(self, machine_mm) -> np.ndarray:
        x, y, z = machine_mm
        return np.array([-x, -y, z]) * M

    def vps(self, template: str, **v) -> None:
        """A probing cycle output from VPS to MDI, to run on Cycle Start: "surface" (axis, sign: one touch, its offset
        the ball's radius beyond the ball's centre; in Z the probe's length below its gauge line), "bore" (four
        touches, the centre in X and Y), or "tool_length" (the tool in the spindle down onto the tool setter, whose top
        is setter_z; gauge_length is the operator's approximate length, to come down to it at rapid)."""
        s, r = self.machine_mm().copy(), v.get("ball_r", 0.0)
        G = self.work["G54"]
        if template == "surface":
            i, sign = "xyz".index(v["axis"]), v["sign"]
            u = np.zeros(3)
            u[i] = sign
            self.cycle = [("probe", u, v.get("max_mm", 50.0)), ("move", s)]

            def done(t):
                G[i] = t[0][i] - self.tool_length.get(self.tool, 0.0) if i == 2 else t[0][i] + sign * r
        elif template == "bore":
            ex = np.array([1.0, 0, 0])
            ey = np.array([0, 1.0, 0])
            mid = lambda: np.r_[(self._touches[0][0] + self._touches[1][0]) / 2, s[1], s[2]]     # noqa: E731
            self.cycle = [("probe", ex, 20.0), ("move", s), ("probe", -ex, 20.0), ("move", mid),
                          ("probe", ey, 20.0), ("move", mid), ("probe", -ey, 20.0), ("move", mid)]

            def done(t):
                G[0], G[1] = (t[0][0] + t[1][0]) / 2, (t[2][1] + t[3][1]) / 2
        elif template == "tool_length":
            above = np.r_[s[:2], v["setter_z"] + v["gauge_length"] + 10.0]
            self.cycle = [("move", above), ("probe", np.array([0, 0, -1.0]), 30.0), ("move", np.r_[s[:2], 0.0])]

            def done(t):
                self.tool_length[self.tool] = float(t[0][2] - v["setter_z"])
        else:
            raise ValueError(f"no VPS template {template!r}")
        self._touches, self._done, self._cycle_ready = [], done, True
        self.events.append(f"vps {template}")

    def _toward(self, goal, speed, dt) -> bool:
        """Move the setpoint toward a joint-space goal at speed (mm/s); True once the axes are there."""
        delta = goal - self.setpoint
        dist, stepmax = np.linalg.norm(delta), speed * M * dt
        self.setpoint = goal.copy() if dist <= stepmax else self.setpoint + delta / dist * stepmax
        pos = np.array([self.data.qpos[self.q[a]] for a in ("x", "y", "z")])
        return dist <= stepmax and np.linalg.norm(goal - pos) < 5e-6

    def _run_cycle(self, dt: float) -> None:
        seg = self.cycle[0]
        if seg[0] == "move":
            goal = seg[1]() if callable(seg[1]) else seg[1]
            if self._toward(self._joint(goal), self.rapid, dt):
                self.cycle.pop(0)
        else:                                         # probe: fast to the touch, back off, slow to it again
            _, u, travel = seg[:3]
            stage = seg[3] if len(seg) > 3 else "fast"
            if self.sensor is not None and self.sensor():
                if stage == "fast":
                    back = self.machine_mm() - u * PROBE_BACK_MM
                    self.setpoint = self._joint(self.machine_mm())
                    self.cycle[0] = ("probe", u, travel, "back", back)
                    return
                if stage == "slow":
                    self._touches.append(self.machine_mm().copy())
                    self.setpoint = self._joint(self.machine_mm())
                    self.cycle.pop(0)
                    self._end_if_done()
                    return
            if stage == "back":
                if self._toward(self._joint(seg[4]), PROBE_FAST_MM_S, dt):
                    self.cycle[0] = ("probe", u, travel, "slow", seg[4])
                return
            speed = PROBE_FAST_MM_S if stage == "fast" else PROBE_SLOW_MM_S
            if not hasattr(self, "_probe_from") or self._probe_from[0] is not seg[1]:
                self._probe_from = (seg[1], self.machine_mm().copy())
            if np.linalg.norm(self.machine_mm() - self._probe_from[1]) > travel:
                self.state, self.cycle = "alarm", []
                self.events.append("probe_missed")
                return
            self.setpoint = self.setpoint + self._joint(u) * speed * dt
        self._end_if_done()

    def _end_if_done(self) -> None:
        if not self.cycle and self.state == "running":
            self._done(self._touches)
            self.state = "idle"
            self.events.append("cycle_end")

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
