"""The vise take passes every registered per-frame check, the bar it must clear before it is rendered
(docs/moonshot/physics.md). moonshot/validate/take.py runs them; a check with nothing to read fails.

Physics tier: farm and hub only (`pytest moonshot -m farm`), on the take the planner writes to the data root
(takes/setup-take) once its physics run and skin bake are in it. Protected (plan §6, rule 1)."""
import pytest

from moonshot.config import data_root

pytestmark = [pytest.mark.farm, pytest.mark.data_root]


def test_the_vise_take_passes_every_check():
    take = data_root() / "takes" / "setup-take"
    if not (take / "sim.npz").exists():
        pytest.skip(f"no physics run in {take}")
    from moonshot.validate.take import run
    failed = {k: v for k, v in run(take).items() if isinstance(v, str) or not v.passed}
    assert not failed, failed
