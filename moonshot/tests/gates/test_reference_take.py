"""The new core reproduces trainual's accepted vise take (plan §5.4, step 1). Physics tier: farm and hub only.

First stage: the body alone, in free space, follows the take's whole planned motion (31.8 s, trunk, right arm and
hand) within the tracking-lag threshold, with no motor past its strength. The vise, blank and parallels, and the
per-verb outcomes (lift by friction, placement, slide, crank turns, clamp), are the next stage.
"""
import mujoco
import numpy as np
import pytest

from moonshot.body.controller import Controller
from moonshot.body.skeleton import build
from moonshot.contracts.thresholds import threshold
from moonshot.sim.reference import take_dir

pytestmark = [pytest.mark.farm, pytest.mark.data_root]


@pytest.fixture(scope="module")
def replay():
    if not (take_dir() / "reference.npz").exists():
        pytest.skip(f"no reference take at {take_dir()}")
    from moonshot.sim.reference import ReferenceTake
    body = build()
    m = mujoco.MjModel.from_xml_string(body.xml)
    d = mujoco.MjData(m)
    take = ReferenceTake(body, m)
    q, v, _ = take.at(0.0)
    d.qpos[:], d.qvel[:] = q, v
    mujoco.mj_forward(m, d)
    ctl = Controller(body, m, d)
    lag, saturated = [], 0
    limit = np.abs(m.actuator_forcerange[ctl.acts]).max(1)
    for s in range(int(take.duration / m.opt.timestep)):
        ctl.track(*take.at(s * m.opt.timestep))
        saturated += int((np.abs(d.actuator_force[ctl.acts]) >= 0.999 * limit).any())
        if s % 10 == 0:
            lag.append(np.linalg.norm(d.body("R_hand").xpos - ctl.planned_body_pos("R_hand")) * 1000)
    return np.array(lag), saturated


def test_the_body_follows_the_whole_take(replay):
    lag, _ = replay
    assert lag.max() < threshold("physics.tracking_lag_mm").value, f"wrist lagged up to {lag.max():.1f} mm"


def test_no_motor_needs_more_than_its_strength(replay):
    _, saturated = replay
    assert saturated == 0, f"a motor was at full strength on {saturated} steps"
