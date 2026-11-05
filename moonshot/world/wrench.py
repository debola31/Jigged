"""The shop's 3/4 in combination wrench (shop.json wrenches-1, the wrench asset record), for the step clamps' 3/4 in
flange nuts (moonshot/world/spoilboard.py): a free body whose box end's inside is a hexagon a little wider than the
nut's, so set down over the nut it meets the nut's flats and turns it when its handle is swung about the stud; its
open end isn't modelled (it doesn't work here). It lies flat on the spoilboard where a take puts it.

Its frame: the box end's middle at the origin, the handle along +x, z up; the box end's underside at z = -HEIGHT/2.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.spatial.transform import Rotation

M = 0.001
IN = 25.4
NUT_AF = 0.75 * IN                       # the 3/4 in hex it fits
AF_IN = NUT_AF + 0.9                     # its box end's inside, across flats: 0.45 mm play a flat [proposed]
CHAMFER_MM = 2.0                         # the box end's inside edge on its underside chamfered this far, at 45 deg
                                         # [proposed], as a box end's is: set down a millimetre or two off the nut's
                                         # middle, or turned off its flats, it is led onto them (without, it came down
                                         # 4-8 mm off the middle, sat on the hex's top and the stud's, and slid off
                                         # onto the clamp)
WALL, HEIGHT = 4.5, 7.0                  # the box end's wall and the wrench's thickness
LENGTH = 9.5 * IN                        # overall, a 3/4 in combination wrench
HANDLE_W = 19.0
STEEL_KG_M3 = 7850.0
SLAB_MM = 2.0                            # the chamfer's solid's thickness, behind its face


def turned(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def boxes() -> list[tuple[str, np.ndarray, np.ndarray, np.ndarray]]:
    """The wrench's solids in its frame: (name, centre mm, half size mm, frame). The box end's six walls, their inner
    faces AF_IN / 2 from its middle facing in at 30 + 60k deg (the nut's flats' normals, moonshot/world/spoilboard.py
    _nut_geoms), each above its chamfer: the wall's foot, set back CHAMFER_MM, and the chamfer's face between them;
    and the handle."""
    r_in, c, h = AF_IN / 2, CHAMFER_MM, HEIGHT / 2
    half_side = (r_in + WALL) * math.tan(math.pi / 6) + 0.5
    out = []
    for k in range(6):
        a = math.pi / 6 + k * math.pi / 3
        u, R = np.array([math.cos(a), math.sin(a), 0.0]), turned(a)
        out.append((f"ring_{k}", u * (r_in + WALL / 2) + [0.0, 0.0, c / 2], np.array([WALL / 2, half_side, h - c / 2]),
                    R))
        out.append((f"foot_{k}", u * (r_in + (c + WALL) / 2) + [0.0, 0.0, -h + c / 2],
                    np.array([(WALL - c) / 2, half_side, c / 2]), R))
        # the chamfer's face through the wall's inner edge c up and the foot's c out, its solid behind it: the slab's
        # x out and up (into the wall), y along the wall, z up the face toward the middle
        x_l, z_l = (u + [0.0, 0.0, 1.0]) / math.sqrt(2), ([0.0, 0.0, 1.0] - u) / math.sqrt(2)
        face = u * (r_in + c / 2) + [0.0, 0.0, -h + c / 2]
        out.append((f"chamfer_{k}", face + x_l * SLAB_MM / 2, np.array([SLAB_MM / 2, half_side, c * math.sqrt(2) / 2]),
                    np.column_stack([x_l, R[:, 1], z_l])))
    x0 = r_in + WALL - 1.0
    hl = (LENGTH - x0 - 12.0) / 2
    out.append(("handle", np.array([x0 + hl, 0.0, 0.0]), np.array([hl, HANDLE_W / 2, h - 0.5]), np.eye(3)))
    return out


def play() -> float:
    """How far (rad) the box end turns either way on a nut, square on its flats, before its walls bear on the nut's
    corners."""
    return math.pi / 6 - math.acos(AF_IN / NUT_AF * math.cos(math.pi / 6))


def kg() -> float:
    return STEEL_KG_M3 * sum(8 * float(np.prod(h)) for _, _, h, _ in boxes()) * 1e-9


def _f(v) -> str:
    return " ".join(f"{float(x) * M:.7f}" for x in np.atleast_1d(v))


def _q(R: np.ndarray) -> str:
    """A frame's quaternion, MuJoCo's w x y z."""
    x, y, z, w = Rotation.from_matrix(R).as_quat()
    return f"{w:.7f} {x:.7f} {y:.7f} {z:.7f}"


def xml(name: str, at_mm, yaw: float) -> str:
    """The wrench as a free body lying flat at at_mm (its box end's middle), turned yaw about z."""
    total = kg()
    vol = sum(float(np.prod(h)) for _, _, h, _ in boxes())
    geoms = "".join(
        f'      <geom name="{name}_{part}" class="steel" type="box" size="{_f(h)}" pos="{_f(c)}" quat="{_q(R)}" '
        f'mass="{total * float(np.prod(h)) / vol:.5f}" rgba="0.7 0.71 0.73 1"/>\n' for part, c, h, R in boxes())
    return (f'    <body name="{name}" pos="{_f(at_mm)}" quat="{_q(turned(yaw))}">\n      <freejoint name="{name}"/>\n'
            f'{geoms}    </body>\n')


def resting(board_z: float, xy, yaw: float) -> tuple[np.ndarray, float]:
    """Where a wrench lying flat on a surface at board_z has its frame: (middle mm, yaw)."""
    return np.array([float(xy[0]), float(xy[1]), board_z + HEIGHT / 2]), yaw
