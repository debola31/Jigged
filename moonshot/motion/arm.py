"""Ported from trainual's motion/arm_model.py. Shoulder-elbow-wrist chain with real ranges, for placing the anatomical hand in the world.

Given the shoulder and a world pose for the hand, the elbow lies on a circle (the swivel); for each swivel
the forearm frame follows, and the hand's rotation relative to it splits into forearm pronation and wrist
flexion and deviation. Those are checked against anatomy.json: the wrist limit is an ellipse in
flexion-deviation (Gracia-Ibanez et al. 2020), not a box, and pronation-supination has its own range.

Conventions (world mm): the hand frame H has columns x = toward the fingers, y = radial (thumb side),
z = dorsal (back of the hand). Wrist angles are anatomical: + flexion (fingers toward the palm),
+ radial deviation, + pronation (palm turning down from thumb-up).
"""
from __future__ import annotations

import json
import math
import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.body.hand import ANATOMY

SPEC = json.loads(ANATOMY.read_text(encoding="utf-8"))


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


class Arm:
    def __init__(self, side: str, shoulder, upper_mm: float = 300.0, fore_mm: float = 265.0):
        self.side = side
        self.S = np.asarray(shoulder, dtype=np.float64)
        self.l1, self.l2 = upper_mm, fore_mm
        self.W = SPEC["wrist_deg"]
        self.F = SPEC["forearm_deg"]

    # --- geometry --------------------------------------------------------------------------
    def elbow(self, W, swivel_deg: float, S=None):
        """Elbow for wrist position W at a swivel angle: 0 = elbow straight down from the
        shoulder-wrist line, + = out to the side (away from the body's midline)."""
        S = self.S if S is None else S
        d = W - S
        L = np.linalg.norm(d)
        L = min(L, (self.l1 + self.l2) * 0.999)
        u = d / np.linalg.norm(d)
        a = (self.l1 ** 2 - self.l2 ** 2 + L ** 2) / (2 * L)
        h = math.sqrt(max(0.0, self.l1 ** 2 - a * a))
        down = np.array([0.0, 0.0, -1.0])
        e0 = down - u * down.dot(u)
        if np.linalg.norm(e0) < 1e-6:
            e0 = np.array([0.0, -1.0, 0.0])
        e0 = unit(e0)
        out = np.array([1.0 if self.side == "R" else -1.0, 0.0, 0.0])
        e1 = np.cross(u, e0)
        if e1.dot(out) < 0:
            e1 = -e1
        s = math.radians(swivel_deg)
        return S + u * a + h * (math.cos(s) * e0 + math.sin(s) * e1)

    def angles(self, H: np.ndarray, W, E, S=None) -> dict:
        """Forearm pronation, wrist flexion and deviation (deg) and elbow flexion for hand frame H at
        wrist W with the elbow at E."""
        S = self.S if S is None else S
        f = unit(W - E)
        up = unit(E - S)
        n_e = np.cross(up, f)
        if np.linalg.norm(n_e) < 1e-6:
            n_e = np.array([1.0, 0, 0])
        n_e = unit(n_e)
        r0 = unit(np.cross(n_e, f))                      # thumb-up neutral: radial axis
        F0 = np.stack([f, r0, np.cross(f, r0)], 1)
        R0 = F0.T @ H
        ex, ey, ez = Rotation.from_matrix(R0).as_euler("XYZ", degrees=True)
        pron = -ex if self.side == "R" else ex
        # left hands: radial is -y in a right-handed frame built the same way; mirror the deviation
        dev = ez if self.side == "R" else -ez
        elbow = 180.0 - math.degrees(math.acos(np.clip(np.dot(unit(S - E), unit(W - E)), -1, 1)))
        return {"pronation": pron, "flexion": ey, "deviation": dev, "elbow": elbow,
                "forearm": F0 @ Rotation.from_euler("X", ex, degrees=True).as_matrix()}

    def wrist_excess(self, a: dict, functional: bool = False) -> float:
        """0 inside the flexion-deviation ellipse, else how far out (ellipse units)."""
        W = self.W["functional"] if functional else self.W
        fl = a["flexion"] / (W["flexion"] if a["flexion"] > 0 else W["extension"])
        dv = a["deviation"] / (W["radial"] if a["deviation"] > 0 else W["ulnar"])
        return max(0.0, math.hypot(fl, dv) - 1.0)

    def pron_excess(self, a: dict) -> float:
        p = a["pronation"]
        lim = self.F["pronation"] if p > 0 else self.F["supination"]
        return max(0.0, abs(p) - lim)

    def cost(self, a: dict) -> float:
        """Discomfort: outside the limits costs a lot; within, staying near the middle of the
        functional ranges and the elbow down costs a little."""
        c = 400 * self.wrist_excess(a) ** 2 + 2 * self.pron_excess(a) ** 2
        c += 2 * self.wrist_excess(a, functional=True) ** 2
        c += (a["flexion"] / 60) ** 2 + (a["deviation"] / 30) ** 2 + ((a["pronation"] - 30) / 70) ** 2
        c += 3 * max(0.0, a["elbow"] - 140) ** 2 + 3 * max(0.0, 10 - a["elbow"]) ** 2
        return c

    def solve(self, H, W, prev_swivel: float | None = None, swivels=range(-30, 91, 5), S=None):
        """Best swivel for this hand pose (near the previous one, so the elbow moves smoothly)."""
        best = None
        for s in swivels:
            E = self.elbow(W, s, S)
            a = self.angles(H, W, E, S)
            c = self.cost(a) + 0.002 * s * s
            if prev_swivel is not None:
                c += 0.02 * (s - prev_swivel) ** 2
            if best is None or c < best[0]:
                best = (c, s, E, a)
        c, s, E, a = best
        return {"cost": c, "swivel": s, "E": E, **a}

    def solve_path(self, Hs, Ws, Ss, swivels=tuple(range(-70, 111, 5)), smooth=0.08, prefer=None, prefer_w=0.05):
        """The elbow swivel for a whole motion at once: per frame the arm cost of every swivel, then
        the path through them that is cheapest including a penalty on how fast the swivel changes
        (dynamic programming), so the elbow never flips between frames."""
        n, m = len(Hs), len(swivels)
        C = np.zeros((n, m))
        cache = [[None] * m for _ in range(n)]
        for k in range(n):
            for j, s in enumerate(swivels):
                E = self.elbow(Ws[k], s, Ss[k])
                a = self.angles(Hs[k], Ws[k], E, Ss[k])
                C[k, j] = self.cost(a) + 0.002 * s * s
                if prefer is not None and prefer[k] is not None:
                    C[k, j] += prefer_w * (s - prefer[k]) ** 2
                cache[k][j] = (E, a)
        sw = np.array(swivels, float)
        T = smooth * (sw[:, None] - sw[None, :]) ** 2
        D = C[0].copy()
        back = np.zeros((n, m), int)
        for k in range(1, n):
            tot = D[:, None] + T
            back[k] = np.argmin(tot, 0)
            D = tot[back[k], np.arange(m)] + C[k]
        j = int(np.argmin(D))
        path = [j]
        for k in range(n - 1, 0, -1):
            j = back[k][j]
            path.append(j)
        path = path[::-1]
        out = []
        for k, j in enumerate(path):
            E, a = cache[k][j]
            out.append({"cost": C[k, j], "swivel": swivels[j], "E": E, **a})
        return out

    def clamp_hand(self, H, W, E, S=None):
        """The hand frame with wrist flexion-deviation pulled back onto the ellipse (and pronation
        into its range) if they were outside: where a real wrist stops."""
        a = self.angles(H, W, E, S)
        ex = self.wrist_excess(a)
        pr = a["pronation"]
        lim = self.F["pronation"] if pr > 0 else self.F["supination"]
        if ex <= 0 and abs(pr) <= lim:
            return H, a
        k = 1.0 / (1.0 + ex)
        fl, dv = a["flexion"] * k, a["deviation"] * k
        pr = max(-self.F["supination"], min(self.F["pronation"], pr))
        sgn = 1.0 if self.side == "R" else -1.0
        R0 = Rotation.from_euler("XYZ", [-sgn * pr, fl, sgn * dv], degrees=True).as_matrix()
        f = unit(W - E)
        up = unit(E - (self.S if S is None else S))
        n_e = unit(np.cross(up, f))
        r0 = unit(np.cross(n_e, f))
        F0 = np.stack([f, r0, np.cross(f, r0)], 1)
        H2 = F0 @ R0
        return H2, self.angles(H2, W, E, S)

    def reach_shoulder(self, W, protract_mm: float = 90.0):
        """The shoulder moved toward the wrist (the trunk leans, the shoulder protracts) when the wrist
        is out of comfortable reach (90% of full length)."""
        d = W - self.S
        L = np.linalg.norm(d)
        comfy = 0.9 * (self.l1 + self.l2)
        if L <= comfy:
            return self.S.copy()
        return self.S + unit(d) * min(protract_mm, L - comfy)
