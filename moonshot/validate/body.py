"""The body inside its limits, per frame, on the physics run (plan §5.1; docs/moonshot/physics.md).

Each joint's own range is MuJoCo's to enforce and test_body_conformance.py's to prove. What this adds is the limit
joints set on each other: the wrist's flexion and deviation together stay inside an ellipse (Gracia-Ibanez 2020),
measured from the run's own joint angles with the semi-axes in moonshot/body/data/anatomy.json, so the check
doesn't use the planner or the body's code for it (plan §6, rule 2).
"""
from __future__ import annotations

import json
import math

from moonshot.body.skeleton import DATA
from moonshot.contracts.thresholds import threshold
from moonshot.validate.registry import Result, check


def _ellipse(fl: float, dv: float, wd: dict, grow: float) -> float:
    f = fl / (wd["flexion"] + grow) if fl > 0 else fl / (wd["extension"] + grow)
    d = dv / (wd["radial"] + grow) if dv > 0 else dv / (wd["ulnar"] + grow)
    return math.hypot(f, d)


@check("wrist_ellipse",
       good=["good/wrist_ellipse_inside.json"],
       bad=["bad/wrist_ellipse_reference_peak.json", "bad/wrist_ellipse_corner.json"])
def wrist_ellipse(take: dict) -> Result:
    """take: {"wrist_deg": [per-frame [flexion (+) / extension (-), radial (+) / ulnar (-)], degrees]}. 1.0 is the
    ellipse's edge, its semi-axes grown by the joint-range tolerance MuJoCo's soft limits need."""
    wd = json.loads((DATA / "anatomy.json").read_text(encoding="utf-8"))["wrist_deg"]
    tol = threshold("body.joint_range_tolerance_deg").value
    frames = take["wrist_deg"]
    if not frames:
        raise ValueError("a take with no frames can't pass a per-frame check")
    e = [_ellipse(fl, dv, wd, tol) for fl, dv in frames]
    over = [i for i, x in enumerate(e) if x > 1.0]
    return Result(passed=not over, worst=max(e),
                  detail={"frames_over": len(over), "first_over": over[0] if over else None})
