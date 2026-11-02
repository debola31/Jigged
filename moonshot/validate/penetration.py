"""Nothing passes through solids: the rendered skin, measured per frame (plan §5.1).

The depths come from the rendered skin mesh against each solid, never from MuJoCo's own contact report, so the
check doesn't use the code it checks (plan §6, rule 2). Ported from trainual's blender/check_penetration.py.
"""
from __future__ import annotations

from moonshot.contracts.thresholds import threshold
from moonshot.validate.registry import Result, check


@check("skin_penetration",
       good=["good/skin_penetration_load_blank.json"],
       bad=["bad/skin_penetration_2mm_spike.json", "bad/skin_penetration_sustained.json"])
def skin_penetration(take: dict) -> Result:
    """take: {"depth_mm": [per-frame deepest skin vertex inside any solid]}."""
    limit = threshold("physics.skin_penetration_mm").value
    depths = take["depth_mm"]
    if not depths:
        raise ValueError("a take with no frames can't pass a per-frame check")
    over = [i for i, d in enumerate(depths) if d >= limit]
    worst = max(depths)
    return Result(passed=not over, worst=worst,
                  detail={"limit_mm": limit, "frames_over": len(over), "first_over": over[0] if over else None})
