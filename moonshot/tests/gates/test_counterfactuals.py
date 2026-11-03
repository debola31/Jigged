"""Break it on purpose (plan §5.4, step 2): the vise take's outcomes happen for their physical reasons, so taking the
reason away takes the outcome with it. Each test alters the model or the plan, here in the test, and runs the
unchanged physics (moonshot/sim/vise_take.py, moonshot/world/vf2.py).

- Half the skin's friction: the grip people use is 1.7-2.2 x the slip force, so halving friction leaves it short,
  and the blank leaves the hand.
- No crank: the hand goes through every motion, but the knob and lever no longer touch it and the plan's knob
  enclosure is gone, so nothing turns the screw: the jaw stays where it started and clamps nothing.
- An open door: Cycle Start is refused and nothing moves, in the cell the take runs in.

The take tests are physics tier (farm and hub only), on the take the planner writes to the data root.
Protected (plan §6, rule 1)."""
import json
import shutil

import mujoco
import numpy as np
import pytest

from moonshot.body.skeleton import build
from moonshot.config import data_root
from moonshot.contracts.thresholds import threshold
from moonshot.world import cell
from moonshot.world import vise as V

TAKE = data_root() / "takes" / "setup-take"


def take_or_skip():
    if not (TAKE / "reference.npz").exists():
        pytest.skip(f"no planned take at {TAKE}")
    from moonshot.sim.vise_take import ViseTake
    return ViseTake


@pytest.mark.farm
@pytest.mark.data_root
def test_half_the_friction_drops_the_blank():
    ViseTake = take_or_skip()
    vt = ViseTake(TAKE)
    m = vt.model
    skin = [g for g in range(m.ngeom) if m.geom(g).name.startswith("R_g_")]
    m.geom_friction[skin] *= 0.5
    vt.run(seconds=vt.t_down, log=lambda *a: None)
    t = vt.t[:len(vt.rec["blank"])]
    carried = (t > vt.t_lift + 0.5) & (t < vt.t_down - 0.3)
    fell = vt.rd["blank"][:len(t), 2][carried] - np.array(vt.rec["blank"])[carried, 2]
    assert fell.max() > 20.0, f"with half the friction the blank stayed within {fell.max():.1f} mm of its carry"


@pytest.mark.farm
@pytest.mark.data_root
def test_without_the_crank_the_vise_stays_open(tmp_path):
    ViseTake = take_or_skip()
    for f in ("take.json", "reference.npz"):
        shutil.copy(TAKE / f, tmp_path / f)
    tk = json.loads((tmp_path / "take.json").read_text(encoding="utf-8"))
    tk["events"] = [e for e in tk["events"] if e["kind"] != "enclose"]
    (tmp_path / "take.json").write_text(json.dumps(tk), encoding="utf-8")
    vt = ViseTake(tmp_path)
    m = vt.model
    for g in ("knob", "lever"):
        m.geom_contype[m.geom(g).id] = m.geom_conaffinity[m.geom(g).id] = 0
    rep = vt.run(log=lambda *a: None)
    rot = rep["rotate"]
    assert abs(rot["opening_final_mm"] - vt.load.opening0) < threshold("physics.mechanism_ratio_mm").value, rot
    assert abs(rot["turns"]) < 0.01, rot
    assert rot["clamp_N_final"] < 1.0, rot


def test_an_open_door_refuses_the_cycle():
    """In the cell, with the doors as an operator leaves them to load: Cycle Start is refused, and with the body held
    and the machine's control applied for half a second, no axis moves and the spindle stays still. Closed, the same
    program runs."""
    load = V.REFERENCE
    body = build()
    m = mujoco.MjModel.from_xml_string(cell.with_body(body.xml, load.stage, load.parallels(), "R_hand", load))
    d = mujoco.MjData(m)
    machine = cell.start(m, d)
    machine.program = [(500.0, 100.0, -100.0, 5000.0)]
    axes = {a: m.jnt_qposadr[m.joint(f"vf2_{a}").id] for a in "xyz"}
    spindle = m.jnt_dofadr[m.joint("vf2_spindle").id]
    before = {a: d.qpos[q] for a, q in axes.items()}
    machine.press("cycle_start")
    assert machine.state == "idle" and machine.events[-1] == "cycle_start_refused"
    for _ in range(500):
        machine.step()
    assert all(abs(d.qpos[q] - before[a]) * 1000 < 0.1 for a, q in axes.items()), "an axis moved with a door open"
    assert abs(d.qvel[spindle]) < 1.0
    for door in ("vf2_door_left", "vf2_door_right"):
        d.qpos[m.jnt_qposadr[m.joint(door).id]] = 0.0
    machine.press("cycle_start")
    assert machine.state == "running"
    for _ in range(500):
        machine.step()
    assert d.qpos[axes["x"]] * 1000 > before["x"] * 1000 + 50, "with the doors closed the program runs"
