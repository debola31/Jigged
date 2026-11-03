"""Hand opening (plan §5.2; Bhatia 2022, Smeets 2020): on each reach to grasp the thumb and index open widest 71-77% of
the way through (person.peak_aperture_reach_frac), and wider for a bigger object, 0.74-0.92 mm per mm of its size
(person.aperture_per_object_mm). The size rule needs grasps of two sizes or more; a take that grasps one size is
judged on timing alone.

The aperture is the distance between the thumb's and the index's fingertips, posed from the run's own hand angles
(sim.npz q) on the body model's hand. Reaches are grasp_timing's.
"""
from __future__ import annotations

import functools
import json
from pathlib import Path

import mujoco
import numpy as np

from moonshot.contracts.thresholds import threshold
from moonshot.validate.grasp_timing import measure as grasp_inputs, reaches
from moonshot.validate.registry import Result, check


@functools.cache
def _body():
    from moonshot.body.skeleton import build
    body = build()
    return body, mujoco.MjModel.from_xml_string(body.xml)


def aperture_mm(q: np.ndarray, names: list[str]) -> np.ndarray:
    """Per frame, thumb tip to index tip (mm), from the right hand's anatomical angles."""
    body, m = _body()
    d = mujoco.MjData(m)
    adr = [m.jnt_qposadr[m.joint(f"R_{n}").id] for n in names]
    rest = np.array([body.joints[f"R_{n}"].rest for n in names])
    tips = [m.geom(f"R_g_{s}").id for s in ("dis1", "dis2")]
    out = []
    for row in q:
        d.qpos[adr] = np.radians(row - rest)
        mujoco.mj_kinematics(m, d)
        ends = []
        for g in tips:                                   # the capsule's end farther from its joint
            c, ax, half = d.geom_xpos[g], d.geom_xmat[g].reshape(3, 3)[:, 2], m.geom_size[g, 1]
            joint = d.xpos[m.geom_bodyid[g]]
            ends.append(max((c + ax * half, c - ax * half), key=lambda p: np.linalg.norm(p - joint)))
        out.append(np.linalg.norm(ends[0] - ends[1]) * 1000)
    return np.array(out)


def measure(take: Path) -> dict:
    """What the check reads, from a vise take's physics run: the grasp-timing inputs, the aperture, and each grasped
    object's size across the grip (the blank's near-to-far faces, the knob's diameter)."""
    from moonshot.world import vise as V
    sim = np.load(take / "sim.npz")
    tk = json.loads((take / "take.json").read_text(encoding="utf-8"))
    load = V.Load.from_json(tk["load"]) if "load" in tk else V.REFERENCE
    g = grasp_inputs(take)
    return {"fps": g["fps"], "hand_speed_mm_s": g["hand_speed_mm_s"], "touching": g["touching"],
            "grasping": g["grasping"], "aperture_mm": aperture_mm(sim["q"], [str(n) for n in sim["names"]]).tolist(),
            "size_mm": {"blank": float(load.size_mm[1]), "knob": 2 * V.VISE["knob_r"]}}


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
    if len(set(sizes.values())) > 1:
        x = np.array([sizes[o] for o in peaks for _ in peaks[o]])
        y = np.array([p for o in peaks for p in peaks[o]])
        per_mm = float(np.polyfit(x, y, 1)[0])
        if not slope[0] <= per_mm <= slope[1]:
            outside.append(f"opens {per_mm:.2f} mm wider per mm of object")
    return Result(passed=not outside, worst=float(len(outside)),
                  detail={"reaches": found, "aperture_per_object_mm": per_mm and round(per_mm, 3), "outside": outside})
