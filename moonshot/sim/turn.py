"""Turning (plan §2 O2, §5.1): the moves a lathe runs for each turning operation of a process plan, and the stock they
leave, cut by each tool's own edge: a turning insert's nose radius and its two edges at its holder's lead angle, a
grooving or part-off blade's width and corner radii, a drill's diameter and point.

The stock is a solid of revolution about the spindle's axis, which is the part's own (the axis its STEP's revolved
faces share). It is kept as its half-section on a grid along that axis (GRID_MM): at each station u (mm along the
axis, the part's model frame) the material runs from r_in (0, or the hole's radius) out to r_out. A tool on the
turret's outside (turning, facing, grooving, part-off) takes everything at or above its edge's lowest point at that
station, its holder being above it; a tool on the axis (a drill, a tap) everything from the axis out to its edge. A
straight move sweeps the convex hull of the tool's edge at the move's two ends, exactly, since every edge here is
convex. After each pass the stock is revolved into a BREP: for the take's meshes, and the next step's start.

Paths come from what the operation must leave (its keep): the part, grown by a finishing allowance for a rough pass,
within the operation's span along the axis, and the stock as it stands outside that span (the jaws' side), which no
pass enters. A tool's lowest height at each station is the keep dilated by its edge: it rides on its nose where the
part's shape lets the nose reach and on a flank where the part is steeper than the tool can follow, as a real insert
does, so no pass cuts into what the operation keeps; what the tool can't reach stays on, and the gate sees it.

Lathe coordinates, as a Haas reads them: Z along the spindle, + away from the chuck, zero at the part's finished face
toward the turret; X the diameter. The program lists each pass's moves of the tool's reference point (a turning
insert's nose centre, a blade's bottom centre, a drill's point) as [X, Z, feed in mm/rev or None for a rapid].

Declared shortcuts: a tap is swept as the hole's minor diameter, as the STEP models a tapped hole (as moonshot/sim/
cam.py does); faces are found to the grid (1 µm) and curves to SIMPLIFY_MM, far inside the 0.1 mm gate.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from moonshot.library import lathe_edges

RECORDS = Path(__file__).resolve().parents[1] / "library" / "records" / "assets"
INCH = 25.4
GRID_MM = 0.002                 # stations along the axis
SIMPLIFY_MM = 0.0005            # a path or profile's polyline within this of its points
CLEAR_MM = 1.0                  # rapids this far off the stock
RAPID_MM_MIN = 24000.0          # the ST-25's X and Z rapids, 945 in/min (Haas ST-25 spec sheet)


# --- the stock: a half-section on the grid ---------------------------------------------------------------------------

@dataclass
class Axis:
    """The spindle's axis in the part's model frame: a point on it, its direction, and a direction out from it."""
    origin: np.ndarray
    dir: np.ndarray
    out: np.ndarray

    def point(self, u: float, r: float) -> np.ndarray:
        return self.origin + u * self.dir + r * self.out


@dataclass
class Profile:
    """The stock's half-section: material from r_in[i] to r_out[i] at u = u0 + i * GRID_MM (none where r_out <= r_in)."""
    u0: float
    r_in: np.ndarray
    r_out: np.ndarray

    @property
    def u(self) -> np.ndarray:
        return self.u0 + GRID_MM * np.arange(len(self.r_out))

    def copy(self) -> "Profile":
        return Profile(self.u0, self.r_in.copy(), self.r_out.copy())

    def solid(self) -> np.ndarray:
        return self.r_out > self.r_in + 1e-9

    def index(self, u: float) -> int:
        return int(round((u - self.u0) / GRID_MM))

    def pieces(self) -> list[tuple[int, int]]:
        """Each run of stations with material, as [i0, i1) index ranges."""
        m = self.solid().astype(np.int8)
        d = np.diff(np.r_[0, m, 0])
        return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))

    def keep_piece(self, u_lo: float, u_hi: float) -> "Profile":
        """Only the piece that overlaps [u_lo, u_hi] (the part, once it's parted off the bar)."""
        out = self.copy()
        for i0, i1 in self.pieces():
            a, b = self.u0 + GRID_MM * i0, self.u0 + GRID_MM * (i1 - 1)
            if b < u_lo or a > u_hi:
                out.r_out[i0:i1] = out.r_in[i0:i1]
        return out

    def volume(self) -> float:
        s = self.solid()
        return float(np.pi * np.sum(self.r_out[s] ** 2 - self.r_in[s] ** 2) * GRID_MM)

    def span(self) -> tuple[float, float]:
        s = np.flatnonzero(self.solid())
        return self.u0 + GRID_MM * s[0], self.u0 + GRID_MM * s[-1]

    def save(self, path: Path) -> None:
        np.savez_compressed(path, u0=self.u0, r_in=self.r_in, r_out=self.r_out, grid=GRID_MM)

    @staticmethod
    def load(path: Path) -> "Profile":
        d = np.load(path)
        assert float(d["grid"]) == GRID_MM
        return Profile(float(d["u0"]), d["r_in"].astype(float), d["r_out"].astype(float))


def bar(u_lo: float, u_hi: float, radius: float, margin: float = 3.0) -> Profile:
    """A round bar (or sawn slug) from u_lo to u_hi, its grid running margin past each end."""
    u0 = u_lo - margin
    n = int(math.ceil((u_hi - u_lo + 2 * margin) / GRID_MM)) + 1
    u = u0 + GRID_MM * np.arange(n)
    r_out = np.where((u >= u_lo) & (u <= u_hi), radius, 0.0)
    return Profile(u0, np.zeros(n), r_out)


def regrid(p: Profile, u0: float, n: int) -> Profile:
    """The profile on another span of the same grid (stations outside the old span are empty)."""
    k = int(round((p.u0 - u0) / GRID_MM))
    r_in, r_out = np.zeros(n), np.zeros(n)
    lo, hi = max(0, k), min(n, k + len(p.r_out))
    r_in[lo:hi], r_out[lo:hi] = p.r_in[lo - k:hi - k], p.r_out[lo - k:hi - k]
    return Profile(u0, r_in, r_out)


# --- the part's axis and half-section, from its STEP -----------------------------------------------------------------

def part_axis(part) -> Axis:
    """The axis the part's revolved faces (cylinders, cones, tori, spheres) share, in its model frame."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    axes = []
    for f in part.Faces():
        a = BRepAdaptor_Surface(f.wrapped)
        t = f.geomType()
        if t in ("CYLINDER", "CONE", "TORUS"):
            ax = {"CYLINDER": a.Cylinder, "CONE": a.Cone, "TORUS": a.Torus}[t]().Axis()
            d, o = ax.Direction(), ax.Location()
            axes.append((np.array([d.X(), d.Y(), d.Z()]), np.array([o.X(), o.Y(), o.Z()]), f.Area()))
    # the largest revolved face's axis; faces off it (a bolt circle's holes) are a mill's
    d0, o0, _ = max(axes, key=lambda a: a[2])
    d0 = d0 * (1.0 if d0[np.abs(d0).argmax()] > 0 else -1.0)
    origin = o0 - (o0 @ d0) * d0                    # the axis's point nearest the model's origin
    out = np.cross(d0, np.eye(3)[np.abs(d0).argmin()])
    out /= np.linalg.norm(out)
    return Axis(origin, d0, out)


def section(shape, axis: Axis, u0: float, n: int) -> Profile:
    """A solid of revolution's half-section on the grid: its section by the half-plane through the axis toward
    axis.out, each station's material from the lowest crossing to the highest (one interval: no buried rings)."""
    import cadquery as cq
    bb = shape.BoundingBox()
    size = 2 * max(bb.xlen, bb.ylen, bb.zlen) + 10
    c = axis.point(0.0, 0.0)
    corners = [c - axis.dir * size, c + axis.dir * size, c + axis.dir * size + axis.out * size,
               c - axis.dir * size + axis.out * size]
    half = cq.Face.makeFromWires(cq.Wire.makePolygon([cq.Vector(*q) for q in corners], close=True))
    segs = []
    for f in shape.intersect(half).Faces():
        for w in [f.outerWire()] + f.innerWires():
            rel = _wire_points(w) - axis.origin
            segs.append(np.c_[rel @ axis.dir, rel @ axis.out])
    us = u0 + GRID_MM * np.arange(n)
    lo, hi = np.full(n, np.inf), np.full(n, -np.inf)
    for p in segs:
        a, b = p[:-1], p[1:]
        ua, ra, ub, rb = a[:, 0], a[:, 1], b[:, 0], b[:, 1]
        lo_u, hi_u = np.minimum(ua, ub), np.maximum(ua, ub)
        keep = hi_u - lo_u > 1e-12
        ua, ra, ub, rb, lo_u, hi_u = ua[keep], ra[keep], ub[keep], rb[keep], lo_u[keep], hi_u[keep]
        i0 = np.ceil((lo_u - u0) / GRID_MM).astype(int)
        i1 = np.floor((hi_u - u0) / GRID_MM - 1e-12).astype(int)
        for k in range(len(ua)):
            a0, a1 = max(i0[k], 0), min(i1[k], n - 1)
            if a1 < a0:
                continue
            s = us[a0:a1 + 1]
            r = ra[k] + (rb[k] - ra[k]) * (s - ua[k]) / (ub[k] - ua[k])
            lo[a0:a1 + 1] = np.minimum(lo[a0:a1 + 1], r)
            hi[a0:a1 + 1] = np.maximum(hi[a0:a1 + 1], r)
    solid = np.isfinite(lo) & (hi > lo)
    r_in = np.where(solid, np.clip(lo, 0.0, None), 0.0)
    r_in[r_in < 1e-6] = 0.0
    r_out = np.where(solid, hi, 0.0)
    return Profile(u0, r_in, r_out)


def _wire_points(w) -> np.ndarray:
    """A wire's edges as one closed polyline within 0.2 µm of its curves (OCC's quasi-uniform deflection)."""
    from OCP.BRepAdaptor import BRepAdaptor_CompCurve
    from OCP.GCPnts import GCPnts_QuasiUniformDeflection
    c = BRepAdaptor_CompCurve(w.wrapped)
    d = GCPnts_QuasiUniformDeflection(c, 0.0002)
    pts = np.array([[d.Value(i).X(), d.Value(i).Y(), d.Value(i).Z()] for i in range(1, d.NbPoints() + 1)])
    return np.vstack([pts, pts[:1]])


# --- the stock as a BREP ---------------------------------------------------------------------------------------------

def simplify(pts: np.ndarray, tol: float = SIMPLIFY_MM) -> np.ndarray:
    """Douglas-Peucker: the polyline's points within tol of it, its ends kept."""
    keep = np.zeros(len(pts), bool)
    keep[[0, -1]] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = pts[a], pts[b]
        seg = pts[a + 1:b]
        d = q - p
        L = np.hypot(*d)
        if L < 1e-12:
            dist = np.hypot(*(seg - p).T)
        else:
            dist = np.abs(d[0] * (seg[:, 1] - p[1]) - d[1] * (seg[:, 0] - p[0])) / L
        k = int(np.argmax(dist))
        if dist[k] > tol:
            keep[a + 1 + k] = True
            stack += [(a, a + 1 + k), (a + 1 + k, b)]
    return pts[keep]


def outline(p: Profile, i0: int, i1: int) -> np.ndarray:
    """A piece's half-section as a closed polygon (u, r): out along r_out, back along r_in, its ends at the stations'
    edges (half a grid step past the last station with material)."""
    u = p.u[i0:i1]
    lo, hi = p.r_in[i0:i1].copy(), p.r_out[i0:i1]
    lo[lo < 1e-4] = 0.0                    # on the axis exactly: an edge a hair off it revolves into a sliver OCC refuses
    ua, ub = u[0] - GRID_MM / 2, u[-1] + GRID_MM / 2
    top = simplify(np.c_[np.r_[ua, u, ub], np.r_[hi[0], hi, hi[-1]]])
    bot = simplify(np.c_[np.r_[ua, u, ub], np.r_[lo[0], lo, lo[-1]]])
    return np.vstack([top, bot[::-1]])


def to_brep(p: Profile, axis: Axis):
    """The stock revolved: one solid per piece (a compound once a part-off leaves two)."""
    import cadquery as cq
    solids = []
    for i0, i1 in p.pieces():
        if i1 - i0 < 2:
            continue
        poly = outline(p, i0, i1)
        keep = np.r_[True, np.hypot(*np.diff(poly, axis=0).T) > 1e-7]
        poly = poly[keep]
        if np.hypot(*(poly[0] - poly[-1])) < 1e-7:
            poly = poly[:-1]
        wire = cq.Wire.makePolygon([cq.Vector(*axis.point(a, max(r, 0.0))) for a, r in poly], close=True)
        a0, a1 = axis.point(0.0, 0.0), axis.point(1.0, 0.0)
        solids.append(cq.Solid.revolve(wire, [], 360.0, cq.Vector(*a0), cq.Vector(*a1)))
    if not solids:
        raise ValueError("no stock left")
    return solids[0] if len(solids) == 1 else cq.Compound.makeCompound(solids)


# --- tools -----------------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Tool:
    """A lathe tool's cutting end in lathe coordinates (Z + away from the chuck, X out from the axis), relative to its
    reference point. side "out": it cuts from outside, taking what lies at or above its lower edge; "axis": it cuts
    out from the axis to its upper edge. edge: its outline (a convex polygon, mm)."""
    id: str
    kind: str                   # turn, groove, partoff, drill, center, tap
    side: str
    edge: tuple                 # ((Z, X), ...) convex, counter-clockwise
    nose_r: float
    dia: float | None           # a drill's or tap's
    pitch: float | None
    material: str               # carbide or hss
    width: float | None = None  # a blade's

    @property
    def outline(self) -> np.ndarray:
        return np.array(self.edge, float)


def turning_edge(nose_r: float, lead_deg: float, insert_deg: float, edge_mm: float, hand: str = "R") -> tuple:
    """A turning insert about its nose centre (moonshot/library/lathe_edges.py, the catalogue models' too)."""
    return tuple(lathe_edges.turning(nose_r, lead_deg, insert_deg, edge_mm, hand))


def blade_edge(width: float, corner_r: float, height: float = 25.0) -> tuple:
    """A grooving or parting insert about its bottom centre (moonshot/library/lathe_edges.py)."""
    return tuple(lathe_edges.blade(width, corner_r, height))


def drill_edge(dia: float, point_deg: float, length: float = 200.0) -> tuple:
    """A drill about its point, cutting toward the chuck: the cone out to its radius, then its body back along +Z."""
    r = dia / 2
    lead = r / math.tan(math.radians(point_deg) / 2) if point_deg < 180 else 0.0
    return ((0.0, 0.0), (lead, r), (length, r), (length, -r), (lead, -r))


def _record(tool_id: str) -> dict:
    return json.loads(next(RECORDS.glob(f"*/{tool_id}/{tool_id}.json")).read_text(encoding="utf-8"))


def _mm(s: dict) -> float:
    return float(s["value"]) * (INCH if s.get("unit") == "in" else 1.0)


def tool(tool_id: str) -> Tool:
    """A lathe tool from its catalogue record: what kind it is from its name, its edge from its key specs (nose radius,
    lead and insert angles and cutting edge length; a blade's width and corner radius; a drill's diameter and point)."""
    rec = _record(tool_id)
    spec = {s["name"]: s for s in rec.get("key_specs", [])}
    name = rec["name"].lower()
    material = "carbide" if "carbide" in json.dumps(rec).lower() else "hss"
    if " tap" in name or name.startswith("tap"):
        major, pitch = _thread(spec["Thread"]["value"])
        minor = major - 1.0825 * pitch                     # ISO 68-1's basic minor diameter, as the tap drill
        return Tool(tool_id, "tap", "axis", drill_edge(minor, 180.0), 0.0, minor, pitch, "hss")
    if "drill" in name:
        dia = _mm(spec["Diameter"])
        point = float(spec.get("Point angle", {"value": 118.0})["value"])
        kind = "center" if "center" in name or "centre" in name or "spot" in name else "drill"
        return Tool(tool_id, kind, "axis", drill_edge(dia, point), 0.0, dia, None, material)
    if "part" in name or "groov" in name or "cut-off" in name or "cutoff" in name:
        w, c = _mm(spec["Width"]), _mm(spec["Corner radius"])
        kind = "partoff" if "part" in name or "cut" in name else "groove"
        return Tool(tool_id, kind, "out", blade_edge(w, c), c, None, None, "carbide", width=w)
    nose = _mm(spec["Nose radius"])
    edge = turning_edge(nose, float(spec["Lead angle"]["value"]), float(spec["Insert angle"]["value"]),
                        _mm(spec["Cutting edge length"]), str(spec.get("Hand", {"value": "R"})["value"]))
    return Tool(tool_id, "turn", "out", edge, nose, None, None, "carbide")


def _thread(value: str) -> tuple[float, float]:
    if m := re.match(r"M(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)", value):
        return float(m.group(1)), float(m.group(2))
    m = re.match(r"(\d+)/(\d+)-(\d+)", value)
    return int(m.group(1)) / int(m.group(2)) * INCH, INCH / int(m.group(3))


# --- a setup: the part's axis in lathe coordinates --------------------------------------------------------------------

@dataclass
class Setup:
    """How a lathe setup holds the part: which way along the axis the free end (toward the turret) lies, the work
    zero (the finished face there, model u), and the span the jaws hold (model u), which no pass may come within
    JAW_CLEAR_MM of."""
    side: float                 # +1: the free end is toward +u
    u_zero: float
    jaws: tuple[float, float]

    def z(self, u):
        return self.side * (np.asarray(u, float) - self.u_zero)

    def u(self, z):
        return self.u_zero + self.side * np.asarray(z, float)


def in_model(t: Tool, s: Setup) -> np.ndarray:
    """The tool's outline in (du, r), the model's u: mirrored for a setup whose free end lies toward -u."""
    e = t.outline
    return np.c_[s.side * e[:, 0], e[:, 1]]


# --- sweeping: what a move takes ------------------------------------------------------------------------------------

def _lower_hull(pts: np.ndarray) -> np.ndarray:
    """A point set's lower convex hull, left to right (Andrew's monotone chain)."""
    pts = pts[np.lexsort((pts[:, 1], pts[:, 0]))]
    out: list = []
    for p in pts:
        while len(out) >= 2 and (out[-1][0] - out[-2][0]) * (p[1] - out[-2][1]) - \
                (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0]) <= 0:
            out.pop()
        out.append(p)
    if len(out) > 1 and out[-1][0] - out[-2][0] < 1e-12:      # the right end's vertical side isn't the lower edge
        out.pop()
    return np.array(out)


def _upper_hull(pts: np.ndarray) -> np.ndarray:
    h = _lower_hull(np.c_[pts[:, 0], -pts[:, 1]])
    return np.c_[h[:, 0], -h[:, 1]]


def sweep(p: Profile, edge_model: np.ndarray, side: str, a: np.ndarray, b: np.ndarray) -> None:
    """The stock less what a straight move from a to b (u, r of the reference point) sweeps, in place."""
    pts = np.vstack([edge_model + a, edge_model + b])
    hull = _lower_hull(pts) if side == "out" else _upper_hull(pts)
    lo, hi = hull[:, 0].min(), hull[:, 0].max()
    i0, i1 = max(0, int(math.ceil((lo - p.u0) / GRID_MM))), min(len(p.r_out) - 1, int(math.floor((hi - p.u0) / GRID_MM)))
    if i1 < i0:
        return
    u = p.u0 + GRID_MM * np.arange(i0, i1 + 1)
    r = np.interp(u, hull[:, 0], hull[:, 1])
    if side == "out":
        p.r_out[i0:i1 + 1] = np.minimum(p.r_out[i0:i1 + 1], np.maximum(r, 0.0))
    else:
        p.r_in[i0:i1 + 1] = np.maximum(p.r_in[i0:i1 + 1], np.minimum(r, p.r_out[i0:i1 + 1]))


def lower_of(edge_model: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """An outside tool's lowest edge at each grid offset from its reference point: (offsets in stations, height)."""
    h = _lower_hull(edge_model)
    k = np.arange(int(math.ceil(h[0, 0] / GRID_MM)), int(math.floor(h[-1, 0] / GRID_MM)) + 1)
    return k, np.interp(k * GRID_MM, h[:, 0], h[:, 1])


def dilate(keep: np.ndarray, edge_model: np.ndarray) -> np.ndarray:
    """At each station, the lowest the tool's reference point may stand without its edge going below keep (the
    heights it must leave, -inf where nothing is kept): max over the edge's offsets of keep[i + k] - lower(k)."""
    k, low = lower_of(edge_model)
    n = len(keep)
    out = np.full(n, -np.inf)
    for kk, lv in zip(k, low):
        if kk >= 0:
            src, dst = keep[kk:], slice(0, n - kk)
        else:
            src, dst = keep[:n + kk], slice(-kk, n)
        np.maximum(out[dst], src - lv, out=out[dst])
    return out


def grown(keep: np.ndarray, by: float) -> np.ndarray:
    """keep grown by a radius (a finishing allowance): the dilation by a disc."""
    if by <= 0:
        return keep
    ang = np.radians(np.arange(180.0, 360.0 + 1e-9, 2.0))
    disc = np.c_[by * np.cos(ang), by * np.sin(ang)]
    return dilate(keep, disc)


# --- passes ----------------------------------------------------------------------------------------------------------

@dataclass
class Pass:
    tool: Tool
    rpm: float                                     # the spindle's speed, or its cap under constant surface speed
    feed: float                                    # mm/rev
    css: float | None = None                       # constant surface speed (G96), m/min at the edge, capped by rpm
    moves: list[tuple[float, float, float | None]] = field(default_factory=list)   # (u, r) of the reference, feed
    cuts_at: list[int] = field(default_factory=list)          # move indices after which the stock is shown cut

    def to(self, u: float, r: float, feed: float | None = None) -> None:
        self.moves.append((float(u), float(r), feed))


def run(p: Profile, ps: list[Pass], s: Setup) -> list[tuple[int, int, Profile]]:
    """Cut the stock by each pass's feed moves (rapids cut nothing; a rapid through stock is a crash and raises),
    returning (pass index, move index, the stock after it) at each move a pass shows its cut at."""
    out = []
    for k, ps_ in enumerate(ps):
        e = in_model(ps_.tool, s)
        side = ps_.tool.side
        shown = set(ps_.cuts_at) | {len(ps_.moves) - 1}
        for i in range(1, len(ps_.moves)):
            a, b = np.array(ps_.moves[i - 1][:2]), np.array(ps_.moves[i][:2])
            if ps_.moves[i][2] is None:
                q = p.copy()
                sweep(q, e, side, a, b)
                if ((p.r_out - q.r_out > 0.01) | (q.r_in - p.r_in > 0.01)).sum() > 2:    # more than a face's
                                                                                          # station, 10 µm deep
                    raise ValueError(f"{ps_.tool.id}: a rapid from {a.round(3)} to {b.round(3)} runs into the stock")
            else:
                sweep(p, e, side, a, b)
            if i in shown:
                out.append((k, i, p.copy()))
    return out


def path_points(h: np.ndarray, p: Profile, i0: int, i1: int) -> np.ndarray:
    """The reference's path (u, r) along heights h from station i0 to i1 (either way), simplified."""
    idx = np.arange(i0, i1 + 1) if i1 >= i0 else np.arange(i0, i1 - 1, -1)
    pts = np.c_[p.u0 + GRID_MM * idx, h[idx]]
    return simplify(pts)


def keep_for(p: Profile, part: Profile, span: tuple[float, float], hole_ok: bool = True) -> np.ndarray:
    """What an outside pass must leave at each station: the part's outside within the span (model u), the stock as it
    stands outside it; nothing past the stock's free end. A station the part doesn't reach keeps nothing."""
    u = p.u
    inside = (u >= min(span)) & (u <= max(span))
    part_top = np.where(part.solid(), part.r_out, -np.inf)
    stock_top = np.where(p.solid(), p.r_out, -np.inf)
    return np.where(inside, part_top, stock_top)


def rpm_for(dia_mm: float, v_m_min: float, max_rpm: float) -> float:
    return float(min(max_rpm, round(v_m_min * 1000.0 / (math.pi * max(dia_mm, 1.0)), -1)))


def face(p: Profile, s: Setup, t: Tool, u_face: float, doc: float, rpm: float, feed: float) -> Pass:
    """Facing to u_face: passes across the end, each from above the stock down past the centre, doc apart along Z."""
    ps = Pass(t, rpm, feed)
    lo, hi = p.span()
    u_end = hi if s.side > 0 else lo
    depth = abs(u_end - u_face)
    n = max(1, int(math.ceil(depth / doc - 1e-9)))
    top = float(p.r_out[p.solid()].max()) + CLEAR_MM
    for k in range(1, n + 1):
        uk = u_end - s.side * depth * k / n + s.side * t.nose_r      # the nose centre a radius off the face
        ps.to(uk + s.side * CLEAR_MM, top + t.nose_r)
        ps.to(uk, top + t.nose_r)
        ps.to(uk, -t.nose_r - 0.3, feed)                                # past the centre
        ps.cuts_at.append(len(ps.moves) - 1)
        ps.to(uk + s.side * CLEAR_MM, -t.nose_r - 0.3 + CLEAR_MM)
        ps.to(uk + s.side * CLEAR_MM, top + t.nose_r)
    return ps


def contour(p: Profile, s: Setup, t: Tool, keep: np.ndarray, u_from: float, u_to: float, allowance: float,
            doc: float, rpm: float, feed: float, finish: bool) -> Pass:
    """Turning along the part's shape from u_from (the free end's side) to u_to: rough passes doc apart radially, each
    the finishing path raised, down to allowance over it; or with finish, the one path along the part."""
    ps = Pass(t, rpm, feed)
    e = in_model(t, s)
    h = dilate(grown(keep, allowance), e)
    i0, i1 = p.index(u_from), p.index(u_to)
    lo, hi = min(i0, i1), max(i0, i1)
    top = float(p.r_out[p.solid()].max())
    ref_top = top + CLEAR_MM + t.nose_r
    base = h[lo:hi + 1]
    if not np.isfinite(base).any():
        return ps
    stock_h = dilate(np.where(p.solid(), p.r_out, -np.inf), e)        # where the tool would first touch the stock
    levels = [0.0] if finish else []
    if not finish:
        floor = np.where(np.isfinite(base), base, ref_top)
        reach = (stock_h[lo:hi + 1] - floor).max()
        n = int(math.ceil(max(0.0, reach) / doc - 1e-9))
        levels = [doc * k for k in range(n - 1, -1, -1)]
    for off in levels:
        path_h = np.minimum(np.where(np.isfinite(h), h + off, ref_top), ref_top)
        if not (path_h[lo:hi + 1] < stock_h[lo:hi + 1] - 1e-6).any():
            continue                                                      # this level is all in the air
        pts = path_points(path_h, p, i0, i1)
        ps.to(pts[0, 0] + s.side * CLEAR_MM, ref_top)
        ps.to(pts[0, 0] + s.side * CLEAR_MM, pts[0, 1])
        for u, r in pts:
            ps.to(u, r, feed)
        ps.cuts_at.append(len(ps.moves) - 1)
        ps.to(pts[-1, 0], ref_top, feed)                                  # straight out
    return ps


def plunge(p: Profile, s: Setup, t: Tool, keep: np.ndarray, u_at: float, r_to: float, rpm: float, feed: float,
           u_from: float | None = None) -> Pass:
    """A blade's plunge at u_at (its centre) down to r_to (below 0: past the centre, a part-off), first following the
    part's shape from u_from to u_at if given (a radius or chamfer the blade's corner forms before it cuts through)."""
    ps = Pass(t, rpm, feed)
    e = in_model(t, s)
    top = float(p.r_out[p.solid()].max()) + CLEAR_MM + t.nose_r
    if u_from is not None:
        h = dilate(keep, e)
        h = np.minimum(np.where(np.isfinite(h), h, top), top)           # nothing kept in reach: in the air
        pts = path_points(h, p, p.index(u_from), p.index(u_at))
        ps.to(pts[0, 0], top)
        for u, r in pts:
            ps.to(u, r, feed)
        ps.to(u_at, r_to, feed)
    else:
        ps.to(u_at, top)
        ps.to(u_at, r_to, feed)
    ps.cuts_at.append(len(ps.moves) - 1)
    ps.to(u_at, top)
    return ps


def plunge_rough(p: Profile, s: Setup, t: Tool, keep: np.ndarray, u_from: float, u_to: float, allowance: float,
                 rpm: float, feed: float, step_frac: float = 0.8) -> Pass:
    """A blade's plunge roughing: plunges side by side from u_from to u_to (its centre), step_frac of its width
    apart, each down to allowance over what the operation keeps under it."""
    ps = Pass(t, rpm, feed)
    e = in_model(t, s)
    h = dilate(grown(keep, allowance), e)
    top = float(p.r_out[p.solid()].max()) + CLEAR_MM + t.nose_r
    n = max(1, int(math.ceil(abs(u_to - u_from) / (step_frac * t.width) - 1e-9)))
    for u in np.linspace(u_from, u_to, n + 1):
        r = float(h[p.index(u)])
        if not np.isfinite(r) or r >= top - CLEAR_MM:
            continue
        ps.to(u, top)
        ps.to(u, r, feed)
        ps.cuts_at.append(len(ps.moves) - 1)
        ps.to(u, top)
    return ps


def drill(p: Profile, s: Setup, t: Tool, u_tip: float, rpm: float, feed: float, peck: float | None = None) -> Pass:
    """On the axis from the free end to the point at u_tip, pecking peck deep at a time (G83) if given."""
    ps = Pass(t, rpm, feed)
    lo, hi = p.span()
    u_end = hi if s.side > 0 else lo
    start = u_end + s.side * CLEAR_MM
    ps.to(start + s.side * 5.0, 0.0)
    ps.to(start, 0.0)
    depth = abs(u_tip - start)
    steps = [depth] if not peck else list(np.arange(peck, depth, peck)) + [depth]
    for d in steps:
        ps.to(start - s.side * d, 0.0, feed)
        ps.cuts_at.append(len(ps.moves) - 1)
        ps.to(start, 0.0)
    ps.to(start + s.side * 5.0, 0.0)
    return ps


def tap(p: Profile, s: Setup, t: Tool, u_full: float, rpm: float) -> Pass:
    """Rigid tapping on the axis to the thread's full depth u_full, at the tap's pitch, and back out."""
    ps = Pass(t, rpm, t.pitch)
    lo, hi = p.span()
    u_end = hi if s.side > 0 else lo
    start = u_end + s.side * 3 * t.pitch
    ps.to(start + s.side * 5.0, 0.0)
    ps.to(start, 0.0)
    ps.to(u_full, 0.0, t.pitch)
    ps.cuts_at.append(len(ps.moves) - 1)
    ps.to(start, 0.0, t.pitch)                                    # reversed out at the same pitch
    ps.to(start + s.side * 5.0, 0.0)
    return ps


def program(ps: list[Pass], s: Setup) -> list[dict]:
    """The passes in lathe coordinates: each move [X (diameter), Z, feed mm/rev or None]."""
    return [{"tool": q.tool.id, "rpm": q.rpm, "css_m_min": q.css, "feed_mm_rev": q.feed,
             "moves": [[round(2 * r, 4), round(float(s.z(u)), 4), f] for u, r, f in q.moves]} for q in ps]


def rpm_at(q: Pass, r: float) -> float:
    """The spindle's speed with the edge at radius r: the pass's own, or under constant surface speed the speed that
    gives it there, capped."""
    if not q.css:
        return q.rpm
    return min(q.rpm, q.css * 1000.0 / (math.pi * max(2 * r, 1.0)))


def machine_seconds(ps: list[Pass]) -> list[float]:
    """Each move's end time (s), from the start: feed moves at feed x rpm, rapids at the ST-25's rapid."""
    t, out = 0.0, []
    for q in ps:
        for i, (u, r, f) in enumerate(q.moves):
            if i:
                u0, r0, _ = q.moves[i - 1]
                d = math.hypot(u - u0, r - r0)
                t += d / ((f * rpm_at(q, max(r, r0))) if f else RAPID_MM_MIN) * 60.0
            out.append(t)
        t += 2.0                                                    # an index of the turret between tools
    return out
