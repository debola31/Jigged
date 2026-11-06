"""The take record (moonshot/contracts/take_record.py) a physics run writes for the renderer
(moonshot/sim/record.py): the format checks itself, and a station's GLBs land where its bodies are."""
import json

import mujoco
import numpy as np

from moonshot.contracts.take_record import check
from moonshot.sim.record import Recorder, glbs_in_bodies
from moonshot.world import vf2

OFFSET_MM = -381.0


def _cell():
    body, acts = vf2.worldbody()
    xml = vf2.standalone_xml().replace(body, f'    <body name="vf2" pos="{OFFSET_MM / 1000} 0 0">\n{body}    </body>\n')
    return mujoco.MjModel.from_xml_string(xml)


def _hand(J=3):
    return {"q": np.zeros(J), "W": np.zeros(3), "S": np.zeros(3), "E": np.zeros(3), "H": np.eye(3),
            "forearm": np.eye(3)}


def _record(tmp_path, arms=("R", "L")):
    m = _cell()
    d = mujoco.MjData(m)
    rec = Recorder(m, set(), arms)
    for k in range(4):
        d.qpos[m.jnt_qposadr[m.joint("vf2_x").id]] = 0.1 * k
        mujoco.mj_kinematics(m, d)
        rec.frame(d, {s: _hand() for s in arms}, [0, -900, 1600], [0, 0, 900], [0, 0, 1])
    rec.write(tmp_path, 24, -415.0, {s: ["a", "b", "c"] for s in arms}, "vf2",
              glbs_in_bodies(m, "vf2", vf2.render_links()))
    return m


def test_a_recorded_take_passes_its_own_check(tmp_path):
    _record(tmp_path)
    assert check(tmp_path) == []


def test_a_take_missing_an_arm_fails(tmp_path):
    _record(tmp_path)
    d = dict(np.load(tmp_path / "take.npz"))
    del d["L_H"]
    np.savez(tmp_path / "take.npz", **d)
    assert any("L_H" in e for e in check(tmp_path))


def test_each_glb_follows_its_body(tmp_path):
    """A GLB is authored in the station's frame at joint zero: drawn at its body's pose, the table's moves with X
    and the base's stays put."""
    _record(tmp_path)
    d = np.load(tmp_path / "take.npz")
    scene = json.loads((tmp_path / "scene.json").read_text(encoding="utf-8"))
    names = [str(b) for b in d["bodies"]]

    def origin(body, link, k):
        g = next(g for g in scene["bodies"][body]["glbs"] if g["link"] == link)
        p_in = np.array(g["in_body"][:3])
        i = names.index(body)
        out = np.zeros(3)
        mujoco.mju_rotVecQuat(out, p_in, d["quat"][k, i])
        return d["pos"][k, i] + out

    for k in range(4):
        assert np.allclose(origin("vf2", "base", k), [OFFSET_MM, 0, 0], atol=1e-6)
        assert np.allclose(origin("vf2_table", "table", k), [OFFSET_MM + 100 * k, 0, 0], atol=1e-6)
        assert np.allclose(origin("vf2_head", "coolant", k), [OFFSET_MM, 0, 0], atol=1e-6)
    assert scene["bodies"]["vf2_spindle"]["glbs"][0]["path"] == "library/machines/vf2/links/spindle.glb"
