"""The Haas ST-25 as a MuJoCo station, with its control logic (plan §3.2): built from moonshot/library/stations/st25.json.

Bodies: the Z saddle carries the X slide on the 55 deg slant, which carries the 12-station turret; the spindle turns
on its axis, carrying the chuck, and the drawtube inside it; the door slides open toward the headstock by hand; the
tool setter's arm swings on its hub; the jog handle turns in its detents; the foot pedal tilts on its heel and springs
back. The axes and the turret are position servos capped at their speeds, gravity-compensated as servos hold an axis;
the spindle is a velocity servo held to Haas's torque; the drawtube is a force, the hydraulic cylinder's pull.

The chucks close on the drawtube as their makers make them, each jaw or collet finger tied to it by an exact ratio (a
joint equality): the Kitagawa BR10's wedge, 4.4 mm of jaw a jaw for its 19 mm plunger; the 5C collet's 10 deg taper,
0.176 mm radially a mm of draw. The friction in the wedge and the taper is the pull's efficiency (the actuator's gear),
so a draw of F grips with each maker's own grip per pull. A part is held only by the contact of the jaws or the
collet's fingers. Colliders are the record's boxes, cylinders and capsules (the CAD's shells aren't closed); render
geometry is the per-link GLBs, drawn by Blender, not by MuJoCo.

`Control` is the machine's NGC control as Haas's lathe manual gives it: the door-open table, the door lock while in
cycle, the chuck's settings, M-codes, the turret's tool calls, the tool setter and the offset keys.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import mujoco
import numpy as np

RECORD = Path(__file__).resolve().parents[1] / "library" / "stations" / "st25.json"
LINKS = RECORD.with_name("st25.links.json")
M = 0.001
INCH = 25.4
AXIS = np.array([0.0, 0.0, 1005.2])           # a point on the spindle's axis (mm), which runs along +X
JAW_ANGLES = (90.0, -30.0, -150.0)           # jaw or finger k's direction about +X, from +Y toward +Z: jaw 0 stands up
STATIONS = 12
STEEL = ' class="st25"'
# the chuck's own stops, hard: the plunger's and the jaws' ends of stroke under tens of kN
STIFF = ' solreflimit="0.002 1" solimplimit="0.999 0.9999 0.0001"'
# a chuck's gripping faces: metal on metal, as stiff as the 1 ms step allows (as the vise's jaws, moonshot/world/vise.py)
GRIP = ' priority="1" friction="0.5 0.004 0.0001" solref="0.002 1" solimp="0.95 0.99 0.0005"'
GRIP_COLLET = ' priority="1" friction="0.4 0.004 0.0001" solref="0.002 1" solimp="0.95 0.99 0.0005"'


def record() -> dict:
    return json.loads(RECORD.read_text(encoding="utf-8"))


def _f(v, s=M) -> str:
    return " ".join(f"{x * s:.5f}" for x in np.asarray(v, float))


def _quat(R: np.ndarray) -> str:
    q = np.zeros(4)
    mujoco.mju_mat2Quat(q, np.asarray(R, float).ravel())
    return " ".join(f"{v:.7f}" for v in q)


def _rx(deg: float) -> np.ndarray:
    a = math.radians(deg)
    return np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])


def _rot(axis, deg: float) -> np.ndarray:
    u = np.asarray(axis, float) / np.linalg.norm(axis)
    a = math.radians(deg)
    K = np.array([[0, -u[2], u[1]], [u[2], 0, -u[0]], [-u[1], u[0], 0]])
    return np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * K @ K


def _box(name, lo, hi, cls=STEEL, extra=""):
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    return (f'<geom name="{name}"{cls} type="box" size="{_f((hi - lo) / 2)}" pos="{_f((lo + hi) / 2)}"{extra}/>')


def _obox(name, centre, half, R, cls=STEEL, extra=""):
    """A box at centre (mm) with half sizes half (mm), turned by R."""
    return (f'<geom name="{name}"{cls} type="box" size="{_f(half)}" pos="{_f(centre)}" quat="{_quat(R)}"{extra}/>')


def _cyl_x(name, x0, x1, r, cls=STEEL, extra=""):
    """A cylinder along +X on the spindle's axis, from x0 to x1 (mm), radius r."""
    return (f'<geom name="{name}"{cls} type="cylinder" size="{r * M:.5f} {(x1 - x0) / 2 * M:.5f}" '
            f'pos="{_f([(x0 + x1) / 2, AXIS[1], AXIS[2]])}" quat="0.7071068 0 0.7071068 0"{extra}/>')


def _cyl_y(name, c_rec, cls=STEEL):
    """A cylinder along Y: the pendant's buttons stand out of its face toward the operator."""
    return (f'<geom name="{name}"{cls} type="cylinder" size="{c_rec["radius_mm"] * M:.5f} {c_rec["half_mm"] * M:.5f}" '
            f'pos="{_f(c_rec["centre_mm"])}" quat="0.7071068 0.7071068 0 0"/>')


def _site(name, at, R=None, size=0.005):
    q = f' quat="{_quat(R)}"' if R is not None else ""
    return f'<site name="{name}" pos="{_f(at)}" size="{size}"{q}/>'


def _ring(name, n, r_in, r_out, x0, x1, cls=STEEL):
    """n boxes round the spindle's axis, their inner faces r_in from it, out to r_out, from x0 to x1 (mm): a hollow
    cylinder a bar can pass through."""
    out, half_w = [], r_in * math.tan(math.pi / n) * 1.02
    for i in range(n):
        R = _rx(360.0 * i / n)
        c = AXIS + R @ np.array([0.0, 0.0, (r_in + r_out) / 2]) + np.array([(x0 + x1) / 2, 0, 0])
        out.append(_obox(f"{name}_{i}", c, [(x1 - x0) / 2, half_w * r_out / r_in, (r_out - r_in) / 2], R, cls))
    return "".join(out)


def radial(deg: float) -> np.ndarray:
    """The outward direction at deg about +X, from +Y toward +Z."""
    a = math.radians(deg)
    return np.array([0.0, math.cos(a), math.sin(a)])


# --- the chucks -----------------------------------------------------------------------------------------------------

def _soft_jaw(k: int, w: dict, bore_mm: float | None, depth_mm: float) -> str:
    """Jaw k's colliders at joint zero (fully open), in a frame turned so its z is outward along the jaw: a block
    behind the step, the bore's arc as facets tangent to it, and the block outside the bore. Unbored, one block."""
    sj, R = w["soft_jaw"], _rx(JAW_ANGLES[k] - 90.0)
    r_in, r_out, front, half_w = sj["inner_r_open_mm"], sj["outer_r_open_mm"], sj["front_x_mm"], sj["width_mm"] / 2
    back = front - sj["length_mm"]

    def blk(name, x0, x1, z0, z1):
        c = AXIS + R @ np.array([0.0, 0.0, (z0 + z1) / 2]) + np.array([(x0 + x1) / 2, 0, 0])
        return _obox(f"st25_jaw_{k}_{name}", c, [(x1 - x0) / 2, half_w, (z1 - z0) / 2], R,
                     extra=GRIP)

    # a site on the jaw's gripping face at its front edge, where a hand sees and reaches the jaw
    face = lambda r: _site(f"st25_jaw_{k}_face", AXIS + radial(JAW_ANGLES[k]) * r + [front - 1.0, 0, 0])  # noqa: E731
    if bore_mm is None:
        return blk("block", back, front, r_in, r_out) + face(r_in)
    r0 = bore_mm / 2 + 2.2                  # the bore, cut at mid-stroke (2.2 mm in), its face at joint zero
    step = front - depth_mm
    out = blk("behind", back, step, r_in, r_out) + blk("outer", step, front, r0 + 4.0, r_out) + face(r0)
    for j, phi in enumerate((-26.0, -13.0, 0.0, 13.0, 26.0)):
        Rf = R @ _rx(phi)
        c = AXIS + Rf @ np.array([0.0, 0.0, r0 + 2.0]) + np.array([(step + front) / 2, 0, 0])
        out += _obox(f"st25_jaw_{k}_bore_{j}", c, [depth_mm / 2, r0 * math.tan(math.radians(6.5)) * 1.05, 2.0], Rf,
                     extra=GRIP)
    return out


def _collet_finger(k: int, c: dict, nose_x: float) -> str:
    """Collet finger k's grip at joint zero (open): facets tangent to the open bore over its third of the circle."""
    r0, half_x = c["bore_open_mm"] / 2, c["grip_length_mm"] / 2
    out = ""
    for j, phi in enumerate((-40.0, -13.3, 13.3, 40.0)):
        Rf = _rx(JAW_ANGLES[k] - 90.0 + phi)
        cc = AXIS + Rf @ np.array([0.0, 0.0, r0 + 1.0]) + np.array([nose_x - half_x, 0, 0])
        out += _obox(f"st25_collet_{k}_{j}", cc, [half_x, r0 * math.tan(math.radians(13.4)) * 1.05, 1.0], Rf,
                     extra=GRIP_COLLET)
    face = AXIS + radial(JAW_ANGLES[k]) * r0 + np.array([nose_x - half_x, 0, 0])
    return out + _site(f"st25_collet_face_{k}", face, size=0.002)


@dataclass
class Chuck:
    """A workholding's MuJoCo pieces: what goes in the spindle's body, its equalities, its jaws' (or fingers') names,
    each jaw's gear (its radial force per newton of draw) and the ratio of a jaw's travel to the drawtube's."""
    inside: str
    eq: str
    jaws: list[str]
    gear: float
    ratio: float


def workholding_xml(key: str, bore_mm: float | None = None, depth_mm: float = 8.0) -> Chuck:
    """The chuck's body, and its jaws or collet fingers as bodies on radial slides. The cylinder's pull reaches each
    jaw through the wedge or the taper: a draw F puts F x grip_per_draw / 3 on each (the maker's ratio, its friction
    in it), applied at the jaws; the jaws move as one (equalities, as the wedge or the collet's one piece makes them).
    What drives them is folded onto them through the exact ratio: the drawtube and piston's mass as each jaw's
    reflected inertia (armature m / 3 r^2), the oil's flow as its damping. The drawtube itself, touching nothing in
    the headstock, is shown following them by that ratio (`Control.apply`)."""
    w = record()["workholding"][key]
    J = record()["joints"]
    rotor = J["spindle"]["rotor_kg_m2"]
    I = w["inertia_kg_m2"] + rotor
    inertial = lambda x, kg: (f'<inertial pos="{_f(AXIS + [x, 0, 0])}" mass="{kg:.3f}" '      # noqa: E731
                              f'diaginertia="{I:.4f} {0.6 * I:.4f} {0.6 * I:.4f}"/>')
    if key == "br10":
        ratio = w["jaw_stroke_dia_mm"] / 2 / w["plunger_stroke_mm"]
        travel = w["jaw_stroke_dia_mm"] / 2
        jaw_kg = w["soft_jaw"]["mass_kg"]
        body = inertial(90.0, w["mass_kg"] - 3 * jaw_kg) + _cyl_x("st25_br10_body", 39.7, 141.2, 127.0)
        com = lambda k: AXIS + [160.0, 0, 0] + radial(JAW_ANGLES[k]) * 70.0                    # noqa: E731
        kg, part, prefix = jaw_kg, (lambda k: _soft_jaw(k, w, bore_mm, depth_mm)), "st25_jaw"
    elif key == "c5":
        c = w["collet"]
        ratio = math.tan(math.radians(c["taper_half_deg"]))
        travel = (c["bore_open_mm"] - c["bore_closed_min_mm"]) / 2
        nose = w["nose_x_mm"]
        body = (inertial(86.4, w["mass_kg"]) + _cyl_x("st25_c5_flange", 39.7, 60.0, 94.65)
                + _ring("st25_c5_body", 12, 18.5, 47.0, 60.0, nose - 26.6)
                + _ring("st25_c5_nose", 12, 18.5, 33.4, nose - 26.6, nose))
        com = lambda k: AXIS + [nose - 12.5, 0, 0] + radial(JAW_ANGLES[k]) * 12.0              # noqa: E731
        kg, part, prefix = c["mass_kg"] / 3, (lambda k: _collet_finger(k, c, nose)), "st25_collet"
    else:
        raise ValueError(f"no workholding {key!r} on the ST-25")
    damping = J["drawtube"]["damping_n_s_m"] / (3 * ratio ** 2)
    armature = record()["links"]["drawtube"]["mass_kg"] / (3 * ratio ** 2)
    names = [f"{prefix}_{k}" for k in range(3)]
    moving = "".join(f'<body name="{n}"><joint name="{n}" type="slide" axis="{_f(-radial(JAW_ANGLES[k]), 1)}" '
                     f'range="0 {travel * M:.6f}" damping="{damping:.0f}" armature="{armature:.3f}"{STIFF}/>'
                     f'<inertial pos="{_f(com(k))}" mass="{kg:.4f}" diaginertia="1e-4 1e-4 1e-4"/>{part(k)}</body>'
                     for k, n in enumerate(names))
    tie = 'solref="0.002 1" solimp="0.99 0.999 0.0001"'
    eq = "".join(f'    <joint name="eq_{n}" joint1="{n}" joint2="{names[0]}" polycoef="0 1 0 0 0" {tie}/>\n'
                 for n in names[1:])
    return Chuck(body + moving, eq, names, w["grip_per_draw"] / 3, ratio)


# --- the station ------------------------------------------------------------------------------------------------------

def probe_extended_deg() -> float:
    return record()["joints"]["probe_arm"]["range_deg"][1]


def station_frames() -> list[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Each turret station's mounting frame at joint zero, (point on the turret's face on the ID tool's axis, its
    OD tool tip's reference point, R): R's x points out from the turret's centre along the station, its z toward the
    chuck (-X), as an ID tool points; station 1 faces the spindle."""
    r = record()
    T, J = r["turret"], r["joints"]
    c = np.array(J["turret"]["centre_mm"], float)
    u = np.array(J["x"]["axis"], float)
    out = []
    for k in range(1, STATIONS + 1):
        d = _rot([1, 0, 0], -(k - 1) * 360.0 / T["stations"]) @ -u
        mount = np.r_[T["front_face_x_mm"], c[1:] + d[1:] * T["id_axis_radius_mm"]]
        tip = np.r_[T["front_face_x_mm"] - T["od_tip_ahead_mm"], c[1:] + d[1:] * T["od_tip_radius_mm"]]
        z = np.array([-1.0, 0, 0])
        R = np.column_stack([d, np.cross(z, d), z])
        out.append((mount, tip, R))
    return out


def worldbody(workholding: str = "br10", bore_mm: float | None = None, depth_mm: float = 8.0,
              in_spindle: str = "") -> tuple[str, str, str]:
    """(worldbody XML, equality XML, actuator XML), the station's root body named st25. Each moving body's origin is
    the world origin at joint zero, so the record's world coordinates are used directly; in_spindle is XML for what
    turns with the spindle (a fixture)."""
    r = record()
    J, C, A, L = r["joints"], r["colliders"], r["affordances"], r["links"]
    u = np.array(J["x"]["axis"], float)
    rng = lambda j: f'{J[j]["range_mm"][0] * M:.5f} {J[j]["range_mm"][1] * M:.5f}'      # noqa: E731
    out = '  <body name="st25">\n'
    # the base: the work area's walls and floor, the door's sill, the enclosure right of the opening, the pendant
    for g in ("headstock_wall", "trough_floor", "door_sill", "front_right"):
        out += "    " + _box(f"st25_{g}", C[g]["box_min_mm"], C[g]["box_max_mm"]) + "\n"
    for g in ("trough_front", "trough_back"):
        (y0, z0), (y1, z1) = C[g]["plane_from_mm"], C[g]["plane_to_mm"]
        x0, x1 = C[g]["x_mm"]
        ln, ang = math.hypot(y1 - y0, z1 - z0), math.degrees(math.atan2(z1 - z0, y1 - y0))
        c = np.array([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]) + _rx(ang) @ [0, 0, -C[g]["thick_mm"] / 2]
        out += "    " + _obox(f"st25_{g}", c, [(x1 - x0) / 2, ln / 2, C[g]["thick_mm"] / 2], _rx(ang)) + "\n"
    out += "    " + _box("st25_pendant_face", C["pendant_face"]["box_min_mm"], C["pendant_face"]["box_max_mm"]) + "\n"
    for g in ("estop", "cycle_start_button", "feed_hold_button"):
        out += "    " + _cyl_y(f"st25_{g}", C[g]["cylinder"]) + "\n"
    for b in ("cycle_start", "feed_hold"):
        out += "    " + _site(f"st25_{b}", A[b]["at_mm"]) + "\n"
    k = A["keys"]
    for name, (x, z) in k["at_mm"].items():
        out += "    " + _site(f"st25_key_{name}", (x, k["face_y_mm"], z), size=0.003) + "\n"
    out += "    " + _site("st25_spindle_axis", [J["spindle"]["centre_mm"][0], AXIS[1], AXIS[2]]) + "\n"
    out += _jog(A["jog_handle"]) + _pedal(A["pedal"])
    # the door
    d = J["door"]
    out += f"""    <body name="st25_door">
      <joint name="st25_door" type="slide" axis="{_f(d['axis'], 1)}" range="{rng('door')}" frictionloss="{d['friction_n']}" damping="30"/>
      <inertial pos="0.37 -0.25 1.3" mass="{L['door']['mass_kg']}" diaginertia="5 5 3"/>
      {_box("st25_door_panel", C["door_panel"]["box_min_mm"], C["door_panel"]["box_max_mm"])}
      {_box("st25_door_roof", C["door_roof"]["box_min_mm"], C["door_roof"]["box_max_mm"])}
      {_pull(C["door_pull"])}
      {_site("st25_door_handle", A["door_handle"]["at_mm"])}
    </body>
"""
    # Z, X and the turret
    T = r["turret"]
    tc = np.array(J["turret"]["centre_mm"], float)
    stations = ""
    for n, (mount, tip, R) in enumerate(station_frames(), 1):
        stations += f'        {_site(f"st25_station_{n}", mount, R)}\n        {_site(f"st25_station_{n}_od", tip, R, 0.003)}\n'
    out += f"""    <body name="st25_zslide" gravcomp="1">
      <joint name="st25_z" type="slide" axis="{_f(J['z']['axis'], 1)}" range="{rng('z')}" damping="20000"/>
      <inertial pos="1.2 0.6 1.0" mass="{L['zslide']['mass_kg']}" diaginertia="60 60 60"/>
      <body name="st25_xslide" gravcomp="1">
        <joint name="st25_x" type="slide" axis="{_f(u, 1)}" range="{rng('x')}" damping="20000"/>
        <inertial pos="1.14 0.34 1.39" mass="{L['xslide']['mass_kg']}" diaginertia="25 25 25"/>
        <body name="st25_turret" gravcomp="1">
          <joint name="st25_turret" type="hinge" axis="1 0 0" pos="{_f(tc)}" limited="false" damping="50"/>
          <inertial pos="{_f(tc + [54.5, 0, 0])}" mass="{L['turret']['mass_kg']}" diaginertia="2.5 1.3 1.3"/>
          <geom name="st25_turret_disc"{STEEL} type="cylinder" size="{229.5 * M:.4f} {54.5 * M:.4f}" pos="{_f(tc + [54.5, 0, 0])}" quat="0.7071068 0 0.7071068 0"/>
          {_site("st25_turret_centre", np.r_[T["front_face_x_mm"], tc[1:]])}
{stations}        </body>
      </body>
    </body>
"""
    # the spindle, its drawtube and the chuck
    ch = workholding_xml(workholding, bore_mm, depth_mm)
    sc = J["spindle"]["centre_mm"]
    out += f"""    <body name="st25_spindle">
      <joint name="st25_spindle" type="hinge" axis="1 0 0" pos="{_f(sc)}" limited="false" damping="0.05"/>
      {_cyl_x("st25_spindle_nose", -2.3, 29.4, 137.5)}
      <body name="st25_drawtube">
        <joint name="st25_drawtube" type="slide" axis="{_f(J['drawtube']['axis'], 1)}" limited="false"/>
        <inertial pos="{_f(AXIS + [-233.8, 0, 0])}" mass="0.01" diaginertia="1e-5 1e-5 1e-5"/>
      </body>
      {ch.inside}
{in_spindle}    </body>
"""
    eq = ch.eq
    # the tool setter's arm
    p = J["probe_arm"]
    sty = np.array(C["stylus"]["box_min_mm"]) / 2 + np.array(C["stylus"]["box_max_mm"]) / 2
    caps = "".join(f'<geom name="st25_probe_arm_{i}"{STEEL} type="capsule" size="{C["probe_arm"]["radius_mm"] * M:.4f}" '
                   f'fromto="{_f(a)} {_f(b)}"/>' for i, (a, b) in enumerate(C["probe_arm"]["capsules_mm"]))
    out += f"""    <body name="st25_probe_arm" gravcomp="1">
      <joint name="st25_probe_arm" type="hinge" axis="{_f(p['axis'], 1)}" pos="{_f(p['pivot_mm'])}" range="{math.radians(p['range_deg'][0]):.5f} {math.radians(p['range_deg'][1]):.5f}" damping="5"/>
      <inertial pos="{_f(sty)}" mass="{L['probe_arm']['mass_kg']}" diaginertia="0.02 0.02 0.02"/>
      {caps}
      {_box("st25_stylus", C["stylus"]["box_min_mm"], C["stylus"]["box_max_mm"])}
      {_site("st25_probe_tip", sty)}
    </body>
  </body>
"""
    acts = "".join(f'    <position name="a_st25_{a}" joint="st25_{a}" kp="2e7" dampratio="1" ctrllimited="true" '
                   f'ctrlrange="{rng(a)}"/>\n' for a in ("z", "x"))
    acts += ('    <position name="a_st25_turret" joint="st25_turret" kp="20000" dampratio="1" forcelimited="true" '
             'forcerange="-3000 3000"/>\n')
    sp = J["spindle"]
    w = sp["max_rpm"] * 2 * math.pi / 60
    acts += (f'    <velocity name="a_st25_spindle" joint="st25_spindle" kv="60" ctrllimited="true" '
             f'ctrlrange="{-w:.2f} {w:.2f}" forcelimited="true" forcerange="{-sp["torque_nm"]} {sp["torque_nm"]}"/>\n')
    mx = r["workholding"][workholding]["max_draw_n"]
    acts += "".join(f'    <motor name="a_{n}" joint="{n}" gear="{ch.gear:.5f}" ctrllimited="true" '
                    f'ctrlrange="{-mx} {mx}"/>\n' for n in ch.jaws)       # ctrl: the cylinder's draw (N)
    acts += (f'    <position name="a_st25_probe_arm" joint="st25_probe_arm" kp="200" dampratio="1" ctrllimited="true" '
             f'ctrlrange="{math.radians(p["range_deg"][0]):.5f} {math.radians(p["range_deg"][1]):.5f}" '
             f'forcelimited="true" forcerange="-60 60"/>\n')
    det = A["jog_handle"]["detent_torque_nm"]
    acts += f'    <motor name="a_st25_jog_detent" joint="st25_jog" ctrllimited="true" ctrlrange="{-det} {det}"/>\n'
    lock = '    <joint name="st25_door_lock" joint1="st25_door" polycoef="0 0 0 0 0" active="false" solref="0.005 1"/>\n'
    return out, eq + lock, acts


def _pull(c_rec) -> str:
    lo, hi = np.array(c_rec["box_min_mm"], float), np.array(c_rec["box_max_mm"], float)
    c, h = (lo + hi) / 2, (hi - lo) / 2
    return (f'<geom name="st25_door_pull"{STEEL} type="cylinder" size="{c_rec["radius_mm"] * M:.5f} {h[2] * M:.5f}" '
            f'pos="{_f(c)}"/>')


def _jog(h: dict) -> str:
    """The jog handle: a dial on a hinge into the pendant, held in its detents by a motor the control drives, its
    spinner knob on it; a site on the rim where a fingertip turns it."""
    half = h["depth_mm"] / 2
    c = np.array(h["at_mm"], float) + np.array(h["axis"], float) * half
    k = np.array(h["knob_mm"], float) - c
    return f"""    <body name="st25_jog_handle" pos="{_f(c)}">
      <joint name="st25_jog" type="hinge" axis="{_f(h['axis'], 1)}" limited="false" damping="{h['damping_nms']}"/>
      <geom name="st25_jog_handle"{STEEL} type="cylinder" size="{h['radius_mm'] * M:.5f} {half * M:.5f}" quat="0.7071068 0.7071068 0 0" mass="{h['mass_kg']}" friction="{h['friction']} 0.004 0.0001" rgba="0.1 0.1 0.1 1"/>
      <geom name="st25_jog_knob"{STEEL} type="cylinder" size="{h['knob_r_mm'] * M:.5f} {h['knob_half_mm'] * M:.5f}" pos="{_f(k)}" quat="0.7071068 0.7071068 0 0" mass="0.005" rgba="0.1 0.1 0.1 1"/>
      <site name="st25_jog_rim" pos="0 {-half * M:.5f} {(h['radius_mm'] - 3) * M:.5f}" size="0.002"/>
    </body>
"""


def _pedal(p: dict) -> str:
    """The foot pedal: its housing on the floor and its pad hinged at the heel, raised toward the toe, sprung up
    against its stop; pressing the toe turns it negative."""
    h = np.array(p["hinge_mm"], float)
    rest = math.radians(p["rest_deg"])
    pad_c = np.array([0.0, p["pad_len_mm"] / 2 * math.cos(rest), p["pad_len_mm"] / 2 * math.sin(rest) + 5.0])
    pref = p["preload_nm"] / p["stiffness_nm_rad"]
    return f"""    {_box("st25_pedal_housing", p["housing_min_mm"], np.array(p["housing_max_mm"]) - [0, 0, 10.0])}
    <body name="st25_pedal" pos="{_f(h)}">
      <joint name="st25_pedal" type="hinge" axis="{_f(p['axis'], 1)}" range="{-math.radians(p['travel_deg']):.5f} 0" stiffness="{p['stiffness_nm_rad']}" springref="{pref:.5f}" damping="0.2"/>
      <geom name="st25_pedal_pad"{STEEL} type="box" size="{p['pad_width_mm'] / 2 * M:.5f} {p['pad_len_mm'] / 2 * M:.5f} 0.005" pos="{_f(pad_c)}" quat="{_quat(_rx(p['rest_deg']))}" mass="{p['kg']}" friction="0.8 0.004 0.0001"/>
      <site name="st25_pedal_pad" pos="{_f(pad_c + [0, 0, 5.0])}" size="0.004"/>
    </body>
"""


DEFAULT = ('    <default class="st25"><geom contype="1" conaffinity="3" friction="0.3 0.004 0.0001" '
           'rgba="0.55 0.57 0.6 1"/></default>\n')


def test_bar_xml(workholding: str, dia_mm: float) -> str:
    """A free round bar in the open chuck, for the conformance gate: in the BR10's bored jaws against their step, 12 mm
    long, so it rests in their 8 mm bore unheld (its middle inside it); in the collet, a 3 in length 20 mm out of its
    nose."""
    r = record()["workholding"]
    if workholding == "br10":
        front = r["br10"]["soft_jaw"]["front_x_mm"]
        x0, x1 = front - 8.0 + 0.2, front - 8.0 + 12.2
        sag = 2.2 * 0.5
    else:
        nose = r["c5"]["nose_x_mm"]
        x0, x1 = nose + 20.0 - 76.2, nose + 20.0
        sag = (r["c5"]["collet"]["bore_open_mm"] - dia_mm) / 2 * 0.5
    L = x1 - x0
    kg = math.pi * (dia_mm / 2000) ** 2 * (L / 1000) * 7800
    return f"""    <body name="test_bar" pos="{_f([(x0 + x1) / 2, 0, AXIS[2] - sag])}">
      <freejoint name="test_bar"/>
      <geom name="test_bar" type="cylinder" size="{dia_mm / 2 * M:.5f} {L / 2 * M:.5f}" quat="0.7071068 0 0.7071068 0" mass="{kg:.4f}" contype="1" conaffinity="3" friction="0.4 0.004 0.0001" condim="4"/>
    </body>
"""


def standalone_xml(workholding: str = "br10", bore_mm: float | None = None, depth_mm: float = 8.0,
                   test_bar_mm: float | None = None) -> str:
    """The station alone, for its conformance tests: the floor, the machine and, if asked, a free bar in its chuck."""
    if workholding == "br10" and test_bar_mm and bore_mm is None:
        bore_mm = test_bar_mm
    body, eq, acts = worldbody(workholding, bore_mm, depth_mm)
    bar = test_bar_xml(workholding, test_bar_mm) if test_bar_mm else ""
    return f"""<mujoco model="st25">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" gravity="0 0 -9.81" noslip_iterations="10"/>
  <default>
    <joint limited="true"/>
{DEFAULT}  </default>
  <worldbody>
    <geom name="floor" type="plane" size="4 4 0.1" contype="1" conaffinity="3" rgba="0.25 0.25 0.25 1"/>
{body}{bar}  </worldbody>
  <contact>
{EXCLUDE}  </contact>
  <equality>
{eq}  </equality>
  <actuator>
{acts}  </actuator>
</mujoco>
"""


# The base is a static body, so MuJoCo doesn't filter its contacts with the bodies hung from it: the parts that
# move against it on their own joints (the spindle's nose through the headstock wall, the door on its track, the jog
# handle in its bezel, the pedal in its housing, the arm on its hub) are kept from it here
EXCLUDE = "".join(f'    <exclude body1="st25" body2="st25_{b}"/>\n'
                  for b in ("spindle", "door", "zslide", "probe_arm", "jog_handle", "pedal"))


def render_links(workholding: str = "br10") -> dict[str, tuple[str, str]]:
    """Each link's GLB (moonshot/library/stations/extract.py) and the body that carries it; the chuck's from its
    maker's STEP. The collet (no maker's CAD) is drawn from its colliders."""
    body = {"base": "st25", "pendant": "st25", "zcover_left": "st25", "zcover_right": "st25", "door": "st25_door",
            "zslide": "st25_zslide", "xslide": "st25_xslide", "turret": "st25_turret", "spindle": "st25_spindle",
            "drawtube": "st25_drawtube", "probe_arm": "st25_probe_arm", f"{workholding}/body": "st25_spindle"}
    if workholding == "br10":
        body |= {f"br10/jaw_{k}": f"st25_jaw_{k}" for k in range(3)}
    return {k: (b, f"library/machines/st25/links/{k}.glb") for k, b in body.items()}


# --- the control ------------------------------------------------------------------------------------------------------

@dataclass
class Control:
    """The ST-25's NGC control: its state, the program it runs, the chuck, the turret, the tool setter and the
    interlocks. Program moves are (x, z mm, rpm[, feed mm/min]) in the axes' own travel: 0 at home, negative toward
    the spindle's axis (X) and the chuck (Z)."""
    model: mujoco.MjModel
    data: mujoco.MjData
    program: list[tuple] = field(default_factory=list)
    setup_mode: bool = False
    clamp_n: float | None = None                       # the chuck's draw (N): its pressure for the job
    state: str = "idle"
    step_index: int = 0
    events: list[str] = field(default_factory=list)
    probe_touch: Callable[[], bool] | None = None       # the tool setter's stylus deflected, now

    def __post_init__(self):
        r = record()
        self.rec = r
        lg = r["logic"]
        self.closed_mm = lg["door_closed_mm"]
        self.unclamp_rpm = lg["unclamp_max_rpm"]
        self.clamp_n = self.clamp_n if self.clamp_n is not None else lg["clamp_default_n"]
        self.jog_ipm = lg["jog_speeds_ipm"]
        self.rapid = r["joints"]["x"]["speed_mm_s"]
        self.turret_deg_s = r["joints"]["turret"]["speed_deg_s"]
        self.max_rpm = r["joints"]["spindle"]["max_rpm"]
        pa = r["joints"]["probe_arm"]
        self.arm_out = math.radians(pa["range_deg"][1])
        self.arm_rate = self.arm_out / pa["time_s"]
        A = r["affordances"]
        self.actuation = A["keys"]["actuation_n"]
        self.detents, self.detent_nm = A["jog_handle"]["detents_per_turn"], A["jog_handle"]["detent_torque_nm"]
        self.pedal_switch = -math.radians(A["pedal"]["switch_deg"])
        m = self.model
        self.q = {n: m.jnt_qposadr[m.joint(f"st25_{n}").id]
                  for n in ("x", "z", "door", "jog", "turret", "spindle", "drawtube", "probe_arm", "pedal")}
        self.dof = {n: m.jnt_dofadr[m.joint(f"st25_{n}").id] for n in ("spindle", "turret", "x", "z")}
        self.act = {n: m.actuator(f"a_st25_{n}").id
                    for n in ("x", "z", "turret", "spindle", "probe_arm", "jog_detent")}
        # the chuck's jaws or the collet's fingers, each pulled through the wedge or taper by the drawtube's draw
        self.jaw_acts = [a for a in range(m.nu) if m.actuator(a).name.startswith(("a_st25_jaw_", "a_st25_collet_"))]
        self.workholding = "br10" if m.actuator(self.jaw_acts[0]).name.startswith("a_st25_jaw_") else "c5"
        self.jaw0 = m.jnt_qposadr[m.actuator_trnid[self.jaw_acts[0], 0]]
        self.chuck_ratio = workholding_xml(self.workholding).ratio
        self.lock = m.equality("st25_door_lock").id
        self.setpoint = np.array([self.data.qpos[self.q[a]] for a in ("x", "z")])
        self.max_draw = m.actuator_ctrlrange[self.jaw_acts[0]][1]
        # the pendant: its mode, the handle's axis and increment, the page shown, what has been typed
        self.mode, self.jog_axis, self.increment_mm = "", "x", 0.001 * INCH
        self.page, self.typed, self.mdi_line = "", "", ""
        self.work = {"G54": {"x": 0.0, "z": 0.0}}
        self.tool_offset: dict[int, dict] = {}
        self._await_dia = False
        self.chuck = "unclamped"
        self.station, self._turret_goal = 1, 0.0
        self.probe_arm, self._arm_goal = "retracted", 0.0
        self.spindle_rpm = 0.0
        self.pressed: list[tuple[float, str]] = []
        self._force: dict[str, float] = {}
        self._down: set[str] = set()
        self._pedal_down = False
        self._jog_clicks = self.clicks()
        self._jog_goal = self.setpoint.copy()
        self._touching = False
        self._jog_stopped = False

    # --- what the control reads -----------------------------------------------------------------------------------
    def doors_closed(self) -> bool:
        return abs(self.data.qpos[self.q["door"]]) * 1000 < self.closed_mm

    def spindle_w(self) -> float:
        return float(self.data.qvel[self.dof["spindle"]])

    def axes_moving(self) -> bool:
        return bool(np.any(np.abs(self.data.qvel[[self.dof["x"], self.dof["z"]]]) > 1e-3))

    def door_locked(self) -> bool:
        """Locked while a program runs, the spindle turns or an axis moves (manual 3.5), and only once shut."""
        return self.doors_closed() and (self.state == "running" or abs(self.spindle_w()) > 0.5
                                        or self.spindle_rpm > 0 or self.axes_moving())

    def machine_mm(self) -> np.ndarray:
        """Machine X and Z (mm) as Haas counts them: 0 at home, negative toward the spindle's axis and the chuck; X in
        diameters."""
        d = self.data
        return np.array([2 * d.qpos[self.q["x"]], d.qpos[self.q["z"]]]) / M

    def clicks(self) -> int:
        return round(self.data.qpos[self.q["jog"]] * self.detents / (2 * math.pi))

    def touch(self, forces: dict[str, float]) -> None:
        """How hard a hand pushes on each key or button now (N)."""
        self._force = forces

    def _probe_touching(self) -> bool:
        if self.probe_touch is not None:
            return bool(self.probe_touch())
        m, d = self.model, self.data
        sty = m.geom("st25_stylus").id
        arm = m.body("st25_probe_arm").id
        return any(sty in (c.geom1, c.geom2) and m.geom_bodyid[c.geom2 if c.geom1 == sty else c.geom1] != arm
                   for c in d.contact[:d.ncon])

    # --- the operator's inputs ------------------------------------------------------------------------------------
    def press(self, button: str) -> None:
        self.pressed.append((round(float(self.data.time), 4), button))
        if button == "cycle_start":
            self._cycle_start()
        elif button == "feed_hold" and self.state == "running":
            self.state = "feed_hold"
            self.events.append("feed_hold")
        else:
            self._key(button)

    def type_keys(self, text: str) -> None:
        for ch in text:
            self._key({" ": "space", ";": "eob"}.get(ch, ch.lower()))

    def mdi(self, line: str) -> None:
        """Key an MDI line and press Cycle Start: run only as Cycle Start may be."""
        self.press("mdi")
        self.typed = line.upper()
        self.press("enter")
        self.press("cycle_start")

    def press_pedal(self) -> None:
        """The foot on the pedal: one press, one toggle of the chuck (TG0066)."""
        self.pressed.append((round(float(self.data.time), 4), "pedal"))
        self._toggle_chuck()

    def clamp(self) -> None:
        self._chuck_to("clamped")

    def unclamp(self) -> None:
        self._chuck_to("unclamped")

    def spindle(self, rpm: float) -> None:
        """Start (or with 0 stop) the spindle forward, as S.. M03 in MDI would."""
        if rpm <= 0:
            self.spindle_rpm = 0.0
            return
        if not self.doors_closed():
            self.events.append("spindle_refused_door")
        elif self.chuck != "clamped":
            self.events.append("spindle_refused_unclamped")
        else:
            self.spindle_rpm = min(float(rpm), self.max_rpm)

    # --- the logic ------------------------------------------------------------------------------------------------
    def _cycle_start(self) -> None:
        """Refused with the door open (manual 3.5) or the chuck unclamped (Setting 284), but for an MDI line of only
        the chuck's and the tool setter's M-codes, which work the chuck itself [proposed]."""
        aux = self.mode == "mdi" and self.mdi_line and set(self.mdi_line.split()) <= {"M10", "M11", "M104", "M105"}
        ok = self.doors_closed() and (self.chuck == "clamped" or aux)
        if not ok:
            self.events.append("cycle_start_refused")
        elif self.mode == "mdi" and self.mdi_line:
            line, self.mdi_line = self.mdi_line, ""
            self._run_mdi(line)
        elif self.state in ("idle", "feed_hold") and self.program and self.step_index < len(self.program):
            self.state = "running"
            self.events.append("cycle_start")
        else:
            self.events.append("cycle_start_refused")

    def _run_mdi(self, line: str) -> None:
        words = line.split()
        self.events.append(f"mdi {line}")
        if "M10" in words:
            self._chuck_to("clamped")
        if "M11" in words:
            self._chuck_to("unclamped")
        if "M104" in words:
            self._arm("extended")
        if "M105" in words:
            self._arm("retracted")
        t = next((w for w in words if re.fullmatch(r"T\d+", w)), None)
        if t is not None:
            self._index(int(t[1:]) // 100 if int(t[1:]) >= 100 else int(t[1:]))
        try:
            s = next((float(w[1:]) for w in words if w.startswith("S")), None)
        except ValueError:
            self.events.append(f"mdi_alarm {line}")
            return
        if "M03" in words or "M04" in words:
            self.spindle(s if s is not None else self.spindle_rpm)
        if "M05" in words:
            self.spindle_rpm = 0.0

    def _toggle_chuck(self) -> None:
        self._chuck_to("unclamped" if self.chuck == "clamped" else "clamped")

    def _chuck_to(self, want: str) -> None:
        """Clamp or unclamp: allowed with the door open (manual 3.5); not open while the spindle turns faster than
        Setting 283."""
        if want == self.chuck:
            return
        if want == "unclamped" and abs(self.spindle_w()) * 60 / (2 * math.pi) > self.unclamp_rpm + 1.0:
            self.events.append("unclamp_refused")
            return
        self.chuck = want
        self.events.append("chuck_" + want)

    def _arm(self, want: str) -> None:
        if not self.doors_closed():
            self.events.append("probe_arm_refused_door")
            return
        self._arm_goal = self.arm_out if want == "extended" else 0.0
        self.probe_arm = "moving"

    def _index(self, n: int) -> None:
        """Bring station n to the spindle, the shorter way round; refused with the door open (manual 3.5)."""
        if not self.doors_closed():
            self.events.append("turret_refused_door")
            return
        if not 1 <= n <= STATIONS or self.state == "running":
            return
        cur = self.data.qpos[self.q["turret"]]
        goal = math.radians((n - 1) * 360.0 / STATIONS)
        delta = (goal - cur + math.pi) % (2 * math.pi) - math.pi
        self._turret_goal = cur + delta
        self._turret_to = n
        self.events.append(f"turret T{n}")

    def _key(self, k: str) -> None:
        """The pendant's other keys: modes, the handle's increment and axis, the offsets and their measure keys,
        the turret's and the spindle's keys, typing."""
        if k in ("handle_jog", "mdi", "memory", "zero_return"):
            self.mode = k
            self._jog_clicks = self.clicks()
        elif k.startswith("inc_"):
            self.increment_mm = float(k[4:]) * INCH
        elif k in ("+x", "-x", "+z", "-z"):
            self.jog_axis = k[1]
        elif k == "x_z":
            self.jog_axis = "z" if self.jog_axis == "x" else "x"
        elif k == "offset":
            self.page = "tool" if self.page != "tool" else "work"
        elif k == "f4" and self.page in ("tool", "work"):
            self.page = "work" if self.page == "tool" else "tool"
        elif k == "z_face_measure":
            off = self.tool_offset.setdefault(self.station, {"x": None, "z": None})
            if self.page == "work":
                self.work["G54"]["z"] = float(self.machine_mm()[1] - (off["z"] or 0.0))
            else:
                off["z"] = float(self.machine_mm()[1])
        elif k == "x_diameter_measure":
            off = self.tool_offset.setdefault(self.station, {"x": None, "z": None})
            off["x"] = float(self.machine_mm()[0])
            self._await_dia = True
        elif k == "enter":
            if self._await_dia and self.typed:
                try:
                    self.tool_offset[self.station]["x"] -= float(self.typed)
                except ValueError:
                    self.events.append(f"input_alarm {self.typed}")
                self._await_dia = False
            elif self.mode == "mdi":
                self.mdi_line = self.typed
            self.typed = ""
        elif k in ("atc_fwd", "atc_rev", "next_tool"):
            typed = re.fullmatch(r"T(\d+)", self.typed)
            self.typed = ""
            if typed:
                n = int(typed.group(1))
                n = n // 100 if n >= 100 else n
            else:
                n = (self.station % STATIONS) + 1 if k != "atc_rev" else (self.station - 2) % STATIONS + 1
            self._index(n)
        elif k in ("fwd", "rev"):
            try:
                rpm = float(self.typed) if self.typed else self.spindle_rpm or 50.0
            except ValueError:
                rpm = 50.0
            self.typed = ""
            self.spindle(rpm)
        elif k == "stop":
            self.spindle_rpm = 0.0
        elif k == "cancel":
            self.typed = self.typed[:-1]
        elif k == "reset":
            self.state, self.spindle_rpm, self.typed = "idle", 0.0, ""
            self.events.append("reset")
        elif len(k) == 1 or k in ("space", "eob"):
            self.typed += {"space": " ", "eob": ";"}.get(k, k.upper())

    def step(self) -> None:
        self.apply()
        mujoco.mj_step(self.model, self.data)

    def apply(self) -> None:
        """Apply the interlocks, then set every actuator: for a scene that steps the simulation itself (a take), call
        this before each mj_step."""
        m, d, dt = self.model, self.data, self.model.opt.timestep
        down = {k for k, f in self._force.items() if f >= self.actuation or (k in self._down and f >= 0.3 * self.actuation)}
        for k in sorted(down - self._down):
            self.press(k)
        self._down = down
        pedal = d.qpos[self.q["pedal"]] < self.pedal_switch
        if pedal and not self._pedal_down:
            self.pressed.append((round(float(d.time), 4), "pedal"))
            self._toggle_chuck()
        self._pedal_down = pedal
        # the door
        d.eq_active[self.lock] = 1 if self.door_locked() else 0
        if not self.doors_closed():
            self.spindle_rpm = 0.0
            if self.state == "running":                  # only in setup mode can it be open now: door hold
                self.state = "feed_hold"
                self.events.append("door_hold")
        if self.chuck != "clamped":
            self.spindle_rpm = 0.0
        # the chuck: the drawtube's pull, closing; pushed back out with the same pressure, opening
        d.ctrl[self.jaw_acts] = (1.0 if self.chuck == "clamped" else -1.0) * min(self.clamp_n, self.max_draw)
        # the drawtube, inside the headstock, shown where the jaws' travel puts it (its inertia is the jaws' armature)
        d.qpos[self.q["drawtube"]] = d.qpos[self.jaw0] / self.chuck_ratio
        d.qvel[m.jnt_dofadr[m.joint("st25_drawtube").id]] = 0.0
        # the axes
        self._handle(dt)
        rpm = self.spindle_rpm
        if self.state == "running" and self.step_index < len(self.program):
            x, z, prog_rpm, *feed = self.program[self.step_index]
            rpm = min(prog_rpm, self.max_rpm)
            goal = np.array([x, z]) * M
            delta = goal - self.setpoint
            dist = np.linalg.norm(delta)
            stepmax = min(self.rapid, feed[0] / 60 if feed and feed[0] else self.rapid) * M * dt
            self.setpoint = goal if dist <= stepmax else self.setpoint + delta / dist * stepmax
            pos = np.array([d.qpos[self.q[a]] for a in ("x", "z")])
            if dist <= stepmax and np.linalg.norm(goal - pos) < 0.0005:
                self.step_index += 1
                if self.step_index == len(self.program):
                    self.state, rpm = "idle", 0.0
                    self.events.append("program_end")
        elif self.state != "running":
            rpm = self.spindle_rpm
        for i, a in enumerate(("x", "z")):
            d.ctrl[self.act[a]] = self.setpoint[i]
        if not self.doors_closed() or self.chuck != "clamped":
            rpm = 0.0
        d.ctrl[self.act["spindle"]] = rpm * 2 * math.pi / 60
        # the turret
        tq = d.ctrl[self.act["turret"]]
        tstep = math.radians(self.turret_deg_s) * dt
        tq = self._turret_goal if abs(self._turret_goal - tq) <= tstep else tq + math.copysign(tstep, self._turret_goal - tq)
        d.ctrl[self.act["turret"]] = tq
        if hasattr(self, "_turret_to") and abs(d.qpos[self.q["turret"]] - self._turret_goal) < math.radians(0.05):
            self.station = self._turret_to
            del self._turret_to
        # the tool setter's arm
        aq = d.ctrl[self.act["probe_arm"]]
        astep = self.arm_rate * dt
        aq = self._arm_goal if abs(self._arm_goal - aq) <= astep else aq + math.copysign(astep, self._arm_goal - aq)
        d.ctrl[self.act["probe_arm"]] = aq
        if self.probe_arm == "moving" and abs(d.qpos[self.q["probe_arm"]] - self._arm_goal) < math.radians(0.2):
            self.probe_arm = "extended" if self._arm_goal > 0 else "retracted"
            self.events.append("probe_arm_" + self.probe_arm)

    def _handle(self, dt: float) -> None:
        """The jog handle and the held jog keys: in handle jog each click moves the selected axis by the increment, a
        held axis key at the increment's jog speed, no farther than the travel; with the door open only in setup mode
        (manual 3.5). With the tool setter's arm out, a tool touching its stylus stops the axis and writes the
        station's offset."""
        d = self.data
        d.ctrl[self.act["jog_detent"]] = -self.detent_nm * math.sin(self.detents * d.qpos[self.q["jog"]])
        c = self.clicks()
        if self.mode != "handle_jog" or self.state == "running" or (not self.doors_closed() and not self.setup_mode):
            self._jog_clicks, self._jog_goal = c, self.setpoint.copy()
            return
        i = "xz".index(self.jog_axis)
        step = (c - self._jog_clicks) * self.increment_mm * M
        held = [k for k in self._down if k in ("+x", "-x", "+z", "-z")]
        if held:
            i = "xz".index(held[0][1])
            ipm = self.jog_ipm.get(f"inc_{self.increment_mm / INCH:g}", 1.0)
            step += (1 if held[0][0] == "+" else -1) * ipm * INCH / 60 * M * dt
        self._jog_clicks = c
        touching = self.probe_arm == "extended" and self._probe_touching()
        if touching and not self._touching:
            self._record_touch("xz"[i])
            self._jog_goal = self.setpoint.copy()
            self._jog_stopped = True
        self._touching = touching
        if touching and self._jog_stopped:
            return
        self._jog_stopped = False
        lo, hi = self.model.jnt_range[self.model.joint(f"st25_{'xz'[i]}").id]
        self._jog_goal[i] = min(max(self._jog_goal[i] + step, lo), hi)
        delta = self._jog_goal - self.setpoint
        dist, stepmax = np.linalg.norm(delta), self.rapid * M * dt
        self.setpoint = self._jog_goal.copy() if dist <= stepmax else self.setpoint + delta / dist * stepmax

    def _record_touch(self, axis: str) -> None:
        """The probe beeped: the station's X offset is the machine X at the touch less the stylus face's diameter;
        its Z, the machine Z at which the tip would stand on the spindle's nose face."""
        m, d = self.model, self.data
        off = self.tool_offset.setdefault(self.station, {"x": None, "z": None})
        g = m.geom("st25_stylus").id
        half = m.geom_size[g]
        R = d.geom_xmat[g].reshape(3, 3)
        u = np.array(self.rec["joints"]["x"]["axis"], float)
        c = d.geom_xpos[g] / M
        if axis == "x":
            face = np.dot(c - AXIS, u) + float(np.sum(np.abs(R.T @ u) * half)) / M
            off["x"] = float(self.machine_mm()[0] - 2 * face)
        else:
            face_x = c[0] + float(np.sum(np.abs(R.T @ [1.0, 0, 0]) * half)) / M
            off["z"] = float(self.machine_mm()[1] - (face_x - self.rec["joints"]["spindle"]["centre_mm"][0]))
        self.events.append("probe_touch")
