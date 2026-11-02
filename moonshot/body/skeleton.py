"""The body model in MuJoCo: trunk, shoulder girdles, both arms and both hands, every joint a motor (plan §3.1).

Built like a robot arm. Every segment is a rigid body with its real length and mass; every joint is a position
servo whose range, strength and top speed come from measurements of people (moonshot/body/data). Joints that move
together in people are coupled by soft joint equalities, and the joint that follows a coupling has no motor of its
own, so the coupling can't be fought. Nothing is animated: motion is the motors driving this skeleton, and objects
move only through contact and friction.

Angles are anatomical (degrees, 0 = straight, + = flexion/abduction, as trainual's motion/body_model.py and
motion/hand_model.py define them); MuJoCo's qpos is the angle minus the joint's rest angle, in radians. World
axes: +X right, +Y forward, +Z up, metres. The left side is the right side mirrored through the sagittal plane.

    body = build()                         # BodyModel: .xml, .joints, .couplings
    model = mujoco.MjModel.from_xml_string(body.xml)
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parent / "data"
M = 0.001
# Hand axes (long, radial, dorsal) in the forearm frame at the anatomical zero: arm hanging, thumb forward
H0 = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])
MIRROR = np.diag([-1.0, 1.0, 1.0])
SIDES = {"R": np.eye(3), "L": MIRROR}

# Trunk and arm: (name, kind, axis for the right side). Each body's joints compose in the order listed, about
# axes in its own frame, which reproduces trainual's R = Rz(-rot) Ry(lat) Rx(-flex), Rz(plane) Ry(-elev) Rz(rot), ...
PELVIS = [("pelvis_x", (1, 0, 0)), ("pelvis_y", (0, 1, 0)), ("pelvis_z", (0, 0, 1))]   # the legs, not modelled
TRUNK = [("trunk_rot", (0, 0, -1)), ("trunk_lat", (0, 1, 0)), ("trunk_flex", (-1, 0, 0))]
GIRDLE = [("sc_prot", (0, 1, 0)), ("sc_elev", (0, 0, 1))]
SHOULDER = [("sh_plane", (0, 0, 1)), ("sh_elev", (0, -1, 0)), ("sh_rot", (0, 0, 1))]
ELBOW = [("elbow", (1, 0, 0)), ("pron", (0, 0, 1))]
WRIST = [("wr_flex", (0, 1, 0)), ("wr_dev", (1, 0, 0))]
WRIST_FACETS = 32


def _load(name: str) -> dict:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


@dataclass(frozen=True)
class Joint:
    name: str                       # e.g. "trunk_flex", "R_elbow", "L_index_pip"
    base: str                       # the anatomical name, without the side
    kind: str                       # hinge | slide
    lo: float                       # anatomical range: degrees for hinges, mm for slides
    hi: float
    rest: float                     # anatomical value at qpos 0
    speed: float | None             # top speed, deg/s or mm/s; None where no measurement is recorded (fingers)
    strength: tuple[float, float]   # peak effort against / along the positive direction, N m or N
    driven: bool                    # has its own motor; False for joints that follow a coupling


@dataclass(frozen=True)
class Coupling:
    follower: str                   # anatomical follower = k * leader + c
    leader: str
    k: float
    c: float = 0.0


@dataclass
class BodyModel:
    xml: str
    joints: dict[str, Joint] = field(default_factory=dict)
    couplings: list[Coupling] = field(default_factory=list)


def strength_key(base: str) -> str:
    if base.startswith("thumb_"):
        return base
    if base.startswith("cmc"):
        return "cmc"
    for k in ("mcp_flex", "mcp_abd", "pip", "dip"):
        if base.endswith(k):
            return k
    return base


def hand_couplings(spec: dict) -> list[Coupling]:
    """trainual's hand couplings (motion/hand_model.py `couple`), free-motion form: DIP from PIP per finger
    (Roda-Sales 2022), palm cupping CMC4 from ring MCP flexion and CMC5 from CMC4 (El-Shennawy 2001), thumb CMC
    roll into opposition from CMC flexion (Crisco 2015). Soft, so contact can bend them."""
    C = spec["coupling"]
    out = [Coupling(f"{f}_dip", f"{f}_pip", C["dip_per_pip_free"][f]) for f in ("index", "middle", "ring", "little")]
    out += [Coupling("cmc4_flex", "ring_mcp_flex", C["cmc4_per_mcp"]),
            Coupling("cmc5_flex", "cmc4_flex", C["cmc5_per_cmc4"]),
            Coupling("thumb_cmc_roll", "thumb_cmc_flex", C["thumb_roll_per_cmc_flex"])]
    return out


def set_finger_contact(model, body: BodyModel, side: str, finger: str, contact: bool) -> None:
    """Switch a finger's DIP-from-PIP coupling between free motion and contact (Roda-Sales et al. 2022: in contact
    the fingertip joint bends dip = k*pip + c, with different k and c). A gripping finger uses the contact form;
    with the free form its pad lands millimetres off, enough to miss a face and pinch an edge."""
    spec = json.loads((DATA / "anatomy.json").read_text(encoding="utf-8"))["coupling"]
    k, c = spec["dip_per_pip_contact"][finger] if contact else (spec["dip_per_pip_free"][finger], 0.0)
    f, ld = body.joints[f"{side}_{finger}_dip"], body.joints[f"{side}_{finger}_pip"]
    eq = model.equality(f"couple_{side}_{finger}_dip").id
    model.eq_data[eq, 0] = math.radians(k * ld.rest + c - f.rest)
    model.eq_data[eq, 1] = k


def _f(v) -> str:
    return " ".join(f"{float(x):.6g}" for x in v)


def wrist_ellipse_tendons(body: BodyModel, side: str, wd: dict) -> list[str]:
    """The wrist's flexion-deviation ellipse (Gracia-Ibanez 2020) as MuJoCo limits. Each joint's range alone is a
    box, which allows full flexion with full ulnar deviation (1.41 on the ellipse), so the ellipse is circumscribed
    by WRIST_FACETS tangent lines, each a fixed tendon fl/F cos(a) + dv/D sin(a) <= 1 (degrees; F and D the semi-axes
    of its quadrant). The ellipse is convex, so each tangent bounds all of it; between tangent points the polygon
    is at most 1/cos(180/WRIST_FACETS deg) outside it, 0.5% at 32, and it meets the box at the four axes."""
    fl, dv = body.joints[f"{side}_wr_flex"], body.joints[f"{side}_wr_dev"]
    out = []
    for k in range(WRIST_FACETS):
        a = 2 * math.pi * k / WRIST_FACETS
        c, s = math.cos(a), math.sin(a)
        kf = c / (wd["flexion"] if c >= 0 else wd["extension"])
        kd = s / (wd["radial"] if s >= 0 else wd["ulnar"])
        # anatomical degrees = degrees(qpos) + rest
        hi = 1 - kf * fl.rest - kd * dv.rest
        terms = "".join(f'<joint joint="{j.name}" coef="{math.degrees(x):.6f}"/>'
                        for j, x in ((fl, kf), (dv, kd)) if abs(x) > 1e-9)
        out.append(f'    <fixed name="{side}_wrist_ellipse_{k}" range="-100 {hi:.6f}" solreflimit="0.004 1" '
                   f'solimplimit="0.95 0.99 0.001">{terms}</fixed>')
    return out


def build(load_kg: float = 0.0, pelvis_mm: tuple[float, float, float] | None = None) -> BodyModel:
    """The body model. load_kg > 0 puts a mass of that size rigidly in the right palm (a held object, for the
    strength tests). pelvis_mm places the lumbar pivot in the world (default: on the origin, at standing height)."""
    anatomy, segs, strength_data = _load("anatomy.json"), _load("segments.json"), _load("strength.json")
    strength, hand_kp = strength_data["joints"], strength_data["hand_stiffness_nm_per_rad"]
    body_kp = strength_data["body_stiffness"]
    hand = _load("hand_rest.json")
    ranges, speeds = anatomy["body"]["ranges_deg"], anatomy["body"]["speed_max_deg_s"]
    L = segs["length_mm"]
    mass = segs["body_mass_kg"]["value"]
    frac = segs["mass_fraction"]
    body = BodyModel(xml="")
    couplings = hand_couplings(anatomy)
    followers = {c.follower for c in couplings}

    def add_joint(name, base, kind, axis, lo, hi, rest=0.0, speed=None) -> str:
        s = strength[strength_key(base)]["max"]
        body.joints[name] = Joint(name, base, kind, lo, hi, rest, speed, (float(s[0]), float(s[1])),
                                  driven=base not in followers)
        conv = (lambda x: math.radians(x - rest)) if kind == "hinge" else (lambda x: (x - rest) * M)
        heavy = base in speeds or base.startswith("pelvis")         # trunk, girdle, arm, pelvis vs the hand
        extra = ' damping="0.5" armature="0.01"' if heavy else ' damping="0.004" armature="0.00012"'
        return (f'<joint name="{name}" type="{kind}" axis="{_f(axis)}" range="{conv(lo):.6f} {conv(hi):.6f}"'
                f'{extra}/>')

    def arm_joints(side, T, spec):
        sign = np.linalg.det(T)
        return [add_joint(f"{side}_{n}", n, "hinge", sign * (T @ np.array(ax, float)), *ranges[n], speed=speeds[n])
                for n, ax in spec]

    # hand geometry: NIMBLE's rest frame -> the hand segment's frame (right), then mirrored per side
    J = np.array([j["pos_mm"] for j in hand["joints"]])
    attach = H0 @ np.array(hand["wrist_frame"]).T
    parent = [j["parent"] for j in hand["joints"]]
    names = [j["name"] for j in hand["joints"]]
    dofs_at = {}
    for d in hand["dofs"]:
        dofs_at.setdefault(d["joint"], []).append(d)
    hulls = hand["hulls"]
    hand_density = frac["hand"] * mass / sum(h["volume_mm3"] for h in hulls.values())       # kg per mm^3
    meshes = []

    def hand_xml(side, T, indent):
        R = T @ attach
        sign = np.linalg.det(T)
        P = (R @ J.T).T

        def node(j, ind):
            rel = (P[j] - (P[parent[j]] if parent[j] >= 0 else 0)) * M
            out = []
            if j:
                out.append(f'{ind}<body name="{side}_{names[j]}" pos="{_f(rel)}">')
            for d in dofs_at.get(j, []):
                out.append(ind + "  " + add_joint(f"{side}_{d['name']}", d["name"], "hinge", sign * (R @ d["axis"]),
                                                  *d["range_deg"], rest=d["rest_deg"]))
            if names[j] in hulls:
                # the skin's own hull (moonshot/body/derive_hand.py); the carpal's is the palm
                h, mesh = hulls[names[j]], f"{side}_hull_{names[j]}"
                v = (np.array(h["vertices_mm"]) @ R.T - P[j]) * M
                meshes.append(f'    <mesh name="{mesh}" inertia="convex" vertex="{_f(v.ravel())}"/>')
                pad = names[j].startswith("dis")
                fr = ' condim="4" friction="0.6 0.012 0.0001"' if pad else ' condim="3" friction="0.6 0.004 0.0001"'
                gname = "palm" if j == 0 else names[j]
                out.append(f'{ind}  <geom name="{side}_g_{gname}" class="skin" type="mesh" mesh="{mesh}" '
                           f'mass="{hand_density * h["volume_mm3"]:.6f}"{fr}/>')
            if j == 0:
                tip = (P[5] + P[20]) / 2 * M
                if side == "R" and load_kg > 0:
                    out.append(f'{ind}  <body name="load" pos="{_f(tip * 0.8)}"><geom name="load" type="box" '
                               f'size="0.02 0.02 0.02" mass="{load_kg}" contype="0" conaffinity="0"/></body>')
            for c in [k for k in range(25) if parent[k] == j]:
                out += node(c, ind + ("  " if j else ""))
            if j:
                out.append(f"{ind}</body>")
            return out

        return node(0, indent)

    upper, fore = L["upper_arm"] * M, L["forearm"] * M
    arms = []
    for side, T in SIDES.items():
        sh = T @ np.array(L["shoulder_from_lumbar"], float) * M
        x = [f'      <body name="{side}_girdle" pos="{_f(sh)}">']
        x += ["        " + j for j in arms_joints_slide(side, T, add_joint, ranges, speeds)]
        x += [f'        <geom name="{side}_g_girdle" type="sphere" size="0.03" contype="0" conaffinity="0" '
              f'mass="{segs["girdle_kg"]["value"]}"/>',
              f'        <body name="{side}_humerus">']
        x += ["          " + j for j in arm_joints(side, T, SHOULDER)]
        x += [f'          <geom name="{side}_g_upper_arm" class="skin" type="capsule" size="0.045" '
              f'fromto="0 0 -0.03 0 0 {-upper + 0.03:.4f}" mass="{frac["upper_arm"] * mass:.4f}"/>',
              f'          <body name="{side}_forearm" pos="0 0 {-upper:.4f}">']
        x += ["            " + j for j in arm_joints(side, T, ELBOW)]
        x += [f'            <geom name="{side}_g_forearm" class="skin" type="capsule" size="0.035" '
              f'fromto="0 0 -0.02 0 0 {-fore + 0.03:.4f}" mass="{frac["forearm"] * mass:.4f}"/>',
              f'            <body name="{side}_hand" pos="0 0 {-fore:.4f}">']
        x += ["              " + j for j in arm_joints(side, T, WRIST)]
        x += hand_xml(side, T, "              ")
        x += ["            </body>", "          </body>", "        </body>", "      </body>"]
        arms += x

    thorax_kg = segs["thorax_head_fraction"]["value"] * mass
    neck = np.array(L["neck_from_lumbar"], float) * M
    pel = segs["pelvis"]
    pelvis = [add_joint(n, n, "slide", ax, *pel["shift_mm"], speed=pel["speed_mm_s"]) for n, ax in PELVIS]
    trunk = [add_joint(n, n, "hinge", ax, *ranges[n], speed=speeds[n]) for n, ax in TRUNK]
    eq = []
    for side in SIDES:
        for c in couplings:
            f, ld = body.joints[f"{side}_{c.follower}"], body.joints[f"{side}_{c.leader}"]
            # anatomical f = k*l + c  ->  qpos_f = k*qpos_l + (k*rest_l + c - rest_f), in radians
            off = math.radians(c.k * ld.rest + c.c - f.rest)
            eq.append(f'    <joint name="couple_{side}_{c.follower}" joint1="{f.name}" joint2="{ld.name}" '
                      f'polycoef="{off:.6f} {c.k:.6f} 0 0 0" solref="0.02 1" solimp="0.9 0.95 0.001"/>')
    acts = []
    for j in body.joints.values():
        if not j.driven:
            continue
        lo_s, hi_s = j.strength
        key = strength_key(j.base)
        if key in hand_kp:                      # fingers (strength.json hand_stiffness_nm_per_rad)
            kp, ratio = hand_kp[key], 0.7
        else:                                   # trunk, girdle, arm, pelvis (strength.json body_stiffness)
            kp, ratio = body_kp[j.base], 1
        acts.append(f'    <position name="a_{j.name}" joint="{j.name}" kp="{kp:.4f}" '
                    f'dampratio="{ratio}" forcelimited="true" forcerange="{-lo_s} {hi_s}" ctrllimited="false"/>')
        # ctrl is unlimited because it carries the controller's feedforward on top of the target; the controller
        # clamps targets to the joint's range, and forcerange is what caps the motor at the joint's strength
    tendons = [t for side in SIDES for t in wrist_ellipse_tendons(body, side, anatomy["wrist_deg"])]
    body.xml = f"""<mujoco model="moonshot-body">
  <compiler angle="radian" autolimits="true"/>
  <!-- grasping settings from MuJoCo's own guidance, as trainual's accepted take used them: elliptic cones,
       impratio 10, Newton, a tight tolerance, and noslip iterations so a held part doesn't creep out of the grip -->
  <option timestep="0.001" integrator="implicitfast" solver="Newton" cone="elliptic" impratio="10"
          tolerance="1e-10" iterations="60" ls_iterations="20" noslip_iterations="2" gravity="0 0 -9.81">
    <flag multiccd="enable"/>
  </option>
  <asset>
{chr(10).join(meshes)}
  </asset>
  <default>
    <joint limited="true" solreflimit="0.004 1" solimplimit="0.95 0.99 0.001"/>
    <default class="skin">
      <geom contype="2" conaffinity="1" priority="2" solref="0.006 1" solimp="0.9 0.99 0.003 0.5 2" rgba="0.9 0.7 0.6 1"/>
    </default>
  </default>
  <worldbody>
    <body name="pelvis" pos="{_f(np.array(pelvis_mm or (0, 0, segs["length_mm"]["lumbar_height"])) * M)}">
{chr(10).join("      " + p for p in pelvis)}
      <geom name="g_pelvis" class="skin" type="sphere" size="0.12" mass="{pel["mass_kg"]}" contype="0" conaffinity="0"/>
      <body name="thorax">
{chr(10).join("        " + t for t in trunk)}
        <geom name="g_thorax" class="skin" type="capsule" size="0.12" fromto="0 0 0.08 {_f(neck - [0, 0, 0.08])}"
              mass="{thorax_kg - 0.0694 * mass:.4f}"/>
        <geom name="g_head" class="skin" type="sphere" size="0.1" pos="{_f(neck + [0, 0.02, 0.12])}"
              mass="{0.0694 * mass:.4f}"/>
{chr(10).join(arms)}
      </body>
    </body>
  </worldbody>
  <equality>
{chr(10).join(eq)}
  </equality>
  <tendon>
{chr(10).join(tendons)}
  </tendon>
  <actuator>
{chr(10).join(acts)}
  </actuator>
</mujoco>
"""
    body.couplings = couplings
    return body


def arms_joints_slide(side, T, add_joint, ranges, speeds) -> list[str]:
    """The shoulder girdle: the clavicle and scapula carry the shoulder joint forward and up (mm)."""
    return [add_joint(f"{side}_{n}", n, "slide", T @ np.array(ax, float), *ranges[n], speed=speeds[n])
            for n, ax in GIRDLE]
