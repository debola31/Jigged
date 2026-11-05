"""The per-frame checks read any take from its take record (moonshot/contracts/take_record.py), not from one runner's
own files: both wrists, the left as the right of the mirrored world, and the skin of both hands against every object
in the scene (docs/moonshot/physics.md). Built here as small records with a block the hand sinks into by a known
depth. A folder with no record can't be checked. Needs NIMBLE from the data root. Protected (plan §6, rule 1)."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.config import data_root

pytestmark = pytest.mark.data_root
MIRROR_X = -415.0
SINK_MM = 8.0
W_R = np.array([-200.0, -600.0, 1000.0])


def Ry(a):
    c, s = math.cos(math.radians(a)), math.sin(math.radians(a))
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def Rx(a):
    c, s = math.cos(math.radians(a)), math.sin(math.radians(a))
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


H0 = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])


@pytest.fixture(scope="module")
def hand():
    if not (data_root() / "hand-model" / "nimble").exists():
        pytest.skip("no NIMBLE hand in the data root")
    from moonshot.body.hand import AnatomicalHand
    from moonshot.body.nimble import Nimble
    return AnatomicalHand(Nimble(data_root() / "hand-model" / "nimble"))


def _skin(hand, q, H, W):
    """The right hand's skin as the check poses it (moonshot/validate/skin.py), world mm."""
    skin = hand.forward(hand.clamp(dict(zip(hand.names, q))), collision=True, smooth=True)["skin"]
    return (skin @ (H @ hand.wrist_frame().T).T + W)[np.unique(hand.model.skin_f)]


def _record(folder, hand, blocks, frames):
    """A take record of one block body per entry in blocks ({name: (centre mm, half mm)}), and per frame both hands:
    frames is [{side: (wrist flexion, deviation, W)}], the forearm level and the left given in the mirrored world."""
    from moonshot.sim.record import Recorder
    geoms = "".join(f'<body name="{n}" pos="{" ".join(str(v / 1000) for v in c)}"><geom type="box" '
                    f'size="{" ".join(str(v / 1000) for v in h)}"/></body>' for n, (c, h) in blocks.items())
    m = mujoco.MjModel.from_xml_string(f"<mujoco><worldbody>{geoms}</worldbody></mujoco>")
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    q = hand.vector(hand.neutral())
    rec = Recorder(m, set(), ("R", "L"))
    for fr in frames:
        arms = {s: {"q": q, "W": W, "S": W + [0, 0, 500], "E": W + [0, 0, 260], "H": Ry(fl) @ Rx(dv) @ H0,
                    "forearm": H0} for s, (fl, dv, W) in fr.items()}
        rec.frame(d, arms, [0, -900, 1600], [0, 0, 900], [0, 0, 1])
    rec.write(folder, 30, MIRROR_X, {s: list(hand.names) for s in ("R", "L")}, "test")


def _block_under(hand, H, W, sink):
    """A block whose top is `sink` mm above the skin's lowest point, wide enough that the top is the nearest face."""
    p = _skin(hand, hand.vector(hand.neutral()), H, W)
    low = p[np.argmin(p[:, 2])]
    return np.array([low[0], low[1], low[2] + sink - 50.0]), np.array([150.0, 150.0, 50.0])


def test_the_skin_of_either_hand_is_measured_against_every_object(tmp_path, hand):
    from moonshot.validate.take import inputs
    lifted = W_R + [0, 0, 300]
    under_r = _block_under(hand, H0, W_R, SINK_MM)
    # the left hand at the mirrored world's W_R is drawn at W_R reflected through x = MIRROR_X, as is its block
    c, h = _block_under(hand, H0, W_R, SINK_MM)
    p_L = np.array([2 * MIRROR_X - c[0], c[1], c[2]])
    W_far = W_R + [0, 400, 0]
    _record(tmp_path, hand, {"block_r": under_r, "block_l": (p_L + [0, 0, -400], h)},
            [{"R": (0, 0, W_R), "L": (0, 0, W_far)},
             {"R": (0, 0, lifted), "L": (0, 0, W_far)}])
    depth = inputs(tmp_path)["depth_mm"]
    assert depth[0] == pytest.approx(SINK_MM, abs=0.5)
    assert depth[1] == pytest.approx(0.0, abs=1e-6)
    _record(tmp_path, hand, {"block_r": (under_r[0] + [0, 0, -400], under_r[1]), "block_l": (p_L, h)},
            [{"R": (0, 0, lifted), "L": (0, 0, W_R)}])
    assert inputs(tmp_path)["depth_mm"][0] == pytest.approx(SINK_MM, abs=0.5), "the left hand, mirrored"


def test_both_wrists_are_held_to_the_ellipse(tmp_path, hand):
    from moonshot.validate.take import inputs, run
    far = {"block": (np.array([0.0, 2000.0, 0.0]), np.array([10.0, 10.0, 10.0]))}
    _record(tmp_path, hand, far, [{"R": (20, -5, W_R), "L": (60, 18, W_R)}])
    wrists = inputs(tmp_path)["wrist_deg"]
    assert sorted(map(tuple, np.round(wrists, 3))) == [(20, -5), (60, 18)]
    assert not run(tmp_path)["wrist_ellipse"].passed, "the left wrist is past its ellipse"
    _record(tmp_path, hand, far, [{"R": (20, -5, W_R), "L": (30, 5, W_R)}])
    assert run(tmp_path)["wrist_ellipse"].passed


def test_a_folder_without_a_take_record_cant_be_checked(tmp_path):
    from moonshot.validate.take import inputs
    with pytest.raises(FileNotFoundError):
        inputs(tmp_path)
