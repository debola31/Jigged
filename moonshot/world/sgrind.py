"""The 10 x 24 manual surface grinder as a MuJoCo station, with its controls and its magnetic chuck (plan §3.2): built
from moonshot/library/stations/sgrind.json, each moving link weighed from sgrind.links.json at the record's density.

Bodies: a jointless base (the pedestal, the column and the control box), so the grinder's own parts don't collide with
it, carries the saddle on its cross slide, the wheelhead on its vertical slide and the down-feed handwheel with its
graduated dial. The saddle carries the table on its longitudinal slide and the two front handwheels; the table carries
the chuck, and the chuck its lever; the wheelhead carries the spindle and its wheel. Each handwheel drives its slide
through an equality at its ratio: the longitudinal handwheel the table through a rack and pinion (not self-locking, so a
push on the table turns it back), the cross and down-feed handwheels their screws (self-locking: their friction holds
the saddle and the head's weight). The dial turns with the down-feed handwheel on its own friction, and a hand slips it
to set its zero. The spindle is a velocity servo inside its motor's torque while the machine runs, and its drive is
cut, not braked, when it stops, so the wheel coasts down on its bearings' friction. Colliders are the record's boxes,
discs and capsules, in class "sg": hands and parts collide with them but they never collide with each other, and the
joints' limits bound the grinder's own motion. Render geometry is the per-link GLBs, drawn by Blender, not by MuJoCo.
Each body's origin is the world origin at joint zero, but each turning body's, which is on its axis.

The magnetic chuck is a permanent magnet switched by its lever (record "chuck"). Its hold is a force, applied each step
by `Control.apply` to every part it holds and, reversed, to the chuck. Each held geom's face turned to the chuck is
split into points each standing for a share of its area (a box's four corners; a mesh's downward faces), and each point
over the chuck's face and within the magnet's reach of it pulls along the face's normal with

    rated pressure x field(lever) x material x min(1, thickness / pole width) x its area / (1 + gap / g0)^2

the gap being its height above the face (zero when seated). It is measured from the geometry, not from MuJoCo's
contacts, so a part set down near the face is pulled and a part lifted off it is pulled less as it rises. The pull
presses the part into the face, and MuJoCo's contact friction on that harder press is what holds it sideways; nothing
welds it. The lever's own magnet holds it at either
end of its half turn, a torque the control sets on the lever's detent actuator.

`Control` is the grinder's switchgear (SB1029's): ON runs the wheel unless OFF is in or the wheel isn't rated for its
speed; OFF stops it and stays in until twisted out; the coolant switch runs the pump. It owns `data.xfrc_applied` for
the chuck and every body it holds: push them through `qfrc_applied`.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import mujoco
import numpy as np

RECORD = Path(__file__).resolve().parents[1] / "library" / "stations" / "sgrind.json"
LINKS = RECORD.with_name("sgrind.links.json")
M = 0.001
HP_W = 745.7
SPINDLE_KV = 2.0                   # N m per rad/s: 0.15 N m of bearing friction holds it 0.04% under its speed
JOINT_OF = {"saddle": "saddle", "table": "table", "wheelhead": "wheelhead", "spindle": "spindle",
            "table_handwheel": "table_handwheel", "cross_handwheel": "cross_handwheel",
            "downfeed_handwheel": "downfeed_handwheel", "downfeed_dial": "downfeed_dial", "chuck_lever": "chuck_lever"}
TURNING = ("spindle", "table_handwheel", "cross_handwheel", "downfeed_handwheel", "downfeed_dial", "chuck_lever")
# the grinder's defaults, for any scene that holds it: contype 0 so its parts skip each other; stiff joint limits and
# dry friction, as the band saw's (moonshot/world/bandsaw.py SAW_DEFAULT)
SG_DEFAULT = """    <default class="sg">
      <geom contype="0" conaffinity="3" friction="0.25 0.004 0.0001" rgba="0.55 0.6 0.62 1"/>
      <joint solreflimit="0.002 1" solimplimit="0.99 0.999 0.001" solreffriction="0.002 1"
             solimpfriction="0.999 0.9999 0.001"/>
    </default>"""


def record() -> dict:
    return json.loads(RECORD.read_text(encoding="utf-8"))


def links() -> dict:
    return json.loads(LINKS.read_text(encoding="utf-8"))


def _xyz(v, scale=M) -> str:
    return " ".join(f"{float(x) * scale:.6f}" for x in v)


def origins() -> dict[str, np.ndarray]:
    """Each link's body origin, the world's (mm) at joint zero: the world origin, or a turning link's axis point."""
    r = record()
    out = {link: np.zeros(3) for link in r["links"]}
    for link in TURNING:
        out[link] = np.array(r["joints"][JOINT_OF[link]]["at_mm"], float)
    return out


def mass_properties(link: str) -> tuple[float, np.ndarray, list[float]]:
    """(kg, centre of mass in the world at joint zero, m, inertia about it as xx yy zz xy xz yz in kg m^2)."""
    rho, L = record()["density_g_cm3"][link], links()[link]
    return L["volume_cm3"] * rho / 1000, np.array(L["com_mm"]) * M, [v * rho for v in L["inertia_kg_m2_at_1g_cm3"]]


def wheel(wheel_id: str | None = None) -> dict:
    """A wheel the spindle mounts (record "wheels"), the mounted one if none is named."""
    r = record()
    return r["wheels"][wheel_id or r["spindle"]["mounted"]]


def _inertial(link: str, origin: np.ndarray, wheel_id: str | None = None) -> str:
    if link == "spindle":                        # the nose and the motor's rotor, with the wheel it mounts
        s, w = record()["spindle_mass"], wheel(wheel_id)
        com = np.array(links()["spindle"]["com_mm"]) - origin
        kg, axial = s["kg"] + w["kg"], s["axial_inertia_kg_m2"] + w["axial_inertia_kg_m2"]
        side = axial * 0.6
        return f'<inertial pos="{_xyz(com)}" mass="{kg:.4f}" diaginertia="{side:.6f} {axial:.6f} {side:.6f}"/>'
    kg, com, inertia = mass_properties(link)
    return (f'<inertial pos="{_xyz(com - origin * M, 1)}" mass="{kg:.4f}" '
            f'fullinertia="{" ".join(f"{v:.6f}" for v in inertia)}"/>')


def _geom(name: str, c: dict, o: np.ndarray) -> str:
    """A record collider as a geom in a body whose origin is o (world mm at joint zero)."""
    if "box_min_mm" in c:
        lo, hi = np.array(c["box_min_mm"], float), np.array(c["box_max_mm"], float)
        return f'<geom name="{name}" type="box" size="{_xyz((hi - lo) / 2)}" pos="{_xyz((lo + hi) / 2 - o)}"'
    if "capsule_mm" in c:
        a, b = (np.array(p, float) - o for p in c["capsule_mm"])
        return f'<geom name="{name}" type="capsule" size="{c["radius_mm"] * M:.6f}" fromto="{_xyz([*a, *b])}"'
    if "sphere_mm" in c:
        return (f'<geom name="{name}" type="sphere" size="{c["radius_mm"] * M:.6f}" '
                f'pos="{_xyz(np.array(c["sphere_mm"], float) - o)}"')
    at = np.array(c["at_mm"], float)
    if "cylinder_y_mm" in c:
        y0, y1 = c["cylinder_y_mm"]
        a, b = np.array([at[0], y0, at[2]]) - o, np.array([at[0], y1, at[2]]) - o
    else:
        x0, x1 = c["cylinder_x_mm"]
        a, b = np.array([x0, at[1], at[2]]) - o, np.array([x1, at[1], at[2]]) - o
    return f'<geom name="{name}" type="cylinder" size="{c["radius_mm"] * M:.6f}" fromto="{_xyz([*a, *b])}"'


def _joint(link: str) -> str:
    r = record()
    if link not in JOINT_OF:
        return ""
    j = r["joints"][JOINT_OF[link]]
    name = f"sg_{JOINT_OF[link]}"
    if j["type"] == "slide":
        lo, hi = j["range_mm"]
        return (f'<joint name="{name}" type="slide" axis="{_xyz(j["axis"], 1)}" range="{lo * M:.6f} {hi * M:.6f}" '
                f'frictionloss="{j["friction_n"]}"/>')
    limits = (f'range="{math.radians(j["range_deg"][0]):.6f} {math.radians(j["range_deg"][1]):.6f}"'
              if "range_deg" in j else 'limited="false"')
    return (f'<joint name="{name}" type="hinge" pos="0 0 0" axis="{_xyz(j["axis"], 1)}" {limits} '
            f'frictionloss="{j["friction_n_m"]}"/>')


def wheel_colliders_and_sites(wheel_id: str | None = None) -> tuple[dict, dict]:
    """The mounted wheel's colliders (its disc, and its flange in front of it) and its lowest point's sites."""
    r = record()
    w, at = wheel(wheel_id), r["joints"]["spindle"]["at_mm"]
    r_mm = w["dia_mm"] / 2
    fl, f0, f1 = w["flange_mm"]
    cols = {"wheel": {"link": "spindle", "cylinder_y_mm": w["y_mm"], "at_mm": at, "radius_mm": r_mm},
            "flange": {"link": "spindle", "cylinder_y_mm": [f0, f1], "at_mm": at, "radius_mm": fl / 2}}
    if r["coolant"]["fitted"]:                   # the nozzle's last run to its tip, set for the wheel
        path = r["coolant"]["nozzle_mm"][wheel_id or r["spindle"]["mounted"]]
        cols["coolant_nozzle"] = {"link": "wheelhead", "capsule_mm": path[-2:], "radius_mm": r["coolant"]["radius_mm"]}
    bottom = [at[0], 0.0, at[2] - r_mm]
    sites = {"wheel_bottom": {"link": "spindle", "at_mm": bottom},          # on its rim's circle, so still the lowest
             "wheel_bottom_head": {"link": "wheelhead", "at_mm": bottom}}   # carried by the head: doesn't turn
    return cols, sites


def worldbody(wheel_id: str | None = None) -> tuple[str, str, str]:
    """(worldbody XML, actuator XML, equality XML), the spindle mounting wheel_id (the record's mounted wheel if
    None)."""
    r = record()
    C, J, S = r["chuck"], r["joints"], r["spindle"]
    o = origins()
    inner = {link: "" for link in r["links"]}
    wheel_cols, wheel_sites = wheel_colliders_and_sites(wheel_id)
    for name, c in {**r["colliders"], **wheel_cols}.items():
        g = _geom(f"sg_{name}", c, o[c["link"]])
        if name == "chuck_face":                 # the magnet's face: ground steel
            g += f' friction="{C["face_friction"]} 0.004 0.0001"'
        inner[c["link"]] += f"      {g}/>\n"
    for name, s in {**r["sites"], **wheel_sites, **r["affordances"]}.items():
        inner[s["link"]] += (f'      <site name="sg_{name}" pos="{_xyz(np.array(s["at_mm"], float) - o[s["link"]])}" '
                             f'size="0.006"/>\n')
    children: dict[str, list[str]] = {}
    for link, v in r["links"].items():
        children.setdefault(v["parent"], []).append(link)

    def body(link: str, parent_origin: np.ndarray, depth: int) -> str:
        pad = "    " + "  " * depth
        attrs = ' childclass="sg"' if link == "base" else ""
        out = f'{pad}<body name="sg_{link}" pos="{_xyz(o[link] - parent_origin)}"{attrs}>\n'
        jx = _joint(link)
        if jx:
            out += f"{pad}  {jx}\n"
        if link not in ("base", "controls"):
            out += f"{pad}  {_inertial(link, o[link], wheel_id)}\n"
        out += inner[link]
        for child in children.get(link, []):
            out += body(child, o[link], depth + 1)
        return out + f"{pad}</body>\n"

    xml = body("base", np.zeros(3), 0)
    top = S["rpm"] * 2 * math.pi / 60
    torque = S["motor_hp"] * HP_W / top
    detent = J["chuck_lever"]["detent_n_m"]
    acts = (f'    <velocity name="a_sg_spindle" joint="sg_spindle" kv="{SPINDLE_KV}" forcelimited="true" '
            f'forcerange="{-torque:.3f} {torque:.3f}" ctrllimited="true" ctrlrange="0 {top:.4f}"/>\n'
            f'    <motor name="a_sg_chuck_detent" joint="sg_chuck_lever" gear="1" ctrllimited="true" '
            f'ctrlrange="{-detent} {detent}"/>\n')
    stiff = 'solref="0.002 1" solimp="0.999 0.9999 0.001"'
    table = J["table_handwheel"]["travel_mm_per_turn"] * M / (2 * math.pi)
    cross = J["cross_handwheel"]["lead_mm"] * M / (2 * math.pi)
    down = -J["downfeed_handwheel"]["lead_mm"] * M / (2 * math.pi)            # positive turns lower the head
    eq = (f'    <joint name="sg_table_rack" joint1="sg_table" joint2="sg_table_handwheel" '
          f'polycoef="0 {table:.9f} 0 0 0" {stiff}/>\n'
          f'    <joint name="sg_cross_screw" joint1="sg_saddle" joint2="sg_cross_handwheel" '
          f'polycoef="0 {cross:.9f} 0 0 0" {stiff}/>\n'
          f'    <joint name="sg_downfeed_screw" joint1="sg_wheelhead" joint2="sg_downfeed_handwheel" '
          f'polycoef="0 {down:.9f} 0 0 0" {stiff}/>\n')
    return xml, acts, eq


def standalone_xml(loose: str = "", wheel_id: str | None = None) -> str:
    """The station alone, with any loose bodies (parts on its chuck), for its conformance tests: on the body model's
    solver settings (moonshot/body/skeleton.py), as the takes run it."""
    body, acts, eq = worldbody(wheel_id)
    return f"""<mujoco model="sgrind">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" solver="Newton" cone="elliptic" impratio="10" tolerance="1e-10"
          iterations="60" ls_iterations="20" noslip_iterations="10" gravity="0 0 -9.81"/>
  <default>
    <joint limited="true"/>
{SG_DEFAULT}
  </default>
  <worldbody>
{body}{loose}  </worldbody>
  <equality>
{eq}  </equality>
  <actuator>
{acts}  </actuator>
</mujoco>
"""


@dataclass
class Control:
    """The grinder's switchgear, its chuck's magnet and its readings. held maps each body the chuck may hold to its
    material (a key of the record's chuck materials); hold() adds one."""
    model: mujoco.MjModel
    data: mujoco.MjData
    held: dict[str, str] = field(default_factory=dict)
    state: str = "idle"
    stop_in: bool = False
    coolant_on: bool = False
    events: list[str] = field(default_factory=list)
    wrench: dict[str, np.ndarray] = field(default_factory=dict)

    def __post_init__(self):
        r = record()
        m = self.model
        self.C, self.J = r["chuck"], r["joints"]
        self.omega = r["spindle"]["rpm"] * 2 * math.pi / 60
        self.q = {j: m.jnt_qposadr[m.joint(f"sg_{j}").id] for j in JOINT_OF.values()}
        self.v = {j: m.jnt_dofadr[m.joint(f"sg_{j}").id] for j in JOINT_OF.values()}
        self.act = {n: m.actuator(f"a_sg_{n}").id for n in ("spindle", "chuck_detent")}
        self.face = m.geom("sg_chuck_face").id
        self.chuck = m.body("sg_chuck").id
        self._meshes: dict[int, tuple] = {}
        radius_mm = m.geom("sg_wheel").size[0] * 1000                       # the wheel the model mounts, by its size
        self.wheel_id = next(w for w, s in r["wheels"].items() if abs(s["dia_mm"] / 2 - radius_mm) < 0.01)
        for body, material in dict(self.held).items():
            self.hold(body, material)

    def wheel_may_run(self) -> bool:
        """SB1029 safety rule 2: the wheel's rating, confirmed, at least the spindle's speed."""
        w = record()["wheels"][self.wheel_id]
        return bool(w["rating_confirmed"]) and w["rated_rpm"] >= self.omega * 60 / (2 * math.pi)

    # --- the chuck -------------------------------------------------------------------------------------------------
    def hold(self, body: str, material: str) -> None:
        """Let the chuck pull on body, of material: each of its geoms must be a box or a mesh."""
        m = self.model
        if material not in self.C["materials"]:
            raise ValueError(f"no magnetic factor for {material!r}: add it to sgrind.json's chuck materials")
        b = m.body(body).id
        for g in range(m.ngeom):
            if m.geom_bodyid[g] == b and m.geom_type[g] not in (mujoco.mjtGeom.mjGEOM_BOX, mujoco.mjtGeom.mjGEOM_MESH):
                raise ValueError(f"{body}: the chuck's hold needs box or mesh geoms, not {m.geom(g).name}")
        self.held[body] = material

    def field(self) -> float:
        """The share of the chuck's field the lever has on: (1 - cos a) / 2."""
        a = self.data.qpos[self.q["chuck_lever"]]
        return float(np.clip((1.0 - math.cos(a)) / 2.0, 0.0, 1.0))

    def pressure_n_cm2(self, material: str, thickness_mm: float, gap_mm: float = 0.0) -> float:
        """The pull on a part's face, per cm2, at the lever's present field."""
        C = self.C
        return (C["rated_n_cm2"] * self.field() * C["materials"][material]
                * min(1.0, thickness_mm / C["full_hold_thickness_mm"]) / (1.0 + max(gap_mm, 0.0) / C["gap_mm"]) ** 2)

    def _footprint(self, g: int, n: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
        """Geom g's face turned to a chuck whose normal is n (world), as points (world, m) each standing for an area
        (mm2), and its thickness along n (mm): a box's face as its four corners, a quarter of its area each (the same
        force and the same moment against tipping as an even pressure on it); a mesh's faces turned to the chuck within
        14 deg as their centroids, each its own area."""
        m, d = self.model, self.data
        R, p = d.geom_xmat[g].reshape(3, 3), d.geom_xpos[g]
        nl = R.T @ n
        if m.geom_type[g] == mujoco.mjtGeom.mjGEOM_BOX:
            s = m.geom_size[g]
            k = int(np.argmax(np.abs(nl)))
            i, j = (a for a in range(3) if a != k)
            corners = []
            for si, sj in ((1, 1), (1, -1), (-1, -1), (-1, 1)):
                c = np.zeros(3)
                c[k], c[i], c[j] = -math.copysign(s[k], nl[k]), si * s[i], sj * s[j]
                corners.append(p + R @ c)
            area = 4e6 * s[i] * s[j]
            return np.array(corners), np.full(4, area / 4), float(2000 * s[k])
        if g not in self._meshes:
            mid = m.geom_dataid[g]
            v0, nv = m.mesh_vertadr[mid], m.mesh_vertnum[mid]
            f0, nf = m.mesh_faceadr[mid], m.mesh_facenum[mid]
            V = m.mesh_vert[v0:v0 + nv].astype(float)
            F = m.mesh_face[f0:f0 + nf]
            cr = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
            twice = np.linalg.norm(cr, axis=1)
            self._meshes[g] = (V, V[F].mean(axis=1), cr / np.maximum(twice, 1e-15)[:, None], twice / 2 * 1e6)
        V, centroids, normals, areas = self._meshes[g]
        down = normals @ -nl > math.cos(math.radians(14))
        h = V @ nl
        return p + centroids[down] @ R.T, areas[down], float((h.max() - h.min()) * 1000)

    def _magnet(self) -> None:
        """Each held part's pull, from where its face turned to the chuck lies: each of its points over the chuck's
        face and within the magnet's reach of it pulls its share of the face's area at the gap under it. Measured from
        the geometry, not from MuJoCo's contacts, so a part set down near the face is pulled, and a part lifted off
        it is pulled less as it rises, whatever its contact parameters."""
        m, d, C = self.model, self.data, self.C
        out = {b: np.zeros(6) for b in self.held}
        out["sg_chuck"] = np.zeros(6)
        if self.field() > 0.0 and self.held:
            R = d.geom_xmat[self.face].reshape(3, 3)
            n, half = R[:, 2], m.geom_size[self.face]
            top = d.geom_xpos[self.face] + n * half[2]                 # the middle of the face's top
            for name, material in self.held.items():
                b = m.body(name).id
                for g in range(m.ngeom):
                    if m.geom_bodyid[g] != b:
                        continue
                    points, areas, thick = self._footprint(g, n)
                    seated = self.pressure_n_cm2(material, thick)
                    if seated <= 0.0:
                        continue
                    local = (points - top) @ R                         # in the face's frame, z its height above it
                    for pos, a, (x, y, z) in zip(points, areas, local):
                        gap_mm = max(z, 0.0) * 1000
                        if gap_mm > C["reach_mm"] or abs(x) > half[0] or abs(y) > half[1]:
                            continue
                        f = -n * seated * a / 100 / (1.0 + gap_mm / C["gap_mm"]) ** 2
                        out[name][:3] += f
                        out[name][3:] += np.cross(pos - d.xipos[b], f)
                        out["sg_chuck"][:3] -= f
                        out["sg_chuck"][3:] += np.cross(pos - d.xipos[self.chuck], -f)
        for name, w in out.items():
            d.xfrc_applied[m.body(name).id] = w
        self.wrench = out

    # --- the switchgear ----------------------------------------------------------------------------------------------
    def press(self, button: str) -> None:
        if button == "start":
            if self.stop_in or self.state != "idle":
                self.events.append("start_refused")
            elif not self.wheel_may_run():
                self.events.append("start_refused_wheel_rating")
            else:
                self.state = "running"
                self.events.append("start")
        elif button == "stop":
            self.stop_in = True
            if self.state == "running":
                self.state = "idle"
                self.events.append("stop")

    def twist_stop(self) -> None:
        """Twist the OFF button clockwise: it pops out, and ON works again."""
        self.stop_in = False
        self.events.append("stop_reset")

    def turn_coolant(self, on: bool) -> None:
        """SB1029's coolant switch: the pump runs while it is on. The flow is drawn by the render, not simulated."""
        if not record()["coolant"]["fitted"]:
            self.events.append("coolant_not_fitted")
            return
        if on != self.coolant_on:
            self.coolant_on = on
            self.events.append("coolant_on" if on else "coolant_off")

    def apply(self) -> None:
        """The spindle's drive, the lever's detent and the chuck's pull. For a scene that steps the simulation itself
        (a take): call this before each mj_step."""
        m, d = self.model, self.data
        s, kv = self.act["spindle"], SPINDLE_KV if self.state == "running" else 0.0   # stopped: driven by nothing
        m.actuator_gainprm[s, 0], m.actuator_biasprm[s, 2] = kv, -kv
        d.ctrl[s] = self.omega if self.state == "running" else 0.0
        d.ctrl[self.act["chuck_detent"]] = -self.J["chuck_lever"]["detent_n_m"] * math.sin(
            2.0 * d.qpos[self.q["chuck_lever"]])
        self._magnet()

    def step(self) -> None:
        self.apply()
        mujoco.mj_step(self.model, self.data)

    def set_axes(self, table_mm: float | None = None, saddle_mm: float | None = None,
                 head_mm: float | None = None) -> None:
        """Put the table, the saddle or the wheelhead where given (each slide's mm from joint zero) with its handwheel
        turned to match through its ratio, so their equality holds: a slide set alone is snapped back to its
        handwheel by the stiff equality, which throws what is on the chuck."""
        m, d, J = self.model, self.data, self.J
        per_rad = {"table": J["table_handwheel"]["travel_mm_per_turn"] / (2 * math.pi),
                   "saddle": J["cross_handwheel"]["lead_mm"] / (2 * math.pi),
                   "wheelhead": -J["downfeed_handwheel"]["lead_mm"] / (2 * math.pi)}
        wheel = {"table": "table_handwheel", "saddle": "cross_handwheel", "wheelhead": "downfeed_handwheel"}
        for slide, mm in (("table", table_mm), ("saddle", saddle_mm), ("wheelhead", head_mm)):
            if mm is None:
                continue
            d.qpos[self.q[slide]] = mm * M
            d.qpos[self.q[wheel[slide]]] = mm / per_rad[slide]
            d.qvel[self.v[slide]] = d.qvel[self.v[wheel[slide]]] = 0.0
        mujoco.mj_forward(m, d)

    # --- readings ---------------------------------------------------------------------------------------------------
    def spindle_rpm(self) -> float:
        return float(self.data.qvel[self.v["spindle"]] * 60 / (2 * math.pi))

    def wheel_above_chuck_mm(self) -> float:
        """The wheel's lowest point above the chuck's face, along the face's normal."""
        d = self.data
        n = d.geom_xmat[self.face].reshape(3, 3)[:, 2]
        return float((d.site("sg_wheel_bottom_head").xpos - d.site("sg_chuck_centre").xpos) @ n * 1000)

    def downfeed_graduations(self) -> float:
        """The dial's reading against its index, in graduations (0.0002 in each), counting whole turns."""
        d = self.data
        a = d.qpos[self.q["downfeed_handwheel"]] + d.qpos[self.q["downfeed_dial"]]
        return float(a * self.J["downfeed_handwheel"]["graduations"] / (2 * math.pi))

    def cross_graduations(self) -> float:
        return float(self.data.qpos[self.q["cross_handwheel"]] * self.J["cross_handwheel"]["graduations"]
                     / (2 * math.pi))


LINK_DIR = "library/machines/sgrind/links"


def render_links(wheel_id: str | None = None, coolant_flowing: bool = False) -> dict[str, tuple[str, str]]:
    """Each link's GLB (moonshot/library/stations/extract.py) and the body that carries it: the mounted wheel's drawn
    on the spindle, its coolant nozzle on the wheelhead, and, for a take where the coolant runs throughout, its flow
    (coolant_stream_glb, for a take that switches it, to draw as a mesh that changes by frame)."""
    r = record()
    w = wheel_id or r["spindle"]["mounted"]
    out = {k: (f"sg_{k}", f"{LINK_DIR}/{k}.glb") for k in r["links"]}
    out["wheel"] = ("sg_spindle", f"{LINK_DIR}/{wheel(w)['glb']}.glb")
    if r["coolant"]["fitted"]:
        out["coolant_nozzle"] = ("sg_wheelhead", f"{LINK_DIR}/coolant_nozzle_{w}.glb")
        if coolant_flowing:
            out["coolant_stream"] = ("sg_wheelhead", coolant_stream_glb(w))
    return out


def coolant_stream_glb(wheel_id: str | None = None) -> str:
    """The coolant's flow from the nozzle's tip to the wheel's grinding point, for the mounted wheel: drawn, not
    simulated."""
    return f"{LINK_DIR}/coolant_stream_{wheel_id or record()['spindle']['mounted']}.glb"
