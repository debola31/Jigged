"""The hand touches only what it is working on, per frame, on the physics run (plan §5.1; docs/moonshot/physics.md).

Some parts are never held: the crank's lever turns round the knob the fist holds, so a hand touching it is a hand
inside a moving part, which no grip gets away with. Grazing contacts elsewhere (a fingertip on the table) are
reported by the run, not failed here.
"""
from __future__ import annotations

from moonshot.validate.registry import Result, check


@check("never_held_parts",
       good=["good/never_held_parts_knob_only.json"],
       bad=["bad/never_held_parts_lever.json"])
def never_held_parts(take: dict) -> Result:
    """take: {"touching": [per-frame geom names the hand touches], "never_held": [geom names]}."""
    frames, never = take["touching"], set(take["never_held"])
    if not frames:
        raise ValueError("a take with no frames can't pass a per-frame check")
    over = [i for i, names in enumerate(frames) if never & set(names)]
    return Result(passed=not over, worst=float(len(over)),
                  detail={"frames_touching": len(over), "first": over[0] if over else None,
                          "parts": sorted({n for i in over for n in frames[i] if n in never})})
