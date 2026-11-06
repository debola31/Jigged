"""The 3/4 in ratcheting combination wrench the plate takes run the step clamps' 3/4 in flange nuts with (moonshot/
world/spoilboard.py; the asset record moonshot/library/records/assets/hand_tools/ratchet-wrench, after GEARWRENCH's
reversible 9532N and its 9024, the user's decision of 2026-11-05: it replaces the shop's plain combination wrench,
wrenches-1, for these takes). Its box end is a ratchet: a ring in the head, whose inside fits over the nut, turns in
the head on a hinge (`ratchet`, the joint in the head), held to it one way by the pawl and free the other, so the
handle swung one way turns the nut and swung back leaves it, the box end staying on the nut. The pawl is the hinge's
limit, set by the physics run where the ring stands each time the handle swings back (moonshot/sim/plate_clamps.py):
a pawl catching wherever it stops, the real one's 72 teeth (5 deg) not modelled. Its reversing lever sets which way
it drives, the take saying which (tighten or loosen). Its open end isn't among its solids (it does no work here); its
model, which the take record draws, has it (moonshot/library/generators.py ratchet_wrench, LINKS). It lies flat where a
take puts it.

The ring's inside is modelled as the hexagon it drives the nut by (the real one's 12 points fit the hex every 30
deg; its six flats, every 60), a little wider than the nut's, its underside's edge chamfered.

Its frame (the head's): the box end's middle at the origin, the handle along +x, z up; the head's underside at
z = -HEIGHT/2.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.spatial.transform import Rotation

M = 0.001
IN = 25.4
NUT_AF = 0.75 * IN                       # the 3/4 in hex it fits
LENGTH = 9.594 * IN                      # overall (GEARWRENCH 9532N)
HEAD_W = 1.339 * IN                      # the box end's width across its head (9024, 9532N)
HEIGHT = 0.441 * IN                      # ... and its thickness: 11.2 mm
HANDLE_W, HANDLE_T = 17.0, 7.0           # the handle's width and thickness [proposed]: no source gives them
RING_R = 13.0                            # the ratchet ring's outside radius in the head [proposed]
AF_IN = NUT_AF + 1.6                     # the ring's inside across flats: 0.8 mm play a flat [proposed], a well used
                                         # one's: set down by the hand 0.4-1 mm off the nut's middle, at 0.45 the box
                                         # end sat on its chamfer and the swing tipped it off
CHAMFER_MM = 1.5                         # the ring's inside edge on its underside chamfered this far, at 45 deg
                                         # [proposed], as a box end's is: set down a millimetre or two off the nut's
                                         # middle, or turned off its flats, it is led onto them
LINKS = "library/hand_tools/ratchet-wrench/links"   # its parts' GLBs under the data root (generators.write_hand_tool)
Y_UP_IN_BODY = [0.0, 0.0, 0.0, 0.7071068, 0.7071068, 0.0, 0.0]   # ... stored Y up: +90 deg about x in each body
STEEL_KG_M3 = 7850.0
SLAB_MM = 1.0                           # the chamfer's solid's thickness, behind its face
RATCHET_DAMPING = 0.0005                 # the ring's turn in the head: its damping (N m s / rad) and the pawl's drag
RATCHET_DRAG_NM = 0.004                  # on its teeth as it freewheels (N m) [proposed]: under the nut's own drag on
                                         # its stud (spoilboard.NUT_FRICTION_NM, 0.008), so the ring stays on the nut
                                         # as the handle swings back


def turned(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def head_boxes() -> list[tuple[str, np.ndarray, np.ndarray, np.ndarray]]:
    """The head's solids in its frame (name, centre mm, half size mm, frame): eight walls round the ring, from RING_R
    out to the head's width, and the handle."""
    h, r0, r1 = HEIGHT / 2, RING_R, HEAD_W / 2
    half_side = r1 * math.tan(math.pi / 8)
    out = []
    for k in range(8):
        a = k * math.pi / 4
        u = np.array([math.cos(a), math.sin(a), 0.0])
        out.append((f"head_{k}", u * (r0 + r1) / 2, np.array([(r1 - r0) / 2, half_side, h]), turned(a)))
    x0 = r1 - 2.0
    hl = (LENGTH - x0 - 15.0) / 2
    out.append(("handle", np.array([x0 + hl, 0.0, 0.0]), np.array([hl, HANDLE_W / 2, HANDLE_T / 2]), np.eye(3)))
    return out


def ring_boxes() -> list[tuple[str, np.ndarray, np.ndarray, np.ndarray]]:
    """The ratchet ring's solids in its frame (the head's, turned by the ratchet): its inside's six flats, AF_IN / 2
    from its middle facing in at 30 + 60k deg (the nut's flats' normals, moonshot/world/spoilboard.py _nut_geoms), each
    above its chamfer: the flat's foot, set back CHAMFER_MM, and the chamfer's face between them."""
    r_in, c, h = AF_IN / 2, CHAMFER_MM, HEIGHT / 2 - 0.5
    wall = RING_R - r_in
    half_side = RING_R * math.tan(math.pi / 6)
    out = []
    for k in range(6):
        a = math.pi / 6 + k * math.pi / 3
        u, R = np.array([math.cos(a), math.sin(a), 0.0]), turned(a)
        out.append((f"ring_{k}", u * (r_in + wall / 2) + [0.0, 0.0, c / 2], np.array([wall / 2, half_side, h - c / 2]),
                    R))
        out.append((f"foot_{k}", u * (r_in + (c + wall) / 2) + [0.0, 0.0, -h + c / 2],
                    np.array([(wall - c) / 2, half_side, c / 2]), R))
        # the chamfer's face through the flat's inner edge c up and the foot's c out, its solid behind it: the slab's
        # x out and up (into the ring), y along the flat, z up the face toward the middle
        x_l, z_l = (u + [0.0, 0.0, 1.0]) / math.sqrt(2), ([0.0, 0.0, 1.0] - u) / math.sqrt(2)
        face = u * (r_in + c / 2) + [0.0, 0.0, -h + c / 2]
        out.append((f"chamfer_{k}", face + x_l * SLAB_MM / 2, np.array([SLAB_MM / 2, half_side, c * math.sqrt(2) / 2]),
                    np.column_stack([x_l, R[:, 1], z_l])))
    return out


def boxes() -> list[tuple[str, np.ndarray, np.ndarray, np.ndarray]]:
    """All the wrench's solids in its frame, the ring as it stands square in the head (for a grip's colliders)."""
    return head_boxes() + ring_boxes()


def play() -> float:
    """How far (rad) the ring turns either way on a nut, square on its flats, before its flats bear on the nut's
    corners."""
    return math.pi / 6 - math.acos(AF_IN / NUT_AF * math.cos(math.pi / 6))


def _vol(bs) -> float:
    return sum(8 * float(np.prod(h)) for _, _, h, _ in bs)


def kg() -> float:
    """The whole wrench's mass (kg): the 9024's catalogue 0.47 lb is 0.21 kg."""
    return STEEL_KG_M3 * _vol(boxes()) * 1e-9


def _f(v) -> str:
    return " ".join(f"{float(x) * M:.7f}" for x in np.atleast_1d(v))


def _q(R: np.ndarray) -> str:
    """A frame's quaternion, MuJoCo's w x y z."""
    x, y, z, w = Rotation.from_matrix(R).as_quat()
    return f"{w:.7f} {x:.7f} {y:.7f} {z:.7f}"


def _geoms(name: str, bs, ind: str) -> str:
    return "".join(
        f'{ind}<geom name="{name}_{part}" class="steel" type="box" size="{_f(h)}" pos="{_f(c)}" quat="{_q(R)}" '
        f'mass="{STEEL_KG_M3 * 8 * float(np.prod(h)) * 1e-9:.6f}" rgba="0.7 0.71 0.73 1"/>\n' for part, c, h, R in bs)


def xml(name: str, at_mm, yaw: float) -> str:
    """The wrench as a free body lying flat at at_mm (its box end's middle), turned yaw about z, its ring a body in
    its head on the ratchet's hinge, locked till a run frees it one way (moonshot/sim/plate_clamps.py)."""
    return (f'    <body name="{name}" pos="{_f(at_mm)}" quat="{_q(turned(yaw))}">\n      <freejoint name="{name}"/>\n'
            f'{_geoms(name, head_boxes(), "      ")}'
            f'      <body name="{name}_ring">\n'
            f'        <joint name="{name}_ratchet" type="hinge" axis="0 0 1" limited="true" range="-0.00001 0.00001" '
            f'damping="{RATCHET_DAMPING}" frictionloss="{RATCHET_DRAG_NM}" armature="0.00001"/>\n'
            f'{_geoms(name, ring_boxes(), "        ")}'
            f'      </body>\n    </body>\n')


def resting(board_z: float, xy, yaw: float) -> tuple[np.ndarray, float]:
    """Where a wrench lying flat on a surface at board_z has its frame: (middle mm, yaw)."""
    return np.array([float(xy[0]), float(xy[1]), board_z + HEIGHT / 2]), yaw
