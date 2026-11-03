"""The posture checks' people (your decision, 2026-11-03): people manipulating objects, seated or standing. A
machinist stands, as AnDy's people do (moonshot/validate/standing_prior.py), but holds a part up close to look at it,
grasps it palm down and cranks a vise, which AnDy's screwing, picking and carrying don't contain and the seated
tabletop manipulation of GRAB and ARCTIC (trainual's prior) does: against AnDy alone the tuned vise take sat 77% in
range at a median nll of 26.6, against both 100% and 24.5.

The prior: an even mixture of the two datasets' own 8-component mixtures over the seven arm angles (16 components),
and each joint's range from the lower of their 1st percentiles to the higher of their 99th. The seated data is the
seated prior's, per sequence (GRAB s1's frames in contact with the object, all of ARCTIC's), measured through
moonshot.motion.kinematics.anatomical_angles where it lives (the M4's ~/Downloads/hand-datasets), into
<data root>/datasets/seated/seated_seqs.npz. GRAB and ARCTIC are non-commercial research data, accepted for research
(plan §1: reopen first if this ever becomes product), so the prior stays in the data root, never in git.

The limits are people's own: each person is held out of their own dataset's mixture and range (the other dataset's,
which never saw them, as it is), and each of their trials scored, its median nll and the share of its frames in range.
Across every trial of both datasets: the 95th percentile of the medians, and the median of the shares (your decision:
a take must be as in range as a typical person's trial).

    python -m moonshot.validate.people_prior     # -> <data root>/arm-prior/people_prior.npz
"""
from __future__ import annotations

import numpy as np

from moonshot.config import data_root
from moonshot.validate import standing_prior as SP

SEATED_SEQS = data_root() / "datasets" / "seated" / "seated_seqs.npz"
OUT = data_root() / "arm-prior" / "people_prior.npz"
K = 8


def seated() -> list[tuple[str, np.ndarray]]:
    """(subject, the sequence's kept frames' angles) per sequence of the seated data."""
    d = np.load(SEATED_SEQS)
    out, at = [], 0
    for subject, n in zip(d["subject"], d["lens"]):
        A, m = d["angles"][at:at + n], d["mask"][at:at + n]
        at += n
        if m.any():
            out.append((str(subject), A[m]))
    return out


def standing() -> list[tuple[str, np.ndarray]]:
    """(person, the trial's standing frames' angles) per AnDy trial."""
    return [(f"andy-{p}", A[s]) for p, _, A, s in SP.trials() if s.any()]


def fit(X: np.ndarray):
    from sklearn.mixture import GaussianMixture
    return GaussianMixture(K, covariance_type="full", random_state=0).fit(X[:, 3:])


def nll(mixtures, x: np.ndarray) -> np.ndarray:
    """Per frame, under an even mixture of the given ones, as validate/posture.py Prior.nll: without (7/2) log 2 pi."""
    ll = np.stack([g.score_samples(x[:, 3:]) for g in mixtures])
    return -(np.logaddexp.reduce(ll, axis=0) - np.log(len(mixtures))) - 3.5 * np.log(2 * np.pi)


def main() -> None:
    data = {"seated": seated(), "standing": standing()}
    X = {k: np.concatenate([A for _, A in v]) for k, v in data.items()}
    full = {k: fit(x) for k, x in X.items()}
    rng = {k: np.percentile(x, [1, 99], axis=0) for k, x in X.items()}
    medians, inside = [], []
    for k, seqs in data.items():
        other = "standing" if k == "seated" else "seated"
        for person in sorted({p for p, _ in seqs}):
            rest = np.concatenate([A for p, A in seqs if p != person])
            held, (lo, hi) = fit(rest), np.percentile(rest, [1, 99], axis=0)
            lo, hi = np.minimum(lo, rng[other][0]), np.maximum(hi, rng[other][1])
            for p, A in seqs:
                if p == person:
                    medians.append(float(np.median(nll([held, full[other]], A))))
                    inside.append(float(1 - ((A < lo) | (A > hi)).any(1).mean()))
    lo, hi = np.minimum(rng["seated"][0], rng["standing"][0]), np.maximum(rng["seated"][1], rng["standing"][1])
    g = [full["seated"], full["standing"]]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    np.savez(OUT, names=np.array(SP.NAMES), weights=np.concatenate([m.weights_ / 2 for m in g]),
             means=np.concatenate([m.means_ for m in g]), covs=np.concatenate([m.covariances_ for m in g]),
             pct=np.stack([lo, hi], 1), vpct=np.zeros((len(SP.NAMES), 3)), n_frames=sum(len(x) for x in X.values()),
             n_seqs=sum(len(v) for v in data.values()), nll_median_p95=np.percentile(medians, 95),
             inside_frac_median=np.median(inside), source="GRAB s1 and ARCTIC (seated), AnDy (standing), evenly")
    print(f"{sum(len(v) for v in data.values())} trials ({len(data['seated'])} seated, {len(data['standing'])} "
          f"standing), {sum(len(x) for x in X.values())} frames -> {OUT}")
    print(f"people held out: trial median nll 95th percentile {np.percentile(medians, 95):.2f}; frames in range "
          f"median {np.median(inside):.3f}, 5th percentile {np.percentile(inside, 5):.3f}")
    for j, n in enumerate(SP.NAMES):
        print(f"{n:11s} {lo[j]:7.1f} {hi[j]:7.1f}")


if __name__ == "__main__":
    main()
