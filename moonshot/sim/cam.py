"""The VF-2's cycle for each operation of a process plan (plan §2 O2, §5.1): the moves the machine runs, and the stock
it leaves, cut by the tool's swept volume along those moves.

The stock stays in the part's model frame (its STEP's) and passes from operation to operation and setup to setup. The
paths are worked out in a setup's vise frame (moonshot/motion/loads.py part_pose: world mm with the table at loading,
+z up), from the part's STEP, by operation kind:
- levels (face, profile, pocket, the pads, the ears' tops): at each tool-tip level the tool's centre may go wherever
  its disc clears the part above that level (the union of the part's sections there, its shadow), inside the
  operation's own area. It zig-zags across that region, lines spaced under its radius, then follows its boundary,
  so it sweeps the region grown by its radius; that, extruded up from the level, is the cut.
- holes (drill, ream, tap, counterbore): pecks or a plunge on each hole of the operation's diameter along the setup's
  up axis that opens upward; the cut is the tool's cylinder and point.
- ball (the humps and hollows, and the ridge beside them): straight passes, each at the height where the ball first
  touches the part's profile (a drop cutter); the cut is the region above the passes' lower envelope, extruded along
  them.
Declared shortcuts: a level's cut is computed as the region its path covers rather than swept line by line (the
same region, as the lines are under a radius apart and the boundary is followed); the ball's envelope is a polyline
through it, within 10 µm; a tap is swept as the hole's minor diameter, as the STEP models a tapped hole; where a ball
pass stops short of the ridge, its round end is left out of the cut (it cuts less than the real ball).
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import cadquery as cq
import numpy as np

from moonshot.config import data_root
from moonshot.motion.loads import part_pose
from moonshot.world import vf2

RECORDS = Path(__file__).resolve().parents[1] / "library" / "records" / "assets"
INCH = 25.4
GAUGE_MM = 1.75 * INCH          # the CAT40 holder's nose below the spindle's gauge line (its record, cat40.json)
CLEAR_MM = 10.0                 # rapids this far above the stock
# rpm, and chip load per tooth (mills) or feed per rev (drills, reamers; a tap feeds at its pitch), each inside the
# limits in thresholds.toml's machining.*: surface speed under carbide's 381 or HSS's 152 m/min (half for reamers and
# taps), 0.10-0.30 mm per tooth, 0.8-3.2% of a drill's diameter per rev (twice that for a reamer)
SPEEDS = {"facem": (2300, 0.15), "em12": (8000, 0.10), "em38": (8000, 0.10), "em14": (8000, 0.10),
          "bem14": (8000, 0.10), "drill-2p5": (8000, 0.04), "drill-6": (6000, 0.09), "drill-7": (5500, 0.10),
          "drill-5p5": (7000, 0.08), "ream-3p5": (3000, 0.10), "tap-m3": (1000, None)}
PILOT = {"ream": "drill-2p5", "tap": "drill-2p5"}            # the drill each finishing tool's holes start from
# where an operation may cut, in the part's model frame (mm), as a CAM programmer would choose it from the STEP.
# The ball's passes run along its features' axis over `stations` (model x); past `junction` they stop short of the
# ridge, which `ridge` passes along model x cover; beyond `walls` the profile is held at `wall_top` so the ball
# stays out of the ears' region, which the ears' operation clears
REGIONS = {
    ("nist-ftc-10", "op20", "scallops"): {"profile_at": -20.0, "stations": (-66.0, 26.0), "walls": 62.5,
                                          "wall_top": 22.0, "junction": 15.8, "gap": 10.5,
                                          "ridge": {"profile_at": 40.0, "to": 66.0}},
    ("nist-ftc-10", "op20", "pads"): {"x": (18.0, 66.0)},
    ("nist-ftc-10", "op20", "ear_cbores"): {"abs_x": (57.0, 95.0)},
}


# --- tools -----------------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Tool:
    id: str
    kind: str                   # mill, ball, drill, ream or tap
    dia: float
    teeth: int | None
    oal: float
    point_deg: float | None
    pitch: float | None
    rpm: float
    feed: float                 # mm/min

    @property
    def r(self) -> float:
        return self.dia / 2

    @property
    def stickout(self) -> float:
        return self.oal if self.id == "facem" else self.oal - min(0.35 * self.oal, 30.0)

    @property
    def length(self) -> float:
        """The tip's distance below the spindle's gauge line."""
        return GAUGE_MM + self.stickout

    @property
    def point_mm(self) -> float:
        return self.r / math.tan(math.radians(self.point_deg) / 2) if self.point_deg else 0.0


def tool(tool_id: str) -> Tool:
    rec = json.loads(next(RECORDS.glob(f"*/{tool_id}/{tool_id}.json")).read_text(encoding="utf-8"))
    spec = {s["name"]: s for s in rec.get("key_specs", [])}
    mm = lambda s: float(s["value"]) * (INCH if s.get("unit") == "in" else 1.0)      # noqa: E731
    name = rec["name"].lower()
    kind = ("tap" if " tap" in name else "ream" if "reamer" in name else "drill" if "drill" in name
            else "ball" if "ball" in name else "mill")
    teeth = spec.get("Flutes", spec.get("Inserts"))
    oal = spec.get("Overall length", spec.get("Thickness"))
    pitch = float(re.search(r"x(\d+(?:\.\d+)?)", spec["Thread"]["value"]).group(1)) if kind == "tap" else None
    rpm, load = SPEEDS[tool_id]
    feed = rpm * (pitch if kind == "tap" else load * (teeth["value"] if kind in ("mill", "ball") else 1))
    point = float(spec["Point angle"]["value"]) if "Point angle" in spec else None
    return Tool(tool_id, kind, mm(spec["Diameter"]), int(teeth["value"]) if teeth else None, mm(oal), point, pitch,
                float(rpm), float(feed))


# --- a setup's frame ---------------------------------------------------------------------------------------------------

def _trsf(R: np.ndarray, t: np.ndarray) -> cq.Location:
    from OCP.gp import gp_Trsf
    tr = gp_Trsf()
    tr.SetValues(*R[0], t[0], *R[1], t[1], *R[2], t[2])
    return cq.Location(tr)


@dataclass
class Frame:
    """A setup's vise frame: model point p stands at origin + R @ p (world mm, table at loading)."""
    R: np.ndarray
    origin: np.ndarray

    def world(self, p) -> np.ndarray:
        return self.origin + self.R @ np.asarray(p, float)

    def to_world(self, shape):
        return shape.moved(_trsf(self.R, self.origin))

    def to_model(self, shape):
        return shape.moved(_trsf(self.R.T, -self.R.T @ self.origin))


def joints(p_world: np.ndarray, t: Tool) -> tuple[float, float, float]:
    """The VF-2's axes (mm) that put the tool's tip at this point of the table (world mm with the table at loading):
    the spindle's gauge point is fixed; the table carries the point (moonshot/world/cell.py)."""
    s = vf2.record()["joints"]["spindle"]["centre_mm"]
    return (-p_world[0] + s[0], s[1] - p_world[1], p_world[2] + t.length - s[2])


# --- 2D regions on a level (planar faces at z = 0, OCC) -----------------------------------------------------------------

def _faces(shape) -> list:
    return [] if shape is None else [f for f in shape.Faces() if f.Area() > 1e-6]


def union(faces: list):
    faces = [f for f in faces if f.Area() > 1e-6]
    if not faces:
        return None
    if len(faces) == 1:
        return faces[0]
    fused = faces[0].fuse(*faces[1:])
    try:
        return fused.clean()
    except Exception:                                       # OCC couldn't merge the pieces: keep them as they are
        return fused


def _offset(wire, d: float) -> list:
    bb = wire.BoundingBox()
    if d < 0 and min(bb.xlen, bb.ylen) < -2 * d:
        return []                                           # a hole narrower than the offset closes up
    try:
        return [w for w in wire.offset2D(d, "arc") if w.IsClosed()]
    except Exception:                                       # the wire vanished under the offset
        return []


def contains(region, x: float, y: float) -> bool:
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN
    return any(BRepClass_FaceClassifier(f.wrapped, gp_Pnt(x, y, 0), 1e-6).State() == TopAbs_IN for f in _faces(region))


def grow(region, d: float):
    """The region dilated by d (> 0)."""
    out = []
    for f in _faces(region):
        holes = [w for iw in f.innerWires() for w in _offset(iw, -d)]
        for o in _offset(f.outerWire(), d):
            of = cq.Face.makeFromWires(o)
            inside = [h for h in holes if contains(of, *h.Center().toTuple()[:2])]
            out.append(cq.Face.makeFromWires(o, inside) if inside else of)
    return union(out)


def rect(x0, x1, y0, y1):
    """A rectangle at z = 0 (cadquery's makePlane takes its length along y)."""
    return cq.Face.makePlane(y1 - y0, x1 - x0, cq.Vector((x0 + x1) / 2, (y0 + y1) / 2, 0), cq.Vector(0, 0, 1))


BIG = rect(-3000, 3000, -3000, 3000)


def minus(a, b):
    if a is None:
        return None
    if b is None:
        return a
    return union(_faces(a.cut(b)))


def shrink(region, d: float):
    """The region eroded by d (> 0), as the complement of the complement grown."""
    return minus(region, grow(minus(BIG, region), d))


def raster(region, spacing: float, step: float = 1.0) -> list[np.ndarray]:
    """Zig-zag lines across a region, this far apart, each run kept to where it lies inside."""
    bb = region.BoundingBox()
    edges = [(a, b) for loop in loops(region, 0.2) for a, b in zip(loop, np.roll(loop, -1, axis=0))]
    if not edges:
        return []
    a, b = np.array([e[0] for e in edges]), np.array([e[1] for e in edges])
    out = []
    xs = np.arange(bb.xmin, bb.xmax + step, step)
    for i, y in enumerate(np.arange(bb.ymin + spacing / 2, bb.ymax, spacing)):
        crosses = (a[:, 1] > y) != (b[:, 1] > y)              # even-odd: boundary crossings left of each point
        xc = a[crosses, 0] + (y - a[crosses, 1]) * (b[crosses, 0] - a[crosses, 0]) / (b[crosses, 1] - a[crosses, 1])
        inside = (xc[None, :] < xs[:, None]).sum(axis=1) % 2 == 1
        runs = np.flatnonzero(np.diff(np.r_[0, inside.astype(int), 0]))
        for i0, i1 in zip(runs[::2], runs[1::2]):
            line = np.array([[xs[i0], y], [xs[i1 - 1], y]])           # a straight run: its two ends
            out.append(line if i % 2 == 0 else line[::-1])
    return out


def extrude(region, z0: float, z1: float):
    """A region (faces at z = 0) as a solid from z0 up to z1."""
    solids = [cq.Solid.extrudeLinear(f.moved(cq.Location(cq.Vector(0, 0, z0))), cq.Vector(0, 0, z1 - z0))
              for f in _faces(region)]
    return solids[0] if len(solids) == 1 else cq.Compound.makeCompound(solids)


def sample(edge, step: float) -> np.ndarray:
    """Points along an edge about every step mm, evenly in its parameter."""
    n = max(2, int(math.ceil(edge.Length() / step)) + 1)
    u0, u1 = edge._bounds()
    return np.array([v.toTuple() for v in edge.positions(np.linspace(u0, u1, n).tolist(), mode="parameter")])


def loops(region, step: float = 1.0) -> list[np.ndarray]:
    """Each boundary wire of a region as a closed polyline (x, y), sampled about every step mm."""
    from OCP.BRepTools import BRepTools_WireExplorer
    out = []
    for f in _faces(region):
        for w in [f.outerWire(), *f.innerWires()]:
            pts, ex = [], BRepTools_WireExplorer(w.wrapped)
            edges = []
            while ex.More():
                edges.append(cq.Edge(ex.Current()))
                ex.Next()
            for e in edges or w.Edges():                       # a wire the explorer can't walk: its edges as stored
                if e.Length() < 1e-6:
                    continue
                p = sample(e, step)[:, :2]
                if pts and np.linalg.norm(pts[-1][-1] - p[0]) > np.linalg.norm(pts[-1][-1] - p[-1]):
                    p = p[::-1]
                pts.append(p)
            if pts:
                out.append(np.vstack(pts))
    return out


# --- the part in a setup: sections and features ----------------------------------------------------------------------

class PartInSetup:
    def __init__(self, part, frame: Frame):
        self.part, self.frame = part, frame
        self.world = frame.to_world(part)
        bb = self.world.BoundingBox()
        self.top, self.bottom, self.centre = bb.zmax, bb.zmin, bb.center
        self._sections: dict[float, object] = {}

    def section(self, z: float):
        """The part's section at height z, as faces at z = 0."""
        z = round(z, 3)
        if z not in self._sections:
            c = self.centre
            for dz in (0.0, 0.003, -0.003, 0.03, -0.03, 0.1, -0.1):   # this STEP's booleans fail where a plane
                                                                         # grazes a cylinder; a hair off, they don't
                plane = cq.Face.makePlane(800, 800, cq.Vector(c.x, c.y, z + dz), cq.Vector(0, 0, 1))
                try:
                    s = self.world.intersect(plane)
                    break
                except ValueError:
                    continue
            else:
                raise ValueError(f"the part can't be sectioned near z = {z}")
            self._sections[z] = union([f.moved(cq.Location(cq.Vector(0, 0, -z - dz))) for f in _faces(s)])
        return self._sections[z]

    def solid_at(self, x: float, y: float, z: float) -> bool:
        from OCP.BRepClass import BRepClass_FaceClassifier
        from OCP.gp import gp_Pnt
        from OCP.TopAbs import TopAbs_IN
        for f in _faces(self.section(z)):
            if BRepClass_FaceClassifier(f.wrapped, gp_Pnt(x, y, 0), 1e-6).State() == TopAbs_IN:
                return True
        return False

    def faces_in(self, area) -> list:
        """The part's faces (world) whose footprint meets an area (faces at z = 0)."""
        if area is None:
            return self.world.Faces()
        ab = area.BoundingBox()
        return [f for f in self.world.Faces() if (b := f.BoundingBox()).xmax >= ab.xmin and b.xmin <= ab.xmax
                and b.ymax >= ab.ymin and b.ymin <= ab.ymax]

    def heights(self, area, lo: float, hi: float, planes_only: bool = False) -> list[float]:
        """Where the part's shape changes over an area, between lo and hi: each face's ends, just inside it."""
        hs = set()
        for f in self.faces_in(area):
            b = f.BoundingBox()
            if planes_only and not (f.geomType() == "PLANE" and b.zlen < 1e-3):
                continue
            for z in ((b.zmin + 0.01, b.zmax - 0.01) if b.zlen > 0.02 else (b.zmin - 0.01, b.zmin + 0.01)):
                if lo - 1e-6 <= z <= hi + 1e-6:
                    hs.add(round(z, 2))
        out = []
        for z in sorted(hs, reverse=True):                     # heights closer than 0.25 mm section alike
            if not out or out[-1] - z >= 0.25:
                out.append(z)
        return out

    def shadow(self, heights: list[float]):
        return union([f for z in heights for f in _faces(self.section(z))])


def _model_to_world_area(frame: Frame, part_world_bb, region: dict):
    """An operation's area (REGIONS) as faces at z = 0 in the vise frame; model x is the frame's x where it's used."""
    ys = (part_world_bb.ymin - 50, part_world_bb.ymax + 50)
    xs = lambda a, b: sorted((frame.world([a, 0, 0])[0], frame.world([b, 0, 0])[0]))      # noqa: E731
    if "x" in region:
        x0, x1 = xs(*region["x"])
        return rect(x0, x1, *ys)
    a, b = region["abs_x"]
    return union([rect(*xs(a, b), *ys), rect(*xs(-b, -a), *ys)])


# --- cycles ----------------------------------------------------------------------------------------------------------

@dataclass
class Pass:
    tool: Tool
    moves: list[tuple[np.ndarray, float | None]] = field(default_factory=list)   # tip (world mm), feed or None: rapid
    cuts: list[tuple[int, object]] = field(default_factory=list)                 # (move done at, solid in model frame)

    def to(self, p, feed=None):
        self.moves.append((np.asarray(p, float), feed))

    def cut(self, solid_world, frame: Frame):
        self.cuts.append((len(self.moves) - 1, frame.to_model(solid_world)))


@dataclass
class Cycle:
    part: str
    setup: str
    op: dict
    frame: Frame
    passes: list[Pass]
    clear_z: float

    @property
    def step(self) -> str:
        return f"{self.setup}-{self.op['id']}"


class Planner:
    """Plans a part's operations one at a time against the stock as it is when each starts."""

    def __init__(self, plan: dict):
        self.plan = plan
        self.part = cq.importers.importStep(str(data_root() / "parts" / plan["part"] / "part.step")).val()
        self._setups: dict[str, PartInSetup] = {}

    def frame(self, setup_id: str) -> Frame:
        pose = part_pose(self.plan, setup_id)
        return Frame(np.asarray(pose["R"], float), np.asarray(pose["origin_mm"], float))

    def in_setup(self, setup_id: str) -> PartInSetup:
        if setup_id not in self._setups:
            self._setups[setup_id] = PartInSetup(self.part, self.frame(setup_id))
        return self._setups[setup_id]

    def stock0(self):
        """The plan's blank, centred on the part in x and z, faced FACE_A off datum A (as loads.envelope)."""
        from moonshot.motion.loads import envelope
        env = envelope(self.plan, self.plan["setups"][0]["id"])
        return cq.Solid.makeBox(*(env[:, 1] - env[:, 0]), cq.Vector(*env[:, 0]))

    def cycle(self, setup: dict, op: dict, stock) -> Cycle:
        ps = self.in_setup(setup["id"])
        sw = ps.frame.to_world(stock).BoundingBox()
        c = Cycle(self.plan["part"], setup["id"], op, ps.frame, [], sw.zmax + CLEAR_MM)
        kind = op["kind"]
        if kind == "face":
            c.passes = [self.face(ps, sw, tool(op["tool"]))]
        elif kind == "profile":
            c.passes = [self.profile(ps, sw, tool(op["tool"]))]
        elif kind == "ball_mill":
            c.passes = [self.ball(ps, sw, tool(op["tool"]), REGIONS[(self.plan["part"], setup["id"], op["id"])])]
        elif kind == "pocket" or (kind == "counterbore" and (self.plan["part"], setup["id"], op["id"]) in REGIONS):
            c.passes = [self.levels(ps, sw, tool(op["tool"]), self.area(ps, setup, op))]
        else:
            t = tool(op["tool"])
            dia = self.hole_dia(op)
            holes = self.holes(ps, dia)
            for tid in ([PILOT[t.kind]] if t.kind in PILOT else []) + [t.id]:
                p = self.drill(ps, sw, tool(tid), holes, dia, kind == "counterbore")
                if p.cuts:
                    c.passes.append(p)
        return c

    # --- areas ---

    def area(self, ps: PartInSetup, setup: dict, op: dict):
        """Where a level operation's tool centre may go (faces at z = 0): the pocket's opening, or REGIONS."""
        key = (self.plan["part"], setup["id"], op["id"])
        if key in REGIONS:
            return _model_to_world_area(ps.frame, ps.world.BoundingBox(), REGIONS[key])
        top = _faces(ps.section(ps.top - 0.3))
        holes = [w for f in top for w in f.innerWires()]
        return cq.Face.makeFromWires(max(holes, key=lambda w: cq.Face.makeFromWires(w).Area()))

    # --- face: zig-zag across the stock with the face mill ---

    def face(self, ps: PartInSetup, sw, t: Tool) -> Pass:
        p = Pass(t)
        top, goal = sw.zmax, ps.top
        n = max(1, math.ceil((top - goal) / 3.5 - 1e-9))
        ys = np.arange(sw.ymin + 0.3 * t.dia, sw.ymax - 0.3 * t.dia + 0.75 * t.dia, 0.75 * t.dia)
        x0, x1 = sw.xmin - t.r - 5, sw.xmax + t.r + 5
        for k in range(1, n + 1):
            z = top - (top - goal) * k / n
            for i, y in enumerate(ys):
                a, b = (x0, x1) if i % 2 == 0 else (x1, x0)
                if i == 0:
                    p.to([a, y, top + CLEAR_MM])
                    p.to([a, y, z], t.feed)
                else:
                    p.to([a, y, z], t.feed)
                p.to([b, y, z], t.feed)
            p.to([p.moves[-1][0][0], ys[-1], top + CLEAR_MM])
            # the passes overlap and run off both ends, so together they sweep the stock's whole face
            p.cut(cq.Solid.makeBox(sw.xlen + 2, sw.ylen + 2, top + CLEAR_MM - z, cq.Vector(sw.xmin - 1, sw.ymin - 1, z)),
                  ps.frame)
        return p

    # --- profile: round the part's silhouette, down through the stock ---

    def profile(self, ps: PartInSetup, sw, t: Tool) -> Pass:
        sil = ps.shadow(ps.heights(None, ps.bottom, ps.top, planes_only=True))
        centres = minus(grow(sil, 1.5 * t.r), grow(sil, t.r))
        top, bottom = sw.zmax, sw.zmin - 0.5
        n = max(1, math.ceil((top - bottom) / t.dia - 1e-9))
        p = Pass(t)
        swept = grow(centres, t.r)
        for k in range(1, n + 1):
            z = top - (top - bottom) * k / n
            self._follow(p, loops(centres), z, top)
            p.cut(extrude(swept, z, top + CLEAR_MM),
                  ps.frame)
        return p

    def _follow(self, p: Pass, paths: list[np.ndarray], z: float, top: float):
        for path in paths:
            p.to([*path[0], top + CLEAR_MM])
            p.to([*path[0], top + 1.0])
            for q in path:
                p.to([*q, z], p.tool.feed)
            p.to([*path[-1], top + CLEAR_MM])

    # --- levels: clear an area level by level, clear of the part ---

    def levels(self, ps: PartInSetup, sw, t: Tool, area) -> Pass:
        top = sw.zmax
        flat = [f for f in ps.faces_in(grow(area, t.r)) if f.geomType() == "PLANE"]
        ups = [f for f in flat if f.BoundingBox().zlen < 1e-3 and f.normalAt().z > 0.99]
        floor = min(f.BoundingBox().zmin for f in ups if contains(area, f.Center().x, f.Center().y))
        crit = ps.heights(grow(area, t.r), floor, top)
        # the tool stops at each floor, and just above where each wall meets the fillet at its foot; the shadow
        # still comes from every height where the part changes (crit)
        stops = {f.BoundingBox().zmin for f in ups} | \
                {f.BoundingBox().zmin + 0.01 for f in flat if abs(f.normalAt().z) < 1e-3}
        levels = []
        for z in sorted({round(z, 2) for z in stops if floor - 0.02 <= z < top - 0.25} | {round(floor, 2)},
                        reverse=True):
            if levels and levels[-1] - z < 0.25:               # a sliver of a level breaks the stock's B-rep:
                levels[-1] = z                                 # the lower one stands, so a floor stays exact
            else:
                levels.append(z)
        filled = [top]
        for z in levels:                                       # at most half the tool's diameter a level
            while filled[-1] - z > 0.5 * t.dia + 1e-6:
                filled.append(filled[-1] - 0.5 * t.dia)
            filled.append(z)
        p, shadow, used = Pass(t), None, set()
        for z in filled[1:]:
            new = [h for h in crit if h > z + 1e-3 and h not in used] + [z + 0.01]
            used |= set(new)
            shadow = union(_faces(shadow) + _faces(ps.shadow(new)))
            centres = minus(area, grow(shadow, t.r)) if shadow is not None else area
            if centres is None:
                continue
            self._follow(p, raster(centres, 0.8 * t.r) + loops(centres), z, top)
            swept = grow(centres, t.r)
            p.cut(extrude(swept, z, top + CLEAR_MM),
                  ps.frame)
        return p

    # --- holes ---

    @staticmethod
    def hole_dia(op: dict) -> float:
        holes = [f["dia_mm"] for f in op.get("features", []) if f["type"] == "hole"]
        return holes[0] if holes else float(re.search(r"Ø(\d+(?:\.\d+)?)", op["what"]).group(1))

    def holes(self, ps: PartInSetup, dia: float) -> list[tuple[np.ndarray, float, bool]]:
        """Each hole of this diameter along the setup's up axis that opens upward: (axis point x, y), the world height
        its full diameter reaches, and whether it opens below too."""
        out = {}
        for f in ps.world.Faces():
            if f.geomType() != "CYLINDER":
                continue
            from OCP.BRepAdaptor import BRepAdaptor_Surface
            cyl = BRepAdaptor_Surface(f.wrapped).Cylinder()
            d = cyl.Axis().Direction()
            if abs(cyl.Radius() * 2 - dia) > 0.01 or abs(abs(d.Z()) - 1) > 1e-6:
                continue
            loc = cyl.Axis().Location()
            key = (round(loc.X(), 2), round(loc.Y(), 2))
            b = f.BoundingBox()
            out.setdefault(key, []).append((b.zmin, b.zmax))
        ring = [(math.cos(a), math.sin(a)) for a in np.linspace(0, 2 * math.pi, 8, endpoint=False)]
        cone = dia / 2 / math.tan(math.radians(59.0))          # the STEP's own 118 deg points
        spans = []                                             # an axis's walls, joined where they meet: two holes
        for key, walls in sorted(out.items()):                 # on one axis (a counterbore from each side) stay two
            for lo, hi in sorted(walls):
                if spans and spans[-1][0] == key and lo <= spans[-1][2] + 1e-3:
                    spans[-1][2] = max(spans[-1][2], hi)
                else:
                    spans.append([key, lo, hi])
        holes = []
        for (x, y), lo, hi in spans:
            pts = [(x, y)] + [(x + (dia / 2 - 0.05) * c, y + (dia / 2 - 0.05) * s) for c, s in ring]
            if any(ps.solid_at(px, py, hi + 0.5) for px, py in pts):
                continue                                       # covered above: it opens the other way
            holes.append((np.array([x, y]), lo, not ps.solid_at(x, y, lo - cone - 0.3)))
        return holes

    def drill(self, ps: PartInSetup, sw, t: Tool, holes, dia: float, flat: bool) -> Pass:
        """A plunge (pecks past 3 diameters) per hole; a flat tool smaller than the hole goes round it in a helix."""
        p, top = Pass(t), sw.zmax
        r_cut = dia / 2 if t.kind == "tap" or flat else t.r
        for xy, lo, through in holes:
            full = lo - (t.point_mm + 1.0 if through and t.kind in ("drill", "ream") else 0.0)
            tip = full - (t.point_mm if t.kind == "drill" else 0.0)
            p.to([*xy, top + CLEAR_MM])
            p.to([*xy, top + 2.0])
            if flat and dia > t.dia + 0.01:
                e = dia / 2 - t.r
                angles = np.linspace(0, 2 * math.pi, 13)
                z = top + 0.5
                while z > tip + 1e-6:
                    z_next = max(tip, z - 1.5)
                    for k, a in enumerate(angles):
                        p.to([xy[0] + e * math.cos(a), xy[1] + e * math.sin(a), z + (z_next - z) * k / 12], t.feed)
                    z = z_next
                for a in angles:
                    p.to([xy[0] + e * math.cos(a), xy[1] + e * math.sin(a), tip], t.feed)
                p.to([*xy, tip], t.feed)
            elif t.kind == "tap":
                p.to([*xy, tip], t.feed)
                p.to([*xy, top + 2.0], t.feed)                 # backs out, reversed, at its pitch
            else:
                depth, peck = top + 2.0 - tip, (t.dia if top - tip > 3 * t.dia else np.inf)
                reached = top + 2.0
                while reached > tip + 1e-6:
                    nxt = max(tip, reached - peck)
                    if reached < top + 2.0:
                        p.to([*xy, reached + 0.5])
                    p.to([*xy, nxt], t.feed)
                    reached = nxt
                    if reached > tip + 1e-6:
                        p.to([*xy, top + 2.0])
                _ = depth
            p.to([*xy, top + CLEAR_MM])
            h = top + CLEAR_MM - full
            solid = cq.Solid.makeCylinder(r_cut, h, cq.Vector(xy[0], xy[1], full), cq.Vector(0, 0, 1))
            if t.kind == "drill":
                solid = solid.fuse(cq.Solid.makeCone(r_cut, 0.0, full - tip, cq.Vector(xy[0], xy[1], full),
                                                     cq.Vector(0, 0, -1)))
            p.cut(solid, ps.frame)
        return p

    # --- the ball end mill's raster ---

    def ball(self, ps: PartInSetup, sw, t: Tool, cfg: dict) -> Pass:
        """Passes along the humps' axis (model z), then along the ridge's (model x). A pass's height is where the ball
        first touches the part's profile across it (a drop cutter on the section's edges)."""
        f, R, top = ps.frame, t.r, sw.zmax
        ex, ez = f.R @ [1, 0, 0], f.R @ [0, 0, 1]              # model x and z in the vise frame
        p = Pass(t)

        def profile(normal_model, at: float, along_model) -> np.ndarray:
            """The part's section by the plane normal_model . p = at, as points (along_model . p, world height)."""
            n_w, a_w = f.R @ np.asarray(normal_model, float), f.R @ np.asarray(along_model, float)
            o = f.world(np.asarray(normal_model, float) * at)
            plane = cq.Face.makePlane(800, 800, cq.Vector(*o), cq.Vector(*n_w))
            pts = [v for e in ps.world.intersect(plane).Edges()
                   for v in sample(e, 0.02)]
            q = np.array(pts)
            return np.c_[(q - f.origin) @ a_w, q[:, 2]]

        def drop(prof: np.ndarray, s: np.ndarray) -> np.ndarray:
            out = np.full(len(s), -np.inf)
            for i, si in enumerate(s):
                d = prof[:, 0] - si
                near = np.abs(d) <= R
                if near.any():
                    out[i] = np.max(prof[near, 1] + np.sqrt(R * R - d[near] ** 2))
            return out

        def envelope(st: np.ndarray, c: np.ndarray) -> np.ndarray:
            s = np.arange(st[0] - R, st[-1] + R - 0.05, 0.5)
            s = np.unique(np.round(np.r_[s, st - R, st + R], 4))
            s = s[np.r_[True, np.diff(s) > 0.01]]
            e = np.full(len(s), np.inf)
            for si, ci in zip(st, c):
                d = s - si
                ok = np.abs(d) <= R + 1e-6
                e[ok] = np.minimum(e[ok], ci - np.sqrt(np.maximum(R * R - d[ok] ** 2, 0)))
            return np.c_[s, e]

        def prism(env: np.ndarray, across, along, a0: float, a1: float):
            """The region above an envelope (s across, world height), extruded along from a0 to a1."""
            if not np.isfinite(env).all():
                bad = env[~np.isfinite(env).all(axis=1)]
                raise ValueError(f"the ball's envelope has no height at {len(bad)} points, from s = {bad[0, 0]:.2f}")
            pts = [env[0, 0] * across + env[0, 1] * np.array([0, 0, 1.0])] + \
                  [s * across + h * np.array([0, 0, 1.0]) for s, h in env] + \
                  [env[-1, 0] * across + (top + CLEAR_MM) * np.array([0, 0, 1.0]),
                   env[0, 0] * across + (top + CLEAR_MM) * np.array([0, 0, 1.0])]
            o = f.origin * np.array([1, 1, 0]) + a0 * along
            from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
            from OCP.gp import gp_Dir, gp_Pln, gp_Pnt
            w = cq.Wire.makePolygon([cq.Vector(*(o + q)) for q in pts[1:]], close=True)
            plane = gp_Pln(gp_Pnt(*o), gp_Dir(*np.cross(across, [0, 0, 1.0])))     # given, not found from the points
            face = cq.Face(BRepBuilderAPI_MakeFace(plane, w.wrapped, True).Face())
            return cq.Solid.extrudeLinear(face, cq.Vector(*((a1 - a0) * along)))

        # the humps: passes along model z at stations in model x
        prof = profile([0, 0, 1], cfg["profile_at"], [1, 0, 0])
        wall = cfg["walls"]
        beyond = np.arange(-wall - 2 * R - 2, wall + 2 * R + 2, 0.05)
        beyond = beyond[np.abs(beyond) > wall]
        prof = np.r_[prof, np.c_[beyond, np.full(len(beyond), f.world([0, cfg["wall_top"], 0])[2])]]
        st = np.arange(cfg["stations"][0], cfg["stations"][1] + 1e-9, 0.5)
        c = drop(prof, st)
        zs = np.array([-37.5 - R - 3, 37.5 + R + 3])            # model z, past both sides
        gap = cfg["gap"]
        a_lo = lambda z: float((f.world([0, 0, z]) - f.origin) @ ez)    # noqa: E731
        groups = np.array_split(np.arange(len(st)), max(1, len(st) // 18))
        for g in groups:
            for i in g:
                s0 = f.world([st[i], 0, 0])
                span = [(zs[0], zs[1])] if st[i] < cfg["junction"] else [(zs[0], -gap), (gap, zs[1])]
                if i % 2:
                    span = [(b, a) for a, b in reversed(span)]
                for a, b in span:
                    pa = s0 + (f.R @ [0, 0, a]) + [0, 0, c[i] - R - s0[2]]
                    pb = s0 + (f.R @ [0, 0, b]) + [0, 0, c[i] - R - s0[2]]
                    p.to([*pa[:2], top + CLEAR_MM])
                    p.to(pa, t.feed)
                    p.to(pb, t.feed)
                    p.to([*pb[:2], top + CLEAR_MM])
            full = [i for i in g if st[i] < cfg["junction"]]
            split = [i for i in g if st[i] >= cfg["junction"]]
            for sel, spans in ((full, [(zs[0], zs[1])]), (split, [(zs[0], -gap), (gap, zs[1])])):
                if not sel:
                    continue
                env = envelope(st[sel], c[sel])
                for a, b in spans:
                    lo, hi = sorted((a_lo(a), a_lo(b)))
                    p.cut(prism(env, ex, ez, lo, hi), f)
        # the ridge: passes along model x at stations in model z, from where the humps fall below the pass
        rc = cfg["ridge"]
        prof2 = profile([1, 0, 0], rc["profile_at"], [0, 0, 1])
        st2 = np.arange(-gap, gap + 1e-9, 0.5)
        c2 = drop(prof2, st2 * (ez @ (f.R @ [0, 0, 1])))
        fine = np.arange(cfg["stations"][0], cfg["stations"][1], 0.1)
        c1 = drop(prof, fine)
        starts = []
        for ci in c2:
            higher = np.nonzero(c1 > ci + 1e-3)[0]
            starts.append((fine[higher[-1]] if len(higher) else fine[0]) + 1.5)
        groups = np.array_split(np.arange(len(st2)), max(1, len(st2) // 6))
        ax = lambda x: float((f.world([x, 0, 0]) - f.origin) @ ex)      # noqa: E731
        for g in groups:
            x0 = max(starts[i] for i in g)
            for i in g:
                a, b = (x0, rc["to"]) if i % 2 == 0 else (rc["to"], x0)
                pa = f.world([a, 0, st2[i]]) * [1, 1, 0] + [0, 0, c2[i] - R]
                pb = f.world([b, 0, st2[i]]) * [1, 1, 0] + [0, 0, c2[i] - R]
                p.to([*pa[:2], top + CLEAR_MM])
                p.to(pa, t.feed)
                p.to(pb, t.feed)
                p.to([*pb[:2], top + CLEAR_MM])
            s_w = st2[g] * (ez @ (f.R @ [0, 0, 1]))
            order = np.argsort(s_w)
            env = envelope(s_w[order], c2[g][order])
            lo, hi = sorted((ax(x0), ax(rc["to"])))
            p.cut(prism(env, ez, ex, lo, hi), f)
        # the junction, where the ridge meets the last hump: passes along model x ride both, so a pass's height varies
        # along it; the cut is the surface the ball's lowest points sweep there, through a 0.5 mm grid (within 10 µm),
        # as a solid of its triangles under a lid. It ignores the ridge's blend into the hump, which the ball may graze
        # (an exempt blend)
        xa, xb = cfg["junction"], max(starts)
        xs = np.arange(xa, xb + 1e-9, 0.1)
        C = np.maximum(drop(prof, xs)[None, :], c2[:, None])            # (pass, x): the ball's centre, world height
        for i, z in enumerate(st2):
            order = slice(None, None, 5 if i % 2 == 0 else -5)            # a move every 0.5 mm, zig-zag
            pts = [f.world([x, 0, z]) * [1, 1, 0] + [0, 0, h - R] for x, h in zip(xs[order], C[i][order])]
            p.to([*pts[0][:2], top + CLEAR_MM])
            for q in pts:
                p.to(q, t.feed)
            p.to([*pts[-1][:2], top + CLEAR_MM])
        gx, gz = np.linspace(xa, xb, int(round((xb - xa) / 0.5)) + 1), np.linspace(-gap, gap, int(round(2 * gap / 0.5)) + 1)
        S = np.full((len(gz), len(gx)), np.inf)
        for i, z in enumerate(st2):
            r2 = R * R - (gz[:, None, None] - z) ** 2 - (gx[None, :, None] - xs[None, None, :]) ** 2
            S = np.minimum(S, np.where(r2 >= 0, C[i] - np.sqrt(np.maximum(r2, 0)), np.inf).min(axis=2))
        P = np.array([[f.world([x, 0, z]) * [1, 1, 0] + [0, 0, S[i, j]] for j, x in enumerate(gx)]
                      for i, z in enumerate(gz)])
        lid = top + CLEAR_MM
        V = lambda q: cq.Vector(*map(float, q))                         # noqa: E731
        tri = lambda *q: cq.Face.makeFromWires(cq.Wire.makePolygon([V(v) for v in q], close=True))   # noqa: E731
        faces = [tri(P[i, j], P[i, j + 1], P[i + 1, j + 1]) for i in range(len(gz) - 1) for j in range(len(gx) - 1)]
        faces += [tri(P[i, j], P[i + 1, j + 1], P[i + 1, j]) for i in range(len(gz) - 1) for j in range(len(gx) - 1)]
        up = lambda q: np.r_[q[:2], lid]                                # noqa: E731
        for edge in (P[0, :], P[-1, :], P[:, 0], P[:, -1]):             # four walls up to the lid, and the lid
            faces.append(cq.Face.makeFromWires(cq.Wire.makePolygon([V(q) for q in edge] + [V(up(edge[-1])), V(up(edge[0]))],
                                                                   close=True)))
        faces.append(cq.Face.makeFromWires(cq.Wire.makePolygon([V(up(q)) for q in (P[0, 0], P[0, -1], P[-1, -1], P[-1, 0])],
                                                               close=True)))
        p.cut(cq.Solid.makeSolid(cq.Shell.makeShell(faces)), f)
        return p


def cut(stock, solid, nudged: bool = False):
    """The stock less a cut; pieces cut free fall away (the largest solid stays). Where OCC's boolean fails, it
    tries again with a fuzzy tolerance (1 µm, then 10), then one piece of the cut at a time, then grown a hair."""
    fallback = None
    for tol in (None, 1e-3, 1e-2):
        try:
            solids = stock.cut(solid, tol=tol).Solids()
        except ValueError:
            continue
        if solids:
            out = max(solids, key=lambda s: s.Volume())
            if out.isValid():
                return out
            fallback = fallback or out                         # a result OCC itself finds faulty: a last resort
    if fallback is not None and nudged:
        return fallback
    pieces = solid.Solids()
    if len(pieces) > 1:
        for piece in pieces:
            stock = cut(stock, piece)
        return stock
    if not nudged:                                            # faces coinciding with an earlier cut's: grown by
        from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform   # under a micron, they no longer coincide
        from OCP.gp import gp_Pnt, gp_Trsf
        c, tr = solid.Center(), gp_Trsf()
        tr.SetScale(gp_Pnt(c.x, c.y, c.z), 1 + 2e-5)
        return cut(stock, cq.Shape.cast(BRepBuilderAPI_Transform(solid.wrapped, tr, True).Shape()), nudged=True)
    raise ValueError("OCC can't make this cut")

