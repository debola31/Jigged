"""Posture like people's: a run's trunk-to-wrist angles against people's (plan §5.2). Ported from trainual's
sim/validate.py §2b, reproducing its numbers on its reference take from its own prior (test_posture_port.py).

A prior is each joint's 1st to 99th percentile and an 8-component Gaussian mixture over the seven arm angles. The
checks hold a take to people standing at industry-like manual work, as a machinist stands at the VF-2 (your decision,
2026-11-03): the AnDy dataset's standing frames (moonshot/validate/standing_prior.py, STANDING). trainual's prior is
seated tabletop manipulation, 268,845 frames of GRAB and ARCTIC (SEATED), which a standing machinist isn't: the arm
hangs lower between reaches and the trunk turns further (plan §5.5). Both live in the data root (arm-prior/), never in
git: the seated one is derived from non-commercial research data.

    python -m moonshot.validate.posture <take dir>     # frames outside, per joint, and the likelihood
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.linalg import solve_triangular
from scipy.special import logsumexp

from moonshot.config import data_root
from moonshot.contracts.thresholds import threshold
from moonshot.validate.registry import Result, check

SEATED = data_root() / "arm-prior" / "arm_prior.npz"
STANDING = data_root() / "arm-prior" / "standing_prior.npz"
PRIOR = STANDING                                    # what the checks hold a take to
ARM = slice(3, 10)          # the mixture's seven: sh_plane, sh_elev, sh_rot, elbow, pron, wr_flex, wr_dev


@dataclass(frozen=True)
class Prior:
    names: list[str]        # trunk_flex .. wr_dev, sim.npz theta[:, :10]'s order
    lo: np.ndarray          # each joint's 1st percentile, degrees
    hi: np.ndarray          # its 99th
    log_w: np.ndarray       # the mixture: (K,) log weights, (K, 7) means, (K, 7, 7) Cholesky factors, (K,) log dets
    mu: np.ndarray
    chol: np.ndarray
    logdet: np.ndarray
    n_frames: int

    @classmethod
    def load(cls, path: Path = PRIOR) -> "Prior":
        d = np.load(path)
        chol = np.linalg.cholesky(d["covs"])
        return cls([str(n) for n in d["names"]], d["pct"][:, 0], d["pct"][:, -1], np.log(d["weights"]), d["means"],
                   chol, 2 * np.log(np.diagonal(chol, axis1=1, axis2=2)).sum(1), int(d["n_frames"]))

    def outside(self, theta: np.ndarray) -> list[list[str]]:
        """Per frame, the joints outside people's 1st-99th percentile."""
        out = (theta < self.lo) | (theta > self.hi)
        return [[self.names[j] for j in np.flatnonzero(row)] for row in out]

    def nll(self, theta: np.ndarray) -> np.ndarray:
        """Per frame, the arm's negative log-likelihood under the mixture, without the constant (7/2) log 2 pi, as
        trainual's motion/body_solver.py ArmPrior defines it and the threshold is measured."""
        x = theta[:, ARM]
        m = np.stack([(solve_triangular(L, (x - mu).T, lower=True) ** 2).sum(0) for L, mu in zip(self.chol, self.mu)], 1)
        return -logsumexp(self.log_w - 0.5 * (m + self.logdet), axis=1)


def measure(theta: np.ndarray, prior: Prior | None = None) -> dict:
    """What the posture checks read, from a run's trunk-to-wrist angles (sim.npz theta[:, :10])."""
    prior = prior or Prior.load()
    return {"posture_outside": prior.outside(theta), "posture_nll": prior.nll(theta).tolist()}


@check("posture_like_people",
       good=["good/posture_like_people_within.json"],
       bad=["bad/posture_like_people_reference.json"])
def posture_like_people(take: dict) -> Result:
    """take: {"posture_outside": per-frame joints outside people's 1st-99th percentile}. Enough frames have every
    trunk-to-wrist angle inside it (body.posture_frames_in_range_frac)."""
    frames = take["posture_outside"]
    if not frames:
        raise ValueError("a take with no frames can't pass a per-frame check")
    inside = sum(1 for f in frames if not f) / len(frames)
    per_joint: dict[str, int] = {}
    for f in frames:
        for j in f:
            per_joint[j] = per_joint.get(j, 0) + 1
    return Result(passed=inside >= threshold("body.posture_frames_in_range_frac").value, worst=1.0 - inside,
                  detail={"frames_inside_frac": round(inside, 4), "frames_outside_by_joint": per_joint})


@check("posture_likelihood",
       good=["good/posture_likelihood_standing_person.json"],
       bad=["bad/posture_likelihood_rotated.json", "bad/posture_likelihood_replanned.json"])
def posture_likelihood(take: dict) -> Result:
    """take: {"posture_nll": per-frame negative log-likelihood under people's posture mixture}. The median is no
    more unlikely than people's own 95th percentile (body.posture_nll_median_max)."""
    nll = np.asarray(take["posture_nll"], float)
    if not len(nll):
        raise ValueError("a take with no frames can't pass a per-frame check")
    median = float(np.median(nll))
    return Result(passed=median <= threshold("body.posture_nll_median_max").value, worst=median,
                  detail={"median": round(median, 2), "max": round(float(nll.max()), 2)})


def main(argv: list[str]) -> int:
    theta = np.load(Path(argv[0]) / "sim.npz")["theta"][:, :10]
    out = measure(theta)
    for c in (posture_like_people, posture_likelihood):
        print(c.__name__, c(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
