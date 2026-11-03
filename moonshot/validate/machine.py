"""Machines inside spec (plan §5.1): every machine axis a take records stays within its maker's travel and speed, and
the spindle within its top speed, from the station's record (moonshot/library/stations/vf2.json). The record gives
no acceleration, so none is judged.

The vise take's physics run doesn't record the VF-2's axes yet (checks.json machine_axes), so on it the check has
nothing to read.
"""
from __future__ import annotations

import numpy as np

from moonshot.contracts.thresholds import threshold
from moonshot.validate.registry import Result, check
from moonshot.world import vf2


def spec() -> dict[str, dict]:
    """Each recorded axis's limits, by the name the take records it under: vf2_x/y/z (mm, mm/s), vf2_spindle (rpm)."""
    J = vf2.record()["joints"]
    out = {f"vf2_{a}": {"range": J[a]["range_mm"], "speed": J[a]["speed_mm_s"]} for a in ("x", "y", "z")}
    out["vf2_spindle"] = {"range": [-J["spindle"]["max_rpm"], J["spindle"]["max_rpm"]], "speed": None}
    return out


@check("machines_inside_spec",
       good=["good/machines_vf2_program.json", "good/machines_vf2_time_lapse.json"],
       bad=["bad/machines_vf2_past_travel.json", "bad/machines_vf2_too_fast.json"])
def machines_inside_spec(take: dict) -> Result:
    """take: {"fps", "machine_axes": {axis: per-frame position, mm (the spindle in rpm)}} and, for a time-lapsed take,
    "frame_machine_s": the machine's clock at each frame (a cycle take's program.json), which speeds are read
    against instead of the video's frame rate. Axes with no record fail."""
    fps, axes, limits = float(take["fps"]), take["machine_axes"], spec()
    clock = take.get("frame_machine_s")
    if not axes or not any(len(v) for v in axes.values()):
        raise ValueError("a take with no frames can't pass a per-frame check")
    travel_tol = threshold("physics.machine_travel_mm").value
    speed_tol = threshold("physics.machine_speed_frac").value
    out, worst = {}, 0.0
    for name, x in axes.items():
        if name not in limits:
            out[name] = "no record"
            continue
        x, lim = np.asarray(x, float), limits[name]
        lo, hi = lim["range"]
        past = float(max(lo - x.min(), x.max() - hi, 0.0))
        fast = 0.0
        if lim["speed"] is not None and len(x) > 1:
            dt = np.diff(np.asarray(clock, float)) if clock is not None else np.full(len(x) - 1, 1.0 / fps)
            fast = float((np.abs(np.diff(x)) / np.maximum(dt, 1e-9)).max() / lim["speed"])
        if past > travel_tol or fast > 1 + speed_tol:
            out[name] = {"past_travel": round(past, 2), "speed_of_rapid": round(fast, 3)}
        worst = max(worst, fast)
    return Result(passed=not out, worst=worst, detail={"out_of_spec": out})
