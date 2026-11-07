"""A lathe tool's cutting edge in the plane of the spindle's axis, the one definition the catalogue's models
(moonshot/library/generators.py) and the cut simulation (moonshot/sim/turn.py) both draw: points (Z, X) in mm, Z along
the spindle (+ away from the chuck), X out from the axis, about the tool's reference point, convex, in order round it.
"""
from __future__ import annotations

import math

ARC_DEG = 1.0                   # a radius drawn as points this far apart (a 0.2 mm nose: 8 nm off its arc)


def arc(c: tuple[float, float], r: float, a0: float, a1: float) -> list[tuple[float, float]]:
    n = max(2, int(math.ceil(abs(a1 - a0) / ARC_DEG)) + 1)
    return [(c[0] + r * math.cos(math.radians(a0 + (a1 - a0) * k / (n - 1))),
             c[1] + r * math.sin(math.radians(a0 + (a1 - a0) * k / (n - 1)))) for k in range(n)]


def turning(nose_r: float, lead_deg: float, insert_deg: float, edge_mm: float, hand: str = "R") -> list:
    """A turning insert in its holder, about its nose centre: the leading edge at lead_deg to the feed (toward the
    chuck, -Z, for a right-hand tool), the trailing edge insert_deg round from it, both tangent to the nose radius;
    the leading edge's far end first, then the nose's arc, then the trailing edge's far end."""
    alpha = 180.0 - lead_deg                       # the leading edge from the nose, from +Z (87 deg at a 93 deg lead)
    beta = alpha - insert_deg                      # the trailing edge's
    pts = arc((0.0, 0.0), nose_r, alpha + 90.0, beta - 90.0 + 360.0)    # between each edge's outward normal
    (zm, xm), (zt, xt) = pts[0], pts[-1]
    far_m = (zm + edge_mm * math.cos(math.radians(alpha)), xm + edge_mm * math.sin(math.radians(alpha)))
    far_t = (zt + edge_mm * math.cos(math.radians(beta)), xt + edge_mm * math.sin(math.radians(beta)))
    out = [far_m] + pts + [far_t]
    if hand == "L":
        out = [(-z, x) for z, x in reversed(out)]
    return out


def blade(width: float, corner_r: float, height: float) -> list:
    """A grooving or parting insert about its bottom centre: width wide, its two bottom corners rounded, height tall."""
    h, c = width / 2, corner_r
    return arc((-h + c, c), c, 180.0, 270.0) + arc((h - c, c), c, 270.0, 360.0) + [(h, height), (-h, height)]
