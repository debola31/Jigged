"""The skin check measures depth into a convex mesh collider by its hull's face planes (moonshot/sim/record.py
hull_planes, moonshot/validate/skin.py _sdf): inside it, as deep as into the same shape as a box."""
import mujoco
import numpy as np

from moonshot.sim.record import hull_planes
from moonshot.validate.skin import _radius, _sdf


def test_a_cube_as_a_mesh_measures_as_the_box():
    half = np.array([10.0, 6.0, 3.0])
    corners = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]) * half * 0.001
    xml = f"""<mujoco><asset><mesh name="m" vertex="{' '.join(f'{v:.6f}' for v in corners.ravel())}"/></asset>
      <worldbody><body><geom name="g" type="mesh" mesh="m"/></body></worldbody></mujoco>"""
    m = mujoco.MjModel.from_xml_string(xml)
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    g = {"name": "g", "type": "mesh", "size": [0, 0, 0]} | hull_planes(m, 0)
    box = {"name": "b", "type": "box", "size": half.tolist()}
    rng = np.random.default_rng(0)
    p = rng.uniform(-1, 1, (500, 3)) * half                                 # points inside it, the body's frame
    in_geom = (p - d.geom_xpos[0] * 1000) @ d.geom_xmat[0].reshape(3, 3)    # MuJoCo turns a mesh to its principal axes
    assert np.allclose(_sdf(in_geom, g), _sdf(p, box), atol=1e-3)
    assert (_sdf(in_geom, g) <= 0).all()
    assert _radius(g) == np.float64(round(float(np.linalg.norm(half)), 3))
