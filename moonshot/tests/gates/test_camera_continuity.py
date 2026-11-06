"""A take split from another across a cut on the same camera, which a step plays straight after it, starts exactly on
that take's last camera pose: the cut shows no jump (moonshot/motion/bench.py continue_camera). A take says which
it continues in its take.json ("continues"); a deliberate cut, from one place to another (the saw's load to its
handwheel), says none. Physics tier, on the take records in the data root. Protected (plan §6, rule 1).
"""
import json

import numpy as np
import pytest

from moonshot.config import data_root

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
EYE_MM = 0.5            # the join's eye and look this close, in mm
UP_COS = 0.99999        # and its up this close


def continuing():
    takes = data_root() / "takes"
    out = []
    for f in sorted(takes.glob("*/take.json")):
        tk = json.loads(f.read_text(encoding="utf-8"))
        if tk.get("continues") and (f.parent / "take.npz").exists():
            out.append((f.parent, takes / tk["continues"]))
    return out


@pytest.mark.parametrize("take,after", continuing() or [pytest.param(None, None, marks=pytest.mark.skip("none"))],
                         ids=lambda p: p.name if p is not None else "none")
def test_a_continuing_take_starts_on_the_last_camera_pose(take, after):
    assert (after / "take.npz").exists(), f"{take.name} continues {after.name}, which has no record"
    a, b = np.load(after / "take.npz"), np.load(take / "take.npz")
    assert np.linalg.norm(b["eye"][0] - a["eye"][-1]) <= EYE_MM
    assert np.linalg.norm(b["look"][0] - a["look"][-1]) <= EYE_MM
    assert float(np.dot(b["up"][0], a["up"][-1])) >= UP_COS
