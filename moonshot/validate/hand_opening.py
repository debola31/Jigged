"""Hand opening (plan §5.2; Bhatia 2022, Smeets 2020): on each reach to grasp the thumb and index open widest 71-77% of
the way through (person.peak_aperture_reach_frac), and wider for a bigger object, 0.74-0.92 mm per mm of its size
(person.aperture_per_object_mm). The size rule needs grasps of sizes 20 mm apart or more; a take that grasps one size is
judged on timing alone.

The aperture is the distance between the thumb's and the index's fingertips, posed from the run's own hand angles
(sim.npz q) on the body model's hand. Reaches are grasp_timing's, timed between frames (the user's decision,
2026-11-04): at 30 fps one frame is 7% of a half-second reach, wider than the 6% band, so on frames alone a reach
had one frame that passed and a frame's shift failed it. The reach starts where the hand's speed crosses its onset
between the frames either side; it ends at the first touch, at the physics step it came on (checks.json touch_lead,
which the run records); and the hand is widest at the peak of a parabola through the widest frame and the frames
either side of it. A recording of people (the fixtures) has its frames only, and its touch is its contact frame.

A take that isn't the vise's has each grasped
object's size from its record's colliders (moonshot/validate/objects.py thinnest_mm), and a left hand's reach is read
from the left hand's aperture (sim.npz L_q; q_L in a run with the vise's keys, as the door takes', whose bars are sized
across their width).

A grasp the user exempted from this check (take.json "exempt", as grasp_timing reads it) isn't judged: its reaches are
listed as exempt, and a take whose every grasp is exempt passes on that alone.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from moonshot.body.aperture import aperture_mm
from moonshot.contracts.thresholds import threshold
from moonshot.validate import objects
from moonshot.validate.grasp_timing import BARS, all_exempt, exempt, hand_of, measure as grasp_inputs, reaches
from moonshot.validate.registry import Result, check


def measure(take: Path) -> dict:
    """What the check reads, from a physics run: the grasp-timing inputs, the aperture, and each grasped object's size
    across the grip (a vise take's: the blank's near-to-far faces, the knob's diameter, a door's handle bar's width)."""
    from moonshot.world import vf2
    from moonshot.world import vise as V
    sim = np.load(take / "sim.npz")
    g = grasp_inputs(take)
    if objects.is_vise(sim):
        tk = json.loads((take / "take.json").read_text(encoding="utf-8"))
        load = V.Load.from_json(tk["load"]) if "load" in tk else V.REFERENCE
        bars = {geom: vf2.record()["colliders"][geom[len("vf2_"):]] for geom in set(BARS.values())}
        size = ({"blank": float(load.size_mm[1]), "knob": 2 * V.VISE["knob_r"]}
                | {geom: c["box_max_mm"][0] - c["box_min_mm"][0] for geom, c in bars.items()})
    else:
        size = {o: objects.thinnest_mm(take, o) for o in g["grasping"]}
    names = [str(n) for n in sim["names"]]
    out = {"fps": g["fps"], "hand_speed_mm_s": g["hand_speed_mm_s"], "touching": g["touching"],
           "grasping": g["grasping"], "aperture_mm": aperture_mm(sim["q"], names).tolist(), "size_mm": size,
           "touch_lead": g["touch_lead"]}
    if "hand" in g:
        out |= {"hand": g["hand"], "hand_speed_L_mm_s": g["hand_speed_L_mm_s"],
                "aperture_L_mm": aperture_mm(sim[left_q_key(sim)], names).tolist()}
    if "exempt" in g:
        out["exempt"] = g["exempt"]
    return out


def left_q_key(sim) -> str:
    """Where a run's sim.npz keeps the left hand's angles: q_L in the vise runner's keys and in a step take's
    (moonshot/sim/runner.py TakeRunner.export), L_q in the bench's. Read as L_q alone, a step take's left-hand grasp
    had nothing to read."""
    return "L_q" if "L_q" in sim.files else "q_L"


def between_frames(speed: np.ndarray, ap: np.ndarray, start: int, contact: int, lead: float) -> tuple[float, float]:
    """A reach's widest opening as a fractional frame, and how far through the reach it is: the onset where the
    speed crosses its threshold between start and the frame after; the touch lead frames before the contact frame;
    the widest point a parabola's peak through the widest frame and its neighbours."""
    frac = threshold("person.movement_onset_frac").value
    peak_v = float(np.max(speed[start:contact + 1]))
    t0 = float(start)
    if start + 1 < len(speed) and speed[start + 1] > speed[start]:
        t0 += float(np.clip((frac * peak_v - speed[start]) / (speed[start + 1] - speed[start]), 0.0, 1.0))
    t1 = contact - float(np.clip(lead, 0.0, 1.0))
    k = start + int(np.argmax(ap[start:contact + 1]))
    tk = float(k)
    if start < k < contact:
        den = ap[k - 1] - 2 * ap[k] + ap[k + 1]
        if den < 0:
            tk += float(np.clip(0.5 * (ap[k - 1] - ap[k + 1]) / den, -0.5, 0.5))
    tk = min(max(tk, t0), t1)
    return tk, (tk - t0) / max(1e-6, t1 - t0)


MIN_SPREAD_MM = 20.0   # the size rule's slope, fitted on grasps this far apart or more: op30's 31 mm part and the 27 mm
                       # knob gave a slope of noise (-1.16 mm per mm), as the studies' objects span 2-8 cm


@check("hand_opening",
       good=["good/hand_opening_people.json", "good/hand_opening_left_hand.json"],
       bad=["bad/hand_opening_early_peak.json", "bad/hand_opening_one_size_fits_all.json",
            "bad/hand_opening_left_early_peak.json"])
def hand_opening(take: dict) -> Result:
    """take: {"fps", "hand_speed_mm_s", "aperture_mm", "touching": per frame, "grasping": {object: per frame},
    "size_mm": {object: its size across the grip}}, and for the left hand's grasps "hand" ({object: "L"}),
    "hand_speed_L_mm_s" and "aperture_L_mm"; a physics run's "touch_lead" (per frame, {object: frames before it the
    touch came on})."""
    fps = float(take["fps"])
    if not len(take["aperture_mm"]):
        raise ValueError("a take with no frames can't pass a per-frame check")
    when, slope = threshold("person.peak_aperture_reach_frac").band, threshold("person.aperture_per_object_mm").band
    found, outside, peaks, excused = [], [], {}, []
    for obj, grasping in take["grasping"].items():
        side, speed = hand_of(take, obj)
        ap = np.asarray(take["aperture_mm" if side == "R" else "aperture_L_mm"], float)
        for start, contact in reaches(speed, take["touching"], obj, grasping, fps):
            if exempt(take, "hand_opening", obj, contact):
                excused.append({"object": obj, "contact_frame": contact})
                continue
            lead = take["touch_lead"][contact].get(obj, 0.0) if "touch_lead" in take else 0.0
            _, frac = between_frames(speed, ap, start, contact, lead)
            k = start + int(np.argmax(ap[start:contact + 1]))
            found.append({"object": obj, "hand": side, "contact_frame": contact, "peak_frac": round(frac, 3),
                          "peak_mm": round(float(ap[k]), 1)})
            peaks.setdefault(obj, []).append(float(ap[k]))
            if not when[0] <= frac <= when[1]:
                outside.append(f"{obj}@{contact} widest at {frac:.0%} of the reach")
    if not found:
        if all_exempt(take, "hand_opening"):
            return Result(passed=True, worst=0.0, detail={"reaches": [], "aperture_per_object_mm": None, "outside": [],
                                                          "exempt": all_exempt(take, "hand_opening"),
                                                          "exempt_reaches": excused})
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
                  detail={"reaches": found, "aperture_per_object_mm": per_mm and round(per_mm, 3), "outside": outside}
                  | ({"exempt_reaches": excused} if excused else {}))
