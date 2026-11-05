"""The VF-2's table set up for a plate (nist-ftc-09 and ll-1005337, plan Â§3.2), in place of the vise: a 3/4 in MDF
spoilboard bolted to the table, which the through cuts run into, the plate on it, and the clamp kit's step clamps on
the plate's two ends (McMaster 8957A43, the shop's clamp-kit-1: 5/8 in T-slots, 1/2-13 studs; the clamps asset
record).

Each clamp is a 4 in step clamp, its slot over a 4 in stud screwed into a T-nut in one of the table's three T-slots,
its nose on the plate's end margin and its heel on a step block, the flange nut on the stud pressing it down. Its nose
is NOSE_IN_MM onto the plate, inside the outline's cutter path (the plans keep 30-32 mm margins); in an outer T-slot
nearer a long edge than SIDE_IN_MM the clamp is swung about its stud to keep its nose that far in. The heel stands on
a block level with the plate's top (a 3/4 in step block's step under the 3/4 in Delrin plate; under the 3 mm sheet, a
strip of its own stock), so the clamp sits level.

World millimetres at the loading position, +Z up, as moonshot/world/cell.py's (the table's top at TABLE_Z, its middle
at TABLE_MID). Bolted things (the spoilboard, the studs and T-nuts, the step blocks, and a clamp and its nut while
tightened or parked and untouched) are geoms of the machine's table body, so they ride the table when the machine
moves; the plate is the free body `blank`, as the vise's part is, so a take's `clamped` weld names it the same way.

A clamp's two poses: `clamped`, on the plate; `parked`, slid back along its slot off the plate's end and tipped
nose-down onto the spoilboard about its heel, which stays on its block, its nut run up the stud, as a machinist leaves
them while the plate goes on or comes off (moonshot/motion/plate_clamps.py brings one level and slides it on: swung
off across the table instead, setting one back took the hand a quarter turn about the vertical, past the arm's
reach). A clamp the take moves is a free body; a nut on its thread turns on the stud (`clamp_thread_<i>`, the
1/2-13 thread's lead as an exact ratio, as the vise's `lead_screw`; not yet declared).

    with_body(body_xml, plate, layout(plate, 4), state="clamped")      # the scene, in place of cell.with_body
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from moonshot.world import vf2
from moonshot.world import vise as V
from moonshot.world.cell import FLOOR

M = 0.001
IN = 25.4
TABLE_Z = V.TABLE_Z                                      # 853.0
TABLE_MID = np.array([-381.5, -340.5])                   # the table top's middle (vf2.json table_top) at loading
TSLOT_Y = tuple(float(TABLE_MID[1] + k * 4.921 * IN) for k in (-1, 0, 1))   # shop.json vf2-1: 3 slots 4.921 in apart
SPOILBOARD_MM = np.array([36.0 * IN, 14.0 * IN, 0.75 * IN])     # the table's 36 x 14 in, 3/4 in MDF
TOP_Z = TABLE_Z + SPOILBOARD_MM[2]                       # 872.05: the spoilboard's top, where a plate's underside sits
MDF_FRICTION = 0.4                                       # [proposed] dry MDF against a plate or a clamp's pad; the
                                                         # board's contacts take it (its priority over the steel's
                                                         # 0.25, on which a parked clamp slid down onto the plate)

# the clamp kit: 1/2-13 studs and flange nuts, 4 in step clamps (McMaster 4999A32 class), step blocks in 3/4 in steps
STUD_R, STUD_L = 0.25 * IN, 4.0 * IN
LEAD_MM = IN / 13.0                                      # 1/2-13: 1.954 mm a turn
TNUT_DEPTH = 22.0                                        # the stud's foot, in the T-nut, under the table's top
CLAMP_L, CLAMP_W, CLAMP_T = 4.0 * IN, 1.25 * IN, 0.625 * IN
SLOT_W, SLOT_HALF = 9.0 / 16.0 * IN, 36.0                # the slot, 9/16 in wide, 72 mm long about the strap's middle:
                                                         # at 64, a parked clamp's tipped slot end met the stud
PAD_L, PAD_T = 14.0, 3.0                                 # the nose's and the heel's pads under the strap's ends
NUT_AF, NUT_HEX_H, FLANGE_R, FLANGE_T = 0.75 * IN, 9.7, 13.5, 3.0     # 3/4 in hex, its flange 27 mm across
STEP_RISE, BLOCK_W = 0.75 * IN, 1.0 * IN                 # the block narrower than the strap: at 1.5 in its edges
                                                         # stood out under the pinching fingertips, which dragged on it
BLOCK_FRICTION = 0.6         # [proposed] a step block's serrated step: at steel's 0.25 a parked clamp, tipped 16 deg
                             # over the block's front edge, crept down it 0.5 mm a second
PARK_SLIDE_MM = 25.0                                     # a parked clamp slid back this far along its slot: its
                                                         # tipped nose clear of the plate's end
NOSE_IN_MM = 12.0                                        # the nose's reach onto the plate from its end
SIDE_IN_MM = 24.0                                        # ... and its tip at least this far in from a long edge: at
                                                         # 18 a swung nose's back corner stood 1.5 mm off the sheet
PARK_NUT_GAP_MM = 6.0                                    # a parked clamp's nut run up this far over its clamped place
STEEL_KG_M3 = 7850.0
PLATE_RGBA = {8000.0: "0.72 0.72 0.74 1", 1410.0: "0.06 0.06 0.07 1"}    # stainless sheet; black Delrin


@dataclass(frozen=True)
class Plate:
    """The plate on the spoilboard: its box's centre and size (x along the table, y across it, z up; mm), and its
    density. Its underside is on the spoilboard."""
    centre_mm: tuple[float, float, float]
    size_mm: tuple[float, float, float]
    density: float

    @property
    def centre(self) -> np.ndarray:
        return np.array(self.centre_mm, float)

    @property
    def size(self) -> np.ndarray:
        return np.array(self.size_mm, float)

    @property
    def top(self) -> float:
        return float(self.centre[2] + self.size[2] / 2)

    @property
    def mass_kg(self) -> float:
        return self.density * float(np.prod(self.size)) * 1e-9

    @classmethod
    def on_board(cls, xy, size_mm, density) -> "Plate":
        """A plate lying on the spoilboard with its middle at xy."""
        s = np.asarray(size_mm, float)
        return cls((float(xy[0]), float(xy[1]), TOP_Z + s[2] / 2), tuple(float(v) for v in s), density)


@dataclass(frozen=True)
class Clamp:
    """One step clamp: its stud (x, y mm), the strap's direction heel to nose when clamped (yaw, rad from +x), the
    plate's top it clamps (mm), and the heel block's top over the spoilboard (mm)."""
    name: str
    stud: tuple[float, float]
    yaw: float
    plate_top: float
    heel_rise: float

    @property
    def u(self) -> np.ndarray:
        return np.array([math.cos(self.yaw), math.sin(self.yaw)])

    def strap_z(self, state: str = "clamped") -> float:
        """The strap's mid-thickness when level (mm), on its pads on the plate and the heel block."""
        return self.plate_top + PAD_T + CLAMP_T / 2

    def pose_at(self, slide: float = 0.0, lift: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
        """The strap level, slid back `slide` mm along its slot from its clamped place and lifted `lift` mm: its middle
        (mm) and frame (its columns: heel to nose, across, up)."""
        return np.r_[np.asarray(self.stud) - self.u * slide, self.strap_z() + lift], _rot(self.yaw)

    def park_pitch(self) -> tuple[float, float]:
        """How a clamp slid back PARK_SLIDE_MM rests: tipped nose-down until its nose's pad is on the spoilboard and
        its underside on its block (the heel's pad, or the rails over the block's front edge when it tips that far).
        (pitch rad, the middle's height mm), solved by bisection on the pitch."""
        zb = TOP_Z + self.heel_rise
        a0 = -PARK_SLIDE_MM                                       # the middle along u from the stud
        lo_b, hi_b = sorted(self.heel_steps()[0][:2])             # the block's extent along u from the stud
        xs = np.linspace(-CLAMP_L / 2, CLAMP_L / 2, 409)
        pad = (np.abs(xs) >= CLAMP_L / 2 - PAD_L)
        zl = np.where(pad, -CLAMP_T / 2 - PAD_T, -CLAMP_T / 2)   # the underside, strap frame

        def rest(th):
            c, s = math.cos(th), math.sin(th)
            h = TOP_Z + (CLAMP_L / 2) * s + (CLAMP_T / 2 + PAD_T) * c    # the nose's front-bottom edge on the board
            a = a0 + xs * c + zl * s
            z = h - xs * s + zl * c
            over = (a >= lo_b) & (a <= hi_b)
            return h, float((z[over] - zb).min())
        lo, hi = 0.0, 0.5
        for _ in range(60):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if rest(mid)[1] < 0 else (lo, mid)
        return hi, rest(hi)[0]

    def pose(self, state: str = "clamped") -> tuple[np.ndarray, np.ndarray]:
        """The strap's middle (mm) and frame: clamped, level with its middle on the stud; parked, slid back
        PARK_SLIDE_MM off the plate's end and tipped onto the spoilboard (park_pitch)."""
        if state == "clamped":
            return self.pose_at()
        th, h = self.park_pitch()
        return np.r_[np.asarray(self.stud) - self.u * PARK_SLIDE_MM, h], _rot(self.yaw) @ _pitch(th)

    def nose_tip(self) -> np.ndarray:
        """Where the nose's tip stands when clamped (x, y mm)."""
        return np.asarray(self.stud) + self.u * CLAMP_L / 2

    def nut_z(self, state: str = "clamped") -> float:
        """The nut's flange's underside (mm): on the strap's top when clamped, run up the stud when parked."""
        z = self.plate_top + PAD_T + CLAMP_T
        return z if state == "clamped" else z + PARK_NUT_GAP_MM

    def stud_z(self) -> tuple[float, float]:
        return TABLE_Z - TNUT_DEPTH, TABLE_Z - TNUT_DEPTH + STUD_L

    def heel_steps(self) -> list[tuple[float, float, float]]:
        """The heel block as (from, to along the strap from the stud, top over the spoilboard), mm: one step level
        with the plate's top, long enough that the heel's pad stays on it when the clamp is slid back to park."""
        return [(-CLAMP_L / 2 + PAD_L + 3.0, -CLAMP_L / 2 - PARK_SLIDE_MM - 6.0, self.heel_rise)]


def layout(plate: Plate, n: int) -> list[Clamp]:
    """n step clamps on the plate's two ends (half at each), in the T-slots under them: the outer two for two a side,
    all three for three. Each clamp's nose NOSE_IN_MM onto the end and SIDE_IN_MM in from a long edge at least; its
    stud CLAMP_L / 2 back from the nose, in its slot. The -x end's first, then the +x end's, each from -y."""
    per_end = n // 2
    if per_end * 2 != n or per_end not in (2, 3):
        raise ValueError(f"{n} clamps: the layout puts two or three on each end")
    slots = (TSLOT_Y[0], TSLOT_Y[2]) if per_end == 2 else TSLOT_Y
    c, s = plate.centre, plate.size
    y_lo, y_hi = c[1] - s[1] / 2 + SIDE_IN_MM, c[1] + s[1] / 2 - SIDE_IN_MM
    rise = s[2]                                      # a 3/4 in step block's step; under the sheet, a strip of its stock
    out = []
    for sign in (-1.0, 1.0):                         # -x end, the nose pointing +x; +x end, pointing -x
        x_end = c[0] + sign * s[0] / 2
        for y in slots:
            tip = np.array([x_end - sign * NOSE_IN_MM, min(max(y, y_lo), y_hi)])
            uy = (tip[1] - y) / (CLAMP_L / 2)
            u = np.array([-sign * math.sqrt(1.0 - uy * uy), uy])
            stud = tip - u * CLAMP_L / 2
            out.append(Clamp(f"clamp_{len(out)}", (float(stud[0]), float(y)), math.atan2(u[1], u[0]), plate.top,
                             float(rise)))
    return out


# --- MJCF ---------------------------------------------------------------------------------------------------------
def _f(v) -> str:
    return " ".join(f"{float(x) * M:.7f}" for x in np.atleast_1d(v))


def _quat_z(yaw: float) -> str:
    return f"{math.cos(yaw / 2):.7f} 0 0 {math.sin(yaw / 2):.7f}"


def _rot(yaw: float) -> np.ndarray:
    c, s = math.cos(yaw), math.sin(yaw)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def _pitch(a: float) -> np.ndarray:
    """A turn about the strap's across axis (its y), nose-down for a positive a."""
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _quat(R: np.ndarray) -> str:
    """A rotation matrix as MJCF's w x y z."""
    from scipy.spatial.transform import Rotation
    x, y, z, w = Rotation.from_matrix(np.asarray(R, float)).as_quat()
    return f"{w:.7f} {x:.7f} {y:.7f} {z:.7f}"


def strap_boxes() -> list[tuple[str, np.ndarray, np.ndarray]]:
    """The step clamp's solids in its own frame (mm: x heel to nose, z up, origin the strap's middle): the two rails
    either side of the slot, the solid ends, and the nose's and heel's pads under them. (name, centre, half size)."""
    end = (CLAMP_L / 2 - SLOT_HALF) / 2
    rail = (CLAMP_W / 2 - SLOT_W / 2) / 2
    return [
        ("rail_a", np.array([0.0, SLOT_W / 2 + rail, 0.0]), np.array([SLOT_HALF, rail, CLAMP_T / 2])),
        ("rail_b", np.array([0.0, -SLOT_W / 2 - rail, 0.0]), np.array([SLOT_HALF, rail, CLAMP_T / 2])),
        ("heel_end", np.array([-SLOT_HALF - end, 0.0, 0.0]), np.array([end, CLAMP_W / 2, CLAMP_T / 2])),
        ("nose_end", np.array([SLOT_HALF + end, 0.0, 0.0]), np.array([end, CLAMP_W / 2, CLAMP_T / 2])),
        ("nose", np.array([CLAMP_L / 2 - PAD_L / 2, 0.0, -CLAMP_T / 2 - PAD_T / 2]),
         np.array([PAD_L / 2, CLAMP_W / 2, PAD_T / 2])),
        ("heel", np.array([-CLAMP_L / 2 + PAD_L / 2, 0.0, -CLAMP_T / 2 - PAD_T / 2]),
         np.array([PAD_L / 2, CLAMP_W / 2, PAD_T / 2])),
    ]


def clamp_kg() -> float:
    return STEEL_KG_M3 * sum(8 * float(np.prod(h)) for _, _, h in strap_boxes()) * 1e-9


def _strap_geoms(name: str, at=None, yaw: float = 0.0, ind: str = "      ") -> str:
    """The strap's geoms: in its own body (at None), or placed at `at` (mm) turned by yaw in the enclosing body."""
    kg = clamp_kg()
    vol = sum(float(np.prod(h)) for _, _, h in strap_boxes())
    out = ""
    for part, c, h in strap_boxes():
        p, q = (c, "1 0 0 0") if at is None else (np.asarray(at) + _rot(yaw) @ c, _quat_z(yaw))
        out += (f'{ind}<geom name="{name}_{part}" class="steel" type="box" size="{_f(h)}" pos="{_f(p)}" quat="{q}" '
                f'mass="{kg * float(np.prod(h)) / vol:.5f}" rgba="0.55 0.56 0.58 1"/>\n')
    return out


def _nut_geoms(name: str, ind: str) -> str:
    """The flange nut's geoms in its own frame (its flange's underside at z 0, on the stud's axis): the flange, and the
    hex as three boxes a third of a turn apart, whose union is the hexagonal prism (boxes, so the take record draws it
    and a wrench's jaws meet its flats)."""
    kg_flange = STEEL_KG_M3 * math.pi * FLANGE_R ** 2 * FLANGE_T * 1e-9
    side = NUT_AF / math.sqrt(3)
    kg_hex = STEEL_KG_M3 * 1.5 * side * NUT_AF * NUT_HEX_H * 1e-9
    out = (f'{ind}<geom name="{name}_flange" class="steel" type="cylinder" size="{_f([FLANGE_R, FLANGE_T / 2])}" '
           f'pos="0 0 {FLANGE_T / 2 * M:.5f}" mass="{kg_flange:.5f}" rgba="0.3 0.3 0.32 1"/>\n')
    for j in range(3):
        out += (f'{ind}<geom name="{name}_hex_{j}" class="steel" type="box" size="{_f([side / 2, NUT_AF / 2, NUT_HEX_H / 2])}" '
                f'pos="0 0 {(FLANGE_T + NUT_HEX_H / 2) * M:.5f}" quat="{_quat_z(j * math.pi / 3)}" '
                f'mass="{kg_hex / 3:.5f}" rgba="0.3 0.3 0.32 1"/>\n')
    return out


def bolted(plate: Plate, clamps: list[Clamp], state: str = "clamped", free: tuple[str, ...] = (),
           nuts: tuple[str, ...] | None = None) -> str:
    """What is bolted to the table (bodies fixed in the table body, whose frame is the world's at the loading position;
    each its own body, with no GLB, so the take record draws it from its geoms): the spoilboard with each clamp's T-nut,
    stud and heel block (body `spoilboard`), each clamp not in `free` in its pose, and each clamp's nut where the pose
    has it: on its thread (a body on a slide and a hinge along the stud, its frame at the flange's underside) if its
    clamp is in `nuts` (by default the free clamps), fixed otherwise."""
    c = np.r_[TABLE_MID, TABLE_Z + SPOILBOARD_MM[2] / 2]
    out = (f'        <body name="spoilboard">\n'
           f'        <geom name="spoilboard" type="box" size="{_f(SPOILBOARD_MM / 2)}" pos="{_f(c)}" contype="1" '
           f'conaffinity="3" priority="2" friction="{MDF_FRICTION} 0.004 0.0001" rgba="0.62 0.5 0.36 1"/>\n')
    for i, k in enumerate(clamps):
        z0, z1 = k.stud_z()
        s = np.asarray(k.stud, float)
        out += (f'        <geom name="tnut_{i}" type="box" size="{_f([12.0, 12.7, 5.0])}" '
                f'pos="{_f(np.r_[s, z0 + 5.0])}" quat="{_quat_z(k.yaw)}" contype="0" conaffinity="0" '
                f'rgba="0.3 0.3 0.32 1"/>\n'
                f'        <geom name="stud_{i}" class="steel" type="cylinder" size="{_f([STUD_R, (z1 - z0) / 2])}" '
                f'pos="{_f(np.r_[s, (z0 + z1) / 2])}" rgba="0.5 0.5 0.52 1"/>\n')
        for j, (a, b, top) in enumerate(k.heel_steps()):
            mid = s + k.u * (a + b) / 2
            out += (f'        <geom name="heel_block_{i}_{j}" class="steel" type="box" '
                    f'size="{_f([abs(b - a) / 2, BLOCK_W / 2, top / 2])}" pos="{_f(np.r_[mid, TOP_Z + top / 2])}" '
                    f'quat="{_quat_z(k.yaw)}" priority="2" friction="{BLOCK_FRICTION} 0.004 0.0001" '
                    f'rgba="0.15 0.15 0.16 1"/>\n')
    out += '        </body>\n'
    for k in clamps:
        s = np.asarray(k.stud, float)
        z1 = k.stud_z()[1]
        at, R = k.pose(state)
        nz = k.nut_z(state)
        if k.name not in free:
            out += (f'        <body name="{k.name}" pos="{_f(at)}" quat="{_quat(R)}">\n'
                    + _strap_geoms(k.name, ind="          ") + '        </body>\n')
        if k.name in (free if nuts is None else nuts):
            out += (f'        <body name="{k.name}_nut" pos="{_f(np.r_[s, nz])}">\n'
                    f'          <joint name="{k.name}_nut_slide" type="slide" axis="0 0 1" '
                    f'range="{-(nz - k.nut_z()) * M - 0.004:.5f} {(z1 - nz - NUT_HEX_H - FLANGE_T) * M:.5f}" '
                    f'damping="2"/>\n'
                    f'          <joint name="{k.name}_nut_turn" type="hinge" axis="0 0 1" limited="false" '
                    f'damping="0.002" frictionloss="0.02" armature="0.0005"/>\n'
                    + _nut_geoms(f"{k.name}_nut", "          ") + '        </body>\n')
        else:
            out += (f'        <body name="{k.name}_nut" pos="{_f(np.r_[s, nz])}">\n'
                    + _nut_geoms(f"{k.name}_nut", "          ") + '        </body>\n')
    return out


def loose(plate: Plate, clamps: list[Clamp], state: str = "clamped", free: tuple[str, ...] = ()) -> str:
    """The free bodies: the plate (`blank`) on the spoilboard, if it is there, and each clamp in `free`, in its pose."""
    out = "" if plate is None else (
        f'    <body name="blank" pos="{_f(plate.centre)}">\n      <freejoint name="blank"/>\n'
        f'      <geom name="blank" type="box" size="{_f(plate.size / 2)}" mass="{plate.mass_kg:.4f}" contype="1" '
        f'conaffinity="3" priority="1" friction="0.3 0.004 0.0001" solref="0.002 1" solimp="0.95 0.99 0.0005" '
        f'rgba="{PLATE_RGBA.get(plate.density, "0.6 0.6 0.62 1")}"/>\n    </body>\n')
    for k in clamps:
        if k.name in free:
            at, R = k.pose(state)
            out += (f'    <body name="{k.name}" pos="{_f(at)}" quat="{_quat(R)}">\n'
                    f'      <freejoint name="{k.name}"/>\n' + _strap_geoms(k.name) + '    </body>\n')
    return out


def threads(clamps: list[Clamp], free: tuple[str, ...] = ()) -> str:
    """Each free clamp's nut on its stud's thread: the nut's slide is the lead times its turn, right-handed (turned
    clockwise from above, negative about +z, it runs down)."""
    k = LEAD_MM * M / (2 * math.pi)
    return "".join(f'    <joint name="clamp_thread_{c.name[len("clamp_"):]}" joint1="{c.name}_nut_slide" '
                   f'joint2="{c.name}_nut_turn" polycoef="0 {k:.8f} 0 0 0" solref="0.002 1" '
                   f'solimp="0.9999 0.9999 0.0001"/>\n' for c in clamps if c.name in free)


def excludes(clamps: list[Clamp], free: tuple[str, ...] = ()) -> str:
    """A free clamp's nut threads onto its stud, which the stud's cylinder and the nut's solid hex can't: the nut and
    the spoilboard's body (the studs) don't collide."""
    return "".join(f'    <exclude body1="spoilboard" body2="{c.name}_nut"/>\n' for c in clamps if c.name in free)


def with_body(body_xml: str, plate: Plate | None, clamps: list[Clamp], state: str = "clamped",
              free: tuple[str, ...] = (), nuts: tuple[str, ...] | None = None) -> str:
    """The body model's MJCF with the VF-2 cell set up for the plate: the machine carrying the spoilboard and the
    clamps, the floor, the plate (None: the table bare), the free clamps and the nuts on their threads, and the
    machine's actuators after the body's. The vise isn't on the table. state: the clamps' pose (`clamped` or
    `parked`); free: the clamps a take moves; nuts: the clamps whose nuts turn on their threads (default: free's)."""
    from moonshot.world.cell import LOAD_X_MM
    nuts = free if nuts is None else nuts
    machine, acts = vf2.worldbody(bolted(plate, clamps, state, free, nuts))
    machine = f'    <body name="vf2" pos="{-LOAD_X_MM * vf2.M:.4f} 0 0">\n{machine}    </body>\n'
    head, _, tail = body_xml.rpartition("\n  </default>")
    xml = head + "\n" + V.STEEL_DEFAULT + "\n  </default>" + tail
    xml = xml.replace("<worldbody>\n", "<worldbody>\n" + FLOOR + machine + loose(plate, clamps, state, free), 1)
    xml = xml.replace("<equality>\n", "<equality>\n" + threads(clamps, nuts), 1)
    if nuts:
        xml = xml.replace("  <equality>\n", f"  <contact>\n{excludes(clamps, nuts)}  </contact>\n  <equality>\n", 1)
    head, _, tail = xml.rpartition("  </actuator>")
    return head + acts + "  </actuator>" + tail


def standalone_xml(plate: Plate, clamps: list[Clamp], state: str = "clamped", free: tuple[str, ...] = (),
                   extra: str = "") -> str:
    """The table set up alone, for its conformance tests: the table fixed at the loading position (its bolted things
    in its body), the plate, the free clamps and their threads; extra, more free bodies."""
    return f"""<mujoco model="spoilboard">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" gravity="0 0 -9.81" noslip_iterations="10"/>
  <default>
    <joint limited="true"/>
{V.STEEL_DEFAULT}
  </default>
  <worldbody>
{FLOOR}    <body name="vf2_table">
      {vf2._box("vf2_table_top", vf2.record()["colliders"]["table_top"])}
{bolted(plate, clamps, state, free)}    </body>
{loose(plate, clamps, state, free)}{extra}  </worldbody>
  <contact>
{excludes(clamps, free)}  </contact>
  <equality>
{threads(clamps, free)}  </equality>
</mujoco>
"""
