"""Matches its footage (plan §5.2, §4): for a take whose usage card has footage, the take's hand moves in segments
timed like the footage's: the median segment as long as the footage's middle half, the peak speed and the widest
opening as far through each as the footage's medians, within person.footage_frac_band. A card without footage has
nothing to match and passes, saying so.

The take's segments are found exactly as trainual's motion/analyze_timing.py found the footage's: the wrist's speed
in hand lengths per second, smoothed over 5 frames, moving above 1.2, segments 6 to 90 frames long. Which card a
take plays is take.json's `card`, which the vise take's planner doesn't write yet.
"""
from __future__ import annotations

import json
from pathlib import Path

import mujoco
import numpy as np

from moonshot.contracts.thresholds import threshold
from moonshot.validate.registry import Result, check

CARDS = Path(__file__).resolve().parents[1] / "cards"
MOVING_HAND_LENGTHS_S = 1.2     # trainual's analyze_timing.py, so the take is cut as its footage was
SEGMENT_FRAMES = (6, 90)


def segments(wrist_mm: np.ndarray, aperture_mm: np.ndarray, hand_mm: float, fps: float) -> list[dict]:
    """Each movement segment: its length (s), and how far through it the peak speed and the widest opening come."""
    sp = np.full(len(wrist_mm), np.nan)
    sp[1:] = np.linalg.norm(np.diff(wrist_mm, axis=0), axis=1) * fps / hand_mm
    sp = np.convolve(np.nan_to_num(sp), np.ones(5) / 5, "same")
    moving, out, i = sp > MOVING_HAND_LENGTHS_S, [], 0
    while i < len(sp):
        if not moving[i]:
            i += 1
            continue
        j = i
        while j < len(sp) and moving[j]:
            j += 1
        if SEGMENT_FRAMES[0] <= j - i <= SEGMENT_FRAMES[1]:
            n = max(1, j - i - 1)
            out.append({"t0": round(i / fps, 2), "dur_s": round((j - i) / fps, 2),
                        "peak_speed_frac": round(int(np.argmax(sp[i:j])) / n, 2),
                        "peak_aperture_frac": round(int(np.argmax(aperture_mm[i:j])) / n, 2)})
        i = j
    return out


def card_footage(card_id: str) -> dict | None:
    """The card's footage measurements for the right hand, or None if the card has no footage."""
    card = json.loads((CARDS / f"{card_id}.json").read_text(encoding="utf-8"))
    files = [s["file"] for s in card["sources"] if s["kind"] == "footage" and "file" in s]
    if not files:
        return None
    root = Path(__file__).resolve().parents[2]
    return json.loads((root / files[0]).read_text(encoding="utf-8"))["measured"]["Right"]


def hand_length_mm() -> float:
    """Wrist to the middle finger's knuckle, the hand length the footage was measured in (MediaPipe's 0 to 9)."""
    from moonshot.body.skeleton import build
    m = mujoco.MjModel.from_xml_string(build().xml)
    d = mujoco.MjData(m)
    mujoco.mj_kinematics(m, d)
    return float(np.linalg.norm(d.body("R_pro3").xpos - d.body("R_hand").xpos) * 1000)


def measure(take: Path) -> dict:
    """What the check reads, from a physics run: the right wrist's path and the aperture (validate/hand_opening.py),
    and the footage of the card take.json names."""
    from moonshot.validate.hand_opening import aperture_mm
    sim = np.load(take / "sim.npz")
    tk = json.loads((take / "take.json").read_text(encoding="utf-8"))
    out = {"fps": float(sim["fps"]), "wrist_mm": sim["W"].tolist(), "hand_length_mm": hand_length_mm(),
           "aperture_mm": aperture_mm(sim["q"], [str(n) for n in sim["names"]]).tolist()}
    if "card" in tk:
        out["footage"] = card_footage(tk["card"])
    return out


@check("matches_its_footage",
       good=["good/footage_like_kurt_vise.json", "good/footage_none.json"],
       bad=["bad/footage_slow_segments.json", "bad/footage_late_opening.json"])
def matches_its_footage(take: dict) -> Result:
    """take: {"fps", "wrist_mm": per frame, "aperture_mm": per frame, "hand_length_mm", "footage": the card's measured
    right hand (dur_iqr, peak_speed_frac_median, peak_aperture_frac_median), or null for a card with none}."""
    footage = take["footage"]
    if footage is None:
        return Result(passed=True, worst=0.0, detail={"footage": "the card has none"})
    wrist = np.asarray(take["wrist_mm"], float)
    if not len(wrist):
        raise ValueError("a take with no frames can't pass a per-frame check")
    segs = segments(wrist, np.asarray(take["aperture_mm"], float), float(take["hand_length_mm"]), float(take["fps"]))
    if not segs:
        return Result(passed=False, worst=1.0, detail={"segments": 0, "outside": ["the hand never moves as a segment"]})
    band = threshold("person.footage_frac_band").value
    med = {k: float(np.median([s[k] for s in segs])) for k in ("dur_s", "peak_speed_frac", "peak_aperture_frac")}
    lo, hi = footage["dur_iqr"]
    outside = [] if lo <= med["dur_s"] <= hi else [f"median segment {med['dur_s']:.2f} s, the footage's {lo}-{hi} s"]
    for k in ("peak_speed_frac", "peak_aperture_frac"):
        if abs(med[k] - footage[f"{k}_median"]) > band:
            outside.append(f"median {k} {med[k]:.2f}, the footage's {footage[f'{k}_median']}")
    return Result(passed=not outside, worst=float(len(outside)),
                  detail={"segments": len(segs), "median": med, "outside": outside})
