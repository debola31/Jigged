"""Ported from trainual's motion/body_solver.py. Whole-motion body solver: trunk + arm joint angles for every frame at once, from task constraints, under a
posture prior measured from people (GRAB, ARCTIC; the fitted mixture is in the data root, arm-prior/arm_prior.npz), joint ranges, gravity effort and smoothness.

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
WRIST_KNEE, WRIST_MAX = 0.8, 0.95      # ellipse units, 1.0 the edge


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
        d = np.load(path or data_root() / "arm-prior" / "arm_prior.npz")
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


def posture_cost(th, prior=None, w_comfort=1.0, w_prior=0.3):
    """The one posture cost every solver uses (grips and trajectories): range-normalised comfort around
    research-based centres, extra cost for pronation far from its centre, a barrier near every limit, and the
    people's prior. th: (n, 10) degrees -> (n,)."""
    cf = SPEC["body"]["comfort"]
    t = lambda key: torch.as_tensor([cf[key][nm] for nm in BM.NAMES], dtype=th.dtype)
    ctr, half, w = t("centre"), t("half"), t("weight")
    z = (th - ctr) / half
    c = w_comfort * (w * z ** 2).sum(-1)
    c = c + w_comfort * 2 * w[7] * (torch.relu((th[:, 7] - ctr[7]).abs() - 45.0) / half[7]) ** 2
    lo, hi = (torch.as_tensor(x, dtype=th.dtype) for x in ranges())
    span = hi - lo
    near = torch.relu(0.1 - (th - lo) / span) + torch.relu(0.1 - (hi - th) / span)
    c = c + 1e3 * (near ** 2).sum(-1)
    if prior is not None:
        c = c + w_prior * prior.nll(th[:, 3:10])
    return c


def ranges():
    b = SPEC["body"]["ranges_deg"]
    lo = np.array([b[n][0] for n in BM.NAMES], float)
    hi = np.array([b[n][1] for n in BM.NAMES], float)
    return lo, hi


class BodySolver:
    W = {"pose_pos": 2.0, "pose_rot": 400.0, "tsr_pos": 2.0, "tsr_axis": 400.0, "pos": 0.5,
         "comfort": 1.0, "prior": 0.3, "effort": 1e-6, "accel": 0.4, "speed": 0.2,
         "clear": 1.0, "pelvis": 0.02, "hand_rot": 0.0}
    # the trunk is heavy and moves slowly: its angular acceleration costs more
    ACCEL_SCALE = [300, 300, 300, 1, 1, 1, 1, 1, 1, 1, 0.3, 0.3]

    def __init__(self, n, fps, lumbar, prior: ArmPrior | None = None, boxes=()):
        self.n, self.fps = n, fps
        self.lumbar = np.asarray(lumbar, float)
        self.prior = prior or ArmPrior()
        lo, hi = ranges()
        self.lo, self.hi = torch.as_tensor(lo), torch.as_tensor(hi)
        self.boxes = [(torch.as_tensor(c, dtype=torch.float64), torch.as_tensor(h, dtype=torch.float64)) for c, h in boxes]
        # obstacles for the hand itself (wrist and points along the fingers), each with a per-frame mask:
        # e.g. the crank's swept disc, except while the hand is meant to hold the knob
        self.hand_boxes = []
        self.tasks = [dict() for _ in range(n)]
        self.load = np.zeros(n)                                         # kg held in the hand per frame
        sm = SPEC["body"]["speed_max_deg_s"]
        self.vmax = torch.as_tensor([sm[nm] for nm in BM.NAMES], dtype=torch.float64)
        cf = SPEC["body"]["comfort"]
        self.c_ctr = torch.as_tensor([cf["centre"][nm] for nm in BM.NAMES], dtype=torch.float64)
        self.c_half = torch.as_tensor([cf["half"][nm] for nm in BM.NAMES], dtype=torch.float64)
        self.c_w = torch.as_tensor([cf["weight"][nm] for nm in BM.NAMES], dtype=torch.float64)
        self.hand_rot_w = torch.zeros(n, dtype=torch.float64)          # per-frame weight on hand rotation speed

    # -- constraints -------------------------------------------------------------------------
    def pose(self, k, H, W, w=1.0):
        self.tasks[k]["pose"] = (torch.as_tensor(H), torch.as_tensor(W), w)

    def tsr(self, k, point_hand, world_point, axis_hand, world_axis, w=1.0):
        """point_hand / axis_hand are in the hand frame H (columns long, radial, dorsal), relative to W."""
        t = lambda x: torch.as_tensor(np.asarray(x, float))
        self.tasks[k]["tsr"] = (t(point_hand), t(world_point), t(axis_hand), t(world_axis), w)

    def pos(self, k, W, w=1.0):
        self.tasks[k]["pos"] = (torch.as_tensor(np.asarray(W, float)), w)

    # -- solve ------------------------------------------------------------------------------
    def angles(self, u):
        return wrist_inside(self.lo + (self.hi - self.lo) * torch.sigmoid(u))

    def free(self, theta):
        th = torch.as_tensor(theta, dtype=torch.float64)
        x = ((th - self.lo) / (self.hi - self.lo)).clamp(1e-3, 1 - 1e-3)
        return torch.log(x / (1 - x))

    def solve(self, theta0, iters=1500, lr=0.03, verbose=False):
        th0 = np.asarray(theta0, float)
        if th0.shape[-1] == 10:
            th0 = np.concatenate([th0, np.zeros(th0.shape[:-1] + (2,))], -1)
        th0 = np.broadcast_to(th0, (self.n, 12)).copy()
        u = self.free(th0).clone().requires_grad_(True)
        dp = torch.zeros(self.n, 3, dtype=torch.float64, requires_grad=True)      # pelvis shift (mm)
        opt = torch.optim.Adam([u, dp], lr=lr)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, iters)
        W = self.W
        # vectorised task data
        pose_k = [k for k in range(self.n) if "pose" in self.tasks[k]]
        tsr_k = [k for k in range(self.n) if "tsr" in self.tasks[k]]
        pos_k = [k for k in range(self.n) if "pos" in self.tasks[k]]
        if pose_k:
            PH = torch.stack([self.tasks[k]["pose"][0] for k in pose_k])
            PW = torch.stack([self.tasks[k]["pose"][1] for k in pose_k])
            Pw = torch.as_tensor([self.tasks[k]["pose"][2] for k in pose_k])
        if tsr_k:
            T = [self.tasks[k]["tsr"] for k in tsr_k]
            Tp, Tq, Ta, Tb = (torch.stack([x[i] for x in T]) for i in range(4))
            Tw = torch.as_tensor([x[4] for x in T])
        if pos_k:
            QW = torch.stack([self.tasks[k]["pos"][0] for k in pos_k])
            Qw = torch.as_tensor([self.tasks[k]["pos"][1] for k in pos_k])
        load = torch.as_tensor(self.load)
        dt = 1.0 / self.fps
        best = None
        for it in range(iters):
            opt.zero_grad()
            th = self.angles(u)
            L = torch.as_tensor(self.lumbar) + dp
            f = BM.torch_fk(th, L)
            H, Wp = f["H"], f["W"]
            terms = {}
            if pose_k:
                e_p = ((Wp[pose_k] - PW) ** 2).sum(-1)
                e_r = ((H[pose_k] - PH) ** 2).sum((-1, -2))
                terms["pose"] = (Pw * (W["pose_pos"] * e_p + W["pose_rot"] * e_r)).sum()
            if tsr_k:
                Hk = H[tsr_k]
                pt = Wp[tsr_k] + torch.einsum("nij,nj->ni", Hk, Tp)
                ax = torch.einsum("nij,nj->ni", Hk, Ta)
                terms["tsr"] = (Tw * (W["tsr_pos"] * ((pt - Tq) ** 2).sum(-1)
                                      + W["tsr_axis"] * ((ax - Tb) ** 2).sum(-1))).sum()
            if pos_k:
                terms["pos"] = (Qw * W["pos"] * ((Wp[pos_k] - QW) ** 2).sum(-1)).sum()
            terms["posture"] = posture_cost(th, self.prior, W["comfort"], W["prior"]).sum()
            # gravity moment at the shoulder: arm segments (upper 2.1 kg, forearm 1.2, hand 0.5) + load
            S = f["S"]
            mid_u = (S + f["E"]) / 2
            mid_f = (f["E"] + Wp) / 2
            mom = lambda m, p: m * torch.linalg.norm((p - S)[:, :2], dim=-1)
            M = mom(2.1, mid_u) + mom(1.2, mid_f) + mom(0.5 + load, Wp)
            terms["effort"] = W["effort"] * (M ** 2).sum() * 9.81 ** 2
            vel = (th[1:] - th[:-1]) / dt
            acc = (th[2:] - 2 * th[1:-1] + th[:-2]) / dt ** 2
            terms["accel"] = W["accel"] * 1e-4 * ((acc ** 2) * torch.as_tensor(self.ACCEL_SCALE, dtype=torch.float64)).sum()
            # the hand's rotation speed (cranking: a translating fist, the knob spinning in it)
            dH = ((H[1:] - H[:-1]) ** 2).sum((-1, -2)) / dt ** 2
            terms["hand_rot"] = (self.hand_rot_w[1:] * dH).sum()
            terms["speed"] = W["speed"] * (torch.relu(vel.abs() - self.vmax) ** 2).sum()
            terms["pelvis"] = W["pelvis"] * (dp ** 2).sum() + 1e-3 * (((dp[1:] - dp[:-1]) / dt) ** 2).sum()
            if self.hand_boxes:
                long = H[:, :, 0]
                hp = torch.cat([Wp, Wp + 70 * long, Wp + 140 * long], 0)
                c = 0
                for bc, bh, mask in self.hand_boxes:
                    m3 = torch.cat([mask, mask, mask])
                    d = (hp - bc).abs() - bh
                    out = torch.linalg.norm(d.clamp_min(0), dim=-1) + d.max(-1).values.clamp_max(0)
                    c = c + (m3 * torch.relu(30.0 - out) ** 2).sum()
                terms["hand_clear"] = W["clear"] * c
            if self.boxes:
                pts = torch.cat([f["E"], (f["E"] + Wp) / 2, Wp * 0.75 + f["E"] * 0.25], 0)
                c = 0
                for bc, bh in self.boxes:
                    d = (pts - bc).abs() - bh
                    out = torch.linalg.norm(d.clamp_min(0), dim=-1) + d.max(-1).values.clamp_max(0)
                    c = c + (torch.relu(45.0 - out) ** 2).sum()            # forearm radius ~ 40 mm
                terms["clear"] = W["clear"] * c
            loss = sum(terms.values())
            loss.backward()
            opt.step()
            sched.step()
            if verbose and (it % 250 == 0 or it == iters - 1):
                print(it, f"{loss.item():.1f}", {k: round(float(v), 1) for k, v in terms.items()})
            if best is None or loss.item() < best[0]:
                best = (loss.item(), th.detach().clone(), dp.detach().clone(), {k: float(v) for k, v in terms.items()})
        _, th, dp, terms = best
        f = BM.fk  # numpy frames for the result
        out = []
        for k in range(self.n):
            out.append(BM.fk(th[k].numpy(), self.lumbar + dp[k].numpy()))
        return th.numpy(), dp.numpy(), out, terms
