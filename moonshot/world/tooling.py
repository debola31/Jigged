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
    (moonshot/tests/test_tool_load.py)."""
    s = _spec(tool_id)
    mm = lambda v: float(v["value"]) * (INCH if v.get("unit") == "in" else 1.0)      # noqa: E731
    r = mm(s["Diameter"]) / 2
    oal = mm(s.get("Overall length", s.get("Thickness")))
    stick = oal if tool_id == "facem" else oal - min(0.35 * oal, 30.0)
    hss = any(w in s["_name"].lower() for w in ("tap", "reamer", "face mill"))
    kg = math.pi * r * r * stick * (STEEL_KG_MM3 if hss else CARBIDE_KG_MM3) * (0.6 if tool_id == "facem" else 0.8)
    return {"id": tool_id, "r": r, "stickout": stick, "length": GAUGE_MM + stick, "kg": kg}


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
        _cyl(f"{prefix}_tool", t["r"], -t["length"], -GAUGE_MM, t["kg"], extra + ' rgba="0.7 0.7 0.72 1"'),
    ]
    return "".join(out)


def holder_body(name: str, tool_id: str, at_mm, quat=(1.0, 0.0, 0.0, 0.0), free: bool = True) -> str:
    """A holder as a body at at_mm (its gauge line's centre, world), free or fixed where it is."""
    joint = f'<freejoint name="{name}"/>' if free else ""
    q = " ".join(f"{v:.7f}" for v in quat)
    return (f'    <body name="{name}" pos="{_f(at_mm)}" quat="{q}">{joint}'
            f'{holder_geoms(name, tool_id, collide=free)}</body>\n')


def render_glbs(tool_id: str) -> list[dict]:
    """A holder body's GLBs: the CAT40 holder from its nose, the tool from its tip (as the cycle takes draw them)."""
    t = cutter(tool_id)
    return [{"path": HOLDER_GLB, "in_body": [0, 0, -round(GAUGE_MM, 3), 1, 0, 0, 0]},
            {"path": f"library/tooling/{tool_id}/{tool_id}.glb", "in_body": [0, 0, -round(t["length"], 3), 1, 0, 0, 0]}]


# --- the tool stand ------------------------------------------------------------------------------------------------
STAND = {"first_mm": (-190.0, -430.0, 1023.0),      # the first fork's holder axis at its tines' top (world): on the
         "pitch_mm": (72.0, 0.0, 0.0),               # table right of the vise, the forks in a row along X, opening
                                                     # toward the operator; the longest tool hangs 115 mm, clear of the
                                                     # 853 mm table top
         "tine_t": 4.0, "tine_w": 6.0, "tine_back": 36.0, "tine_front": 34.0, "clear": 0.5,
         "plate_y": 60.0, "table_z": 853.0}


def stand_axis(k: int) -> np.ndarray:
    """Fork k's holder axis at the height of its tines' top (world mm)."""
    return np.asarray(STAND["first_mm"], float) + k * np.asarray(STAND["pitch_mm"], float)


def on_stand(k: int) -> np.ndarray:
    """Where a holder in fork k has its gauge line: its upper flange disc's underside on the tines."""
    return stand_axis(k) + [0.0, 0.0, -GROOVE[2]]


def stand_xml(n: int, waiting: dict[int, str]) -> str:
    """The stand with n forks (a static body, steel): each two tines in a holder's V-groove and a back stop, opening
    toward -Y, on a back plate standing on the table; holders in forks `waiting` ({fork: tool}) are on it, fixed, as
    nothing in the take moves them. The hand that wraps a holder's back passes under the back stop and in front of
    the plate."""
    c = STAND
    x0 = GROOVE[0] + c["clear"] + c["tine_w"] / 2
    geoms = []
    for k in range(n):
        a = stand_axis(k) - stand_axis(0)
        zc = a[2] - c["tine_t"] / 2
        yc = a[1] + (c["tine_back"] - c["tine_front"]) / 2
        hl = (c["tine_back"] + c["tine_front"]) / 2
        for s in (-1, 1):
            geoms.append(f'<geom name="stand_tine_{k}{"lr"[s > 0]}" class="steel" type="box" '
                         f'size="{_f([c["tine_w"] / 2, hl, c["tine_t"] / 2])}" pos="{_f([a[0] + s * x0, yc, zc])}"/>')
        geoms.append(f'<geom name="stand_back_{k}" class="steel" type="box" size="{_f([x0 + c["tine_w"] / 2, 3, 8])}" '
                     f'pos="{_f([a[0], a[1] + c["tine_back"] + 3, zc + 4])}"/>')
        geoms.append(f'<geom name="stand_arm_{k}" class="steel" type="box" size="{_f([6, (c["plate_y"] - c["tine_back"]) / 2, 8])}" '
                     f'pos="{_f([a[0], a[1] + (c["plate_y"] + c["tine_back"]) / 2, zc + 4])}"/>')
    span = stand_axis(n - 1) - stand_axis(0)
    h = stand_axis(0)[2] + 12 - c["table_z"]
    plate = (f'<geom name="stand_plate" class="steel" type="box" size="{_f([span[0] / 2 + 40, 4, h / 2])}" '
             f'pos="{_f([span[0] / 2, c["plate_y"] + 4, 12 - h / 2])}"/>'
             f'<geom name="stand_foot" class="steel" type="box" size="{_f([span[0] / 2 + 40, 30, 5])}" '
             f'pos="{_f([span[0] / 2, c["plate_y"] - 22, 5 + c["table_z"] - stand_axis(0)[2]])}"/>')
    held = "".join(f'<body name="stand_holder_{k}" pos="{_f(on_stand(k) - stand_axis(0))}">'
                   f'{holder_geoms(f"stand_holder_{k}", t, collide=True)}</body>' for k, t in waiting.items())
    return f'    <body name="tool_stand" pos="{_f(stand_axis(0))}">{"".join(geoms)}{plate}{held}</body>\n'


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
