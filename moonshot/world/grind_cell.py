"""The surface grinder as a cell for a body model's takes (plan §3.2): the station (moonshot/world/sgrind.py), the
part on its chuck and the keepers round it, set into the body model's MJCF the way moonshot/world/saw_cell.py sets in
the band saw.

Coordinates are the station's own (mm; floor at z = 0, the table's middle at x = 0, the wheel's mid-plane at y = 0,
the operator at -Y), and a take places the whole cell in its world (saw_cell.Place): the body model always faces +Y
and doesn't walk, so a take at the grinder's right side, where its down-feed handwheel is, turns the grinder a
quarter turn under it instead. Each take's world is its own; what carries over between takes (the grinder's joints
and switches, the parts on the chuck) is passed in the station's frame (grinder_state, set_grinder).

Where the operator stands (lumbar, the station's mm; proposed, for the planner to refine):
- FRONT: behind the front handwheels, the table's (left) and the cross-feed's (right) under the hands. The saddle's
  arm puts them 550 mm in front of the table, so the chuck isn't in reach from here;
- CHUCK: at the front right corner, right of the saddle's arm (x 350): the chuck's right half (the table traversed
  right brings the rest), the chuck's lever and the control box;
- RIGHT: at the machine's right side facing the column, the down-feed handwheel 1.4 m up under the right hand (the
  table traversed left of x 750 to clear the body). The plan's hand grind splits each pass into a FRONT take, rocking
  the table, and a RIGHT take, the down-feed, joined by declared cuts (your decision, 2026-11-06).

Bodies the chuck may hold are named chucked_<name> (the declared mechanism "force on chucked_*"): the part
(chucked_part) and its keepers (chucked_keeper_<i>), each with its material for the chuck's pull (HELD). The wheel
and the part don't collide: the wheel's way into the part is the grind, the cut simulation's work (as the band saw's
blade and its bar, moonshot/world/saw_cell.py). A body the hand carries is held by the declared shortcut
`carry_<body>`, a stiff weld to the hand, as at the band saw.
"""
from __future__ import annotations

import math

import mujoco
import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.world import sgrind as SG
from moonshot.world.saw_cell import Place

M = 0.001
FLOOR = '    <geom name="floor" type="plane" size="4 4 0.1" contype="1" conaffinity="3" rgba="0.25 0.25 0.25 1"/>\n'
PREFIX = "chucked_"

FRONT = Place()                     # the grinder as it stands, the body at its front
CHUCK = Place()                     # the same turn, the body at the front right corner
RIGHT = Place(yaw_deg=-90.0)        # turned so the station's -X, toward the column from its right side, is the way the
                                    # body faces
FRONT_LUMBAR = np.array([-220.0, -1180.0, 955.0])   # the table handwheel's knob (y -853 to -905) 275-330 mm ahead
CHUCK_LUMBAR = np.array([650.0, -650.0, 955.0])     # right of the saddle's arm (x 350; at 520 the left hip stood on
                                                    # its edge the take through) and of the control box (at 600 the
                                                    # hanging left hand brushed it); the lever's ball 400 mm ahead
RIGHT_LUMBAR = np.array([850.0, 260.0, 955.0])      # the down-feed knob 360-420 mm ahead, 100 mm to the right

PART = {"density": 14900.0, "friction": 0.2, "material": "carbide",          # C2 (WC, 6% Co): 14.9 g/cm3
        "solref": (0.002, 1.0), "solimp": (0.95, 0.99, 0.001), "rgba": (0.5, 0.5, 0.52, 1.0)}
KEEPER = {"density": 7850.0, "friction": 0.2, "material": "steel", "rgba": (0.62, 0.63, 0.66, 1.0), "asset": "keeper",
          # the shop's grinding keepers (keepers-1): 1/8 x 1/2 in ground O-1 flat stock cut 1-1/2 in long, so a pinwheel
          # of three round a 3/8 in IC insert reaches 23 mm behind it and 35 in front (your decision, 2026-11-06: the
          # shop's 6 in parallels reach 256 mm across the table that way, past the 254 mm chuck)
          "size_mm": (38.1, 12.7, 3.175)}


def _f(v, scale=M) -> str:
    return " ".join(f"{float(x) * scale:.6f}" for x in v)


def _quat(R: np.ndarray) -> np.ndarray:
    x, y, z, w = Rotation.from_matrix(R).as_quat()
    return np.array([w, x, y, z])


def chuck_top_mm() -> float:
    return float(SG.record()["chuck"]["face_z_mm"])


# --- what the chuck holds ---------------------------------------------------------------------------------------------

def triangle_insert_mm(ic_mm: float, thick_mm: float, nose_mm: float, clearance_deg: float,
                       arc_points: int = 8) -> np.ndarray:
    """A triangle insert's vertices in its model frame (the inscribed circle's centre on its bottom face, z up, its
    first flank's outward normal +X): its top face's outline, a triangle of inscribed radius ic/2 with its corners
    rounded to the nose radius, and its bottom face's the same pulled in by the clearance angle over the thickness.
    Convex, so MuJoCo's hull of it is the insert."""
    inset = thick_mm * math.tan(math.radians(clearance_deg))
    centre_r = 2 * (ic_mm / 2 - nose_mm)                     # a nose's centre from the middle, at 30 deg to its flanks
    out = []
    for z, r in ((thick_mm, nose_mm), (0.0, nose_mm - inset)):
        for k in range(3):
            phi = math.radians(60 + 120 * k)
            c = centre_r * np.array([math.cos(phi), math.sin(phi)])
            for a in np.linspace(phi - math.pi / 3, phi + math.pi / 3, arc_points):
                p = c + max(r, 0.01) * np.array([math.cos(a), math.sin(a)])
                out.append([p[0], p[1], z])
    return np.array(out)


def part_body(place: Place, vertices_mm: np.ndarray, at_mm, yaw_deg: float = 0.0, name: str = "part",
              density: float | None = None) -> tuple[str, str]:
    """A part as a free mesh body, chucked_<name>, its model frame at at_mm (the station's mm) turned yaw_deg about
    the chuck's normal: (its <mesh> asset, its body)."""
    body = PREFIX + name
    R = place.R @ Rotation.from_euler("z", yaw_deg, degrees=True).as_matrix()
    P = PART
    asset = f'    <mesh name="{body}" vertex="{_f(np.asarray(vertices_mm, float).ravel())}"/>\n'
    xml = (f'    <body name="{body}" pos="{_f(place.world(at_mm))}" quat="{_f(_quat(R), 1)}">\n'
           f'      <freejoint name="{body}"/>\n'
           f'      <geom name="{body}" type="mesh" mesh="{body}" class="grind_part" '
           f'density="{P["density"] if density is None else density}"/>\n'
           f'    </body>\n')
    return asset, xml


def keeper_body(place: Place, i: int, centre_mm, yaw_deg: float, length_mm: float | None = None) -> str:
    """A keeper, chucked_keeper_<i>: a parallel laid flat, its middle at centre_mm on the chuck (the station's mm, its
    underside's height), its length along yaw_deg from +X."""
    body = f"{PREFIX}keeper_{i}"
    size = np.array(KEEPER["size_mm"], float)
    if length_mm is not None:
        size[0] = length_mm
    half = size / 2
    c = np.asarray(centre_mm, float) + np.array([0.0, 0.0, half[2]])
    R = place.R @ Rotation.from_euler("z", yaw_deg, degrees=True).as_matrix()
    return (f'    <body name="{body}" pos="{_f(place.world(c))}" quat="{_f(_quat(R), 1)}">\n'
            f'      <freejoint name="{body}"/>\n'
            f'      <geom name="{body}" type="box" size="{_f(half)}" class="grind_keeper" '
            f'density="{KEEPER["density"]}"/>\n'
            f'    </body>\n')


def pinwheel(centre_mm, first_flank_deg: float, ic_mm: float, gap_mm: float = 0.05,
             length_mm: float | None = None) -> list[tuple[np.ndarray, float]]:
    """Keepers set tight round a triangle insert lying at centre_mm (its inscribed circle's middle, on the chuck),
    its first flank's outward normal at first_flank_deg from +X: one along each flank, each from the flank's one
    corner out past the next, so the three never cross (each runs past its next corner outside the next flank's
    keeper, which starts at that corner). (centre on the chuck, yaw) for keeper_body; gap_mm from each flank."""
    L, w = length_mm or KEEPER["size_mm"][0], KEEPER["size_mm"][1]
    r = ic_mm / 2
    side = 2 * r * math.sqrt(3)                               # a sharp-cornered triangle's side, from its inscribed radius
    out = []
    for k in range(3):
        n = math.radians(first_flank_deg + 120 * k)           # the flank's outward normal
        nv, uv = np.array([math.cos(n), math.sin(n)]), np.array([-math.sin(n), math.cos(n)])   # u: counterclockwise
        start = nv * r - uv * side / 2                         # the flank's corner it starts from
        mid = start + uv * L / 2 + nv * (gap_mm + w / 2)
        c = np.asarray(centre_mm, float) + np.array([mid[0], mid[1], 0.0])
        out.append((c, math.degrees(math.atan2(uv[1], uv[0]))))
    return out


def held(loose: str) -> dict[str, str]:
    """The bodies in loose the chuck holds, each with its material."""
    out = {}
    for chunk in loose.split('<body name="')[1:]:
        name = chunk.split('"', 1)[0]
        if name.startswith(PREFIX):
            out[name] = KEEPER["material"] if name.startswith(PREFIX + "keeper") else PART["material"]
    return out


# --- the cell --------------------------------------------------------------------------------------------------------

def defaults() -> str:
    P, K = PART, KEEPER
    return SG.SG_DEFAULT + f"""
    <default class="grind_part">
      <geom contype="1" conaffinity="3" priority="1" friction="{P['friction']} 0.004 0.0001" solref="{_f(P['solref'], 1)}"
            solimp="{_f(P['solimp'], 1)}" rgba="{_f(P['rgba'], 1)}"/>
    </default>
    <default class="grind_keeper">
      <geom contype="1" conaffinity="3" priority="1" friction="{K['friction']} 0.004 0.0001" solref="0.002 1"
            solimp="0.95 0.99 0.001" rgba="{_f(K['rgba'], 1)}"/>
    </default>"""


def _grinder(place: Place, wheel_id: str | None) -> tuple[str, str, str]:
    body, acts, eq = SG.worldbody(wheel_id)
    body = f'    <body name="sgrind" pos="{_f(place.at_mm)}" quat="{_f(place.quat(), 1)}">\n{body}    </body>\n'
    return body, acts, eq


def _contacts(loose: str) -> str:
    """The wheel never meets the part (above)."""
    rows = [f'    <exclude body1="sg_spindle" body2="{b}"/>' for b in held(loose) if not b.startswith(PREFIX + "keeper")]
    return "  <contact>\n" + "\n".join(rows) + "\n  </contact>\n" if rows else ""


def with_body(body_xml: str, place: Place, loose: str, assets: str = "", carried: tuple = (),
              wheel_id: str | None = None) -> str:
    """The body model's MJCF with the grinder cell added: the grinder's, the part's and the keepers' classes, the
    floor, the grinder where place puts it, the loose bodies (part_body, keeper_body) and their mesh assets, a carry
    weld to each carried body from the hand that carries it (a body, the right hand's, or a (side, body) pair), the
    grinder's rack and screws, and its actuators after the body's, so the body's keep their ids."""
    grinder, acts, eq = _grinder(place, wheel_id)
    head, _, tail = body_xml.rpartition("\n  </default>")
    xml = head + "\n" + defaults() + "\n  </default>" + tail
    if assets:
        xml = xml.replace("<asset>\n", "<asset>\n" + assets, 1) if "<asset>\n" in xml else \
            xml.replace("<worldbody>\n", f"<asset>\n{assets}  </asset>\n  <worldbody>\n", 1)
    xml = xml.replace("<worldbody>\n", "<worldbody>\n" + FLOOR + grinder + loose, 1)
    pairs = [c if isinstance(c, tuple) else ("R", c) for c in carried]
    welds = "".join(f'    <weld name="carry_{b}" body1="{side}_hand" body2="{b}" active="false" solref="0.004 1" '
                    f'solimp="0.95 0.99 0.001" torquescale="1"/>\n' for side, b in pairs)
    xml = xml.replace("<equality>\n", "<equality>\n" + welds + eq, 1)
    xml = xml.replace("  <equality>\n", _contacts(loose) + "  <equality>\n", 1)
    head, _, tail = xml.rpartition("  </actuator>")
    return head + acts + "  </actuator>" + tail


def standalone_xml(place: Place, loose: str, assets: str = "", wheel_id: str | None = None) -> str:
    """The cell without a body: the grinder and what is on its chuck, to let it come to rest, and for the grind; on
    the body model's solver settings (moonshot/body/skeleton.py)."""
    grinder, acts, eq = _grinder(place, wheel_id)
    asset = f"  <asset>\n{assets}  </asset>\n" if assets else ""
    return f"""<mujoco model="grind_cell">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" solver="Newton" cone="elliptic" impratio="10" tolerance="1e-10"
          iterations="60" ls_iterations="20" noslip_iterations="10" gravity="0 0 -9.81"/>
  <default>
    <joint limited="true"/>
{defaults()}
  </default>
{asset}  <worldbody>
{FLOOR}{grinder}{loose}  </worldbody>
{_contacts(loose)}  <equality>
{eq}  </equality>
  <actuator>
{acts}  </actuator>
</mujoco>
"""


def control(model: mujoco.MjModel, data: mujoco.MjData, loose: str) -> SG.Control:
    """The grinder's control, holding what loose puts on its chuck."""
    return SG.Control(model, data, held=held(loose))


# --- the grinder's state, carried from take to take, in the station's frame -------------------------------------------

def grinder_state(model: mujoco.MjModel, data: mujoco.MjData, ctl: SG.Control, place: Place) -> dict:
    """What the next take starts from: the grinder's joints, its switches, the wheel's speed, and each held body's
    pose (centre mm, rotation, the station's frame)."""
    m, d = model, data
    out = {"q": {j: float(d.qpos[m.jnt_qposadr[m.joint(f"sg_{j}").id]]) for j in SG.JOINT_OF.values()},
           "control": {"state": ctl.state, "stop_in": ctl.stop_in, "coolant_on": ctl.coolant_on},
           "spindle_rad_s": float(d.qvel[m.jnt_dofadr[m.joint("sg_spindle").id]]), "held": {}}
    for b in ctl.held:
        i = m.body(b).id
        out["held"][b] = {"centre": place.station(d.xpos[i] * 1000).tolist(),
                          "R": (place.R.T @ d.xmat[i].reshape(3, 3)).tolist()}
    return out


def set_grinder(model: mujoco.MjModel, data: mujoco.MjData, ctl: SG.Control, state: dict, place: Place) -> None:
    """Put the grinder as state has it (grinder_state's), and the held bodies where it left them, before the take's
    first step."""
    m, d = model, data
    for j, v in state["q"].items():
        d.qpos[m.jnt_qposadr[m.joint(f"sg_{j}").id]] = v
    d.qvel[m.jnt_dofadr[m.joint("sg_spindle").id]] = state.get("spindle_rad_s", 0.0)
    c = state["control"]
    ctl.state, ctl.stop_in, ctl.coolant_on = c["state"], c["stop_in"], c["coolant_on"]
    for b, s in state.get("held", {}).items():
        try:
            j = m.joint(b)
        except KeyError:
            continue
        a = m.jnt_qposadr[j.id]
        d.qpos[a:a + 3] = place.world(s["centre"]) * M
        d.qpos[a + 3:a + 7] = _quat(place.R @ np.asarray(s["R"], float))
    mujoco.mj_forward(m, d)


def grind_cut_active(model: mujoco.MjModel, data: mujoco.MjData, part: str = PREFIX + "part") -> bool:
    """Is the wheel inside the part's uncut shape: its lowest point below the part's top and over its footprint? For
    the frame's record of the grind's shortcut (the wheel and the part don't collide while it grinds), pending its
    declaration."""
    m, d = model, data
    try:
        g = m.geom(part).id
    except KeyError:
        return False
    R, p = d.geom_xmat[g].reshape(3, 3), d.geom_xpos[g]
    if m.geom_type[g] == mujoco.mjtGeom.mjGEOM_MESH:
        mid = m.geom_dataid[g]
        V = p + m.mesh_vert[m.mesh_vertadr[mid]:m.mesh_vertadr[mid] + m.mesh_vertnum[mid]] @ R.T
    else:
        s = m.geom_size[g]
        V = p + np.array([[x, y, z] for x in (-s[0], s[0]) for y in (-s[1], s[1]) for z in (-s[2], s[2])]) @ R.T
    w = d.site("sg_wheel_bottom_head").xpos
    lo, hi = V.min(axis=0), V.max(axis=0)
    return bool(w[2] < hi[2] and lo[0] <= w[0] <= hi[0] and lo[1] <= w[1] <= hi[1])


def render_links(wheel_id: str | None = None, coolant_flowing: bool = False) -> dict[str, tuple[str, str]]:
    """The grinder's GLBs and the bodies that carry them, for glbs_in_bodies(model, "sgrind", ...)."""
    return SG.render_links(wheel_id, coolant_flowing)
