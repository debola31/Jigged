"""Surface grinding (plan §2 O2): the passes of a surface grinder's wheel along a part on its magnetic chuck, and the
stock they leave. G2's ct-tpg322: the chipbreaker ground into a bought, ground-to-size TPGN 322 insert, a straight
slot along each of its three edges with a 6 x 0.035 in 1A1R diamond wheel, the insert turned 120 deg between them
(moonshot/planning/plans/ct-tpg322.json). The grind is the operator's at the handwheels, so a person's step; this is
what each pass cuts, for its stock and its still.

The stock is a BREP in the part's model frame. A pass is the wheel's rim, its width w across the edge at the plan's
cross position, its lowest point at the pass's depth, rocked along the edge between the plan's stroke ends: it takes
everything above the circle its rim's bottom sweeps (radius R, the wheel's), so the slot's floor is flat over the
stroke and rises along the wheel's arc past each end (the run-out). Each down-feed takes both cross positions, the
outer (the wheel's side at the land, .010 inside the edge) and the inner (the cross step in), then the spark-outs
repeat the last depth.

The blank: the plan's insert as bought, the part with its groove filled to the top (its floor's outline raised to the
top face); every other face, the periphery, the noses and both faces, is the STEP's, as bought ground.

Declared shortcut: each pass's cut is the region its stroke covers, computed at once (the wheel's path is a straight
line along the edge, so the region is exact), not stroke by stroke.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import cadquery as cq
import numpy as np

from moonshot.sim import cam

INCH = 25.4
ARC_MM = 0.05                   # the run-out arc drawn as points this far apart along the edge (sag under 0.1 µm)


@dataclass(frozen=True)
class Edge:
    """An edge of the insert's top in the model's plan view: its start corner, its unit direction along it, the unit
    normal pointing out of the insert, and its length (the sharp triangle's)."""
    start: np.ndarray
    along: np.ndarray
    out: np.ndarray
    length: float

    def point(self, t: float, n: float, z: float) -> np.ndarray:
        """The model point t along the edge from its start, n in from it, at height z."""
        p = self.start + t * self.along - n * self.out
        return np.array([p[0], p[1], z])


def insert_edges(ic_mm: float) -> list[Edge]:
    """A triangle insert's three edges, its inscribed circle (ic_mm across) centred on the origin, the first edge's
    outward normal +X (ct-tpg322's plan): the second and third 120 and 240 deg round from it."""
    r = ic_mm / 2
    side = 2 * math.sqrt(3) * r
    out = []
    for k in range(3):
        a = math.radians(120.0 * k)
        n = np.array([math.cos(a), math.sin(a)])
        along = np.array([-n[1], n[0]])                       # counter-clockwise round the insert
        out.append(Edge(r * n - along * side / 2, along, n, side))
    return out


def blank(part, top_z: float, floor_z: float):
    """The insert as bought: the part with each planar floor at floor_z (the groove's) filled up to top_z."""
    floors = [f for f in part.Faces() if f.geomType() == "PLANE" and abs(f.Center().z - floor_z) < 1e-3
              and f.normalAt().z > 0.99]
    fill = [cq.Solid.extrudeLinear(f, cq.Vector(0, 0, top_z - floor_z)) for f in floors]
    out = part
    for s in fill:
        out = out.fuse(s)
    return out.clean()


def pass_solid(e: Edge, n0: float, width: float, bottom_z: float, stroke: tuple[float, float], radius: float,
               top_z: float):
    """What one pass takes: everything above the wheel's rim's lowest circle swept over the stroke (t of its centre
    along the edge), n0 to n0 + width in from the edge, up past the top."""
    lid = top_z + 0.2
    reach = math.sqrt(max(0.0, radius ** 2 - (radius - (lid - bottom_z)) ** 2))
    k = max(2, int(math.ceil(reach / ARC_MM)))
    t0, t1 = stroke
    left = [(t0 - d, bottom_z + radius - math.sqrt(radius ** 2 - d ** 2)) for d in np.linspace(reach, 0.0, k)]
    right = [(t1 + d, bottom_z + radius - math.sqrt(radius ** 2 - d ** 2)) for d in np.linspace(0.0, reach, k)]
    section = left + right + [(t1 + reach, lid), (t0 - reach, lid)]
    pts = [cq.Vector(*e.point(t, n0, z)) for t, z in section]
    face = cq.Face.makeFromWires(cq.Wire.makePolygon(pts, close=True))
    depth = e.point(0.0, n0 + width, 0.0) - e.point(0.0, n0, 0.0)
    return cq.Solid.extrudeLinear(face, cq.Vector(*depth))


@dataclass
class Pass:
    edge: int
    cross: str                  # outer or inner
    n0: float                   # the wheel's outer side, in from the edge (mm)
    bottom_z: float
    spark_out: bool


def passes(edge: int, land_mm: float, width_mm: float, cross_step_mm: float, top_z: float, downfeed_mm: float,
           n_passes: int, spark_outs: int) -> list[Pass]:
    """An edge's passes in order: each down-feed at the outer cross position then the inner, then the spark-outs at
    the last depth, both positions each."""
    out = []
    for k in range(1, n_passes + spark_outs + 1):
        z = top_z - downfeed_mm * min(k, n_passes)
        for cross, n0 in (("outer", land_mm), ("inner", land_mm + cross_step_mm)):
            out.append(Pass(edge, cross, n0, z, k > n_passes))
    return out


def cut(stock, solid):
    return cam.cut(stock, solid)
