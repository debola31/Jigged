"""The VF-2 cell holds together before anything is filmed in it (plan §3.2): the vise sits where the takes expect it
with the operator clear of the machine, and the vise rides the table when the machine moves. Protected (plan §6,
rule 1). The machine runs with the operator stepped back: at the loading stance the closed doors' handle bars would
stand in their chest."""
import mujoco
import numpy as np
import pytest

from moonshot.body.skeleton import build
from moonshot.world import cell
from moonshot.world import vise as V

LUMBAR_MM = (-415.0, -935.0, 955.0)          # where trainual's vise take stands the operator
RUNNING_MM = (-381.0, -1230.0, 955.0)        # where the operator stands while the machine runs: back from the doors
PARALLELS_MM = {"para_a": np.array([-381.5, -244.0, 926.2]), "para_b": np.array([-381.5, -296.0, 926.2])}  # the take's


@pytest.fixture(scope="module")
def scene():
    return _scene(LUMBAR_MM)


@pytest.fixture(scope="module")
def running():
    return _scene(RUNNING_MM)


def _scene(lumbar):
    xml = cell.with_body(build(pelvis_mm=lumbar).xml, V.STAGE, PARALLELS_MM, "R_hand")
    m = mujoco.MjModel.from_xml_string(xml)
    d = mujoco.MjData(m)
    return m, d, cell.start(m, d)


def test_the_vise_is_where_the_takes_expect_it(scene):
    m, d, _ = scene
    assert d.geom("fixed_jaw").xpos[0] * 1000 == pytest.approx(V.VISE["x"], abs=0.01)
    assert d.geom("vf2_table_top").xpos[2] * 1000 + 15 == pytest.approx(V.TABLE_Z, abs=0.01)


def test_the_operator_stands_clear_of_the_machine(scene):
    m, d, _ = scene
    mujoco.mj_forward(m, d)
    machine = {g for g in range(m.ngeom) if m.geom(g).name.startswith("vf2_")}
    body = {g for g in range(m.ngeom) if m.geom(g).name[:2] in ("L_", "R_", "g_")}
    touching = [(m.geom(a).name, m.geom(b).name) for a, b in zip(d.contact.geom1, d.contact.geom2)
                if {a, b} & machine and {a, b} & body]
    assert not touching


def test_the_vise_and_parallels_ride_the_table(running):
    m, d, ctl = running
    x0 = d.geom("fixed_jaw").xpos.copy()
    p0 = d.body("para_a").xpos.copy()
    ctl.program = [(cell.LOAD_X_MM + 100.0, 0.0, 0.0, 0.0)]
    for _ in range(50):
        mujoco.mj_step(m, d)                     # the body sags a little under gravity; the machine holds
    ctl.press("cycle_start")                    # the doors are open: refused
    assert ctl.state == "idle"
    for k in ("door_left", "door_right"):
        d.qpos[ctl.q[k]] = 0.0
    ctl.press("cycle_start")
    for _ in range(1500):
        ctl.step()
    assert ctl.state == "idle" and "program_end" in ctl.events
    assert (d.geom("fixed_jaw").xpos - x0) * 1000 == pytest.approx([100.0, 0, 0], abs=0.5)
    assert (d.body("para_a").xpos - p0) * 1000 == pytest.approx([100.0, 0, 0], abs=0.5)
