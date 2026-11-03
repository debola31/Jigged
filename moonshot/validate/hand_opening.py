"""Hand opening (plan §5.2; Bhatia 2022, Smeets 2020): on each reach to grasp the thumb and index open widest 71-77% of
the way through (person.peak_aperture_reach_frac), and wider for a bigger object, 0.74-0.92 mm per mm of its size
(person.aperture_per_object_mm). The size rule needs grasps of sizes 20 mm apart or more; a take that grasps one size is
judged on timing alone.

The aperture is the distance between the thumb's and the index's fingertips, posed from the run's own hand angles
(sim.npz q) on the body model's hand. Reaches are grasp_timing's. A take that isn't the vise's has each grasped
object's size from its record's colliders (moonshot/validate/objects.py thinnest_mm).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from moonshot.body.aperture import aperture_mm
from moonshot.contracts.thresholds import threshold
from moonshot.validate import objects
from moonshot.validate.grasp_timing import measure as grasp_inputs, reaches
from moonshot.validate.registry import Result, check


def measure(take: Path) -> dict:
    """What the check reads, from a physics run: the grasp-timing inputs, the aperture, and each grasped object's size
    across the grip (a vise take's: the blank's near-to-far faces, the knob's diameter)."""
    from moonshot.world import vise as V
    sim = np.load(take / "sim.npz")
    g = grasp_inputs(take)
    if objects.is_vise(sim):
        tk = json.loads((take / "take.json").read_text(encoding="utf-8"))
        load = V.Load.from_json(tk["load"]) if "load" in tk else V.REFERENCE
        size = {"blank": float(load.size_mm[1]), "knob": 2 * V.VISE["knob_r"]}
    else:
        size = {o: objects.thinnest_mm(take, o) for o in g["grasping"]}
    return {"fps": g["fps"], "hand_speed_mm_s": g["hand_speed_mm_s"], "touching": g["touching"],
            "grasping": g["grasping"], "aperture_mm": aperture_mm(sim["q"], [str(n) for n in sim["names"]]).tolist(),
            "size_mm": size}


MIN_SPREAD_MM = 20.0   # the size rule's slope, fitted on grasps this far apart or more: op30's 31 mm part and the 27 mm
                       # knob gave a slope of noise (-1.16 mm per mm), as the studies' objects span 2-8 cm


@check("hand_opening",
       good=["good/hand_opening_people.json"],
       bad=["bad/hand_opening_early_peak.json", "bad/hand_opening_one_size_fits_all.json"])
def hand_opening(take: dict) -> Result:
    """take: {"fps", "hand_speed_mm_s", "aperture_mm", "touching": per frame, "grasping": {object: per frame},
    "size_mm": {object: its size across the grip}}."""
    fps = float(take["fps"])
    speed, ap = np.asarray(take["hand_speed_mm_s"], float), np.asarray(take["aperture_mm"], float)
    if not len(ap):
        raise ValueError("a take with no frames can't pass a per-frame check")
    when, slope = threshold("person.peak_aperture_reach_frac").band, threshold("person.aperture_per_object_mm").band
    found, outside, peaks = [], [], {}
    for obj, grasping in take["grasping"].items():
        for start, contact in reaches(speed, take["touching"], obj, grasping, fps):
            k = start + int(np.argmax(ap[start:contact + 1]))
            frac = (k - start) / max(1, contact - start)
            found.append({"object": obj, "contact_frame": contact, "peak_frac": round(frac, 3),
                          "peak_mm": round(float(ap[k]), 1)})
            peaks.setdefault(obj, []).append(float(ap[k]))
            if not when[0] <= frac <= when[1]:
                outside.append(f"{obj}@{contact} widest at {frac:.0%} of the reach")
    if not found:
        raise ValueError("no reach to grasp: the hand never closed on what the take grasps")
    per_mm = None
    sizes = {o: take["size_mm"][o] for o in peaks}
    if max(sizes.values()) - min(sizes.values()) >= MIN_SPREAD_MM:
        x = np.array([sizes[o] for o in peaks for _ in peaks[o]])
        y = np.array([p for o in peaks for p in peaks[o]])
        per_mm = float(np.polyfit(x, y, 1)[0])
        if not slope[0] <= per_mm <= slope[1]:
            outside.append(f"opens {per_mm:.2f} mm wider per mm of object")
    return Result(passed=not outside, worst=float(len(outside)),
                  detail={"reaches": found, "aperture_per_object_mm": per_mm and round(per_mm, 3), "outside": outside})
