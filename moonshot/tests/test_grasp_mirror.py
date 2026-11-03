"""A left hand's grip problem is the right hand's in the mirrored world (moonshot/motion/grasp.py, mirrored): its
colliders and targets see the world reflected through the body's mid-plane."""
import numpy as np
import torch

from moonshot.motion import grasp as G
from moonshot.motion import kinematics as BM

LUMBAR = np.array([-415.0, -935.0, 955.0])
CENTRE = np.array([-200.0, -600.0, 900.0])


def test_a_mirrored_problem_sees_the_world_reflected():
    box = lambda p: G.sdf_box(p, CENTRE, np.eye(3), np.array([20.0, 30.0, 10.0]))   # noqa: E731
    face = G.plane_target(CENTRE + [0, -30, 0], np.array([0.0, -1.0, 0.0]))
    (box_m,), tgts = G.mirrored([box], {"thumb": face}, LUMBAR)
    p = torch.as_tensor(np.random.default_rng(1).uniform(-50, 50, (20, 3)) + CENTRE)
    p_m = torch.as_tensor(BM.mirror_points(p.numpy(), LUMBAR))
    assert torch.allclose(box_m(p_m), box(p))
    assert box_m(torch.as_tensor(BM.mirror_points(CENTRE, LUMBAR))[None])[0] < 0, "the mirrored box holds its centre"
    n = torch.tensor([0.0, 1.0, 0.0], dtype=torch.float64)
    for c in p[:5]:
        c_m = torch.as_tensor(BM.mirror_points(c.numpy(), LUMBAR))
        assert torch.isclose(tgts["thumb"](c_m, n * torch.tensor([-1.0, 1.0, 1.0], dtype=torch.float64)), face(c, n))
