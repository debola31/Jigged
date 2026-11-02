"""The ported motion planner regenerates trainual's accepted vise take (plan §5.4, step 1): the same grips, the same
body trajectory and the same events, within what the optimiser's floating-point path allows across machines.
Physics tier: farm and hub only (`pytest moonshot -m farm`); the first run solves the take (minutes).
Protected (plan §6, rule 1)."""
import json

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from moonshot.sim.reference import take_dir

pytestmark = [pytest.mark.farm, pytest.mark.data_root]

WRIST_MM = 2.0          # the wrist's path
HAND_DEG = 2.0          # the hand's orientation
CRANK_DEG = 0.5         # the planned crank angle


@pytest.fixture(scope="module")
def takes():
    ref = take_dir()
    if not (ref / "reference.npz").exists():
        pytest.skip(f"no reference take at {ref}")
    from moonshot.motion import setup_take as ST
    if not (ST.OUT / "reference.npz").exists():
        ST.build(verbose=False)
    load = lambda d: (np.load(d / "reference.npz"), json.loads((d / "take.json").read_text(encoding="utf-8")))  # noqa: E731
    return load(ref), load(ST.OUT)


def test_same_events_at_the_same_times(takes):
    (_, a), (_, b) = takes
    assert [e["kind"] for e in a["events"]] == [e["kind"] for e in b["events"]]
    for ea, eb in zip(a["events"], b["events"]):
        for k in ("t0", "t1"):
            assert (ea[k] is None) == (eb[k] is None) and (ea[k] is None or abs(ea[k] - eb[k]) < 1e-6), (ea, eb)
    assert a["T"] == pytest.approx(b["T"], abs=1e-6)


def test_same_wrist_path_and_hand_orientation(takes):
    (a, _), (b, _) = takes
    assert a["W"].shape == b["W"].shape
    assert np.linalg.norm(a["W"] - b["W"], axis=1).max() < WRIST_MM
    rel = Rotation.from_matrix(np.einsum("nji,njk->nik", a["H"], b["H"]))
    assert np.degrees(rel.magnitude()).max() < HAND_DEG


def test_same_crank_blank_and_fingers(takes):
    (a, _), (b, _) = takes
    assert np.abs(a["crank"] - b["crank"]).max() < CRANK_DEG
    assert np.linalg.norm(a["blank"] - b["blank"], axis=1).max() < WRIST_MM
    assert np.abs(a["q"] - b["q"]).max() < HAND_DEG
