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
M = 0.001


def record() -> dict:
    return json.loads(RECORD.read_text(encoding="utf-8"))


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
    body += "    " + _box("vf2_pendant_face", C["pendant_face"]) + "\n"
    for b in ("cycle_start", "feed_hold"):
        body += "    " + _site(f"vf2_{b}", A[b]["at_mm"]) + "\n"
    rapid = J["x"]["speed_mm_s"]
    acts = "".join(
        f'    <position name="a_vf2_{a}" joint="vf2_{a}" kp="2e6" dampratio="1" ctrllimited="true" '
        f'ctrlrange="{rng(a)}"/>\n' for a in ("x", "y", "z"))
    acts += '    <velocity name="a_vf2_spindle" joint="vf2_spindle" kv="5" ctrllimited="true" ' \
            f'ctrlrange="0 {J["spindle"]["max_rpm"] * 2 * math.pi / 60:.2f}"/>\n'
    _ = rapid
    return body, acts


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

    def __post_init__(self):
        r = record()
        self.closed_mm = r["logic"]["door_closed_mm"]
        self.rapid = r["joints"]["x"]["speed_mm_s"]
        m = self.model
        self.q = {n: m.jnt_qposadr[m.joint(f"vf2_{n}").id] for n in ("x", "y", "z", "door_left", "door_right")}
        self.act = {n: m.actuator(f"a_vf2_{n}").id for n in ("x", "y", "z", "spindle")}
        self.setpoint = np.array([self.data.qpos[self.q[a]] for a in ("x", "y", "z")])

    def doors_closed(self) -> bool:
        d = self.data
        return all(d.qpos[self.q[k]] * 1000 < self.closed_mm for k in ("door_left", "door_right"))

    def press(self, button: str) -> None:
        if button == "cycle_start":
            if self.state in ("idle", "feed_hold") and self.doors_closed() and self.program:
                self.state = "running"
                self.events.append("cycle_start")
            else:
                self.events.append("cycle_start_refused")
        elif button == "feed_hold" and self.state == "running":
            self.state = "feed_hold"
            self.events.append("feed_hold")

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
        if self.state == "running" and not self.doors_closed():
            self.state = "feed_hold"
            self.events.append("door_opened_feed_hold")
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
        d.ctrl[self.act["spindle"]] = rpm * 2 * math.pi / 60 if self.state == "running" else 0.0
