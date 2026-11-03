"""Ported from trainual's motion/grasp.py. Grasps found by optimisation, inside the anatomy.

The hand is NIMBLE posed through the anatomical joint layer (moonshot/body/hand.py), made differentiable in torch.
Joint angles are sigmoids of free variables, so every candidate is inside its range by construction;
the optimiser can't produce a pose the joints don't allow. A grasp is then:

- each digit's pad (the palmar skin of its distal phalanx) on its target surface, pressed in by the
  pad's compression (about 2 mm, anatomy.json grip),
- no other skin inside the object (every surface vertex of the skin is tested),
- the couplings of anatomy.json as soft terms (DIP from PIP in contact, the little finger following the
  ring), and
- an arm that can hold the hand there: the hand's orientation is scored by moonshot.motion.arm.Arm (wrist ellipse,
  pronation range, elbow comfort) over a grid, and the best few are refined.

    hand = AnatomicalHand(Nimble(folder)); arm = Arm("R", shoulder)
    g = blank_grasp(hand, arm, blank_world)          # dict: q, H (world hand frame), W (wrist), cost
"""
from __future__ import annotations

import math

import numpy as np
import torch

from moonshot.body.hand import FINGERS, AnatomicalHand

DIGITS = ["thumb", "index", "middle", "ring", "little"]
DIST_JOINT = {"thumb": 3, "index": 8, "middle": 13, "ring": 18, "little": 23}   # joint the distal bone rotates at
TIP_JOINT = {"thumb": 4, "index": 9, "middle": 14, "ring": 19, "little": 24}


def rot_aa(aa: torch.Tensor) -> torch.Tensor:
    """Rodrigues for a batch of axis-angle vectors (..., 3) -> (..., 3, 3)."""
    th = torch.linalg.norm(aa, dim=-1, keepdim=True).clamp_min(1e-9)
    k = aa / th
    kx, ky, kz = k[..., 0], k[..., 1], k[..., 2]
    z = torch.zeros_like(kx)
    K = torch.stack([z, -kz, ky, kz, z, -kx, -ky, kx, z], -1).reshape(*aa.shape[:-1], 3, 3)
    s = torch.sin(th)[..., None]
    c = torch.cos(th)[..., None]
    I = torch.eye(3, dtype=aa.dtype).expand_as(K)
    return I + s * K + (1 - c) * (K @ K)


class TorchHand:
    """Differentiable posing of the anatomical hand's skin (surface vertices) and joints."""

    def __init__(self, hand: AnatomicalHand, dtype=torch.float64):
        self.hand = hand
        m = hand.model
        self.dtype = dtype
        t = lambda x: torch.as_tensor(np.asarray(x), dtype=dtype)
        skin_idx = np.arange(m.skin_sep, m.skin_sep + 5990) if m.skin_sep > 0 else np.arange(len(m.vert) + m.skin_sep, len(m.vert))
        used = np.zeros(5990, bool)
        used[np.unique(m.skin_f)] = True
        self.surface = np.nonzero(used & m.skin_surface)[0]                 # skin-local indices
        rows = skin_idx[self.surface]
        self.rows = rows
        self.v = t(hand.rest_v[rows])
        self.sw = t(m.sw[rows])
        self.pbs = t(m.pbs[rows])
        self.J = t(hand.rest_J)
        from moonshot.body.nimble import JOINT_BONE, PARENT
        self.parent = PARENT
        self.joint_bone = JOINT_BONE
        self.axes = t(np.stack([d["axis"] for d in hand.dofs]))
        self.bones = [d["bone"] for d in hand.dofs]
        self.rest = t(hand.rest)
        self.lo, self.hi = t(hand.lo), t(hand.hi)
        self.scale = hand.scale
        B = hand.wrist_frame()
        self.B = t(B)                                                        # rest hand frame (columns)
        self._pads()

    def _pads(self):
        """Pad vertex sets: palmar skin over the distal phalanx's middle-to-distal part."""
        h = self.hand
        m = h.model
        rest = h.rest_v[self.rows]
        J = h.rest_J
        self.pad_idx, self.pad_normal_rest = {}, {}
        for d in DIGITS:
            j0, j1 = DIST_JOINT[d], TIP_JOINT[d]
            u = (J[j1] - J[j0]) / np.linalg.norm(J[j1] - J[j0])
            L = np.linalg.norm(J[j1] - J[j0])
            w = m.sw[self.rows, j0]
            s = (rest - J[j0]) @ u
            # the palmar direction of this phalanx: for fingers, the palm's; for the thumb, toward the
            # index side of the palm (its pad faces the fingers)
            if d == "thumb":
                pal = J[6] - J[j1]
                pal = pal - u * pal.dot(u)
            else:
                pal = h.palmar - u * h.palmar.dot(u)
            pal /= np.linalg.norm(pal)
            r = rest - J[j0] - np.outer(s, u)
            side = r @ pal
            sel = (w > 0.5) & (s > 0.35 * L) & (s < 0.95 * L) & (side > 0.6 * np.linalg.norm(r, axis=1))
            self.pad_idx[d] = torch.as_tensor(np.nonzero(sel)[0])
            self.pad_normal_rest[d] = pal

    def angles(self, u: torch.Tensor) -> torch.Tensor:
        """Free variables -> joint angles strictly inside their ranges (degrees). MCP abduction's range
        narrows as its MCP flexes (hand_model.mcp_abd_limit), so it is scaled after the flexion."""
        q = self.lo + (self.hi - self.lo) * torch.sigmoid(u)
        loss = self.hand.spec["coupling"]["mcp_abd_loss_at_90"]
        out = []
        for i, n in enumerate(self.hand.names):
            if n.endswith("_mcp_abd"):
                flex = q[self.hand.index[n.replace("abd", "flex")]]
                k = (1 - flex.clamp_min(0) / 90.0 * loss).clamp_min(0.05)
                out.append(q[i] * k)
            else:
                out.append(q[i])
        return torch.stack(out)

    def free(self, q_deg) -> torch.Tensor:
        q = torch.as_tensor(q_deg, dtype=self.dtype).clone()
        for i, n in enumerate(self.hand.names):
            if n.endswith("_mcp_abd"):
                flex = q[self.hand.index[n.replace("abd", "flex")]]
                k = max(0.05, 1 - max(0.0, float(flex)) / 90.0 * self.hand.spec["coupling"]["mcp_abd_loss_at_90"])
                q[i] = q[i] / k
        x = ((q - self.lo) / (self.hi - self.lo)).clamp(1e-3, 1 - 1e-3)
        return torch.log(x / (1 - x))

    def bone_R(self, q: torch.Tensor) -> torch.Tensor:
        R = [torch.eye(3, dtype=self.dtype) for _ in range(20)]
        delta = torch.deg2rad(q - self.rest)
        for i, b in enumerate(self.bones):
            R[b] = R[b] @ rot_aa(self.axes[i] * delta[i])
        return torch.stack(R)

    def forward(self, q: torch.Tensor, H: torch.Tensor, W: torch.Tensor):
        """Skin surface vertices and joints in the world (mm), for joint angles q (deg), world hand
        frame H (3x3, columns x long, y radial, z dorsal) and wrist joint position W."""
        R = self.bone_R(q)
        pose_map = (R[1:] - torch.eye(3, dtype=self.dtype)).reshape(-1)
        v = self.v + torch.einsum("nkc,c->nk", self.pbs, pose_map)
        G = [None] * 25
        for j in range(25):
            Rj = R[self.joint_bone[j]] if j in self.joint_bone else torch.eye(3, dtype=self.dtype)
            p = self.parent[j]
            off = self.J[j] - (self.J[p] if p >= 0 else 0)
            T = torch.eye(4, dtype=self.dtype)
            T = torch.cat([torch.cat([Rj, off[:, None]], 1), torch.tensor([[0, 0, 0, 1.0]], dtype=self.dtype)], 0)
            G[j] = T if p < 0 else G[p] @ T
        G = torch.stack(G)
        jpos = G[:, :3, 3]
        A_R = G[:, :3, :3]
        A_t = jpos - torch.einsum("jab,jb->ja", A_R, self.J)
        TR = torch.einsum("vj,jab->vab", self.sw, A_R)
        Tt = self.sw @ A_t
        posed = torch.einsum("vab,vb->va", TR, v) + Tt
        M = H @ self.B.T * self.scale
        world = (posed - self.J[0]) @ M.T + W
        joints = (jpos - self.J[0]) @ M.T + W
        return world, joints, G, M

    def pads(self, world: torch.Tensor, G: torch.Tensor, M: torch.Tensor):
        """Pad centre (mean of its vertices) and outward pad normal per digit, world."""
        out = {}
        for d in DIGITS:
            c = world[self.pad_idx[d]].mean(0)
            n_rest = torch.as_tensor(self.pad_normal_rest[d], dtype=self.dtype)
            n = M @ (G[DIST_JOINT[d], :3, :3] @ n_rest)
            out[d] = (c, n / torch.linalg.norm(n))
        return out


# --- object distance functions (world mm) -----------------------------------------------------
def sdf_box(p: torch.Tensor, center, R, half) -> torch.Tensor:
    """Signed distance to an oriented box (R columns = box axes)."""
    c = torch.as_tensor(center, dtype=p.dtype)
    Rm = torch.as_tensor(R, dtype=p.dtype)
    h = torch.as_tensor(half, dtype=p.dtype)
    q = (p - c) @ Rm
    d = q.abs() - h
    outside = torch.linalg.norm(d.clamp_min(0), dim=-1)
    inside = d.max(-1).values.clamp_max(0)
    return outside + inside


def sdf_cyl(p: torch.Tensor, a, b, r) -> torch.Tensor:
    """Signed distance to a capped cylinder from a to b, radius r."""
    a = torch.as_tensor(a, dtype=p.dtype)
    b = torch.as_tensor(b, dtype=p.dtype)
    ba = b - a
    L = torch.linalg.norm(ba)
    u = ba / L
    pa = p - a
    t = pa @ u
    radial = torch.linalg.norm(pa - t[:, None] * u, dim=-1) - r
    axial = (t - L / 2).abs() - L / 2
    d = torch.stack([radial, axial], -1)
    return torch.linalg.norm(d.clamp_min(0), dim=-1) + d.max(-1).values.clamp_max(0)


def frame_from(x, z) -> np.ndarray:
    x = np.asarray(x, float)
    z = np.asarray(z, float)
    x = x / np.linalg.norm(x)
    z = z - x * z.dot(x)
    z = z / np.linalg.norm(z)
    return np.stack([x, np.cross(z, x), z], 1)


def rot_about(axis, deg) -> np.ndarray:
    from scipy.spatial.transform import Rotation
    return Rotation.from_rotvec(np.asarray(axis, float) / np.linalg.norm(axis) * math.radians(deg)).as_matrix()


# --- the arm, differentiable ------------------------------------------------------------------
class TorchArm:
    """moonshot.motion.arm.Arm's angles and discomfort in torch, with the elbow swivel as a variable, so the
    grasp optimiser can trade finger contact against what the arm and wrist can do."""

    def __init__(self, arm):
        self.arm = arm
        self.S = torch.as_tensor(arm.S, dtype=torch.float64)

    def angles(self, H, W, swivel_deg):
        S = self.S
        l1, l2 = self.arm.l1, self.arm.l2
        d = W - S
        L = torch.linalg.norm(d).clamp(max=(l1 + l2) * 0.999)
        u = d / torch.linalg.norm(d)
        a = (l1 ** 2 - l2 ** 2 + L ** 2) / (2 * L)
        h = torch.sqrt((l1 ** 2 - a * a).clamp_min(1e-6))
        down = torch.tensor([0.0, 0.0, -1.0], dtype=torch.float64)
        e0 = down - u * (down @ u)
        e0 = e0 / torch.linalg.norm(e0)
        e1 = torch.linalg.cross(u, e0)
        out = torch.tensor([1.0 if self.arm.side == "R" else -1.0, 0, 0], dtype=torch.float64)
        e1 = e1 * torch.sign(e1 @ out)
        sw = torch.deg2rad(swivel_deg)
        E = S + u * a + h * (torch.cos(sw) * e0 + torch.sin(sw) * e1)
        f = (W - E) / torch.linalg.norm(W - E)
        up = (E - S) / torch.linalg.norm(E - S)
        n_e = torch.linalg.cross(up, f)
        n_e = n_e / torch.linalg.norm(n_e)
        r0 = torch.linalg.cross(n_e, f)
        F0 = torch.stack([f, r0, torch.linalg.cross(f, r0)], 1)
        R0 = F0.T @ H
        # intrinsic XYZ: R = Rx(a) Ry(b) Rz(c)
        b = torch.asin(R0[0, 2].clamp(-0.999999, 0.999999))
        ax = torch.atan2(-R0[1, 2], R0[2, 2])
        c = torch.atan2(-R0[0, 1], R0[0, 0])
        sign = 1.0 if self.arm.side == "R" else -1.0
        pron = -sign * torch.rad2deg(ax)
        flex = torch.rad2deg(b)
        dev = sign * torch.rad2deg(c)
        elbow = 180.0 - torch.rad2deg(torch.acos(((S - E) / torch.linalg.norm(S - E) @ f).clamp(-1, 1)))
        return pron, flex, dev, elbow, E

    def cost(self, H, W, swivel_deg):
        pron, flex, dev, elbow, _ = self.angles(H, W, swivel_deg)
        Wl, F = self.arm.W, self.arm.F
        def ell(lims):
            fl = flex / torch.where(flex > 0, torch.tensor(float(lims["flexion"])), torch.tensor(float(lims["extension"])))
            dv = dev / torch.where(dev > 0, torch.tensor(float(lims["radial"])), torch.tensor(float(lims["ulnar"])))
            return torch.relu(torch.sqrt(fl * fl + dv * dv + 1e-9) - 1.0)
        plim = torch.where(pron > 0, torch.tensor(float(F["pronation"])), torch.tensor(float(F["supination"])))
        c = 400 * ell(Wl) ** 2 + 2 * torch.relu(pron.abs() - plim) ** 2 + 2 * ell(Wl["functional"]) ** 2
        c = c + (flex / 60) ** 2 + (dev / 30) ** 2 + ((pron - 30) / 70) ** 2
        c = c + 3 * torch.relu(elbow - 140) ** 2 + 3 * torch.relu(10 - elbow) ** 2 + 0.002 * swivel_deg ** 2
        return c


# --- the optimiser ------------------------------------------------------------------------------
class Problem:
    """A grasp problem: terms are callables (world skin, joints, pads, q) -> scalar tensor."""

    def __init__(self, th: TorchHand, colliders, targets, q0: dict, extra=None, arm=None, arm_weight=10.0, body=None):
        """body: dict(lumbar=(3,), prior=body_solver.ArmPrior, load_kg=float, theta0=list of start
        postures): the hand's pose comes from the trunk and arm (body_model) instead of being free, and the
        posture is scored by the human-data prior, so the grip and the arm are chosen together."""
        self.th, self.colliders, self.targets, self.extra = th, colliders, targets, extra
        self.arm = TorchArm(arm) if arm is not None else None
        self.arm_weight = arm_weight
        self.body = body
        self.q0 = th.hand.vector(th.hand.couple(q0))

    def solve(self, H0: np.ndarray, W0: np.ndarray, iters=350, lr=0.05, rot_free_deg=12.0, move_mm=40.0,
              verbose=False):
        th = self.th
        dt = th.dtype
        u = th.free(self.q0).clone().requires_grad_(True)
        r = torch.zeros(3, dtype=dt, requires_grad=True)                     # small rotation of H
        w = torch.zeros(3, dtype=dt, requires_grad=True)                     # wrist shift (mm / 10)
        H0t = torch.as_tensor(H0, dtype=dt)
        W0t = torch.as_tensor(W0, dtype=dt)
        sv = torch.tensor(0.5, dtype=dt, requires_grad=True)                 # elbow swivel (-30..90 deg)
        opt = torch.optim.Adam([u, r, w, sv], lr=lr)
        best = None
        for it in range(iters):
            opt.zero_grad()
            q = th.angles(u)
            rr = math.radians(rot_free_deg) * torch.tanh(r)
            H = rot_aa(rr) @ H0t
            W = W0t + move_mm * torch.tanh(w / 4)
            world, joints, G, M = th.forward(q, H, W)
            pads = th.pads(world, G, M)
            terms = {}
            # contact targets
            for d, tgt in self.targets.items():
                terms[f"pad_{d}"] = tgt(pads[d][0], pads[d][1])
            # nothing else inside the colliders (pads may sink by their compression)
            pad_all = torch.cat([th.pad_idx[d] for d in self.targets])
            allow = torch.zeros(len(world), dtype=dt)
            allow[pad_all] = 2.5
            pen = torch.zeros((), dtype=dt)
            for c in self.colliders:
                sd = c(world)
                pen = pen + (torch.relu(-(sd + allow)) ** 2).sum()
            terms["penetration"] = 2.0 * pen
            # anatomy priors: stay near the starting (natural) shape, DIP-PIP and ring-little coupling
            qn = (q - torch.as_tensor(self.q0, dtype=dt)) / 40.0
            terms["prior"] = 0.6 * (qn ** 2).sum()
            terms["coupling"] = self._coupling(q)
            if self.extra:
                for k, f in self.extra.items():
                    terms[k] = f(world, joints, pads, q, H, W)
            if self.arm is not None:
                terms["arm"] = self.arm_weight * self.arm.cost(H, W, -30 + 120 * torch.sigmoid(sv))
            loss = sum(terms.values())
            loss.backward()
            opt.step()
            if best is None or loss.item() < best[0]:
                best = (loss.item(), q.detach().clone(), H.detach().clone(), W.detach().clone(),
                        {k: float(v.detach()) for k, v in terms.items()})
            if verbose and it % 50 == 0:
                print(it, round(loss.item(), 3), {k: round(float(v), 3) for k, v in terms.items()})
        loss, q, H, W, terms = best
        return {"loss": loss, "q": th.hand.as_dict(q.numpy()), "H": H.numpy(), "W": W.numpy(), "terms": terms}

    def solve_body(self, theta0, iters=500, lr=0.04, verbose=False):
        """Grasp with the hand placed by the body: variables are the finger angles and the 10 body
        angles (body_model.NAMES), the wrist inside its ellipse by construction (solver.wrist_inside); costs
        add the posture prior, gravity effort and trunk lean to the contact and penetration terms."""
        from moonshot.motion import kinematics as BM
        from moonshot.motion import solver as BSV
        th = self.th
        dt = th.dtype
        b = self.body
        lo, hi = (torch.as_tensor(x) for x in BSV.ranges())
        th0 = np.asarray(theta0, float)
        if len(th0) == 10:
            th0 = np.concatenate([th0, [0.0, 0.0]])
        x0 = ((torch.as_tensor(th0) - lo) / (hi - lo)).clamp(1e-3, 1 - 1e-3)
        ub = torch.log(x0 / (1 - x0)).clone().requires_grad_(True)
        u = th.free(self.q0).clone().requires_grad_(True)
        opt = torch.optim.Adam([u, ub], lr=lr)
        L = torch.as_tensor(b["lumbar"], dtype=dt)
        best = None
        for it in range(iters):
            opt.zero_grad()
            q = th.angles(u)
            tb = BSV.wrist_inside((lo + (hi - lo) * torch.sigmoid(ub))[None])[0]
            f = BM.torch_fk(tb[None], L)
            H, W = f["H"][0], f["W"][0]
            world, joints, G, M = th.forward(q, H, W)
            pads = th.pads(world, G, M)
            terms = {}
            for d, tgt in self.targets.items():
                terms[f"pad_{d}"] = tgt(pads[d][0], pads[d][1])
            pad_all = torch.cat([th.pad_idx[d] for d in self.targets])
            allow = torch.zeros(len(world), dtype=dt)
            allow[pad_all] = 2.5
            pen = torch.zeros((), dtype=dt)
            for c in self.colliders:
                pen = pen + (torch.relu(-(c(world) + allow)) ** 2).sum()
            terms["penetration"] = 2.0 * pen
            qn = (q - torch.as_tensor(self.q0, dtype=dt)) / 40.0
            terms["prior"] = 0.6 * (qn ** 2).sum()
            terms["coupling"] = self._coupling(q)
            terms["posture"] = BSV.posture_cost(tb[None], b["prior"], **{k: b[k] for k in ("w_prior",) if k in b})[0]
            S = f["S"][0]
            mom = lambda m, p: m * torch.linalg.norm((p - S)[:2])
            Mo = mom(2.1, (S + f["E"][0]) / 2) + mom(1.2, (f["E"][0] + W) / 2) + mom(0.5 + b.get("load_kg", 0.0), W)
            terms["effort"] = 1e-6 * (Mo * 9.81) ** 2
            loss = sum(terms.values())
            loss.backward()
            opt.step()
            if best is None or loss.item() < best[0]:
                best = (loss.item(), q.detach().clone(), H.detach().clone(), W.detach().clone(), tb.detach().clone(),
                        {k: float(v.detach()) for k, v in terms.items()})
            if verbose and it % 100 == 0:
                print(it, round(loss.item(), 2), {k: round(float(v), 2) for k, v in terms.items()})
        loss, q, H, W, tb, terms = best
        return {"loss": loss, "q": th.hand.as_dict(q.numpy()), "H": H.numpy(), "W": W.numpy(), "theta": tb.numpy(),
                "terms": terms}

    def solve_starts(self, starts, **kw):
        """Best of several starting hand poses [(H0, W0), ...]."""
        best = None
        for H0, W0 in starts:
            g = self.solve(H0, W0, **kw)
            if best is None or g["loss"] < best["loss"]:
                best = g
        return best

    def _coupling(self, q):
        h = self.th.hand
        ix = h.index
        C = h.spec["coupling"]
        c = torch.zeros((), dtype=q.dtype)
        for nm in ("index", "middle", "ring", "little"):
            k, off = C["dip_per_pip_contact"][nm] if nm in self.targets else (C["dip_per_pip_free"][nm], 0.0)
            c = c + ((q[ix[f"{nm}_dip"]] - (k * q[ix[f"{nm}_pip"]] + off)) / 12.0) ** 2
        # the little finger follows the ring (enslaving); the ring the middle, a little
        e = C["enslave"]
        for a, b, k in (("ring", "little", e["ring->little"]), ("middle", "ring", e["middle->ring"])):
            for j in ("mcp_flex", "pip"):
                diff = q[ix[f"{b}_{j}"]] - q[ix[f"{a}_{j}"]]
                c = c + k * (diff / 25.0) ** 2
        c = c + ((q[ix["thumb_cmc_roll"]] - C["thumb_roll_per_cmc_flex"] * q[ix["thumb_cmc_flex"]]) / 6.0) ** 2
        c = c + ((q[ix["cmc4_flex"]] - C["cmc4_per_mcp"] * q[ix["ring_mcp_flex"]].clamp_min(0)) / 4.0) ** 2
        c = c + ((q[ix["cmc5_flex"]] - C["cmc5_per_cmc4"] * q[ix["cmc4_flex"]]) / 4.0) ** 2
        return c


def mirrored(colliders, targets, lumbar):
    """A left hand's grip problem as the right hand's in the mirrored world (moonshot/motion/kinematics.py): every
    collider and target sees points and normals reflected through the body's mid-plane, so the right-hand solver
    finds the left hand's grip as its mirror image (H, W and the arm's angles in the mirrored world; the finger angles
    as they are)."""
    x2 = 2.0 * float(np.asarray(lumbar, float)[0])

    def flip_p(p):
        return torch.stack([x2 - p[..., 0], p[..., 1], p[..., 2]], -1)

    def flip_n(n):
        return torch.stack([-n[..., 0], n[..., 1], n[..., 2]], -1)

    cols = [(lambda p, c=c: c(flip_p(p))) for c in colliders]
    tgts = {d: (lambda cc, n, t=t: t(flip_p(cc), flip_n(n))) for d, t in targets.items()}
    return cols, tgts


def solve_spec(th: "TorchHand", spec: dict, lumbar, prior) -> dict:
    """A grip from its spec: colliders, targets, q0, obj and body starts, and optionally iters, load (kg), refine (a
    second stage's targets, solved from the first's best), side, and w_prior (people's posture's weight, posture_cost's
    own when absent). A left grip (side "L") is solved mirrored and stays in the mirrored world, H, W, theta and obj
    alike, as the body solver takes a left hand's tasks."""
    cols, tgts, ref = spec["colliders"], spec["targets"], spec.get("refine")
    obj = np.asarray(spec["obj"], float)
    if spec.get("side") == "L":
        cols, tgts = mirrored(cols, tgts, lumbar)
        ref = mirrored([], ref, lumbar)[1] if ref else None
        obj = np.r_[2 * float(np.asarray(lumbar, float)[0]) - obj[0], obj[1:]]
    body = dict(lumbar=lumbar, prior=prior, load_kg=spec.get("load", 0.0)) | (
        {"w_prior": spec["w_prior"]} if "w_prior" in spec else {})
    P = Problem(th, cols, tgts, spec["q0"], body=body)
    best = None
    for th0 in spec["starts"]:
        g = P.solve_body(th0, iters=spec.get("iters", 700))
        if best is None or g["loss"] < best["loss"]:
            best = g
    if ref:
        best = Problem(th, cols, ref, best["q"], body=body).solve_body(best["theta"], iters=800, lr=0.01)
    return best | {"obj": obj, "side": spec.get("side", "R")}


def plane_target(point, normal, comp_mm=2.0, band=None):
    """Pad on a plane (point, outward normal): the pad centre sits comp_mm inside it and the pad faces
    into it. band: optional callable(pad centre) -> extra penalty (where on the face)."""
    P = torch.as_tensor(point, dtype=torch.float64)
    N = torch.as_tensor(normal, dtype=torch.float64)
    def f(c, n):
        d = (c - P) @ N + comp_mm
        face = 1.0 + n @ N            # 0 when the pad faces straight into the surface
        out = d * d + 30.0 * face * face
        if band is not None:
            out = out + band(c)
        return out
    return f


def arm_score(arm, H, W, prev=None):
    s = arm.solve(H, W, prev)
    return s["cost"], s
