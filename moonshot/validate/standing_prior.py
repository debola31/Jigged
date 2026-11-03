"""The standing-work posture prior (your decision, 2026-11-03): what the posture checks (moonshot/validate/posture.py)
hold a take to, measured from people standing at industry-like manual work, as a machinist stands at the VF-2. The
seated prior (GRAB and ARCTIC, tabletop work) stays for reproducing trainual's report (test_posture_port.py).

The data is the AnDy dataset (Maurice et al. 2019, "Human movement and ergonomics: an industry-oriented dataset for
collaborative robotics", IJRR; zenodo.org/records/3254403, CC BY 4.0, which allows this use with credit): 13 people,
15 trials each of screwing at several heights, picking, placing and carrying loads, recorded with Xsens MVN suits
(xsens_bvh.zip) and labelled frame by frame by three annotators (labels_csv.zip). Kept: the frames the annotators'
majority labels standing (St), whatever the hands are doing, as every frame of a take is checked.

Each frame's ten angles come from the BVH segments' world rotations through moonshot.motion.kinematics's
anatomical_angles, as the seated prior's came from SMPL-X's: the BVH's rest pose is a T-pose like SMPL-X's, its axes
(x left, y up, z forward) SMPL-X's, so the same axis change applies. Then the same statistics: each joint's 1st to 99th
percentile, an 8-component Gaussian mixture over the seven arm angles, and the speeds' percentiles; and people's own
limits (thresholds.toml body.posture_*): each trial's median likelihood under a mixture fitted without its person,
the 95th percentile of those, and the share of its frames inside the other people's ranges, the median of those.

    python -m moonshot.validate.standing_prior     # <data root>/datasets/andy -> <data root>/arm-prior/standing_prior.npz
"""
from __future__ import annotations

import csv
import re
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion.kinematics import anatomical_angles

ANDY = data_root() / "datasets" / "andy"
OUT = data_root() / "arm-prior" / "standing_prior.npz"
NAMES = ["trunk_flex", "trunk_lat", "trunk_rot", "sh_plane", "sh_elev", "sh_rot", "elbow", "pron", "wr_flex", "wr_dev"]
SEGMENTS = {"pelvis": "Hips", "thorax": "Chest4", "humerus": "RightShoulder", "forearm": "RightElbow",
            "hand": "RightWrist"}
C = np.array([[-1.0, 0, 0], [0, 0, 1.0], [0, 1.0, 0]])     # BVH (x left, y up, z forward) -> ours (x right, y forward, z up)
FPS = 30.0


def read_bvh(text: str) -> tuple[dict[str, np.ndarray], float]:
    """Each joint's world rotation (n, 3, 3), BVH axes, at every frame nearest FPS (the suits record at 240 Hz: every
    8th), and that rate. Taken, not interpolated: an angle interpolated across +-180 deg is wrong."""
    tokens = re.split(r"\s+", text.strip())
    i, stack, joints = 0, [], []          # joints: (name, parent index, channel names)
    while tokens[i] != "MOTION":
        t = tokens[i]
        if t in ("ROOT", "JOINT"):
            joints.append([tokens[i + 1], stack[-1] if stack else -1, []])
            i += 2
        elif t == "End":
            joints.append([None, stack[-1], []])
            i += 2
        elif t == "{":
            stack.append(len(joints) - 1)
            i += 1
        elif t == "}":
            stack.pop()
            i += 1
        elif t == "CHANNELS":
            n = int(tokens[i + 1])
            joints[-1][2] = tokens[i + 2:i + 2 + n]
            i += 2 + n
        else:
            i += 1
    n_frames, dt = int(tokens[i + 2]), float(tokens[i + 5])
    values = np.array(tokens[i + 6:], float)
    width = sum(len(j[2]) for j in joints)
    every = max(1, round(1.0 / (dt * FPS)))
    values = values[:n_frames * width].reshape(n_frames, width)[::every]
    n_frames = len(values)
    world, col = {}, 0
    G = [None] * len(joints)
    for k, (name, parent, channels) in enumerate(joints):
        rots = [(c[0].lower(), col + m) for m, c in enumerate(channels) if c.endswith("rotation")]
        col += len(channels)
        if rots:
            order = "".join(a for a, _ in rots).upper()                # intrinsic, in the channels' order
            R = Rotation.from_euler(order, values[:, [c for _, c in rots]], degrees=True).as_matrix()
        else:
            R = np.broadcast_to(np.eye(3), (n_frames, 3, 3))
        G[k] = R if parent < 0 else G[parent] @ R
        if name:
            world[name] = G[k]
    return world, 1.0 / (dt * every)


def angles(world: dict[str, np.ndarray]) -> np.ndarray:
    """(n, 10) anatomical angles, as the seated prior measures them."""
    g = {k: np.einsum("ab,nbc,cd->nad", C, world[v], C.T) for k, v in SEGMENTS.items()}
    return anatomical_angles(g["pelvis"], g["thorax"], g["humerus"], g["forearm"], g["hand"])


def standing(labels: Path, t: np.ndarray) -> np.ndarray:
    """At each time t (s from the trial's start), whether the annotators' majority labels the person standing."""
    rows = list(csv.DictReader(labels.read_text(encoding="utf-8").splitlines()))
    tv = np.array([float(r["t_video"]) for r in rows])
    st = np.array([Counter(r[f"general_posture_Annotator{a}"] for a in (1, 2, 3)).most_common(1)[0][0] == "St"
                   for r in rows])
    return st[np.clip(np.searchsorted(tv, t, side="right") - 1, 0, len(st) - 1)]


def trial(member: str, labels: Path, root: Path = ANDY) -> tuple[str, str, np.ndarray, np.ndarray]:
    """(person, trial, angles at FPS, standing at FPS) for one of the archive's BVH files."""
    with zipfile.ZipFile(root / "xsens_bvh.zip") as z:
        world, fps = read_bvh(z.read(member).decode("utf-8", "replace"))
    A = angles(world)
    name = labels.name.split(".")[0]
    return name.split("_")[1], name, A, standing(labels, np.arange(len(A)) / fps)


def trials(root: Path = ANDY, workers: int = 6) -> list:
    """Every trial with labels, parsed across processes (a trial's BVH takes ~10 s)."""
    from concurrent.futures import ProcessPoolExecutor
    labels = {p.name.split(".")[0]: p for p in (root / "labels").rglob("*.labels.csv")}
    with zipfile.ZipFile(root / "xsens_bvh.zip") as z:
        members = sorted(n for n in z.namelist() if n.endswith(".bvh"))
    jobs = [(m, labels[k]) for m in members if (k := Path(m).name.split(".")[0]) in labels]   # Participant_<id>_..
    with ProcessPoolExecutor(workers) as ex:
        return list(ex.map(trial, *zip(*jobs)))


def nll(gmm, x: np.ndarray) -> np.ndarray:
    """Per frame, as validate/posture.py Prior.nll: without the constant (7/2) log 2 pi."""
    return -gmm.score_samples(x) - 3.5 * np.log(2 * np.pi)


def main() -> None:
    from sklearn.mixture import GaussianMixture
    data = list(trials())
    X = np.concatenate([A[s] for _, _, A, s in data])
    V = np.concatenate([(np.abs(np.diff(A, axis=0)) * FPS)[s[1:]] for _, _, A, s in data])
    gmm = GaussianMixture(8, covariance_type="full", random_state=0).fit(X[:, 3:])
    # people held to the others: each trial's median likelihood under a mixture fitted without its person, and the
    # share of its frames with every angle inside the others' 1st-99th percentiles
    medians, inside = [], []
    for person in sorted({p for p, *_ in data}):
        rest = np.concatenate([A[s] for p, _, A, s in data if p != person])
        held = GaussianMixture(8, covariance_type="full", random_state=0).fit(rest[:, 3:])
        lo, hi = np.percentile(rest, [1, 99], axis=0)
        for p, _, A, s in data:
            if p == person and s.any():
                medians.append(float(np.median(nll(held, A[s][:, 3:]))))
                inside.append(float(1 - ((A[s] < lo) | (A[s] > hi)).any(1).mean()))
    pct = np.percentile(X, [1, 5, 25, 50, 75, 95, 99], axis=0).T
    OUT.parent.mkdir(parents=True, exist_ok=True)
    np.savez(OUT, names=np.array(NAMES), weights=gmm.weights_, means=gmm.means_, covs=gmm.covariances_, pct=pct,
             vpct=np.percentile(V, [50, 90, 99], axis=0).T, n_frames=len(X), n_seqs=len(data),
             nll_median_p95=np.percentile(medians, 95), inside_frac_median=np.median(inside),
             inside_frac_p5=np.percentile(inside, 5),
             source="AnDy (Maurice et al. 2019), CC BY 4.0")
    print(f"{len(data)} trials of {len({p for p, *_ in data})} people, {len(X)} standing frames at 30 fps -> {OUT}")
    print(f"each trial's median likelihood under the others' mixture: 95th percentile {np.percentile(medians, 95):.2f}")
    print(f"each trial's frames inside the others' ranges: median {np.median(inside):.3f}, 5th percentile "
          f"{np.percentile(inside, 5):.3f}")
    print(f"{'joint':11s} {'p1':>6s} {'p50':>6s} {'p99':>6s}")
    for j, n in enumerate(NAMES):
        print(f"{n:11s} {pct[j, 0]:6.1f} {pct[j, 3]:6.1f} {pct[j, 6]:6.1f}")


if __name__ == "__main__":
    main()
