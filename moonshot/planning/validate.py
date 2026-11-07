"""Check a process plan against its part and the shop (moonshot/planning/plans/<part>.json).

A plan is written by hand from the drawing, so the validator is what stops it naming a feature the part doesn't
have: every feature a plan claims (a hole's diameter, axis and count; a planar face's level) is measured from the
STEP model; the stock must contain the part along each of the model's axes, fit each mill's travel and the opening
of the vise it's clamped in, a lathe's chuck or collet and its cutting envelope, and a surface grinder's magnetic
chuck, and the bar it's sawn from, flat or round, must fit the saw; and every tool, fixture and gauge is either in the
catalogue or listed as missing.

    python -m moonshot.planning.validate nist-ftc-10
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from functools import cache
from pathlib import Path

from moonshot.config import data_root

PLANS = Path(__file__).resolve().parent / "plans"
RECORDS = Path(__file__).resolve().parents[1] / "library" / "records" / "assets"
SHOP = RECORDS.parent / "shop.json"
AXES = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}
INCH = 25.4


def load_plan(part: str) -> dict:
    return json.loads((PLANS / f"{part}.json").read_text(encoding="utf-8"))


@cache
def measure(step_path: str) -> dict:
    """Holes (distinct axes per diameter and direction) and planar faces (by outward normal and level) of a part."""
    import cadquery as cq
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    shape = cq.importers.importStep(step_path)
    holes, planes = defaultdict(set), defaultdict(float)
    for f in shape.faces().vals():
        if f.geomType() == "CYLINDER":
            c = BRepAdaptor_Surface(f.wrapped).Cylinder()   # also a cylinder stored as a trimmed surface (ll-1007223)
            dr, loc = c.Axis().Direction(), c.Axis().Location()
            axis = tuple(round(abs(v)) for v in (dr.X(), dr.Y(), dr.Z()))
            p = tuple(0 if axis[i] else round(v, 1) for i, v in enumerate((loc.X(), loc.Y(), loc.Z())))
            holes[(round(c.Radius() * 2, 2), axis)].add(p)
        elif f.geomType() == "PLANE":
            n, c = f.normalAt(), f.Center()
            normal = tuple(round(v) for v in (n.x, n.y, n.z))
            level = {0: c.x, 1: c.y, 2: c.z}[next(i for i, v in enumerate(normal) if v)]
            planes[(normal, round(level, 1))] += f.Area()
    bb = shape.val().BoundingBox()
    return {"holes": {k: len(v) for k, v in holes.items()}, "planes": dict(planes),
            "size_mm": (round(bb.xlen, 2), round(bb.ylen, 2), round(bb.zlen, 2))}


def record(asset: str) -> dict:
    return json.loads(next(RECORDS.glob(f"*/{asset}/{asset}.json")).read_text(encoding="utf-8"))


def _mm(spec: dict) -> float:
    return float(spec["value"]) * (INCH if spec.get("unit") == "in" else 1)


def machine_travel_mm(machine: str) -> dict[str, float]:
    """A mill's X, Y and Z travel; empty for a machine that has none (the band saw)."""
    return {s["name"][0]: _mm(s) for s in record(machine).get("key_specs", [])
            if s["name"] in ("X travel", "Y travel", "Z travel")}


def vise_opening_mm(vise: str) -> float:
    return next(_mm(s) for s in record(vise)["key_specs"] if s["name"].startswith("Max opening"))


def machine_kind(machine: str) -> str:
    """The machine's kind in shop.json (vmc, band_saw, lathe, surface_grinder, ...), by its asset."""
    return next(m["kind"] for m in json.loads(SHOP.read_text(encoding="utf-8"))["machines"] if m["asset"] == machine)


def _spec(asset: str, name: str) -> dict:
    return next(s for s in record(asset)["key_specs"] if s["name"] == name)


def _inches(text: str) -> float:
    """A size in inches, "18-1/2" or "6", as mm."""
    whole, _, frac = text.strip().partition("-")
    num, _, den = frac.partition("/")
    return (float(whole) + (float(num) / float(den) if frac else 0.0)) * INCH


def saw_capacity_mm(saw: str) -> tuple[float, float]:
    """The rectangle a horizontal band saw cuts, (height, width) mm, from its "9 x 16 in" capacity."""
    spec = next(s["value"] for s in record(saw)["key_specs"] if s["name"] == "Capacity, rectangle")
    h, w = (float(v) * INCH for v in spec.removesuffix(" in").split(" x "))
    return h, w


def saw_round_mm(saw: str) -> float:
    """The largest round bar a band saw cuts, mm."""
    return _mm(_spec(saw, "Capacity, round"))


def stock_diameter_mm(stock: dict) -> float:
    """A round stock's diameter: its size across its axis ("axis": the model axis it turns about)."""
    i = "XYZ".index(stock["axis"])
    return max(v for j, v in enumerate(stock["size_mm"]) if j != i)


def lathe_fits(setup: dict, stock: dict) -> list[str]:
    """A lathe setup: the stock in its chuck (a collet's capacity, a chuck's diameter) and the lathe's envelope."""
    sid, machine, chuck = setup["id"], setup["machine"], setup["workholding"]["chuck"]
    dia, length = stock_diameter_mm(stock), stock["size_mm"]["XYZ".index(stock["axis"])]
    out = []
    if any(s["name"] == "Collet type" for s in record(chuck)["key_specs"]):
        cap = _mm(_spec(chuck, "Capacity"))
        if dia > cap:
            out.append(f"{sid}: the stock is Ø{dia} mm; the {chuck} collet takes {cap:.1f} mm")
    else:
        cap = _mm(_spec(chuck, "Chuck diameter"))
        if dia > cap:
            out.append(f"{sid}: the stock is Ø{dia} mm, past the {chuck} chuck's {cap:.0f} mm")
    if dia > _mm(_spec(machine, "Max cutting diameter (BOT turret)")):
        out.append(f"{sid}: the stock is Ø{dia} mm, past the {machine}'s cutting diameter")
    if length > _mm(_spec(machine, "Max cutting length")):
        out.append(f"{sid}: the stock is {length} mm long, past the {machine}'s cutting length")
    return out


def grinder_fits(setup: dict, stock: dict) -> list[str]:
    """A surface grinder setup: the stock's footprint on its magnetic chuck, the grinder's own (its record's "Chuck
    size", when the chuck is the machine) or a chuck of its own record ("Size")."""
    sid, chuck = setup["id"], setup["workholding"]["chuck"]
    spec = _spec(chuck, "Chuck size" if chuck == setup["machine"] else "Size")["value"]
    size = sorted((_inches(v) for v in spec.split(" in")[0].split(" x ")), reverse=True)
    footprint = sorted(stock["size_mm"], reverse=True)[:2]
    if footprint[0] > size[0] or footprint[1] > size[1]:
        return [f"{sid}: the stock's {footprint} mm footprint is bigger than the {chuck} chuck's "
                f"{size[0]:.0f} x {size[1]:.0f} mm"]
    return []


def catalogue() -> set[str]:
    return {p.stem for p in RECORDS.glob("*/*/*.json") if not p.stem.endswith("_rig")}


def pending() -> set[str]:
    """Catalogue entries with no model built yet (their record's "pending" says why)."""
    return {p.stem for p in RECORDS.glob("*/*/*.json")
            if "pending" in json.loads(p.read_text(encoding="utf-8"))}


def fits(setup: dict, stock: dict) -> list[str]:
    """What keeps the stock out of this setup's machine or vise. The stock's size_mm is along the model's x, y, z."""
    sid, machine, size = setup["id"], setup["machine"], stock["size_mm"]
    kind = machine_kind(machine)
    if kind == "lathe":
        return lathe_fits(setup, stock)
    if kind == "surface_grinder":
        return grinder_fits(setup, stock)
    travel = machine_travel_mm(machine)
    out = []
    if travel:
        footprint = sorted(size, reverse=True)[:2]
        if footprint[0] > travel["X"] or footprint[1] > travel["Y"]:
            out.append(f"{sid}: stock {footprint} mm exceeds the {machine}'s "
                       f"{travel['X']:.0f} x {travel['Y']:.0f} mm travel")
    elif "bar_dia_mm" in stock:                         # a saw: a round bar must fit its round capacity
        cap = saw_round_mm(machine)
        if stock["bar_dia_mm"] > cap:
            out.append(f"{sid}: the Ø{stock['bar_dia_mm']} mm bar is bigger than the {machine}'s {cap:.0f} mm round")
    else:                                               # a saw: the bar's section must fit its capacity
        cap, bar = sorted(saw_capacity_mm(machine)), sorted(stock["bar_mm"])
        if bar[0] > cap[0] or bar[1] > cap[1]:
            out.append(f"{sid}: the {bar} mm bar is bigger than the {machine}'s {cap[0]:.0f} x {cap[1]:.0f} mm")
    w = setup.get("workholding", {})
    if "vise" in w:
        across, opening = size["XYZ".index(w["jaw_on"][0])], vise_opening_mm(w["vise"])
        if across > opening:
            out.append(f"{sid}: the stock is {across} mm across the jaws; the {w['vise']} opens {opening:.1f} mm")
    return out


def named_assets(plan: dict) -> set[str]:
    """Every catalogue entry the plan names: its operations' tools, its finishing steps' gauges, and each setup's
    vise, chuck, fixture and keepers."""
    tools = {op["tool"] for s in plan["setups"] for op in s["operations"]}
    tools |= {t for f in plan.get("finish", []) for t in f.get("tools", [])}
    tools |= {s["workholding"][k] for s in plan["setups"] for k in ("vise", "chuck", "fixture", "keepers")
              if k in s.get("workholding", {})}
    return tools


def check(plan: dict, step_path: Path | None = None) -> dict:
    """{"problems": [...], "missing_tools": [...], "pending_tools": [...]}: problems are errors in the plan; missing
    tools (no record: a tool, a fixture or a gauge) and pending ones (a record, no model yet) are catalogue work
    (track B), not plan errors."""
    step_path = step_path or data_root() / "parts" / plan["part"] / "part.step"
    meas = measure(str(step_path))
    problems = []
    for setup in plan["setups"]:
        for op in setup["operations"]:
            for f in op.get("features", []):
                where = f"{setup['id']}.{op['id']}"
                if f["type"] == "hole":
                    got = meas["holes"].get((f["dia_mm"], AXES[f["axis"]]), 0)
                    if got != f["count"]:
                        problems.append(f"{where}: the part has {got} Ø{f['dia_mm']} holes along {f['axis']}, "
                                        f"not {f['count']}")
                elif f["type"] == "plane":
                    sign = -1 if f["normal"].startswith("-") else 1
                    normal = tuple(sign * v for v in AXES[f["normal"][-1]])
                    if (normal, f["at_mm"]) not in meas["planes"]:
                        problems.append(f"{where}: the part has no {f['normal']} face at {f['at_mm']} mm")
        problems += fits(setup, plan["stock"])
    if any(s < m for s, m in zip(plan["stock"]["size_mm"], meas["size_mm"])):
        problems.append(f"stock {plan['stock']['size_mm']} mm doesn't contain the part {meas['size_mm']} mm")
    have = catalogue()
    tools = named_assets(plan)
    return {"problems": problems, "missing_tools": sorted(tools - have), "pending_tools": sorted(tools & pending())}


def main(argv: list[str]) -> int:
    out = check(load_plan(argv[0]))
    print(json.dumps(out, indent=1))
    return 1 if out["problems"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
