"""The shop's 3/4 in combination wrench (shop.json wrenches-1, the wrench asset record), for the step clamps' 3/4 in
flange nuts (moonshot/world/spoilboard.py): a free body whose box end's inside is a hexagon a little wider than the
nut's, so set down over the nut it meets the nut's flats and turns it when its handle is swung about the stud; its
open end isn't modelled (it doesn't work here). It lies flat on the spoilboard where a take puts it.

Its frame: the box end's middle at the origin, the handle along +x, z up; the box end's underside at z = -HEIGHT/2.
"""
from __future__ import annotations

import math

import numpy as np

M = 0.001
IN = 25.4
NUT_AF = 0.75 * IN                       # the 3/4 in hex it fits
AF_IN = NUT_AF + 0.9                     # its box end's inside, across flats: 0.45 mm play a flat [proposed]
WALL, HEIGHT = 4.5, 7.0                  # the box end's wall and the wrench's thickness
LENGTH = 9.5 * IN                        # overall, a 3/4 in combination wrench
HANDLE_W = 19.0
STEEL_KG_M3 = 7850.0


def boxes() -> list[tuple[str, np.ndarray, np.ndarray, float]]:
    """The wrench's solids in its frame: (name, centre, half size, yaw about z) mm, rad. The box end's six walls,
    their inner faces AF_IN / 2 from its middle facing in at 30 + 60k deg (the nut's flats' normals,
    moonshot/world/spoilboard.py _nut_geoms), and the handle."""
    r_in = AF_IN / 2
    half_side = (r_in + WALL) * math.tan(math.pi / 6) + 0.5
    out = []
    for k in range(6):
        a = math.pi / 6 + k * math.pi / 3
        c = (r_in + WALL / 2) * np.array([math.cos(a), math.sin(a), 0.0])
        out.append((f"ring_{k}", c, np.array([WALL / 2, half_side, HEIGHT / 2]), a))
    x0 = r_in + WALL - 1.0
    hl = (LENGTH - x0 - 12.0) / 2
    out.append(("handle", np.array([x0 + hl, 0.0, 0.0]), np.array([hl, HANDLE_W / 2, HEIGHT / 2 - 0.5]), 0.0))
    return out


def kg() -> float:
    return STEEL_KG_M3 * sum(8 * float(np.prod(h)) for _, _, h, _ in boxes()) * 1e-9


def _f(v) -> str:
    return " ".join(f"{float(x) * M:.7f}" for x in np.atleast_1d(v))


def xml(name: str, at_mm, yaw: float) -> str:
    """The wrench as a free body lying flat at at_mm (its box end's middle), turned yaw about z."""
    total = kg()
    vol = sum(float(np.prod(h)) for _, _, h, _ in boxes())
    q = f"{math.cos(yaw / 2):.7f} 0 0 {math.sin(yaw / 2):.7f}"
    geoms = "".join(
        f'      <geom name="{name}_{part}" class="steel" type="box" size="{_f(h)}" pos="{_f(c)}" '
        f'quat="{math.cos(a / 2):.7f} 0 0 {math.sin(a / 2):.7f}" mass="{total * float(np.prod(h)) / vol:.5f}" '
        f'rgba="0.7 0.71 0.73 1"/>\n' for part, c, h, a in boxes())
    return f'    <body name="{name}" pos="{_f(at_mm)}" quat="{q}">\n      <freejoint name="{name}"/>\n{geoms}    </body>\n'


def resting(board_z: float, xy, yaw: float) -> tuple[np.ndarray, float]:
    """Where a wrench lying flat on a surface at board_z has its frame: (middle mm, yaw)."""
    return np.array([float(xy[0]), float(xy[1]), board_z + HEIGHT / 2]), yaw
