"""A take that continues another on the same camera across a cut starts exactly on that take's last camera pose and
eases into its own (moonshot/motion/bench.py continue_camera)."""
import numpy as np

from moonshot.motion.bench import CAMERA_EASE_S, continue_camera
from moonshot.motion.primitives import FPS


def own(n=90):
    t = np.arange(n)[:, None]
    eye = np.hstack([100.0 + t, np.zeros((n, 1)), np.full((n, 1), 1500.0)])
    look = eye + [0.0, 500.0, -200.0]
    up = np.tile([0.0, 0.0, 1.0], (n, 1))
    return eye, look, up


def test_it_starts_on_the_last_pose_and_ends_on_its_own():
    eye, look, up = own()
    prev = (np.array([0.0, -40.0, 1450.0]), np.array([10.0, 400.0, 1300.0]), np.array([0.0, 0.6, 0.8]))
    e, l, u = continue_camera(eye, look, up, prev)
    assert np.allclose(e[0], prev[0]) and np.allclose(l[0], prev[1]) and np.allclose(u[0], prev[2])
    k = int(np.ceil(CAMERA_EASE_S * FPS))
    assert np.allclose(e[k:], eye[k:]) and np.allclose(l[k:], look[k:]) and np.allclose(u[k:], up[k:])
    assert np.allclose(np.linalg.norm(u, axis=1), 1.0)


def test_it_eases_with_no_jump():
    eye, look, up = own()
    prev = (eye[0] + [0.0, -60.0, -80.0], look[0] + [0.0, 0.0, -300.0], np.array([0.0, 0.0, 1.0]))
    e, l, _ = continue_camera(eye, look, up, prev)
    step = np.linalg.norm(np.diff(l, axis=0), axis=1)
    assert step.max() < 3 * np.linalg.norm(look[0] - prev[1]) / (CAMERA_EASE_S * FPS)    # spread over the ease


def test_its_inputs_are_left_as_they_were():
    eye, look, up = own()
    keep = eye.copy()
    continue_camera(eye, look, up, (eye[0] + 50.0, look[0], up[0]))
    assert np.array_equal(eye, keep)
