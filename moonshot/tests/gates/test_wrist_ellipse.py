"""The body model's wrist stops at its flexion-deviation ellipse, not at a box (plan §3.1; docs/moonshot/physics.md).

Each wrist angle has its own range, but together they are limited by an ellipse (Gracia-Ibanez 2020): a wrist can't
flex far while deviating far. Limited only by its ranges, the reference take bent the wrist to 1.12 on the ellipse.
Driven at full strength in every direction, the wrist stops on the ellipse, within the joint-range tolerance.
Protected (plan §6, rule 1)."""
import json
import math

import mujoco
import pytest

from moonshot.body.controller import Controller
from moonshot.body.skeleton import DATA, build
from moonshot.contracts.thresholds import threshold

WD = json.loads((DATA / "anatomy.json").read_text(encoding="utf-8"))["wrist_deg"]


def ellipse(fl, dv, grow=0.0):
    """How far out on the ellipse a wrist is, its semi-axes grown by `grow` degrees: 1.0 is the edge."""
    f = fl / (WD["flexion"] + grow) if fl > 0 else fl / (WD["extension"] + grow)
    d = dv / (WD["radial"] + grow) if dv > 0 else dv / (WD["ulnar"] + grow)
    return math.hypot(f, d)


@pytest.fixture(scope="module")
def body():
    return build()


@pytest.mark.parametrize("side", ["R", "L"])
@pytest.mark.parametrize("deg", range(0, 360, 30))
def test_the_wrist_stops_on_its_ellipse(body, side, deg):
    m = mujoco.MjModel.from_xml_string(body.xml)
    d = mujoco.MjData(m)
    ctl = Controller(body, m, d)
    m.opt.gravity[:] = 0
    tol = threshold("body.joint_range_tolerance_deg").value
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    fl, dv = body.joints[f"{side}_wr_flex"], body.joints[f"{side}_wr_dev"]
    ctl.set({fl.name: 100 * c, dv.name: 60 * s})                   # past the box, so clamped to its corner
    for j, push in ((fl, c), (dv, s)):
        d.qfrc_applied[m.jnt_dofadr[m.joint(j.name).id]] = push * max(j.strength)
    ctl.run(0.4)
    got = [j.rest + math.degrees(d.qpos[m.jnt_qposadr[m.joint(j.name).id]]) for j in (fl, dv)]
    assert ellipse(*got, grow=tol) <= 1.0, f"{side} at {deg} deg: {got} is past the ellipse"
    assert ellipse(*got, grow=-tol) >= 1.0, f"{side} at {deg} deg: {got} stops short of the ellipse"
