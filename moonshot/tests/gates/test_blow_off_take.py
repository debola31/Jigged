"""Blow off the vise with the air gun (every VF-2 setup's first and last steps: "Blow out the vise..." and "...blow
the chips off"), on the full body: the right hand takes the gun from its holster, blows along the vise with the
trigger held, and puts it back.

In the physics run the gun leaves the holster only in the hand and is never dropped (it moves with the hand, within
the grip's slip limit, while carried); the trigger is held at least 1.5 s with the nozzle over the vise; the gun ends
back in its holster; and the take is a take record. Physics tier, on the takes the planner writes to the data root:
the shared takes/blow-off nist-ftc-10 plays, and every other part's vise setups' own runs, each with its part on the
table (takes/<part>-<setup>-clean-blow-off, the vise open and the part waiting; -unload-blow-off, the part clamped;
moonshot/planning/takes.py per_setup), which also pass every per-frame check (moonshot/validate/take.py).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.planning.takes import played

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = list(dict.fromkeys(played("clean-blow-off") + played("unload-blow-off")))


@pytest.fixture(scope="module", params=TAKES)
def run(request):
    folder = data_root() / "takes" / request.param
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    from moonshot.sim.blow_off import BlowOff
    r = BlowOff(folder)
    r.run(log=None)
    return r


def test_the_gun_is_never_dropped(run):
    o = run.outcome()
    assert o["max_slip_mm"] < threshold("physics.grip_slip_mm").value, o
    assert o["lifted_mm"] > 120, "it came out of the holster"


def test_the_trigger_is_held_over_the_vise(run):
    assert run.outcome()["blowing_over_vise_s"] >= 1.5


def test_the_gun_ends_back_in_its_holster(run):
    assert run.outcome()["end_off_rest_mm"] < 10.0


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(run.folder) == []


def test_a_setups_run_passes_every_per_frame_check(run):
    from moonshot.validate.take import run as checks
    if run.folder.name == "blow-off":
        pytest.skip("the shared take, published before its per-frame checks were gated here")
    run.export()
    failed = {k: v for k, v in checks(run.folder).items() if isinstance(v, str) or not v.passed}
    assert not failed, (run.folder.name, failed)
