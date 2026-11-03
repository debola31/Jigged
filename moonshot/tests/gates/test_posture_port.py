"""The body-vs-people checks (moonshot/validate/posture.py) are trainual's, ported: on trainual's reference take they
give exactly what trainual's validator wrote in its report.md (§2b), from the same posture prior (plan §5.2).

Needs the data root: the prior is derived from non-commercial data and the reference take is too big for git.
Protected (plan §6, rule 1)."""
import numpy as np
import pytest

from moonshot.config import data_root

pytestmark = pytest.mark.data_root
REFERENCE = data_root() / "reference" / "setup-take" / "sim.npz"
# trainual reference/setup-take/report.md, "2b. The whole body against people": frames outside people's p1..p99
REPORTED_OUTSIDE = {"trunk_flex": 0, "trunk_lat": 0, "trunk_rot": 359, "sh_plane": 0, "sh_elev": 60, "sh_rot": 119,
                    "elbow": 0, "pron": 0, "wr_flex": 77, "wr_dev": 86}
REPORTED_NLL = {"median": 24.9, "max": 76.7}


@pytest.fixture(scope="module")
def measured():
    from moonshot.validate.posture import PRIOR, measure
    if not (PRIOR.exists() and REFERENCE.exists()):
        pytest.skip(f"no posture prior at {PRIOR} or no reference take at {REFERENCE}")
    return measure(np.load(REFERENCE)["theta"][:, :10])


def test_frames_outside_peoples_range_match_trainuals_report(measured):
    counts = {j: sum(j in f for f in measured["posture_outside"]) for j in REPORTED_OUTSIDE}
    assert counts == REPORTED_OUTSIDE


def test_the_likelihood_matches_trainuals_report(measured):
    nll = np.asarray(measured["posture_nll"])
    assert np.median(nll) == pytest.approx(REPORTED_NLL["median"], abs=0.05)
    assert nll.max() == pytest.approx(REPORTED_NLL["max"], abs=0.05)
