"""Ported from trainual's motion/body_model.py. Trunk + right arm kinematics with anatomical angles: the body the hand hangs from.

Twelve degrees of freedom, all anatomical and range-limited (moonshot/body/data/anatomy.json "body"):

    trunk_flex  lean forward (+)            thorax vs pelvis, about the lumbar spine
    trunk_lat   bend toward the right (+)
    trunk_rot   turn toward the right (+)
    sh_plane    plane of elevation: 0 = out to the side (abduction), 90 = straight forward (flexion)
    sh_elev     elevation of the upper arm from hanging (0) in that plane
    sh_rot      humeral axial rotation, internal (+)
    elbow       flexion (0 = straight)
    pron        forearm rotation: 0 = thumb up with the elbow bent (palm facing the body), + = palm turning down
    wr_flex     wrist flexion (+) / extension (-)
    wr_dev      radial (+) / ulnar (-) deviation
    sc_prot     shoulder girdle protraction (+, mm): the clavicle and scapula carry the shoulder joint forward
    sc_elev     shoulder girdle elevation (+, mm): ... and up (shrug); both move the glenohumeral centre in the
                thorax frame, which is how real arms reach and crank without rocking the trunk

Frames (world mm, +X right, +Y forward, +Z up). Every segment's frame is the identity at the anatomical
zero: arm hanging at the side, palm facing the thigh, thumb forward. Segment long axes point along -Z there.
The hand frame used everywhere else (hand_model / grasp: columns long, radial, dorsal) is
R_hand @ H0 with H0 = [-Z, +Y, +X].

    R_thorax = Rz(-trunk_rot) Ry(trunk_lat) Rx(-trunk_flex)          (relative to the pelvis, upright)
    R_hum    = R_thorax Rz(sh_plane) Ry(-sh_elev) Rz(sh_rot)
    R_fore   = R_hum Rx(elbow) Rz(pron)
    R_hand   = R_fore Ry(wr_flex) Rx(wr_dev)

`anatomical_angles` inverts this for SMPL-X segment rotations (trainual's human_data.py), so the data and the solver
measure the same angles.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.spatial.transform import Rotation

NAMES = ["trunk_flex", "trunk_lat", "trunk_rot", "sh_plane", "sh_elev", "sh_rot", "elbow", "pron", "wr_flex", "wr_dev",
         "sc_prot", "sc_elev"]
ARM = slice(3, 10)          # the 7 arm angles (the human-data prior's dimensions)
H0 = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])      # columns: long (-Z), radial (+Y), dorsal (+X)

# body dimensions (mm): a 50th-percentile adult male (ANSUR II), from the lumbar pivot (L5-S1)
# ANSUR II: acromion 1439 mm, eye 1640, biacromial 415 (acromion ~207 lateral); the glenohumeral centre
# sits ~45 below and ~15 medial of the acromion, so with the lumbar pivot at 955 mm:
DIMS = {
    "shoulder_from_lumbar": np.array([190.0, 0.0, 440.0]),   # right glenohumeral centre, thorax frame
    "neck_from_lumbar": np.array([0.0, 10.0, 510.0]),
    "eye_from_neck": np.array([0.0, 90.0, 175.0]),           # between the eyes, head frame
    "upper_arm": 300.0, "forearm": 265.0,
}


def Rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def Ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def Rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def fk(theta, lumbar, R_pelvis=np.eye(3), dims=DIMS):
    """theta: 10 angles in degrees (NAMES order). Returns dict of world frames and points (mm)."""
    th = np.asarray(theta, dtype=np.float64)
    if len(th) == 10:
        th = np.concatenate([th, [0.0, 0.0]])
    t = np.radians(th)
    Rt = R_pelvis @ Rz(-t[2]) @ Ry(t[1]) @ Rx(-t[0])
    Rh = Rt @ Rz(t[3]) @ Ry(-t[4]) @ Rz(t[5])
    Rf = Rh @ Rx(t[6]) @ Rz(t[7])
    Rw = Rf @ Ry(t[8]) @ Rx(t[9])
    S = np.asarray(lumbar) + Rt @ (dims["shoulder_from_lumbar"] + np.array([0.0, th[10], th[11]]))
    E = S + Rh @ np.array([0, 0, -dims["upper_arm"]])
    W = E + Rf @ np.array([0, 0, -dims["forearm"]])
    neck = np.asarray(lumbar) + Rt @ dims["neck_from_lumbar"]
    return {"thorax": Rt, "humerus": Rh, "forearm": Rf, "hand": Rw, "H": Rw @ H0, "F": Rf @ H0,
            "S": S, "E": E, "W": W, "neck": neck}


def anatomical_angles(Gp, Gt, Gh, Gf, Gw):
    """Angles (n, 10) from SMPL-X global segment rotations in our axes (pelvis, spine3, right shoulder,
    elbow, wrist). SMPL-X's rest pose has the arm out to the side, palm down, thumb forward: our
    (sh_plane 0, sh_elev 90, everything else 0), so each arm segment's frame is G @ Ry(-90 deg)."""
    T = Ry(-math.pi / 2)
    n = len(Gp)
    out = np.zeros((n, 10))
    for k in range(n):
        Rt_rel = Gp[k].T @ Gt[k]
        z, y, x = Rotation.from_matrix(Rt_rel).as_euler("ZYX", degrees=False)
        out[k, 0:3] = [-math.degrees(x), math.degrees(y), -math.degrees(z)]
        Rh = Gh[k] @ T
        Rf = Gf[k] @ T
        Rw = Gw[k] @ T
        p, me, a = Rotation.from_matrix(Gt[k].T @ Rh).as_euler("ZYZ", degrees=True)
        e = -me
        if e < 0:                                       # keep elevation positive (equivalent ZYZ solution)
            p, e, a = p + 180, -e, a + 180
        out[k, 3:6] = [((p + 180) % 360) - 180, e, ((a + 180) % 360) - 180]
        lf = Rh.T @ Rf @ np.array([0, 0, -1.0])         # forearm long axis in the humerus frame
        flex = math.degrees(math.atan2(lf[1], -lf[2]))
        rel = (Rh @ Rx(math.radians(flex))).T @ Rw
        pr, wf, wd = Rotation.from_matrix(rel).as_euler("ZYX", degrees=True)
        out[k, 6:10] = [flex, pr, wf, wd]
    return out


# --- torch version for the solver ------------------------------------------------------------------
def torch_fk(theta, lumbar, R_pelvis=None, dims=DIMS):
    """Batched: theta (n, 10) degrees -> dict of (n, 3, 3) frames and (n, 3) points."""
    import torch
    if theta.shape[1] == 10:
        theta = torch.cat([theta, torch.zeros(theta.shape[0], 2, dtype=theta.dtype)], 1)
    t = torch.deg2rad(theta)
    n = t.shape[0]
    dt = t.dtype

    def rot(axis, a):
        c, s = torch.cos(a), torch.sin(a)
        o, z = torch.ones_like(a), torch.zeros_like(a)
        if axis == "x":
            m = [o, z, z, z, c, -s, z, s, c]
        elif axis == "y":
            m = [c, z, s, z, o, z, -s, z, c]
        else:
            m = [c, -s, z, s, c, z, z, z, o]
        return torch.stack(m, -1).reshape(n, 3, 3)

    Rp = torch.eye(3, dtype=dt).expand(n, 3, 3) if R_pelvis is None else torch.as_tensor(R_pelvis, dtype=dt).expand(n, 3, 3)
    Rt = Rp @ rot("z", -t[:, 2]) @ rot("y", t[:, 1]) @ rot("x", -t[:, 0])
    Rh = Rt @ rot("z", t[:, 3]) @ rot("y", -t[:, 4]) @ rot("z", t[:, 5])
    Rf = Rh @ rot("x", t[:, 6]) @ rot("z", t[:, 7])
    Rw = Rf @ rot("y", t[:, 8]) @ rot("x", t[:, 9])
    L = torch.as_tensor(lumbar, dtype=dt).reshape(-1, 3).expand(n, 3)
    v = lambda a: torch.as_tensor(a, dtype=dt)
    girdle = torch.stack([torch.zeros_like(theta[:, 10]), theta[:, 10], theta[:, 11]], -1)
    S = L + torch.einsum("nij,nj->ni", Rt, v(dims["shoulder_from_lumbar"]) + girdle)
    E = S + Rh @ v([0, 0, -dims["upper_arm"]])
    W = E + Rf @ v([0, 0, -dims["forearm"]])
    neck = L + Rt @ v(dims["neck_from_lumbar"])
    H0t = v(H0)
    return {"thorax": Rt, "humerus": Rh, "forearm": Rf, "hand": Rw, "H": Rw @ H0t, "F": Rf @ H0t,
            "S": S, "E": E, "W": W, "neck": neck}
