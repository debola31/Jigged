"""Posture like people's: a run's trunk-to-wrist angles against people's (plan §5.2). Ported from trainual's
sim/validate.py §2b, reproducing its numbers on its reference take from its own prior (test_posture_port.py).

A prior is each joint's 1st to 99th percentile and a Gaussian mixture over the seven arm angles. The checks hold a
take to people manipulating objects seated or standing (your decision, 2026-11-03; PEOPLE,
moonshot/validate/people_prior.py): trainual's seated tabletop manipulation, GRAB and ARCTIC (SEATED), and AnDy's
people standing at industry-like work (STANDING, moonshot/validate/standing_prior.py), evenly. Against standing work
alone a machinist's holding a part up to look at it, palm-down grasps and cranking had no people to match. All live in
the data root (arm-prior/), never in git: the seated data is non-commercial research data.

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
PEOPLE = data_root() / "arm-prior" / "people_prior.npz"
PRIOR = PEOPLE                                      # what the checks hold a take to
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
    """What the posture checks read, from one arm's trunk-to-wrist angles (sim.npz theta[:, :10])."""
    prior = prior or Prior.load()
    return {"posture_outside": prior.outside(theta), "posture_nll": prior.nll(theta).tolist()}


def left_arm(sim) -> np.ndarray | None:
    """A two-handed run's left arm as people's right (the trunk mirrored, as the planner plans it: motion/kinematics.py
    mirror_trunk), from either record: a step take's sim.npz theta_L (its 9 arm angles), or a bench take's theta
    columns 12-20; None for a one-handed run."""
    from moonshot.motion.kinematics import mirror_trunk
    th = sim["theta"]
    if "theta_L" in sim:
        arm = sim["theta_L"][:, :7]
    elif th.shape[1] >= 19:
        arm = th[:, 12:19]
    else:
        return None
    return np.concatenate([mirror_trunk(th[:, :3]), arm], 1)


def measure_arms(sim, prior: Prior | None = None) -> dict:
    """Both arms of a run, the left's under keys ending _L. People's limits are one arm's, so each arm is held to
    them (your decision, 2026-11-03: in two-handed takes the left arm had gone unchecked)."""
    prior = prior or Prior.load()
    out = measure(sim["theta"][:, :10], prior)
    left = left_arm(sim)
    if left is not None:
        out |= {f"{k}_L": v for k, v in measure(left, prior).items()}
    return out


@check("posture_like_people",
       good=["good/posture_like_people_within.json"],
       bad=["bad/posture_like_people_reference.json", "bad/posture_like_people_left_arm.json"])
def posture_like_people(take: dict) -> Result:
    """take: {"posture_outside": per-frame joints outside people's 1st-99th percentile} and, for a two-handed take,
    "posture_outside_L", the left arm's. Each arm has enough frames with every trunk-to-wrist angle inside it
    (body.posture_frames_in_range_frac)."""
    arms = {"R": take["posture_outside"]} | ({"L": take["posture_outside_L"]} if "posture_outside_L" in take else {})
    if not arms["R"]:
        raise ValueError("a take with no frames can't pass a per-frame check")
    detail = {}
    for arm, frames in arms.items():
        per_joint: dict[str, int] = {}
        for f in frames:
            for j in f:
                per_joint[j] = per_joint.get(j, 0) + 1
        detail[arm] = {"frames_inside_frac": round(sum(1 for f in frames if not f) / len(frames), 4),
                       "frames_outside_by_joint": per_joint}
    inside = min(d["frames_inside_frac"] for d in detail.values())
    return Result(passed=inside >= threshold("body.posture_frames_in_range_frac").value, worst=1.0 - inside,
                  detail=detail["R"] if len(detail) == 1 else detail)


@check("posture_likelihood",
       good=["good/posture_likelihood_person.json"],
       bad=["bad/posture_likelihood_rotated.json", "bad/posture_likelihood_left_arm.json"])
def posture_likelihood(take: dict) -> Result:
    """take: {"posture_nll": per-frame negative log-likelihood under people's posture mixture} and, for a two-handed
    take, "posture_nll_L", the left arm's. Each arm's median is no more unlikely than people's own 95th percentile
    (body.posture_nll_median_max)."""
    arms = {"R": take["posture_nll"]} | ({"L": take["posture_nll_L"]} if "posture_nll_L" in take else {})
    if not len(arms["R"]):
        raise ValueError("a take with no frames can't pass a per-frame check")
    detail = {arm: {"median": round(float(np.median(v)), 2), "max": round(float(np.max(v)), 2)}
              for arm, v in arms.items()}
    worst = max(d["median"] for d in detail.values())
    return Result(passed=worst <= threshold("body.posture_nll_median_max").value, worst=worst,
                  detail=detail["R"] if len(detail) == 1 else detail)


def main(argv: list[str]) -> int:
    theta = np.load(Path(argv[0]) / "sim.npz")["theta"][:, :10]
    out = measure(theta)
    for c in (posture_like_people, posture_likelihood):
        print(c.__name__, c(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
