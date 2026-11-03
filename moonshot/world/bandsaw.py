"""The McMaster 8962N13 band saw as a MuJoCo station, with its control logic (plan §3.2): built from
moonshot/library/stations/bandsaw.json, each moving link weighed from bandsaw.links.json at the record's density.

Bodies: a jointless base, so the saw's own parts don't collide with it (MuJoCo skips a body and its parent), carries
the head on its hinge, the movable jaw on its slide and the vise handwheel. The head carries the two wheel guards on
their hinge line and the drive wheel, whose turning is the blade's. The head falls under its weight less a
counterbalance spring; the hydraulic feed cylinder is a velocity servo that can only resist lowering, so it caps the
descent at the valve's rate, holds the head when the valve is shut, and lets a hand lift it, as its check valve does.
The jaw follows the handwheel through the screw's lead, an equality the quick release switches off. The blade is a
velocity servo inside the spec's speed range and the motor's torque. Colliders are the record's boxes, in class "saw":
stock and hands collide with them but they never collide with each other, since the boxes are coarser than the parts
(the bow's box spans the C-frame's open window) and the joints' limits are what bound the saw's own motion. Its joints
take stiff limits and dry friction, so a guard rests on its stop and the self-locking screw holds without MuJoCo's
soft friction letting it creep. Render geometry is the per-link GLBs, drawn by Blender, not by MuJoCo.

`Control` is the saw's switchgear: start runs the blade only with both guards shut; opening a guard stops it; the
blade stops at the end of the cut, when the head reaches its bottom stop.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import mujoco
import numpy as np

RECORD = Path(__file__).resolve().parents[1] / "library" / "stations" / "bandsaw.json"
LINKS = RECORD.with_name("bandsaw.links.json")
M = 0.001
G = 9.81
SFPM = 0.3048 / 60                 # m/s per surface foot per minute
HP_W = 745.7
FEED_KV = 1e7                      # the cylinder's stiffness against lowering: 60 N m of weight creeps 6 urad/s
BLADE_KV = 20.0
COVERS = ("cover_idler", "cover_drive")
# the saw's defaults, for any scene that holds it: contype 0 so its parts skip each other; stiff joint limits and dry
# friction (2 ms, the shortest stable at the 1 ms timestep)
SAW_DEFAULT = """    <default class="saw">
      <geom contype="0" conaffinity="3" friction="0.25 0.004 0.0001" rgba="0.45 0.5 0.4 1"/>
      <joint solreflimit="0.002 1" solimplimit="0.99 0.999 0.001" solreffriction="0.002 1"
             solimpfriction="0.999 0.9999 0.001"/>
    </default>"""


def record() -> dict:
    return json.loads(RECORD.read_text(encoding="utf-8"))


def links() -> dict:
    return json.loads(LINKS.read_text(encoding="utf-8"))


def _xyz(v, scale=M) -> str:
    return " ".join(f"{x * scale:.5f}" for x in v)


def mass_properties(link: str) -> tuple[float, np.ndarray, list[float]]:
    """(kg, centre of mass in m, inertia about it as xx yy zz xy xz yz in kg m^2) at the record's density."""
    rho, L = record()["density_g_cm3"], links()[link]
    return L["volume_cm3"] * rho / 1000, np.array(L["com_mm"]) * M, [v * rho for v in L["inertia_kg_m2_at_1g_cm3"]]


def _inertial(link: str) -> str:
    kg, com, inertia = mass_properties(link)
    return (f'<inertial pos="{_xyz(com, 1)}" mass="{kg:.4f}" '
            f'fullinertia="{" ".join(f"{v:.6f}" for v in inertia)}"/>')


def _geom(name: str, c: dict) -> str:
    if "box_min_mm" in c:
        lo, hi = np.array(c["box_min_mm"], float), np.array(c["box_max_mm"], float)
        return (f'<geom name="{name}" type="box" size="{_xyz((hi - lo) / 2)}" '
                f'pos="{_xyz((lo + hi) / 2)}"/>')
    if "centre_mm" in c:
        return (f'<geom name="{name}" type="box" size="{_xyz(c["half_mm"])}" pos="{_xyz(c["centre_mm"])}" '
                f'euler="0 {math.radians(c["rot_y_deg"]):.5f} 0"/>')
    x0, x1 = c["cylinder_x_mm"]
    _, y, z = c["at_mm"]
    return (f'<geom name="{name}" type="cylinder" size="{c["radius_mm"] * M:.5f}" '
            f'fromto="{_xyz([x0, y, z, x1, y, z])}"/>')


def _site(name: str, at) -> str:
    return f'<site name="{name}" pos="{_xyz(at)}" size="0.006"/>'


def _lever(point: np.ndarray, hinge: np.ndarray, q: float) -> float:
    """How far left of the hinge a head point (world, at joint zero) sits once the head has lowered by q: the lever
    of a vertical force on it. Lowering turns about -Y, taking (x, z) to (x cos q - z sin q, x sin q + z cos q)."""
    r = point - hinge
    return -(r[0] * math.cos(q) - r[2] * math.sin(q))


def counterbalance() -> tuple[float, float]:
    """(stiffness N m/rad, spring reference rad) of the head's spring: it leaves the record's blade force, at the
    middle of the cutting edge, at both the top and the bottom stop. Gravity's torque on the head and its guards, less
    a linear spring through those two points, then presses the blade up to a third harder in between."""
    r = record()
    J, S = r["joints"]["head"], r["sites"]
    hinge, f = np.array(J["at_mm"]) * M, J["counterbalance_blade_n"]
    mid = (np.array(S["blade_edge_a"]["at_mm"]) + np.array(S["blade_edge_b"]["at_mm"])) * M / 2
    bottom = math.radians(J["range_deg"][1])

    def gravity(q):
        return sum(kg * G * _lever(com, hinge, q) for kg, com, _ in map(mass_properties, ("head", *COVERS)))

    top_net, bottom_net = f * _lever(mid, hinge, 0.0), f * _lever(mid, hinge, bottom)
    k = (gravity(bottom) - gravity(0.0) - (bottom_net - top_net)) / bottom
    return k, (top_net - gravity(0.0)) / k


def worldbody() -> tuple[str, str, str]:
    """(worldbody XML, actuator XML, equality XML). Each body's origin is the world origin at joint zero, so the
    record's world coordinates are used directly."""
    r = record()
    J, B = r["joints"], r["blade"]
    inner = {link: "" for link in r["links"]}
    for name, c in r["colliders"].items():
        inner[c["link"]] += f"      {_geom(f'saw_{name}', c)}\n"
    for name, s in {**r["sites"], **r["affordances"]}.items():
        inner[s["link"]] += f"      {_site(f'saw_{name}', s['at_mm'])}\n"
    k, ref = counterbalance()
    head = J["head"]
    lo, hi = (math.radians(v) for v in head["range_deg"])
    covers = ""
    for c in COVERS:
        j = J[c]
        clo, chi = (math.radians(v) for v in j["range_deg"])
        covers += f"""      <body name="saw_{c}">
        <joint name="saw_{c}" type="hinge" pos="{_xyz(j['at_mm'])}" axis="{_xyz(j['axis'], 1)}" range="{clo} {chi:.5f}"
               frictionloss="{j['friction_n_m']}"/>
        {_inertial(c)}
  {inner[c]}      </body>
"""
    bj, hw, jaw = J["blade"], J["handwheel"], J["jaw"]
    body = f"""    <body name="saw_base" childclass="saw">
{inner['base']}      <body name="saw_head">
        <joint name="saw_head" type="hinge" pos="{_xyz(head['at_mm'])}" axis="{_xyz(head['axis'], 1)}"
               range="{lo} {hi:.5f}" stiffness="{k:.3f}" springref="{ref:.5f}"/>
        {_inertial('head')}
  {inner['head']}{covers}        <body name="saw_blade">
          <joint name="saw_blade" type="hinge" pos="{_xyz(bj['at_mm'])}" axis="{_xyz(bj['axis'], 1)}" limited="false"
                 armature="{B['inertia_kg_m2']}"/>
          <inertial pos="{_xyz(bj['at_mm'])}" mass="0.01" diaginertia="1e-5 1e-5 1e-5"/>
        </body>
      </body>
      <body name="saw_jaw">
        <joint name="saw_jaw" type="slide" axis="{_xyz(jaw['axis'], 1)}" range="{_xyz(jaw['range_mm'])}"
               frictionloss="{jaw['friction_n']}"/>
        {_inertial('jaw')}
  {inner['jaw']}      </body>
      <body name="saw_handwheel">
        <joint name="saw_handwheel" type="hinge" pos="{_xyz(hw['at_mm'])}" axis="{_xyz(hw['axis'], 1)}" limited="false"
               frictionloss="{hw['friction_n_m']}" damping="{hw['damping_n_m_s']}"/>
        {_inertial('handwheel')}
  {inner['handwheel']}      </body>
    </body>
"""
    top_rad_s = B["speed_sfpm"][1] * SFPM / (B["drive_radius_mm"] * M)
    torque = B["motor_hp"] * HP_W / top_rad_s
    acts = (f'    <velocity name="a_saw_feed" joint="saw_head" kv="{FEED_KV:g}" forcelimited="true" '
            f'forcerange="-20000 0"/>\n'
            f'    <velocity name="a_saw_blade" joint="saw_blade" kv="{BLADE_KV}" forcelimited="true" '
            f'forcerange="{-torque:.1f} {torque:.1f}" ctrllimited="true" ctrlrange="0 {top_rad_s:.4f}"/>\n')
    lead = hw["lead_mm"] * M / (2 * math.pi)
    # as hard as the joints' dry friction, or the screw stretches before the jaw's friction lets go
    eq = (f'    <joint name="saw_vise_screw" joint1="saw_jaw" joint2="saw_handwheel" polycoef="0 {lead:.8f} 0 0 0" '
          f'solref="0.002 1" solimp="0.999 0.9999 0.001"/>\n')
    return body, acts, eq


def standalone_xml() -> str:
    """The station alone, for its conformance tests."""
    body, acts, eq = worldbody()
    return f"""<mujoco model="bandsaw">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" gravity="0 0 -9.81"/>
  <default>
    <joint limited="true"/>
{SAW_DEFAULT}
  </default>
  <worldbody>
{body}  </worldbody>
  <equality>
{eq}  </equality>
  <actuator>
{acts}  </actuator>
</mujoco>
"""


@dataclass
class Control:
    """The band saw's switchgear and feed valve: its state, the blade speed and feed it is set to, and the interlocks."""
    model: mujoco.MjModel
    data: mujoco.MjData
    state: str = "idle"
    speed_sfpm: float = 98.0
    feed_mm_s: float = 0.0                      # the feed valve: 0 is shut
    events: list[str] = field(default_factory=list)

    def __post_init__(self):
        r = record()
        m = self.model
        self.speeds, self.feeds = r["blade"]["speed_sfpm"], r["joints"]["head"]["feed_mm_s"]
        self.radius = r["blade"]["drive_radius_mm"] * M
        self.shut = math.radians(r["logic"]["guard_shut_deg"])
        self.lead = r["joints"]["handwheel"]["lead_mm"] * M / (2 * math.pi)
        self.q = {n: m.jnt_qposadr[m.joint(f"saw_{n}").id] for n in ("head", "jaw", "handwheel", *COVERS)}
        self.head = m.joint("saw_head").id
        self.end_of_cut = m.jnt_range[self.head][1] - math.radians(r["logic"]["end_of_cut_within_deg"])
        self.act = {n: m.actuator(f"a_saw_{n}").id for n in ("feed", "blade")}
        self.screw = m.equality("saw_vise_screw").id
        self.edge = (m.site("saw_blade_edge_a").id, m.site("saw_blade_edge_b").id)

    def guards_shut(self) -> bool:
        return all(self.data.qpos[self.q[c]] < self.shut for c in COVERS)

    def set_speed(self, sfpm: float) -> None:
        self.speed_sfpm = float(np.clip(sfpm, *self.speeds))

    def set_feed(self, mm_s: float) -> None:
        self.feed_mm_s = float(np.clip(mm_s, *self.feeds))

    def press(self, button: str) -> None:
        if button == "start":
            if self.state == "idle" and self.guards_shut():
                self.state = "running"
                self.events.append("start")
            else:
                self.events.append("start_refused")
        elif button == "stop" and self.state == "running":
            self.state = "idle"
            self.events.append("stop")

    def release_vise(self) -> None:
        """Lift the quick release: the half-nut leaves the screw and the jaw slides free."""
        self.data.eq_active[self.screw] = 0
        self.events.append("vise_released")

    def engage_vise(self) -> None:
        """Drop the quick release: the screw takes the jaw where it now is."""
        d = self.data
        self.model.eq_data[self.screw][0] = d.qpos[self.q["jaw"]] - self.lead * d.qpos[self.q["handwheel"]]
        d.eq_active[self.screw] = 1
        self.events.append("vise_engaged")

    def step(self) -> None:
        self.apply()
        mujoco.mj_step(self.model, self.data)

    def apply(self) -> None:
        """Apply the interlocks, then set the feed cylinder and the blade motor. For a scene that steps the simulation
        itself (a take): call this before each mj_step."""
        d = self.data
        if self.state == "running" and not self.guards_shut():
            self.state = "idle"
            self.events.append("guard_opened_stop")
        if self.state == "running" and d.qpos[self.q["head"]] >= self.end_of_cut:
            self.state = "idle"
            self.events.append("end_of_cut")
        # the valve sets the edge's descent speed; the head turns at that over the edge's lever from the hinge
        mid = (d.site_xpos[self.edge[0]] + d.site_xpos[self.edge[1]]) / 2
        lever = max(abs(mid[0] - d.xanchor[self.head][0]), 0.05)
        d.ctrl[self.act["feed"]] = self.feed_mm_s * M / lever
        running = self.state == "running"
        d.ctrl[self.act["blade"]] = self.speed_sfpm * SFPM / self.radius if running else 0.0
