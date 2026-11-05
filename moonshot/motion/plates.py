"""A plate setup's table (plan §7): the plate as moonshot/motion/loads.py part_pose poses it on the spoilboard, its
weight from the plan's stock, and the step clamps on it (moonshot/world/spoilboard.py), the one definition the plate
takes, the setting session and the conformance gate share.

A setup that slides the plate along the table ("shift") keeps the setup before's clamps where they were: their studs
stay in their T-slots, and the plate slides under their noses.
"""
from __future__ import annotations

from moonshot.motion.loads import part_pose
from moonshot.planning.validate import load_plan
from moonshot.world import spoilboard as SB

# the plans' stock, by the start of its material [proposed: handbook densities] until loads.py carries the plan's own
DENSITY = {"304 stainless": 8000.0, "delrin": 1410.0, "6061": 2700.0}


def density(plan: dict) -> float:
    material = plan["stock"]["material"].lower()
    return next(v for k, v in DENSITY.items() if material.startswith(k))


def _setup(plan: dict, setup_id: str) -> dict:
    return next(s for s in plan["setups"] if s["id"] == setup_id)


def plate(part: str, setup_id: str, plan: dict | None = None) -> SB.Plate:
    """The setup's plate on the spoilboard, at the loading position (world mm)."""
    plan = plan or load_plan(part)
    pose = part_pose(plan, setup_id)
    return SB.Plate(tuple(float(v) for v in pose["centre_mm"]), tuple(float(v) for v in pose["size_mm"]),
                    density(plan))


def clamps(part: str, setup_id: str, plan: dict | None = None) -> list[SB.Clamp]:
    """The setup's step clamps, clamped on its plate: a shifted setup's are the setup before's, on the plate as it
    now lies."""
    plan = plan or load_plan(part)
    i = [s["id"] for s in plan["setups"]].index(setup_id)
    w = _setup(plan, setup_id)["workholding"]
    if "shift" in w:
        before = clamps(part, plan["setups"][i - 1]["id"], plan)
        top = plate(part, setup_id, plan).top
        return [SB.Clamp(c.name, c.stud, c.yaw, top, c.heel_rise) for c in before]
    return SB.layout(plate(part, setup_id, plan), int(w["clamps"]))


def setups() -> list[tuple[str, str]]:
    """Every plate setup in the plans: (part, setup)."""
    from moonshot.planning.validate import PLANS
    out = []
    for f in sorted(PLANS.glob("*.json")):
        plan = load_plan(f.stem)
        out += [(f.stem, s["id"]) for s in plan["setups"] if "clamps" in s.get("workholding", {})]
    return out
