"""Motion building blocks shared by every take: minimum-jerk timing, hand shapes, wrist paths and tremor. Ported
from trainual's motion/showcase_motion.py; the scene constants it held are in moonshot/world/vise.py."""
from __future__ import annotations

import math

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.body.hand import AnatomicalHand

FPS = 30


def min_jerk(x):
    c = min(1.0, max(0.0, x))
    return c * c * c * (10 - 15 * c + 6 * c * c)


def open_like(hand: AnatomicalHand, q: dict, amount: float) -> dict:
    """The grasp shape opened toward an extended hand (fingers straightening at the MCP and PIP, the
    thumb swinging out), for the reach's aperture. Blends joint angles, so it stays in range."""
    ext = dict(q)
    for n in ("index", "middle", "ring", "little"):
        ext[f"{n}_mcp_flex"] = -5.0
        ext[f"{n}_pip"] = 8.0
        ext[f"{n}_dip"] = 4.0
    ext.update(thumb_cmc_abd=hand.hi[hand.index["thumb_cmc_abd"]] - 2, thumb_cmc_flex=-15.0,
               thumb_mcp_flex=5.0, thumb_ip=0.0)
    return hand.clamp({n: q[n] + amount * (ext[n] - q[n]) for n in q})


# Bhatia 2022, Smeets 2020: the reach's widest is 0.74-0.92 mm per mm of size, 6-8 cm for a 2-3 cm object; at 40 mm
# over, the knob's 62 mm was barely wider than a relaxed hand's 57, so the reach had no clear widest point
PEAK_PER_MM, PEAK_PLUS_MM = 0.83, 55.0


def open_for(hand: AnatomicalHand, q: dict, size_mm: float, lag_mm: float = 0.0) -> dict:
    """The grasp shape opened for the reach to an object size_mm across the grip: as wide as people open for it
    (PEAK_PER_MM per mm plus PEAK_PLUS_MM, thumb tip to index tip, measured as the hand-opening check measures it),
    or fully open (open_like 1.0) if the hand can't open that far. lag_mm: planned this much wider where the fingers,
    opening fast out of a closed grip, fall that far short of their shape before they close again."""
    from moonshot.validate.hand_opening import aperture_mm
    names = list(q)
    want = PEAK_PER_MM * size_mm + PEAK_PLUS_MM + lag_mm
    lo, hi = 0.0, 1.0
    for _ in range(14):
        mid = (lo + hi) / 2
        o = open_like(hand, q, mid)
        if aperture_mm(np.array([[o[n] for n in names]]), names)[0] < want:
            lo = mid
        else:
            hi = mid
    return open_like(hand, q, hi)


def blend_q(a: dict, b: dict, w: float) -> dict:
    return {n: a[n] + (b[n] - a[n]) * w for n in a}


def relaxed(hand: AnatomicalHand) -> dict:
    """A hand hanging relaxed: a little more flexed than the MRI rest, fingers cascading."""
    q = hand.neutral()
    for i, n in enumerate(("index", "middle", "ring", "little")):
        q[f"{n}_mcp_flex"] = 18.0 + 5 * i
        q[f"{n}_pip"] = 25.0 + 6 * i
    q.update(thumb_cmc_abd=8.0, thumb_mcp_flex=20.0, thumb_ip=12.0)
    return hand.couple(q)


class PosePath:
    """Wrist position + hand frame along overlapping minimum-jerk submovements (Flash & Henis 1991)."""

    def __init__(self, H, W):
        self.H0, self.W0 = np.asarray(H), np.asarray(W, float)
        self.moves = []

    def to(self, t0, dur, H, W):
        self.moves.append((t0, dur, np.asarray(H), np.asarray(W, float)))
        return self

    def at(self, t):
        W = self.W0.copy()
        R = Rotation.from_matrix(self.H0)
        prevH, prevW = self.H0, self.W0
        for t0, dur, H, Wt in self.moves:
            w = min_jerk((t - t0) / dur)
            W = W + (Wt - prevW) * w
            d = Rotation.from_matrix(H) * Rotation.from_matrix(prevH).inv()
            R = Rotation.from_rotvec(d.as_rotvec() * w) * R
            prevH, prevW = H, Wt
        return R.as_matrix(), W


def tremor(t: float, amp=1.0) -> np.ndarray:
    """Physiological tremor (8-12 Hz, tenths of a mm) on slow postural drift (about 1 mm)."""
    def wave(ph):
        return (0.25 * math.sin(2 * math.pi * 8.7 * t + ph) + 0.15 * math.sin(2 * math.pi * 11.3 * t + 2 * ph)
                + 0.5 * math.sin(2 * math.pi * 0.7 * t + 3 * ph) + 0.3 * math.sin(2 * math.pi * 1.9 * t + 5 * ph))
    return amp * np.array([wave(0.3), wave(1.7), 0.6 * wave(2.9)])
