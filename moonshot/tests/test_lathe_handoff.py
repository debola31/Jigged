"""The mill's cycle steps leave the lathe's and the grinder's to their own simulations, and a mill setup after the
lathe starts from the stock the lathe's last cycle left (moonshot/sim/cycle_take.py cycle_steps, before_mill)."""
import pytest

from moonshot.config import data_root
from moonshot.planning.validate import load_plan
from moonshot.sim.cycle_take import before_mill, cycle_steps


def test_the_mill_s_steps_leave_out_the_lathe_s_and_the_grinder_s():
    spacer = [f"{s['id']}-{o['id']}" for s, o in cycle_steps(load_plan("ll-1007224"))]
    assert spacer == ["op30-spot", "op30-drill"]                       # its op10 and op20 are the ST-25's
    assert cycle_steps(load_plan("ll-1011439")) == []                  # turned and parted off, no mill
    assert cycle_steps(load_plan("ct-tpg322")) == []                   # ground by hand


def test_a_part_milled_from_the_start_keeps_every_mill_step_and_no_lathe_stock():
    steps = cycle_steps(load_plan("nist-ftc-10"))
    assert len(steps) == 15 and all(s["machine"] == "vf2" for s, _ in steps)
    assert before_mill(load_plan("nist-ftc-10")) is None


@pytest.mark.data_root
def test_the_mill_starts_from_the_lathe_s_last_stock():
    end = data_root() / "takes" / "ll-1007224-op20-finish" / "stock-end.brep"
    if not end.exists():
        pytest.skip("ll-1007224's lathe cycles haven't run")
    assert before_mill(load_plan("ll-1007224")) == end
