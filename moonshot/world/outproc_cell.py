"""The outside-process rack as a cell for a body model's takes (plan §3.2): the station
(moonshot/library/stations/outproc_rack.json), the finished part on its coating shelf and the tagged kraft bag it goes
into, set into the body model's MJCF the way moonshot/world/bench_cell.py sets in the inspection bench.

World millimetres in the rack's frame (front at -Y, floor at z = 0). The rack is static: its posts and its three
shelves collide, the bottom and top shelves' totes are drawn only. Its geoms ride on a static body, `outproc_rack`,
so the take record carries them and the render draws them. Each loose object's body frame is its own:
- the part: as finished, in its STEP's frame (SEND_OUT: its colliders are boxes read off the STEP's planar faces, its
  holes and fillets left out), resting on its most stable face. Steel, stiff contact, as the bench's parts.
- the bag: a kraft parts bag standing open, its top rolled down (the station's `bag`), its frame at the middle of its
  underside; its tag hangs from its near wall's rim, drawn only.

A part the right hand carries is held by the declared shortcut `carry_part`, a stiff weld to the hand where the part
sits when the hand closes on it (moonshot/sim/bench.py), as the bench's tools are.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

RECORD = Path(__file__).resolve().parents[1] / "library" / "stations" / "outproc_rack.json"
M = 0.001
FLOOR = '    <geom name="floor" type="plane" size="3 3 0.1" contype="1" conaffinity="3" rgba="0.25 0.25 0.25 1"/>\n'
STEEL_KG_M3 = 7850.0                  # 4140, both send-out parts' steel (their plans' stock)


def record() -> dict:
    return json.loads(RECORD.read_text(encoding="utf-8"))


def shelf_top_mm(name: str = "coating") -> float:
    return record()["rack"]["shelves_mm"][name][1][2]


@dataclass(frozen=True)
class FinishedPart:
    """A finished part as the rack's take handles it, in its STEP's frame (mm): its colliders, its steel's mass (the
    STEP's volume), and how it lies on the shelf (rest: the STEP's axes in the world's, columns x y z). The right
    hand picks it up by `grip`: the thumb on the face with outward normal `thumb_n` at `thumb_at`, the index and
    middle on the face opposite at `finger_at` (each pad's centre, mm, STEP frame), from above, either side of it
    `spread` (mm, its least and most) along the world's x as the part lies."""
    name: str
    boxes: dict
    volume_mm3: float
    rest: tuple
    thumb_at: tuple
    finger_at: tuple
    thumb_n: tuple
    spread: tuple

    @property
    def kg(self) -> float:
        return self.volume_mm3 * 1e-9 * STEEL_KG_M3

    @property
    def R(self) -> np.ndarray:
        return np.array(self.rest, float)

    def lo_hi(self) -> tuple[np.ndarray, np.ndarray]:
        """The colliders' bounds in the STEP's frame."""
        lo = np.min([b[0] for b in self.boxes.values()], 0)
        hi = np.max([b[1] for b in self.boxes.values()], 0)
        return np.asarray(lo, float), np.asarray(hi, float)

    def world_extent(self) -> tuple[np.ndarray, np.ndarray]:
        """Its colliders' bounds as it lies (the rest turn applied, origin at 0)."""
        lo, hi = self.lo_hi()
        c = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]) @ self.R.T
        return c.min(0), c.max(0)


def _cols(*cols) -> tuple:
    """A rotation given by where the STEP's x, y and z go in the world (columns), as nested tuples."""
    return tuple(tuple(float(v) for v in row) for row in np.stack(cols, 1))


# The send-out parts. Each lies on its widest flat face and is picked up by what stands up from it, pinched from
# above with the thumb toward the operator (-Y) and the index and middle away from them, clear of its holes.
SEND_OUT = {
    # The L-block on its bottom, the upright leg toward the operator, the long leg away: picked up by the upright,
    # thumb on its back, the fingers in the L's corner, above the two tapped holes through it (Z 31.7-36.8)
    "ct-slbeam": FinishedPart(
        name="ct-slbeam",
        boxes={"part_base": ((0.0, 0.0, 0.0), (76.2, 38.1, 19.05)),
               "part_upright": ((0.0, 0.0, 19.05), (19.05, 38.1, 50.8))},
        volume_mm3=75138.9,
        rest=_cols([0, 1, 0], [-1, 0, 0], [0, 0, 1]),          # STEP x away from the operator, z up
        thumb_at=(0.0, 19.05, 43.0), finger_at=(19.05, 19.05, 43.0), thumb_n=(-1.0, 0.0, 0.0), spread=(3.0, 13.0)),
    # The gripper jaw, a T in section, on its top (datum face, Y = 40) with the stem up: picked up by the stem's free
    # end, the thumb on its full face (X = 35), the fingers either side of the counterbore breaking out of the other
    "ll-1007223": FinishedPart(
        name="ll-1007223",
        boxes={"part_stem": ((24.0, 0.0, -37.5), (35.0, 30.0, 37.5)),
               "part_flange": ((0.0, 30.0, -37.5), (49.0, 40.0, 37.5)),
               "part_step_a": ((35.0, 20.0, -37.5), (39.25, 30.0, 37.5)),
               "part_step_b": ((39.25, 27.0, -37.5), (49.0, 30.0, 37.5))},
        volume_mm3=62258.2,
        rest=_cols([0, -1, 0], [0, 0, -1], [1, 0, 0]),         # STEP x toward the operator, its top (+Y) down
        # 6 mm down from the stem's end: at 9 the thumb's tip came onto the ledge under it (Y = 20) and pressed the
        # part down 2 N as it was lifted
        thumb_at=(35.0, 6.0, 0.0), finger_at=(24.0, 6.0, 0.0), thumb_n=(1.0, 0.0, 0.0), spread=(8.0, 20.0)),
}


def _f(v, scale=M) -> str:
    return " ".join(f"{float(x) * scale:.6f}" for x in v)


def _box(name: str, lo, hi, extra: str = "") -> str:
    lo, hi = np.array(lo, float), np.array(hi, float)
    return f'<geom name="{name}" type="box" size="{_f((hi - lo) / 2)}" pos="{_f((lo + hi) / 2)}"{extra}/>'


def _quat(R) -> str:
    from scipy.spatial.transform import Rotation
    x, y, z, w = Rotation.from_matrix(np.asarray(R, float)).as_quat()
    return f"{w:.7f} {x:.7f} {y:.7f} {z:.7f}"


def defaults() -> str:
    """The rack's classes, the part's and the bag's."""
    c = record()["contact"]
    ref, imp = _f(c["solref"], 1), _f(c["solimp"], 1)
    return f"""    <default class="surface">
      <geom contype="1" conaffinity="3" priority="2" solref="{ref}" solimp="{imp}" rgba="0.18 0.2 0.23 1"/>
    </default>
    <default class="dressing">
      <geom contype="0" conaffinity="0" rgba="0.12 0.26 0.55 1"/>
    </default>
    <default class="part">
      <!-- steel, as stiff as the shelf: what rests on it sits at its true height -->
      <geom contype="1" conaffinity="3" priority="1" friction="0.4 0.004 0.0001" solref="{ref}" solimp="{imp}"
            rgba="0.33 0.34 0.36 1"/>
    </default>
    <default class="bag">
      <geom contype="1" conaffinity="3" friction="{record()['bag']['friction']} 0.004 0.0001" solref="{ref}"
            solimp="{imp}" rgba="0.6 0.43 0.26 1"/>
    </default>"""


def rack_body() -> str:
    """The rack, static: its posts and shelves, and the totes on its bottom and top shelves (drawn only)."""
    r = record()["rack"]
    geoms = [_box(f"rack_post_{i}", lo, hi, ' class="surface"') for i, (lo, hi) in enumerate(r["posts_mm"])]
    geoms += [_box(f"rack_shelf_{k}", lo, hi, f' class="surface" friction="{r["friction"]} 0.004 0.0001"')
              for k, (lo, hi) in r["shelves_mm"].items()]
    geoms += [_box(f"rack_tote_{i}", lo, hi, ' class="dressing"') for i, (lo, hi) in enumerate(r["totes_mm"])]
    return '    <body name="outproc_rack">\n' + "".join(f"      {g}\n" for g in geoms) + "    </body>\n"


def part_at(part: FinishedPart, xy_mm=None) -> np.ndarray:
    """Where the part's STEP origin is as it lies on the coating shelf, its footprint centred on xy_mm (the
    station's part_at_mm) and dropped 0.2 mm onto it."""
    xy = np.asarray(record()["part_at_mm"] if xy_mm is None else xy_mm, float)
    lo, hi = part.world_extent()
    c = (lo + hi) / 2
    return np.array([xy[0] - c[0], xy[1] - c[1], shelf_top_mm() - lo[2] + 0.2])


def part_body(part: FinishedPart, at_mm) -> str:
    """The finished part, its STEP origin at at_mm, lying as `rest` has it. Its mass is the STEP's volume of steel,
    spread through its colliders by volume, so its centre of mass is theirs."""
    vol = sum(float(np.prod(np.subtract(hi, lo))) for lo, hi in part.boxes.values())
    rho = part.kg / (vol * 1e-9)
    geoms = "".join(f'\n      {_box(n, lo, hi, f" class=\"part\" density=\"{rho:.1f}\"")}'
                    for n, (lo, hi) in part.boxes.items())
    return (f'    <body name="part" pos="{_f(at_mm)}" quat="{_quat(part.R)}">\n      <freejoint name="part"/>{geoms}\n'
            f'    </body>\n')


def bag_at() -> np.ndarray:
    """The bag's frame, the middle of its underside, where it stands on the coating shelf."""
    b = record()["bag"]
    return np.array([*b["at_mm"], shelf_top_mm(b["on"]) + 0.1])


def bag_inside() -> tuple[np.ndarray, np.ndarray]:
    """The bag's inside, in its frame (mm): from its floor's top to its rim."""
    b = record()["bag"]
    (ix, iy), h = b["inside_mm"], b["height_mm"]
    return np.array([-ix / 2, -iy / 2, b["floor_mm"]]), np.array([ix / 2, iy / 2, h])


def bag_body(at_mm) -> str:
    """The tagged bag standing open: its floor and four walls, the tag on its near wall's outside, hanging from the
    rim (drawn only: it has no collisions and next to no mass)."""
    b, t = record()["bag"], record()["tag"]
    (ix, iy), h, w, fl = b["inside_mm"], b["height_mm"], b["wall_mm"], b["floor_mm"]
    ox, oy = ix / 2 + w, iy / 2 + w
    parts = {"bag_floor": ((-ox, -oy, 0.0), (ox, oy, fl)),
             "bag_wall_near": ((-ox, -oy, fl), (ox, -iy / 2, h)), "bag_wall_far": ((-ox, iy / 2, fl), (ox, oy, h)),
             "bag_wall_left": ((-ox, -iy / 2, fl), (-ix / 2, iy / 2, h)), "bag_wall_right": ((ix / 2, -iy / 2, fl), (ox, iy / 2, h))}
    vol = sum(float(np.prod(np.subtract(hi, lo))) for lo, hi in parts.values())
    rho = b["mass_kg"] / (vol * 1e-9)
    geoms = "".join(f'\n      {_box(n, lo, hi, f" class=\"bag\" density=\"{rho:.1f}\"")}' for n, (lo, hi) in parts.items())
    tw, tl = t["size_mm"]
    # hung from the rim on its string, its top 10 mm under it, off-centre to the left as a tag is tied through a
    # punched corner
    tag = _box("bag_tag", (-ox * 0.15 - tw / 2, -oy - t["thickness_mm"] - 0.2, h - 10.0 - tl),
               (-ox * 0.15 + tw / 2, -oy - 0.2, h - 10.0), ' class="dressing" mass="0.0001" rgba="0.85 0.74 0.5 1"')
    return (f'    <body name="bag" pos="{_f(at_mm)}">\n      <freejoint name="bag"/>{geoms}\n      {tag}\n'
            f'    </body>\n')


def with_body(body_xml: str, loose: str, carried: tuple = (), skip: tuple[str, ...] = ()) -> str:
    """The body model's MJCF with the cell added: the floor, the rack, the loose objects (part_body, bag_body) and a
    carry weld to each carried body from the hand that carries it: carried names a body (the right hand's) or a
    (side, body) pair. skip is unused: the rack has no instruments to leave out."""
    head, _, tail = body_xml.rpartition("\n  </default>")
    xml = head + "\n" + defaults() + "\n  </default>" + tail
    xml = xml.replace("<worldbody>\n", "<worldbody>\n" + FLOOR + rack_body() + loose, 1)
    pairs = [c if isinstance(c, tuple) else ("R", c) for c in carried]
    eq = "".join(f'    <weld name="carry_{b}" body1="{side}_hand" body2="{b}" active="false" solref="0.004 1" '
                 f'solimp="0.95 0.99 0.001" torquescale="1"/>\n' for side, b in pairs)
    return xml.replace("<equality>\n", "<equality>\n" + eq, 1)


def standalone_xml(loose: str, skip: tuple[str, ...] = ()) -> str:
    """The cell without a body: the rack and the loose objects, to let them come to rest."""
    return f"""<mujoco model="outproc_cell">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" gravity="0 0 -9.81"/>
  <default>
{defaults()}
  </default>
  <worldbody>
{FLOOR}{rack_body()}{loose}  </worldbody>
</mujoco>
"""


IDENTITY = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]


def render_glbs(model, part: FinishedPart) -> dict[str, list[dict]]:
    """Each body's render meshes for the take record: the part's, as finished, in its STEP's frame (its body's),
    written by moonshot/library/bench_links.py. The rack and the bag are drawn from their geoms."""
    names = {model.body(b).name for b in range(1, model.nbody)}
    return {"part": [{"path": f"parts/{part.name}/finished.glb", "in_body": IDENTITY}]} if "part" in names else {}
