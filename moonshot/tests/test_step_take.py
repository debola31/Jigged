"""A two-handed step's plan (moonshot/motion/step_take.py) and its physics (moonshot/sim/runner.py) agree on where the
left hand is: the plan's left frames are the solver's, and the body in MuJoCo, tracking the plan, puts its left hand
where the plan does once both are seen in the mirrored world. Needs the hand model and posture prior."""
import numpy as np
import pytest

from moonshot.config import data_root

pytestmark = pytest.mark.data_root
LUMBAR = np.array([-381.0, -1230.0, 955.0])


@pytest.fixture(scope="module")
def take(tmp_path_factory):
    if not (data_root() / "arm-prior" / "arm_prior.npz").exists():
        pytest.skip("no posture prior in the data root")
    from moonshot.motion.step_take import StepTake
    t = StepTake(tmp_path_factory.mktemp("step"), LUMBAR, verbose=False)
    t.transit("R", 0.1, 0.8, LUMBAR + np.array([250.0, 380.0, 150.0]))
    t.transit("L", 0.1, 0.8, LUMBAR + np.array([-250.0, 380.0, 150.0]))
    t.look(0.0, LUMBAR + np.array([0.0, 400.0, 100.0]))
    t.t = 1.0
    t.solve(iters=300)
    t.save()
    return t


def test_the_plans_left_frames_are_the_solvers(take):
    for k in range(take.n):
        assert np.linalg.norm(take.frames_at(k)["L"]["W"] - take.left_frames[k]["W"]) < 1e-6


def test_the_hands_reach_their_world_targets(take):
    from moonshot.motion import kinematics as BM
    k = int(0.9 * 30)
    assert np.linalg.norm(take.frames_at(k)["R"]["W"] - (LUMBAR + [250.0, 380.0, 150.0])) < 15
    left_world = BM.mirror_points(take.frames_at(k)["L"]["W"], LUMBAR)
    assert np.linalg.norm(left_world - (LUMBAR + [-250.0, 380.0, 150.0])) < 15


def test_the_body_tracks_both_hands_of_the_plan(take):
    from moonshot.sim.runner import TakeRunner
    r = TakeRunner(take.out)
    n = r.run(log=None)
    rd = np.load(take.out / "reference.npz")
    last = r.hands()
    for s in ("R", "L"):
        assert np.linalg.norm(last[s]["W"] - rd[f"{s}_W"][n - 1]) < 20, s
        assert np.abs(last[s]["H"] - rd[f"{s}_H"][n - 1]).max() < 0.15, s
