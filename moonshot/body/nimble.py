"""NIMBLE hand model (Li et al., SIGGRAPH 2022): bones, muscles and skin from MRI, in numpy. Ported from trainual's
motion/nimble.py; the model files live in the data root (hand-model/nimble), never in git.

A port of NIMBLELayer (https://github.com/reyuwei/NIMBLE_model, MIT) without torch or pytorch3d, reading the
.npz files written by nimble_convert.py. Units are mm (as the model ships).

Pose: 20 axis-angle rotations, one per bone (index 0 = carpals/root, then met1 pro1 dis1, met2 pro2 int2 dis2,
... met5 pro5 int5 dis5), each relative to its parent in the rest pose's axes, applied at the bone's base
joint, the same convention as MANO. Pose blend shapes (`pbs`) move bones, muscles and skin with the joint
rotations, which is what keeps the thenar and knuckles full as the hand bends.
"""
from pathlib import Path

import numpy as np

BONES = ['carpal', 'met1', 'pro1', 'dis1', 'met2', 'pro2', 'int2', 'dis2', 'met3', 'pro3', 'int3', 'dis3',
         'met4', 'pro4', 'int4', 'dis4', 'met5', 'pro5', 'int5', 'dis5']
JOINTS = ['carpal', 'met1', 'pro1', 'dis1', 'dis1_end', 'met2', 'pro2', 'int2', 'dis2', 'dis2_end',
          'met3', 'pro3', 'int3', 'dis3', 'dis3_end', 'met4', 'pro4', 'int4', 'dis4', 'dis4_end',
          'met5', 'pro5', 'int5', 'dis5', 'dis5_end']
PARENT = [-1, 0, 1, 2, 3, 0, 5, 6, 7, 8, 0, 10, 11, 12, 13, 0, 15, 16, 17, 18, 0, 20, 21, 22, 23]
JOINT_BONE = {j: BONES.index(n) for j, n in enumerate(JOINTS) if n in BONES}   # joint index -> bone index
TIP_JOINT = {'dis1': 4, 'dis2': 9, 'dis3': 14, 'dis4': 19, 'dis5': 24}


def rodrigues(aa):
    aa = np.asarray(aa, dtype=np.float64).reshape(-1, 3)
    th = np.linalg.norm(aa, axis=1, keepdims=True)
    k = aa / np.maximum(th, 1e-12)
    kx, ky, kz = k[:, 0], k[:, 1], k[:, 2]
    zero = np.zeros_like(kx)
    K = np.stack([zero, -kz, ky, kz, zero, -kx, -ky, kx, zero], 1).reshape(-1, 3, 3)
    s, c = np.sin(th)[:, :, None], np.cos(th)[:, :, None]
    return np.eye(3)[None] + s * K + (1 - c) * (K @ K)


def mat_to_aa(R):
    R = np.asarray(R, dtype=np.float64).reshape(-1, 3, 3)
    out = np.zeros((len(R), 3))
    for i, m in enumerate(R):
        c = np.clip((np.trace(m) - 1) / 2, -1, 1)
        th = np.arccos(c)
        if th < 1e-8:
            continue
        if np.pi - th < 1e-4:
            # 180 degrees: axis from the largest diagonal entry
            d = np.argmax(np.diag(m))
            v = m[:, d] + np.eye(3)[d]
            out[i] = v / np.linalg.norm(v) * th
            continue
        w = np.array([m[2, 1] - m[1, 2], m[0, 2] - m[2, 0], m[1, 0] - m[0, 1]]) / (2 * np.sin(th))
        out[i] = w * th
    return out


class Nimble:
    def __init__(self, folder):
        folder = Path(folder).expanduser()
        d = np.load(folder / 'NIMBLE_DICT_9137.npz')
        self.vert = d['vert'].astype(np.float64)
        self.face = d['face']
        self.sw = d['all_sw'].astype(np.float64)
        self.pbs = d['all_pbs'].astype(np.float64)
        self.jreg_bone = d['jreg_bone'].astype(np.float64)
        self.shape_basis = d['shape_basis'].astype(np.float64)
        self.shape_std, self.shape_mean = d['shape_pm_std'], d['shape_pm_mean']
        self.pose_basis, self.pose_mean = d['pose_basis'], d['pose_mean']
        self.pose_std, self.pose_pm_mean = d['pose_pm_std'], d['pose_pm_mean']
        self.bone_sep, self.skin_sep = int(d['bone_v_sep']), int(d['skin_v_sep'])
        self.skin_f, self.muscle_f, self.bone_f = d['skin_f'], d['muscle_f'], d['bone_f']
        self.skin_surface = d['skin_v_surface_mask'].astype(bool)
        self._skin_gd = d['skin_v_gd']
        self.folder = folder
        self._node_w = None

    # -- shape --------------------------------------------------------------------------------------
    def shaped(self, betas=None):
        betas = np.zeros(20) if betas is None else np.asarray(betas, dtype=np.float64)
        real = betas * self.shape_std[:len(betas)] + self.shape_mean[:len(betas)]
        v = self.vert + (self.shape_basis[:len(betas)].T @ real).reshape(-1, 3)
        joints = self.jreg_bone @ v[:self.bone_sep]
        return v, joints

    def pca_pose(self, coeffs):
        """Full 20x3 pose (root zero) from normalised pose-PCA coefficients, as NIMBLE's demo samples."""
        c = np.asarray(coeffs, dtype=np.float64)
        real = c * self.pose_std[:len(c)] + self.pose_pm_mean[:len(c)]
        full = self.pose_basis[:len(c)].T @ real + self.pose_mean
        return np.concatenate([np.zeros(3), full]).reshape(20, 3)

    @property
    def mean_pose(self):
        return np.concatenate([np.zeros(3), self.pose_mean]).reshape(20, 3)

    # -- forward ------------------------------------------------------------------------------------
    def forward(self, pose, betas=None, shaped=None):
        """pose: (20, 3) axis-angle per bone. Returns dict of posed skin/muscle/bone vertices and joints."""
        v, J = shaped if shaped is not None else self.shaped(betas)
        pose = np.asarray(pose, dtype=np.float64).reshape(20, 3)
        R = rodrigues(pose)                                   # (20, 3, 3)
        pose_map = (R[1:] - np.eye(3)[None]).reshape(-1)      # 19 * 9 = 171
        v_pb = v + self.pbs @ pose_map
        G = np.zeros((25, 4, 4))
        for j in range(25):
            Rj = R[JOINT_BONE[j]] if j in JOINT_BONE else np.eye(3)
            if j == 0:
                Rj = R[0]
            T = np.eye(4)
            T[:3, :3] = Rj
            T[:3, 3] = J[j] - (J[PARENT[j]] if PARENT[j] >= 0 else 0)
            G[j] = T if j == 0 else G[PARENT[j]] @ T
        joints_posed = G[:, :3, 3].copy()
        A = G.copy()
        A[:, :3, 3] -= np.einsum('jab,jb->ja', G[:, :3, :3], J)
        T = np.einsum('vj,jab->vab', self.sw, A)
        out = np.einsum('vab,vb->va', T[:, :3, :3], v_pb) + T[:, :3, 3]
        return {
            'bone': out[:self.bone_sep], 'muscle': out[self.bone_sep:self.skin_sep], 'skin': out[self.skin_sep:],
            'joints': joints_posed, 'G': G,
        }

    # -- helpers ------------------------------------------------------------------------------------
    def node_weight(self):
        if self._node_w is None:
            d = self._skin_gd.copy()
            d[d == 0] = 1e5
            d[d > 30] = 1e5
            w = np.exp(-d / 50.0)
            n = np.linalg.norm(w, axis=1)
            w = w / (n[:, None] + 1e-6)
            w[n == 0] = 0
            self._node_w = w
        return self._node_w

    def push_skin_out_of_muscle(self, skin, muscle):
        """NIMBLE's handle_collision: skin vertices inside the muscle mesh move 2 mm outside it."""
        import trimesh
        mm = trimesh.Trimesh(muscle, self.muscle_f, process=False)
        inside = self.skin_surface & mm.contains(skin)
        if inside.sum() <= 1:
            return skin
        n = vertex_normals(skin, self.skin_f)
        loc, iray, _ = mm.ray.intersects_location(skin[inside], n[inside], multiple_hits=False)
        offset = np.zeros((inside.sum(), 3))
        offset[iray] = loc + 2 * n[inside][iray] - skin[inside][iray]
        full = np.zeros_like(skin)
        full[inside] = offset
        hard = skin + full
        soft = skin + self.node_weight() @ full
        return 0.7 * hard + 0.3 * soft

    def uv_obj_lines(self):
        return (self.folder / 'NIMBLE_TEX_FUV.txt').read_text()

    def textures(self, alpha=None):
        """Diffuse, normal and specular maps (1024x1024x3 floats in 0..1, RGB) from the appearance PCA.
        The model stores them BGR (its demo writes them with cv2), so the channels are flipped here."""
        t = np.load(self.folder / 'NIMBLE_TEX_DICT.npz')
        alpha = np.zeros(10) if alpha is None else np.asarray(alpha, dtype=np.float64)
        maps = {}
        for k in ('diffuse', 'normal', 'spec'):
            x = t[f'{k}/basis'] @ (alpha * t[f'{k}/std']) + t[f'{k}/mean'][:, 0]
            maps[k] = np.clip(x.reshape(1024, 1024, 3)[:, :, ::-1], 0, 1)
        return maps


def vertex_normals(v, f):
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    n = np.zeros_like(v)
    for k in range(3):
        np.add.at(n, f[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def taubin(v, f, iters=3, lam=0.5, mu=-0.53):
    """Taubin smoothing (what NIMBLE's demo applies to its output via pytorch3d)."""
    import scipy.sparse as sp
    n = len(v)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    A = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    A.data[:] = 1
    deg = np.asarray(A.sum(1)).ravel()
    L = sp.diags(1 / np.maximum(deg, 1)) @ A
    for _ in range(iters):
        v = v + lam * (L @ v - v)
        v = v + mu * (L @ v - v)
    return v
