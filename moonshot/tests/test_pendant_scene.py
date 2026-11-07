"""A setting take's vise is drawn as a per-setup take's is (moonshot/sim/pendant.py setting_table): the setup's part
as its stock enters it, clamped, on the parallels the take was planned with; a plate from its geoms."""
from pathlib import Path

from moonshot.motion.setting import part_in_vise, part_on_table
from moonshot.planning.validate import load_plan
from moonshot.sim.pendant import setting_table


def test_a_setting_takes_vise_is_drawn_as_its_setups_part_enters_it():
    p = part_in_vise(load_plan("ll-1007224"), "op30")
    table = setting_table(Path("takes/ll-1007224/op30-z"), {"setup": p, "step": {"setup": "op30"}})
    assert (table.part, table.setup, table.stock_at, table.vise) == ("ll-1007224", "op30", "in", "clamped")
    assert not table.is_plate and not table.jaw_open
    assert table.load.parallels_y == p["load"]["parallels_y"]


def test_a_plates_setting_take_is_drawn_from_its_geoms():
    p = part_on_table(load_plan("nist-ftc-09"), "op10")
    assert setting_table(Path("takes/nist-ftc-09/op10-z"), {"setup": p, "step": {"setup": "op10"}}) is None
