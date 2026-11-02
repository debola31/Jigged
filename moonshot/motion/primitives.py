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
