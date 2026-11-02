"""The catalogue's parametric tool generators (moonshot/library/generators.py) make tools of the stated size and a
plausible mass: lighter than a solid bar of the same material (the flutes are cut out), not hollow."""
import math

import pytest

from moonshot.library.generators import DENSITY_G_CC, TOOLS, build, record


@pytest.mark.parametrize("tool", [t for t in TOOLS if t.dia_mm <= 3.5], ids=lambda t: t.id)
def test_a_generated_tool_has_its_size_and_a_plausible_mass(tool):
    shape = build(tool)
    rec = record(tool, shape)
    bb = rec["bbox"]
    assert bb["max"][0] - bb["min"][0] == pytest.approx(tool.dia_mm, abs=0.05)
    assert bb["max"][2] - bb["min"][2] == pytest.approx(tool.overall_mm, abs=0.05)
    mass = next(s["value"] for s in rec["key_specs"] if s["name"] == "Mass")
    bar = math.pi * (tool.dia_mm / 2) ** 2 * tool.overall_mm / 1000 * DENSITY_G_CC[tool.material]
    assert 0.6 * bar < mass < bar


def test_every_generated_tool_is_in_the_catalogue():
    from moonshot.planning.validate import catalogue
    assert {t.id for t in TOOLS} <= catalogue()
