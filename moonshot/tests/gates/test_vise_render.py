"""The vise take is drawn as the approved draft drew it (docs/moonshot/checklist.md, 2026-11-02): the Kurt D688 from
trainual's rig, split into the bodies MuJoCo moves (moonshot/world/vise.py render_glbs), and the part and parallels
as boxes at the load's size (render_meshes), each with the material names the look knows (moonshot/render/look.py),
and each drawn where the collider it stands for is.

GLBs are read in their raw stored coordinates, as the renderer places them: metres, and mm for the meshes. Needs the
data root. Protected (plan §6,
rule 1)."""
import json
import struct

import mujoco
import numpy as np
import pytest

from moonshot.config import data_root

pytestmark = pytest.mark.data_root
LOOK = {"kurt_blue", "ground_steel", "handle_steel", "grip_black", "hardened_steel", "aluminium_6061"}


def glb(path, mm=False):
    """(raw bounds in mm, material names) of a GLB: stored in metres, or in mm for a changing body's meshes."""
    import trimesh
    lo, hi = trimesh.load(path, force="mesh").bounds * (1 if mm else 1000)
    raw = path.read_bytes()
    n = struct.unpack("<I", raw[12:16])[0]
    return lo, hi, {m.get("name") for m in json.loads(raw[20:20 + n]).get("materials", [])}


def drawn(d, body, entry, lo, hi):
    """World bounds (mm) of a GLB's box placed by its body's pose and in_body."""
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    p, q = np.array(entry["in_body"][:3]), np.array(entry["in_body"][3:])
    R = np.zeros(9)
    mujoco.mju_quat2Mat(R, q)
    local = corners @ R.reshape(3, 3).T + p
    w = local @ d.body(body).xmat.reshape(3, 3).T + d.body(body).xpos * 1000
    return w.min(0), w.max(0)


def collider(m, d, geom):
    """World bounds (mm) of a box, cylinder or capsule geom."""
    g = m.geom(geom).id
    s = m.geom_size[g] * 1000
    half = {mujoco.mjtGeom.mjGEOM_BOX: s, mujoco.mjtGeom.mjGEOM_CYLINDER: [s[0], s[0], s[1]],
            mujoco.mjtGeom.mjGEOM_CAPSULE: [s[0], s[0], s[1] + s[0]]}[m.geom_type[g]]
    R = d.geom_xmat[g].reshape(3, 3)
    ext = np.abs(R) @ np.asarray(half)
    return d.geom_xpos[g] * 1000 - ext, d.geom_xpos[g] * 1000 + ext


@pytest.fixture(scope="module")
def cell():
    take = data_root() / "takes" / "setup-take"
    if not (take / "reference.npz").exists():
        pytest.skip(f"no planned take in {take}")
    from moonshot.sim.vise_take import ViseTake
    from moonshot.world import cell as C
    run = ViseTake(take)
    d = mujoco.MjData(run.model)
    C.start(run.model, d)
    return run.model, d


def test_the_vise_parts_are_drawn_where_their_colliders_are(cell):
    from moonshot.world import vise as V
    m, d = cell
    glbs = V.render_glbs()
    assert set(glbs) == {"vf2_table", "moving_jaw", "crank", "knob"}
    bounds = {}
    for body, entries in glbs.items():
        for e in entries:
            lo, hi, mats = glb(data_root() / e["path"])
            assert mats and mats <= LOOK, f"{e['path']}: materials {mats} the look doesn't know"
            bounds[e["link"]] = drawn(d, body, e, lo, hi)
    lo, hi = bounds["jaw"]
    c_lo, c_hi = collider(m, d, "moving_jaw")
    assert abs(hi[1] - c_hi[1]) < 1.0, "the jaw's clamping face isn't the collider's"
    assert abs(hi[2] - c_hi[2]) < 1.5 and abs((lo[0] + hi[0]) / 2 - (c_lo[0] + c_hi[0]) / 2) < 1.0
    lo, hi = bounds["base"]
    c_lo, c_hi = collider(m, d, "fixed_jaw")
    assert abs(lo[2] - V.TABLE_Z) < 1.0 and abs(hi[2] - c_hi[2]) < 1.5, "the vise doesn't sit on the table"
    assert c_lo[1] > lo[1] and c_hi[1] < hi[1] and abs((lo[0] + hi[0]) / 2 - V.VISE["x"]) < 1.0
    lo, hi = bounds["knob"]
    c_lo, c_hi = collider(m, d, "knob")
    assert np.allclose((lo + hi) / 2, (c_lo + c_hi) / 2, atol=2.0), "the knob's grip isn't on its collider"
    lo, hi = bounds["handle"]
    c_lo, c_hi = collider(m, d, "lever")
    assert np.all(lo < c_lo + 10) and np.all(hi > c_hi - 10), "the handle doesn't reach along the lever"


def test_the_part_and_parallels_are_boxes_at_the_loads_size(tmp_path):
    from moonshot.world import vise as V
    load = V.Load(size_mm=(158.0, 75.0, 31.0), parallel_h=19.05)
    meshes = V.render_meshes(load, tmp_path)
    assert set(meshes) == {"blank", "para_a", "para_b"}
    want = {"blank": (load.size, "aluminium_6061"),
            "para_a": ([V.PARALLEL_L, V.PARALLEL_T, load.parallel_h], "hardened_steel")}
    want["para_b"] = want["para_a"]
    for body, entry in meshes.items():
        assert entry["frames"] == [0]
        lo, hi, mats = glb(tmp_path / entry["dir"] / "0.glb", mm=True)
        size, mat = want[body]
        assert np.allclose(hi - lo, size, atol=0.01) and np.allclose((lo + hi) / 2, 0, atol=0.01), body
        assert mats == {mat}, body
