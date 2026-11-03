"""The parallels' rack: a slotted steel block on the VF-2's table, left of the vise, where each parallel stands on
its edge between the operator's setups (moonshot/motion/set_parallels.py takes them from it). Two slots, the far one
for para_a (it goes nearer the fixed jaw), 20 mm apart; the walls hold the lower 8 mm of a parallel with 2 mm of
play, as a shop rack does, so its top stands proud of them for a pinch, and it comes out without jamming.

The rack sits turned YAW_DEG on the table, square to the right forearm as it reaches there: the hand that picks a
parallel up holds it square to the jaws only turned that much less, and the parallel is turned square on the way
(set out along X, the arm turned the hand that much on the way of its own, and the parallels landed crooked).

World frame, mm, as the vise's (moonshot/world/vise.py).
"""
from __future__ import annotations

import math

import numpy as np

from moonshot.world.vise import PARALLEL_L, PARALLEL_T, TABLE_Z, Load

M = 0.001
CENTRE = np.array([-600.0, -440.0, TABLE_Z])            # the base's underside, on the table left of the vise
BASE_H, WALL_H, WALL_T, PITCH = 10.0, 8.0, 4.0, 20.0
SLOT = PARALLEL_T + 2.0                                  # a parallel stands in its slot with this much play: at
                                                         # 0.9 mm, tilted 3 deg coming out, it jammed and slipped
SLOTS_Y = {"para_a": PITCH / 2, "para_b": -PITCH / 2}    # each slot's middle, from the rack's centre
YAW_DEG = 8.0                                            # the planned hand turned 0.13-0.15 rad between rack and vise
YAW = math.radians(YAW_DEG)
R = np.array([[math.cos(YAW), -math.sin(YAW), 0.0], [math.sin(YAW), math.cos(YAW), 0.0], [0.0, 0.0, 1.0]])


def slots(load: Load) -> dict[str, np.ndarray]:
    """Each parallel's base centre (mm) standing in its slot (turned with the rack, R), as load.parallels() gives
    them in the vise."""
    return {n: CENTRE + R @ np.array([0.0, SLOTS_Y[n], BASE_H]) for n in load.parallels_y}


def boxes() -> list[tuple[np.ndarray, np.ndarray]]:
    """The rack's solids as (centre, half size), mm, each turned by R: the base and the walls either side of each
    slot."""
    half_len = PARALLEL_L / 2 + 6.0
    out = [(CENTRE + R @ np.array([0.0, 0.0, BASE_H / 2]), np.array([half_len, PITCH + WALL_T + SLOT, BASE_H / 2]))]
    for y in (-PITCH / 2 - SLOT / 2 - WALL_T / 2, 0.0, PITCH / 2 + SLOT / 2 + WALL_T / 2):
        half_w = WALL_T / 2 if y else (PITCH - SLOT) / 2
        out.append((CENTRE + R @ np.array([0.0, y, BASE_H + WALL_H / 2]), np.array([half_len, half_w, WALL_H / 2])))
    return out


def xml() -> str:
    """The rack as a static body (so the take record draws it), steel, on the table."""
    f = lambda v: " ".join(f"{x * M:.5f}" for x in v)                      # noqa: E731
    q = f"{math.cos(YAW / 2):.7f} 0 0 {math.sin(YAW / 2):.7f}"
    geoms = "".join(f'      <geom name="rack_{i}" class="steel" type="box" size="{f(h)}" pos="{f(c)}" quat="{q}" '
                    f'rgba="0.35 0.36 0.38 1"/>\n' for i, (c, h) in enumerate(boxes()))
    return f'    <body name="parallel_rack">\n{geoms}    </body>\n'
