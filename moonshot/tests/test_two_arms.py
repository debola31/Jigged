"""The body solver plans both arms on one trunk (moonshot/motion/solver.py): given mirror-image targets, it finds a
mirror-image body, the trunk upright and both wrists on their targets; given only the right arm, it is unchanged.
Needs the posture prior from the data root."""
import numpy as np
import pytest

from moonshot.motion import kinematics as BM
from moonshot.motion import solver as BS

pytestmark = pytest.mark.data_root
LUMBAR = np.array([-415.0, -935.0, 955.0])
N = 12


def _targets():
    return [np.array([-200.0, -600.0, 1000.0]) + np.array([0, 10.0 * k, 3.0 * k]) for k in range(N)]


def test_mirror_image_targets_give_a_mirror_image_body():
    if not (BS.data_root() / "arm-prior" / "arm_prior.npz").exists():
        pytest.skip("no posture prior in the data root")
    s = BS.BodySolver(N, 30, LUMBAR, arms=("R", "L"))
    for k, t in enumerate(_targets()):
        s.pos(k, t, 1.0)
        s.pos(k, t, 1.0, side="L")          # the left target mirror(t), given in the mirrored world: t itself
    th, _, frames, _ = s.solve(np.array([8, 0, 0, 40, 40, 0, 60, 20, 0, 0]), iters=300)
    assert th.shape == (N, 21)
    assert np.abs(th[:, 1:3]).max() < 0.5, "an upright, untwisted trunk"
    assert np.abs(th[:, 3:12] - th[:, 12:21]).max() < 1.0, "the arms mirror each other"
    for fr, fl, t in zip(frames, s.left_frames, _targets()):
        assert np.linalg.norm(fr["W"] - t) < 2.0
        assert np.linalg.norm(BM.mirror_points(fl["W"], LUMBAR) - BM.mirror_points(t, LUMBAR)) < 2.0
