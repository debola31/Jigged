"""The ported motion planner regenerates trainual's accepted vise take (plan §5.4, step 1).

Two parts, because they reproduce differently. The trajectory solver is deterministic: from trainual's grips it gives
the same take, events, wrist path, hand and fingers. Grip synthesis is a multi-start search over a non-convex cost,
whose result depends on the floating-point environment: trainual's environment is gone, and re-solved in today's the
slide grip settles 5% higher (167.4 against 159.9) while the other five match. So re-solved grips must be within 10%
of trainual's, not identical.

Physics tier: farm and hub only (`pytest moonshot -m farm`); the first run solves (minutes on an M-series Mac, about
an hour on the hub). Protected (plan §6, rule 1)."""
import json

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from moonshot.sim.reference import take_dir

pytestmark = [pytest.mark.farm, pytest.mark.data_root]

WRIST_MM = 2.0          # the wrist's path
HAND_DEG = 2.0          # the hand's orientation and finger angles
CRANK_DEG = 0.5         # the planned crank angle
GRIP_LOSS = 1.10        # a re-solved grip's cost, at most this times trainual's


def _reference():
    ref = take_dir()
    if not (ref / "reference.npz").exists():
        pytest.skip(f"no reference take at {ref}")
    return ref


@pytest.fixture(scope="module")
def takes():
    ref = _reference()
    from moonshot.motion import setup_take as ST
    out = ST.TAKES / "setup-take-seeded"
    if not (out / "reference.npz").exists():
        ST.build(verbose=False, out=out, grips_from=ref / "grips.json")
    load = lambda d: (np.load(d / "reference.npz"), json.loads((d / "take.json").read_text(encoding="utf-8")))  # noqa: E731
    return load(ref), load(out)


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


def test_resolved_grips_are_as_good_as_trainuals():
    ref = _reference()
    from moonshot.motion import setup_take as ST
    take = ST.Take(verbose=False)                   # solves its grips into the default take folder, or reuses them
    trainual = json.loads((ref / "grips.json").read_text(encoding="utf-8"))
    for name, g in take.grips.items():
        assert g["loss"] <= GRIP_LOSS * trainual[name]["loss"], (name, g["loss"], trainual[name]["loss"])
