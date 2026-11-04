"""Ported from trainual's motion/body_solver.py. Whole-motion body solver: trunk + arm joint angles for every frame at once, from task constraints, under a
posture prior measured from people manipulating objects seated or standing (GRAB, ARCTIC, AnDy; the fitted mixture is in the data root, arm-prior/people_prior.npz), joint ranges, gravity effort and smoothness.

Why a trajectory and not frame-by-frame IK: a person's arm doesn't pick the best posture for each instant;
it moves economically (minimum effort and jerk) through postures that are typical for the task. The first
showcase solved each instant separately with hand-tuned comfort weights and got sustained limit pronation,
a flexed "claw" wrist, and 95 deg of forearm rotation per crank turn.

Task constraints per frame (any mix):
- `pose`: hand frame H and wrist W (holding an object: the grip relative to it, carried with it);
- `tsr`: a task-space region (Berenson et al.): a point in the hand must be at a world point, and a hand
  axis must align with a world axis; rotation about that axis is free (a cylinder grip: the crank knob);
- `pos`: wrist position only (free motion along a planned path); orientation is the body's choice;
- nothing: the body's choice.

Costs (weights in BodySolver.W):
- prior: negative log-likelihood of the 7 arm angles under a Gaussian mixture fitted to manipulation in
  GRAB and ARCTIC (trainual's human_data.py);
- trunk: a little lean is free, more costs (people's p95 is 26 deg);
- effort: gravity moment at the shoulder (arm mass and anything held, times its lever arm);
- smoothness: squared angular acceleration, plus a penalty on speeds above people's p99 per joint;
- limits: joint ranges are hard (sigmoid parameterisation), and so is the wrist's flexion-deviation ellipse
  (`wrist_inside`): as a soft cost it was outweighed, and the reference take bent the wrist to 1.12 on it;
- clearance: the elbow and forearm stay out of the table and the machine's boxes.
"""
from __future__ import annotations

import json
import math

import numpy as np
import torch

from moonshot.body.hand import ANATOMY
from moonshot.config import data_root
from moonshot.motion import kinematics as BM

SPEC = json.loads(ANATOMY.read_text(encoding="utf-8"))
# ellipse units, 1.0 the edge. A take planned to 0.95 held the wrist at 0.94 for two seconds while inspecting the part:
# possible, but on review it read as bent too far (2026-11-02); people hold a part mid-range and turn the forearm
WRIST_KNEE, WRIST_MAX = 0.55, 0.75


def wrist_ellipse(fl, dv):
    """How far out on the wrist's flexion-deviation ellipse (Gracia-Ibanez 2020) a wrist is: 1.0 is the edge.
    fl: flexion (+) / extension (-), dv: radial (+) / ulnar (-), degrees; numpy or torch."""
    wd = SPEC["wrist_deg"]
    lib = torch if isinstance(fl, torch.Tensor) else np
    ef = lib.where(fl > 0, fl / wd["flexion"], fl / wd["extension"])
    ed = lib.where(dv > 0, dv / wd["radial"], dv / wd["ulnar"])
    return lib.sqrt(ef ** 2 + ed ** 2 + 1e-12)


def wrist_inside(th):
    """th with its wrist pulled inside the ellipse, smoothly: unchanged up to WRIST_KNEE, never past WRIST_MAX.
    A hard limit by construction, as the sigmoids are for each joint's range. th: (n, 12) degrees, torch."""
    fl, dv = th[:, 8], th[:, 9]
    e = wrist_ellipse(fl, dv)
    span = WRIST_MAX - WRIST_KNEE
    s = torch.where(e > WRIST_KNEE, (WRIST_KNEE + span * torch.tanh((e - WRIST_KNEE) / span)) / e, torch.ones_like(e))
    return torch.cat([th[:, :8], (fl * s)[:, None], (dv * s)[:, None], th[:, 10:]], 1)


class ArmPrior:
    def __init__(self, path=None):
        # people manipulating objects seated or standing (moonshot/validate/people_prior.py), as the posture checks hold
        # a take to
        d = np.load(path or data_root() / "arm-prior" / "people_prior.npz")
        self.w = torch.as_tensor(d["weights"], dtype=torch.float64)
        self.mu = torch.as_tensor(d["means"], dtype=torch.float64)
        cov = torch.as_tensor(d["covs"], dtype=torch.float64)
        self.L = torch.linalg.cholesky(cov)
        self.logdet = 2 * torch.log(torch.diagonal(self.L, dim1=-2, dim2=-1)).sum(-1)
        self.pct = d["pct"]
        self.vpct = d["vpct"]
        self.names = [str(x) for x in d["names"]]

    def nll(self, arm):
        """arm: (n, 7) degrees -> (n,) negative log-likelihood (up to a constant)."""
        diff = arm[:, None, :] - self.mu[None]                         # (n, K, 7)
        sol = torch.linalg.solve_triangular(self.L[None].expand(arm.shape[0], -1, -1, -1), diff[..., None], upper=False)[..., 0]
        m = (sol ** 2).sum(-1)
        logp = torch.log(self.w)[None] - 0.5 * (m + self.logdet[None])
        return -torch.logsumexp(logp, -1)


def posture_cost(th, prior=None, w_comfort=1.0, w_prior=0.3, trunk=True, w_range=0.5):
    """The one posture cost every solver uses (grips and trajectories): range-normalised comfort around
    research-based centres, extra cost for pronation far from its centre, a barrier near every limit, and the
    people's prior: their mixture's likelihood, and each angle's distance outside their 1st-99th percentile range
    (what the posture checks hold a take to; without it the arm turned out past people's range rising from rest,
    2026-11-03). th: (n, 10 or 12) degrees -> (n,). trunk=False leaves the trunk's columns out, for a second arm on a
    trunk the first arm's cost already counts, all but their range: a left arm sees the trunk mirrored, and people's
    range of side-bend and twist isn't symmetric, so the posture checks hold the trunk to both arms' views of it
    (door-close planned its trunk to 13 deg of side-bend, inside the right arm's range, outside the left's)."""
    cf = SPEC["body"]["comfort"]
    t = lambda key: torch.as_tensor([cf[key][nm] for nm in BM.NAMES], dtype=th.dtype)[:th.shape[1]]
    ctr, half, w = t("centre"), t("half"), t("weight")
    if not trunk:
        w = torch.cat([torch.zeros(3, dtype=th.dtype), w[3:]])
    z = (th - ctr) / half
    c = w_comfort * (w * z ** 2).sum(-1)
    c = c + w_comfort * 2 * w[7] * (torch.relu((th[:, 7] - ctr[7]).abs() - 45.0) / half[7]) ** 2
    lo, hi = (torch.as_tensor(x, dtype=th.dtype)[:th.shape[1]] for x in ranges())
    span = hi - lo
    near = torch.relu(0.1 - (th - lo) / span) + torch.relu(0.1 - (hi - th) / span)
    if not trunk:
        near = near[:, 3:]
    c = c + 1e3 * (near ** 2).sum(-1)
    if prior is not None:
        c = c + w_prior * prior.nll(th[:, 3:10])
        plo, phi = (torch.as_tensor(prior.pct[:, i], dtype=th.dtype) for i in (0, -1))
        out = torch.relu(plo - th[:, :10]) + torch.relu(th[:, :10] - phi)          # degrees outside people's range
        c = c + w_range * (out ** 2).sum(-1)
    return c


def ranges():
    b = SPEC["body"]["ranges_deg"]
    lo = np.array([b[n][0] for n in BM.NAMES], float)
    hi = np.array([b[n][1] for n in BM.NAMES], float)
    return lo, hi


class BodySolver:
    W = {"pose_pos": 2.0, "pose_rot": 400.0, "tsr_pos": 2.0, "tsr_axis": 400.0, "pos": 0.5,
         "comfort": 1.0, "prior": 0.3, "range": 0.5, "effort": 1e-6, "accel": 0.4, "speed": 0.2,
         "clear": 1.0, "pelvis": 0.02, "hand_rot": 0.0}
    # prior 0.3 (2026-11-03): against people seated or standing, the vise take plans inside their range (0.936) and
    # likelihood (24.6) at 0.3, and 1.5 adds little (0.941, 23.6) while its hands miss more; at 5 the bench takes'
    # hands missed by up to 118 mm and their caliper and deburr gates failed, and the grip solver's pads came off
    # the trunk is heavy and moves slowly: its angular acceleration costs more
    ACCEL_SCALE = [300, 300, 300, 1, 1, 1, 1, 1, 1, 1, 0.3, 0.3]

    def __init__(self, n, fps, lumbar, prior: ArmPrior | None = None, boxes=(), arms=("R",)):
        """arms: ("R",) solves the trunk and the right arm (12 angles a frame); ("R", "L") adds the left arm's 9
        (theta columns 12-20), planned as the right arm of the mirrored world on the same trunk (kinematics.py)."""
        self.n, self.fps = n, fps
        self.lumbar = np.asarray(lumbar, float)
        self.prior = prior or ArmPrior()
        lo, hi = ranges()
        self.lo, self.hi = torch.as_tensor(lo), torch.as_tensor(hi)
        self.boxes = [(torch.as_tensor(c, dtype=torch.float64), torch.as_tensor(h, dtype=torch.float64)) for c, h in boxes]
        sm = SPEC["body"]["speed_max_deg_s"]
        self.vmax = torch.as_tensor([sm[nm] for nm in BM.NAMES], dtype=torch.float64)
        # per arm: its hand's tasks, the obstacles for the hand itself (wrist and points along the fingers, each with
        # a per-frame mask: e.g. the crank's swept disc, except while the hand is meant to hold the knob), the kg
        # it holds, and a per-frame weight on its rotation speed. The left arm's are in the mirrored world.
        self.side = {s: {"tasks": [dict() for _ in range(n)], "hand_boxes": [], "load": np.zeros(n),
                         "hand_rot_w": torch.zeros(n, dtype=torch.float64)} for s in arms}
        r = self.side["R"]
        self.tasks, self.hand_boxes, self.load, self.hand_rot_w = r["tasks"], r["hand_boxes"], r["load"], r["hand_rot_w"]

    # -- constraints -------------------------------------------------------------------------
    # A left hand's targets are given as the right hand of the mirrored world (kinematics.mirror_points and
    # mirror_frames make one from a world target), as its grips are solved.
    def pose(self, k, H, W, w=1.0, side="R"):
        self.side[side]["tasks"][k]["pose"] = (torch.as_tensor(H), torch.as_tensor(W), w)

    def tsr(self, k, point_hand, world_point, axis_hand, world_axis, w=1.0, side="R"):
        """point_hand / axis_hand are in the hand frame H (columns long, radial, dorsal), relative to W."""
        t = lambda x: torch.as_tensor(np.asarray(x, float))   # noqa: E731
        self.side[side]["tasks"][k]["tsr"] = (t(point_hand), t(world_point), t(axis_hand), t(world_axis), w)

    def pos(self, k, W, w=1.0, side="R"):
        self.side[side]["tasks"][k]["pos"] = (torch.as_tensor(np.asarray(W, float)), w)

    # -- solve ------------------------------------------------------------------------------
    def angles(self, u):
        return wrist_inside(self.lo + (self.hi - self.lo) * torch.sigmoid(u))

    def free(self, theta):
        th = torch.as_tensor(theta, dtype=torch.float64)
        x = ((th - self.lo) / (self.hi - self.lo)).clamp(1e-3, 1 - 1e-3)
        return torch.log(x / (1 - x))

    @staticmethod
    def _pack(tasks, n):
        """One arm's per-frame tasks as stacked tensors: kind -> (frames, [tensors], weights)."""
        out = {}
        for kind, width in (("pose", 2), ("tsr", 4), ("pos", 1)):
            ks = [k for k in range(n) if kind in tasks[k]]
            if ks:
                rows = [tasks[k][kind] for k in ks]
                out[kind] = (ks, [torch.stack([r[i] for r in rows]) for i in range(width)],
                             torch.as_tensor([r[width] for r in rows]))
        return out

    def _arm_terms(self, th, L, packed, side, boxes, trunk):
        """The cost terms of one arm on its trunk: its hand's tasks, posture, effort, smoothness and clearance.
        th: (n, 12) angles of this arm's world (for the left, the mirrored one); trunk: whether to count the trunk's
        own posture and smoothness, which happens once per body."""
        W, dt = self.W, 1.0 / self.fps
        f = BM.torch_fk(th, L)
        H, Wp = f["H"], f["W"]
        terms = {}
        if "pose" in packed:
            ks, (PH, PW), Pw = packed["pose"]
            e_p = ((Wp[ks] - PW) ** 2).sum(-1)
            e_r = ((H[ks] - PH) ** 2).sum((-1, -2))
            terms["pose"] = (Pw * (W["pose_pos"] * e_p + W["pose_rot"] * e_r)).sum()
        if "tsr" in packed:
            ks, (Tp, Tq, Ta, Tb), Tw = packed["tsr"]
            Hk = H[ks]
            pt = Wp[ks] + torch.einsum("nij,nj->ni", Hk, Tp)
            ax = torch.einsum("nij,nj->ni", Hk, Ta)
            terms["tsr"] = (Tw * (W["tsr_pos"] * ((pt - Tq) ** 2).sum(-1)
                                  + W["tsr_axis"] * ((ax - Tb) ** 2).sum(-1))).sum()
        if "pos" in packed:
            ks, (QW,), Qw = packed["pos"]
            terms["pos"] = (Qw * W["pos"] * ((Wp[ks] - QW) ** 2).sum(-1)).sum()
        terms["posture"] = posture_cost(th, self.prior, W["comfort"], W["prior"], trunk=trunk, w_range=W["range"]).sum()
        # gravity moment at the shoulder: arm segments (upper 2.1 kg, forearm 1.2, hand 0.5) + load
        S = f["S"]
        mom = lambda m, p: m * torch.linalg.norm((p - S)[:, :2], dim=-1)   # noqa: E731
        M = mom(2.1, (S + f["E"]) / 2) + mom(1.2, (f["E"] + Wp) / 2) + mom(0.5 + torch.as_tensor(side["load"]), Wp)
        terms["effort"] = W["effort"] * (M ** 2).sum() * 9.81 ** 2
        cols = slice(None) if trunk else slice(3, None)
        vel = (th[1:, cols] - th[:-1, cols]) / dt
        acc = (th[2:, cols] - 2 * th[1:-1, cols] + th[:-2, cols]) / dt ** 2
        scale = torch.as_tensor(self.ACCEL_SCALE, dtype=torch.float64)[cols]
        terms["accel"] = W["accel"] * 1e-4 * ((acc ** 2) * scale).sum()
        # the hand's rotation speed (cranking: a translating fist, the knob spinning in it)
        dH = ((H[1:] - H[:-1]) ** 2).sum((-1, -2)) / dt ** 2
        terms["hand_rot"] = (side["hand_rot_w"][1:] * dH).sum()
        terms["speed"] = W["speed"] * (torch.relu(vel.abs() - self.vmax[cols]) ** 2).sum()
        if side["hand_boxes"]:
            long = H[:, :, 0]
            hp = torch.cat([Wp, Wp + 70 * long, Wp + 140 * long], 0)
            c = 0
            for bc, bh, mask in side["hand_boxes"]:
                m3 = torch.cat([mask, mask, mask])
                d = (hp - bc).abs() - bh
                out = torch.linalg.norm(d.clamp_min(0), dim=-1) + d.max(-1).values.clamp_max(0)
                c = c + (m3 * torch.relu(30.0 - out) ** 2).sum()
            terms["hand_clear"] = W["clear"] * c
        if boxes:
            pts = torch.cat([f["E"], (f["E"] + Wp) / 2, Wp * 0.75 + f["E"] * 0.25], 0)
            c = 0
            for bc, bh in boxes:
                d = (pts - bc).abs() - bh
                out = torch.linalg.norm(d.clamp_min(0), dim=-1) + d.max(-1).values.clamp_max(0)
                c = c + (torch.relu(45.0 - out) ** 2).sum()            # forearm radius ~ 40 mm
            terms["clear"] = W["clear"] * c
        return terms

    def solve(self, theta0, iters=1500, lr=0.03, verbose=False):
        """theta0: a starting pose, 10 or 12 angles (trunk and right arm), or 21 with the left arm's (otherwise the
        left starts as the right). Returns the angles (n, 12, or 21 with the left arm), the pelvis shift (n, 3), the
        right arm's frames per frame and the terms; a left arm's frames, in the mirrored world, are left_frames."""
        th0 = np.asarray(theta0, float)
        if th0.shape[-1] == 10:
            th0 = np.concatenate([th0, np.zeros(th0.shape[:-1] + (2,))], -1)
        two = "L" in self.side
        thL0 = th0[..., 12:21] if th0.shape[-1] == 21 else th0[..., 3:12]
        th0 = np.broadcast_to(th0[..., :12], (self.n, 12)).copy()
        u = self.free(th0).clone().requires_grad_(True)
        dp = torch.zeros(self.n, 3, dtype=torch.float64, requires_grad=True)      # pelvis shift (mm)
        params = [u, dp]
        if two:
            loL, hiL = self.lo[3:], self.hi[3:]
            xL = ((torch.as_tensor(np.broadcast_to(thL0, (self.n, 9)).copy()) - loL) / (hiL - loL)).clamp(1e-3, 1 - 1e-3)
            uL = torch.log(xL / (1 - xL)).clone().requires_grad_(True)
            params.append(uL)
            boxes_L = [(torch.as_tensor(BM.mirror_points(c.numpy(), self.lumbar)), h) for c, h in self.boxes]
            flip = torch.as_tensor(np.r_[BM.TRUNK_MIRROR, np.ones(9)], dtype=torch.float64)
            dp_flip = torch.as_tensor([-1.0, 1.0, 1.0], dtype=torch.float64)
        opt = torch.optim.Adam(params, lr=lr)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, iters)
        packed = {s: self._pack(v["tasks"], self.n) for s, v in self.side.items()}
        best = None
        for it in range(iters):
            opt.zero_grad()
            th = self.angles(u)
            L = torch.as_tensor(self.lumbar) + dp
            terms = self._arm_terms(th, L, packed["R"], self.side["R"], self.boxes, trunk=True)
            terms["pelvis"] = self.W["pelvis"] * (dp ** 2).sum() + 1e-3 * (((dp[1:] - dp[:-1]) * self.fps) ** 2).sum()
            if two:
                # the left arm: the right arm of the mirrored world, on the mirrored trunk and pelvis
                thL = wrist_inside(torch.cat([th[:, :3], loL + (hiL - loL) * torch.sigmoid(uL)], 1) * flip)
                for k, v in self._arm_terms(thL, torch.as_tensor(self.lumbar) + dp * dp_flip, packed["L"],
                                            self.side["L"], boxes_L, trunk=False).items():
                    terms[k + "_L"] = v
            loss = sum(terms.values())
            loss.backward()
            opt.step()
            sched.step()
            if verbose and (it % 250 == 0 or it == iters - 1):
                print(it, f"{loss.item():.1f}", {k: round(float(v), 1) for k, v in terms.items()})
            if best is None or loss.item() < best[0]:
                full = torch.cat([th, thL[:, 3:]], 1) if two else th
                best = (loss.item(), full.detach().clone(), dp.detach().clone(), {k: float(v) for k, v in terms.items()})
        _, th, dp, terms = best
        th, dp = th.numpy(), dp.numpy()
        out = [BM.fk(th[k, :12], self.lumbar + dp[k]) for k in range(self.n)]
        if two:
            self.left_frames = [BM.fk(BM.mirror_trunk(np.r_[th[k, :3], th[k, 12:21]]),
                                      self.lumbar + dp[k] * np.array([-1.0, 1.0, 1.0])) for k in range(self.n)]
        return th, dp, out, terms
