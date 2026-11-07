"""CAT40 tool holders as bodies, the stand they wait on, and where the VF-2's carousel keeps them (plan §3.2; the
vf2-tool-load card). World millimetres; the VF-2 stands as moonshot/world/cell.py places it (station x - 381).

A holder's frame is its gauge line's centre, +Z up its taper, as it hangs in the spindle: the spindle's gauge point
(moonshot/world/vf2.py) and the holder's frame coincide when it is seated, as the cycle takes hang a tool's GLBs
(moonshot/sim/cycle_take.py). Every holder is the shop's one CAT40 model (library/records/assets/tooling/cat40: Haas
04-0001, 1.75 in gauge length, 1.25 in body, 2.4 lb), and its tool sticks out below its nose as the cycle takes have it
(`cutter`, the same rule as moonshot/sim/cam.py Tool).

Its colliders, from the gauge line (mm):
- the retention knob: a neck and a head the drawbar's fingers close under (moonshot/world/vf2.py);
- the taper as a capsule: its round top finds the spindle's bore, and seats against the bore's shoulder ring, as a
  7/24 taper seats in its socket; the knob and the shoulder are the CAT40 standard's sizes rounded [proposed];
- the V-flange: two discs and the groove between them, which the stand's and the carousel's forks hold;
- the body down to the nose, and the tool.

The tools wait on a stand on the table, right of the vise: a row of forks, each holding a holder by its V-groove, tool
down, taper up, as it goes into the spindle; a fork opens toward the operator, so a holder is lifted off its tines and
slid out of the fork toward them [proposed: no source gives where the shop stages its tools; racks with V-flange forks
are sold]. On the table, as a cart beside the doorway is out of a forward-reaching hand's reach: from where the
operator stands to reach the spindle, every place in front of them is inside the machine. The stand is fixed in the
world, which is the table's place while the takes don't move it.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

M = 0.001
INCH = 25.4
RECORDS = Path(__file__).resolve().parents[1] / "library" / "records" / "assets"
HOLDER_GLB = "library/tooling/cat40/cat40.glb"
GAUGE_MM = 1.75 * INCH              # the holder's nose below its gauge line (cat40.json), as cam.GAUGE_MM
HOLDER_KG = 2.4 * 0.4536            # cat40.json's weight
# (name, r, z0, z1) cylinders and the taper capsule, in the holder's frame (mm)
KNOB_NECK = (6.5, 66.0, 80.0)
KNOB_HEAD = (9.5, 86.0)                              # a ball: the drawbar's fingers close on its underside, which
                                                     # pulls the holder up, as on a retention knob's 45 deg face
TAPER = {"r": 16.5, "z0": 12.0, "z1": 52.0}         # a capsule: its ends reach -4.5 and 68.5
FLANGE_TOP = (31.75, -8.0, -3.2)                     # CAT40's 2.5 in flange, 1/8 in below the gauge line
GROOVE = (28.0, -14.0, -8.0)                         # the V-groove's bottom, the forks' 6 mm
FLANGE_BOTTOM = (31.75, -19.05, -14.0)
BODY = (15.875, -GAUGE_MM, -19.05)                   # the 1.25 in body to the nose
STEEL_KG_MM3 = 7.85e-6
CARBIDE_KG_MM3 = 14.5e-6


def _spec(tool_id: str) -> dict:
    rec = json.loads(next(RECORDS.glob(f"*/{tool_id}/{tool_id}.json")).read_text(encoding="utf-8"))
    return {s["name"]: s for s in rec.get("key_specs", [])} | {"_name": rec["name"]}


def cutter(tool_id: str) -> dict:
    """A tool as it sticks out of its holder (mm): radius, stickout below the nose, length below the gauge line, and
    mass. The same rule as moonshot/sim/cam.py Tool (a face mill's whole thickness; a shank tool's length less what
    the holder grips, a third of it, at most 30 mm), so a holder here is the tool the cycle takes cut with
    (moonshot/tests/test_tool_load.py). `r` is the cutting radius, as cam's; `body_r` the tool's solid, the shank's
    where that is wider (a 1/32 in end mill on its 1/8 in shank), which its collider and mass take."""
    s = _spec(tool_id)
    mm = lambda v: float(v["value"]) * (INCH if v.get("unit") == "in" else 1.0)      # noqa: E731
    r = mm(s["Diameter"]) / 2
    body_r = max(r, mm(s["Shank diameter"]) / 2) if "Shank diameter" in s else r
    oal = mm(s.get("Overall length", s.get("Thickness")))
    stick = oal if tool_id == "facem" else oal - min(0.35 * oal, 30.0)
    hss = any(w in s["_name"].lower() for w in ("tap", "reamer", "face mill"))
    kg = (math.pi * body_r * body_r * stick * (STEEL_KG_MM3 if hss else CARBIDE_KG_MM3)
          * (0.6 if tool_id == "facem" else 0.8))
    return {"id": tool_id, "r": r, "body_r": body_r, "stickout": stick, "length": GAUGE_MM + stick, "kg": kg}


def holder_kg(tool_id: str) -> float:
    return HOLDER_KG + cutter(tool_id)["kg"]


def _f(v, scale=M) -> str:
    return " ".join(f"{float(x) * scale:.5f}" for x in np.atleast_1d(v))


def _cyl(name: str, r: float, z0: float, z1: float, kg: float, extra: str = "") -> str:
    return (f'<geom name="{name}" type="cylinder" size="{_f([r, (z1 - z0) / 2])}" pos="0 0 {(z0 + z1) / 2 * M:.5f}" '
            f'mass="{kg:.4f}"{extra}/>')


def holder_geoms(prefix: str, tool_id: str, cls: str = "steel", collide: bool = True) -> str:
    """A holder's and its tool's geoms in the holder's frame, named <prefix>_knob, _taper, _flange, _groove, _body and
    _tool. collide=False: drawn and carried only (a holder parked in the carousel, which nothing reaches)."""
    t = cutter(tool_id)
    kg = HOLDER_KG
    extra = f' class="{cls}"' + ("" if collide else ' contype="0" conaffinity="0"')
    tc = (TAPER["z0"] + TAPER["z1"]) / 2
    out = [
        _cyl(f"{prefix}_knob", *KNOB_NECK, 0.04 * kg, extra),
        f'<geom name="{prefix}_knob_head" type="sphere" size="{KNOB_HEAD[0] * M:.5f}" pos="0 0 {KNOB_HEAD[1] * M:.5f}" '
        f'mass="{0.04 * kg:.4f}"{extra}/>',
        f'<geom name="{prefix}_taper" type="capsule" size="{_f([TAPER["r"], (TAPER["z1"] - TAPER["z0"]) / 2])}" '
        f'pos="0 0 {tc * M:.5f}" mass="{0.30 * kg:.4f}"{extra}/>',
        _cyl(f"{prefix}_flange", *FLANGE_TOP, 0.17 * kg, extra),
        _cyl(f"{prefix}_groove", *GROOVE, 0.17 * kg, extra),
        _cyl(f"{prefix}_flange_low", *FLANGE_BOTTOM, 0.12 * kg, extra),
        _cyl(f"{prefix}_body", *BODY, 0.16 * kg, extra),
        _cyl(f"{prefix}_tool", t["body_r"], -t["length"], -GAUGE_MM, t["kg"], extra + ' rgba="0.7 0.7 0.72 1"'),
    ]
    return "".join(out)


def holder_body(name: str, tool_id: str, at_mm, quat=(1.0, 0.0, 0.0, 0.0), free: bool = True) -> str:
    """A holder as a body at at_mm (its gauge line's centre, world), free or fixed where it is."""
    joint = f'<freejoint name="{name}"/>' if free else ""
    q = " ".join(f"{v:.7f}" for v in quat)
    return (f'    <body name="{name}" pos="{_f(at_mm)}" quat="{q}">{joint}'
            f'{holder_geoms(name, tool_id, collide=free)}</body>\n')


# the library's tool GLBs (the CAT40 holder, every cutter) are stored Y up, glTF's way, their axis along raw +y: turned
# +90 deg about x they stand along the holder body's z, its colliders' axis (as bench_cell.ASSET and wrench.Y_UP_IN_BODY
# turn theirs). Placed unturned, every take drew the holder and its tool lying on their side (found 2026-11-06)
Y_UP = [0.7071068, 0.7071068, 0.0, 0.0]


def glb_entry(path: str, z_mm: float) -> dict:
    """A tool GLB in a holder body, its nose (the holder's) or tip (a cutter's) z_mm along the body's axis: a library
    GLB turned up from Y (Y_UP); a take's own stand-in cutter (moonshot/sim/cycle_take.py write_cutter_glb), built
    along z, as it is."""
    turn = Y_UP if path.startswith("library/") else [1.0, 0.0, 0.0, 0.0]
    return {"path": path, "in_body": [0, 0, round(z_mm, 3), *turn]}


def render_glbs(tool_id: str) -> list[dict]:
    """A holder body's GLBs: the CAT40 holder from its nose, the tool from its tip (as the cycle takes draw them)."""
    return [glb_entry(HOLDER_GLB, -GAUGE_MM), glb_entry(f"library/tooling/{tool_id}/{tool_id}.glb", -cutter(tool_id)["length"])]


# --- the tool stand ------------------------------------------------------------------------------------------------
STAND = {"first_mm": (-190.0, -430.0, 1023.0),      # the first fork's holder axis at its tines' top (world): on the
         "pitch_mm": (72.0, 0.0, 0.0),               # table right of the vise, the forks in a row along X, opening
                                                     # toward the operator; the longest tool hangs 115 mm, clear of the
                                                     # 853 mm table top
         # 3 mm tines, 2.5 mm clear of the groove each side, so a hand a little off its line slides the holder
         # out rather than wedging its flanges on a tine (0.5 mm did, at 200 N)
         "tine_t": 3.0, "tine_w": 6.0, "tine_back": 36.0, "tine_front": 34.0, "clear": 2.5,
         "plate_y": 60.0, "table_z": 853.0}


@dataclass(frozen=True)
class Layout:
    """Where a stand stands and how its forks are set out: fork 0's holder axis at its tines' top (world mm), the forks
    along +X at STAND's pitch, `per_row` to a row (0: all in one row), the front row's first; the back row's forks
    `back_mm` (y, z) behind the front row's, and up or down from them; the stand's feet on `foot_z`. The vise setups'
    stand is ONE_ROW."""
    first_mm: tuple[float, float, float] = STAND["first_mm"]
    per_row: int = 0
    back_mm: tuple[float, float] = (0.0, 0.0)
    foot_z: float = STAND["table_z"]
    bracket: bool = False                               # standing on the bracket at the table's front (BRACKET)

    def row_col(self, k: int) -> tuple[int, int]:
        return (0, k) if not self.per_row else divmod(k, self.per_row)

    def axis(self, k: int) -> np.ndarray:
        row, col = self.row_col(k)
        return (np.asarray(self.first_mm, float) + col * np.asarray(STAND["pitch_mm"], float)
                + row * np.array([0.0, *self.back_mm]))

    def to_json(self) -> dict:
        return {"first_mm": list(self.first_mm), "per_row": self.per_row, "back_mm": list(self.back_mm),
                "foot_z": self.foot_z, "bracket": self.bracket}

    @classmethod
    def from_json(cls, d: dict | None) -> "Layout":
        return ONE_ROW if not d else cls(tuple(d["first_mm"]), int(d["per_row"]), tuple(d["back_mm"]),
                                         float(d["foot_z"]), bool(d.get("bracket", False)))


ONE_ROW = Layout()

# A plate setup's tools (nist-ftc-09, ll-1005337) can't wait on the table: the spoilboard covers all of it, and the
# plate and its clamps most of it. They wait on a two-row stand on this bracket in front of the table instead (the
# user's decision, 2026-11-05), inside the doorway, clear of the plate, the spoilboard and the clamps (ll-1005337's
# plate overhangs the table's front to y -541.4; the back row's plate stands 2.6 mm in front of it).
BRACKET = {
    "what": "A plain steel bracket bolted to the VF-2 table's front edge: a 10 mm plate against the table's front face "
            "and a 10 mm shelf on it, level with the table's top, reaching out toward the operator, on which the "
            "two-row tool stand stands as it stands on the table for a vise setup [proposed]",
    "front_y": -690.0,      # the front row's holder axes (world y), its flanges 33 mm behind the doors' panels' line
    "row_mm": 78.0,         # the back row this far behind, its plate, the stand's one, 2.6 mm in front of
                            # ll-1005337's plate: 53 behind, the open fingers of a hand reaching round a front holder
                            # met the taper of the back holder behind it and pushed the hand 27 mm off its grip
    "right_x": -46.0,       # each row's rightmost fork, where the vise setups' third fork is
    "front_rise_mm": 120.0, # the front row stands this much higher than the back, on arms reaching back over it to the
                            # stand's plate behind the back row: a back holder slides out under the emptied front forks
                            # (its knob, lifted, 5 mm under their back stops), and the hand that takes it reaches in
                            # under them. The other way up, the back row raised over the front, the hand reaching for a
                            # back holder caught on the emptied front forks and closed 44 mm low and 37 mm back on it,
                            # and every front holder had to go up over the back row's knobs
    "drop_mm": 120.0,       # the shelf this far under the table's top, the back row as far under the vise setups'
                            # stand's height and the front row (front_rise_mm over it) at that height: the back row at
                            # that height and the front raised 135 over it, the hand closed on a front holder pressing
                            # 7.8 mm into its body, its weight taken 100 ms after it touched it (people's 139-321);
                            # dropped 60, its fingers swept the spot drill's cutter on the way in for 61 frames, 80 for 2
    "face_y": -524.0,       # the table's front face (vf2.json table_top), which the bracket is bolted to
    "t": 10.0, "margin_x": 60.0, "face_h": 40.0,
}


def bracket_layout(tool_ids: list[str]) -> Layout:
    """The two-row stand on the bracket for a plate setup's tools, in the order they go in: the first half (rounded up)
    in the front row, emptied first, the rest in the back row, each row ending at BRACKET right_x; the back row
    drop_mm under the vise setups' stand's height, the front row front_rise_mm over the back."""
    per_row = (len(tool_ids) + 1) // 2
    rise, drop = BRACKET["front_rise_mm"], BRACKET["drop_mm"]
    first = (BRACKET["right_x"] - (per_row - 1) * STAND["pitch_mm"][0], BRACKET["front_y"],
             STAND["first_mm"][2] - drop + rise)
    return Layout(first, per_row, (BRACKET["row_mm"], -rise), STAND["table_z"] - drop, bracket=True)


def bracket_geoms(layout: Layout, n: int) -> str:
    """The bracket's geoms, in the stand's frame (its fork 0's axis at its tines' top): the shelf under every row's
    foot, from the table's front face out past the front row's foot, and the plate bolted against the table's front
    face from the table's top down to under the shelf."""
    o = stand_axis(0, layout)
    xs = [stand_axis(k, layout)[0] for k in range(n)]
    x0, x1 = min(xs) - 40.0 - BRACKET["margin_x"], max(xs) + 40.0 + BRACKET["margin_x"]
    y0, y1 = min(p["y"] for p in stand_plates(layout, n)) - 52.0, BRACKET["face_y"]      # from the foot's front edge
    t, z = BRACKET["t"], layout.foot_z
    z0, z1 = min(z - 2 * t, STAND["table_z"] - BRACKET["face_h"]), STAND["table_z"]
    shelf = [(x0 + x1) / 2, (y0 + y1) / 2, z - t / 2]
    face = [(x0 + x1) / 2, y1 - t / 2, (z0 + z1) / 2]
    return (f'<geom name="bracket_shelf" class="steel" type="box" size="{_f([(x1 - x0) / 2, (y1 - y0) / 2, t / 2])}" '
            f'pos="{_f(np.array(shelf) - o)}" rgba="0.45 0.46 0.48 1"/>'
            f'<geom name="bracket_face" class="steel" type="box" size="{_f([(x1 - x0) / 2, t / 2, (z1 - z0) / 2])}" '
            f'pos="{_f(np.array(face) - o)}" rgba="0.45 0.46 0.48 1"/>')


def stand_axis(k: int, layout: Layout = ONE_ROW) -> np.ndarray:
    """Fork k's holder axis at the height of its tines' top (world mm)."""
    return layout.axis(k)


def on_stand(k: int, layout: Layout = ONE_ROW) -> np.ndarray:
    """Where a holder in fork k has its gauge line: its upper flange disc's underside on the tines."""
    return stand_axis(k, layout) + [0.0, 0.0, -GROOVE[2]]


def stand_plates(layout: Layout, n: int) -> list[dict]:
    """The stand's back plates (world mm): each row's own, plate_y behind its axes and 12 mm over its tines (the vise
    setups'); on a plate's bracket one for both rows, plate_y behind the back row's axes and 12 mm over the higher
    row's tines, every fork's arm reaching back to it. Each: "tag" (its geoms' name suffix), "forks", "x" (its first
    and last fork's axis), "y" (its front face), "top"."""
    rows = sorted({layout.row_col(k)[0] for k in range(n)})
    groups = [list(range(n))] if layout.bracket else [[k for k in range(n) if layout.row_col(k)[0] == r] for r in rows]
    out = []
    for i, ks in enumerate(groups):
        axes = np.array([stand_axis(k, layout) for k in ks])
        out.append({"tag": "" if i == 0 else f"_{i}", "forks": ks, "x": (float(axes[:, 0].min()), float(axes[:, 0].max())),
                    "y": float(axes[:, 1].max()) + STAND["plate_y"], "top": float(axes[:, 2].max()) + 12.0})
    return out


def stand_xml(n: int, waiting: dict[int, str], layout: Layout = ONE_ROW) -> str:
    """The stand with n forks (a static body, steel): each two tines in a holder's V-groove and a back stop, opening
    toward -Y, on an arm back to a plate standing on the table (stand_plates); holders in forks `waiting` ({fork:
    tool}) are on it, fixed, as nothing in the take moves them. The hand that wraps a holder's back passes under the
    back stop and in front of the plate."""
    c = STAND
    x0 = GROOVE[0] + c["clear"] + c["tine_w"] / 2
    o = stand_axis(0, layout)
    plates = stand_plates(layout, n)
    geoms = []
    for k in range(n):
        a = stand_axis(k, layout) - o
        zc = a[2] - c["tine_t"] / 2
        yc = a[1] + (c["tine_back"] - c["tine_front"]) / 2
        hl = (c["tine_back"] + c["tine_front"]) / 2
        py = next(p["y"] for p in plates if k in p["forks"]) - o[1] - a[1]       # its plate's face, from its axis
        for s in (-1, 1):
            geoms.append(f'<geom name="stand_tine_{k}{"lr"[s > 0]}" class="steel" type="box" '
                         f'size="{_f([c["tine_w"] / 2, hl, c["tine_t"] / 2])}" pos="{_f([a[0] + s * x0, yc, zc])}"/>')
        geoms.append(f'<geom name="stand_back_{k}" class="steel" type="box" size="{_f([x0 + c["tine_w"] / 2, 3, 8])}" '
                     f'pos="{_f([a[0], a[1] + c["tine_back"] + 3, zc + 4])}"/>')
        geoms.append(f'<geom name="stand_arm_{k}" class="steel" type="box" size="{_f([6, (py - c["tine_back"]) / 2, 8])}" '
                     f'pos="{_f([a[0], a[1] + (py + c["tine_back"]) / 2, zc + 4])}"/>')
    plate = ""
    for p in plates:
        (x_a, x_b), y, top = p["x"], p["y"] - o[1], p["top"] - o[2]
        h = top - (layout.foot_z - o[2])
        plate += (f'<geom name="stand_plate{p["tag"]}" class="steel" type="box" size="{_f([(x_b - x_a) / 2 + 40, 4, h / 2])}" '
                  f'pos="{_f([(x_a + x_b) / 2 - o[0], y + 4, top - h / 2])}"/>'
                  f'<geom name="stand_foot{p["tag"]}" class="steel" type="box" size="{_f([(x_b - x_a) / 2 + 40, 30, 5])}" '
                  f'pos="{_f([(x_a + x_b) / 2 - o[0], y - 22, 5 + layout.foot_z - o[2]])}"/>')
    held = "".join(f'<body name="stand_holder_{k}" pos="{_f(on_stand(k, layout) - o)}">'
                   f'{holder_geoms(f"stand_holder_{k}", t, collide=True)}</body>' for k, t in waiting.items())
    if layout.bracket:
        plate += bracket_geoms(layout, n)
    return f'    <body name="tool_stand" pos="{_f(o)}">{"".join(geoms)}{plate}{held}</body>\n'


# --- the carousel --------------------------------------------------------------------------------------------------
POCKETS = 20


def carousel() -> dict:
    """The tool changer's pockets as the station record has them (moonshot/library/stations/vf2.json tool_changer)."""
    from moonshot.world import vf2
    return vf2.record()["tool_changer"]


def pocket_mm(pocket: int, current: int) -> np.ndarray:
    """Where a holder in `pocket` has its gauge line (world mm) with pocket `current` facing the spindle: the pockets
    on a ring, numbered round it, the current one on the ring's side toward the spindle."""
    c = carousel()
    ang = math.radians((pocket - current) * 360.0 / c["pockets"])
    centre = np.array(c["centre_mm"], float) + [-381.0, 0.0, 0.0]
    toward = np.array(c["toward"], float)
    side = np.array([-toward[1], toward[0], 0.0])
    return centre + c["radius_mm"] * (math.cos(ang) * toward + math.sin(ang) * side)


def carousel_xml(pockets: dict[int, str], current: int) -> str:
    """The holders the carousel keeps ({pocket: tool}), each fixed where its pocket has it, drawn only: no take
    reaches into the carousel."""
    return "".join(holder_body(f"pocket_{p}", t, pocket_mm(p, current), free=False) for p, t in sorted(pockets.items()))
