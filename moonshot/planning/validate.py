"""Check a process plan against its part and the shop (moonshot/planning/plans/<part>.json).

A plan is written by hand from the drawing, so the validator is what stops it naming a feature the part doesn't
have: every feature a plan claims (a hole's diameter, axis and count; a planar face's level) is measured from the
STEP model; the stock must fit the machine's travel; and every tool is either in the catalogue or listed as missing.

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
AXES = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}
INCH = 25.4


def load_plan(part: str) -> dict:
    return json.loads((PLANS / f"{part}.json").read_text(encoding="utf-8"))


@cache
def measure(step_path: str) -> dict:
    """Holes (distinct axes per diameter and direction) and planar faces (by outward normal and level) of a part."""
    import cadquery as cq
    shape = cq.importers.importStep(step_path)
    holes, planes = defaultdict(set), defaultdict(float)
    for f in shape.faces().vals():
        if f.geomType() == "CYLINDER":
            c = f._geomAdaptor().Cylinder()
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


def machine_travel_mm(machine: str) -> dict[str, float]:
    rec = json.loads(next(RECORDS.glob(f"*/{machine}/{machine}.json")).read_text(encoding="utf-8"))
    out = {}
    for s in rec.get("key_specs", []):
        if s["name"] in ("X travel", "Y travel", "Z travel"):
            out[s["name"][0]] = float(s["value"]) * (INCH if s.get("unit") == "in" else 1)
    return out


def catalogue() -> set[str]:
    return {p.stem for p in RECORDS.glob("*/*/*.json") if not p.stem.endswith("_rig")}


def check(plan: dict, step_path: Path | None = None) -> dict:
    """{"problems": [...], "missing_tools": [...]}: problems are errors in the plan; missing tools are catalogue
    work (track B), not plan errors."""
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
        travel = machine_travel_mm(setup["machine"])
        footprint = sorted(plan["stock"]["size_mm"], reverse=True)[:2]
        if footprint[0] > travel["X"] or footprint[1] > travel["Y"]:
            problems.append(f"{setup['id']}: stock {footprint} mm exceeds the {setup['machine']}'s "
                            f"{travel['X']:.0f} x {travel['Y']:.0f} mm travel")
    if min(plan["stock"]["size_mm"]) < min(meas["size_mm"]) or \
            sorted(plan["stock"]["size_mm"]) < sorted(meas["size_mm"]):
        problems.append(f"stock {plan['stock']['size_mm']} mm doesn't contain the part {meas['size_mm']} mm")
    have = catalogue()
    tools = {op["tool"] for s in plan["setups"] for op in s["operations"]}
    tools |= {t for f in plan.get("finish", []) for t in f.get("tools", [])}
    return {"problems": problems, "missing_tools": sorted(tools - have)}


def main(argv: list[str]) -> int:
    out = check(load_plan(argv[0]))
    print(json.dumps(out, indent=1))
    return 1 if out["problems"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
