"""The catalogue's parametric tool generators (moonshot/library/generators.py) make tools of the stated size and a
plausible mass: lighter than a solid bar of the same material (the flutes are cut out), not hollow; and gauges of
their published size."""
import math

import cadquery as cq
import pytest

from moonshot.library.generators import (CALIPERS, DENSITY_G_CC, GAUGES, SOURCED, SOURCES, TOOLS, build, caliper,
                                         plug_gauge, record)


@pytest.mark.parametrize("tool", [t for t in TOOLS + SOURCED if t.envelope_mm <= 3.5], ids=lambda t: t.id)
def test_a_generated_tool_has_its_size_and_a_plausible_mass(tool):
    shape = build(tool)
    rec = record(tool, shape)
    bb = rec["bbox"]
    assert bb["max"][0] - bb["min"][0] == pytest.approx(tool.envelope_mm, abs=0.05)
    assert bb["max"][2] - bb["min"][2] == pytest.approx(tool.overall_mm, abs=0.05)
    mass = next(s["value"] for s in rec["key_specs"] if s["name"] == "Mass")
    bar = math.pi * (tool.envelope_mm / 2) ** 2 * tool.overall_mm / 1000 * DENSITY_G_CC[tool.material]
    assert 0.6 * bar < mass < bar


def test_every_generated_tool_is_in_the_catalogue():
    from moonshot.planning.validate import catalogue
    assert {t.id for t in TOOLS + SOURCED} | {g.id for g in GAUGES + CALIPERS} <= catalogue()


def test_every_sourced_tool_says_where_its_dimensions_came_from():
    assert {t.id for t in SOURCED} == set(SOURCES)


def _box(parts):
    return cq.Compound.makeCompound([s.val() for _, s, _ in parts]).BoundingBox()


def test_the_caliper_has_its_datasheet_size_and_lies_centred_on_its_back():
    c = CALIPERS[0]
    bb = _box(caliper(c))
    assert bb.xlen == pytest.approx(c.length_mm, abs=0.1)
    assert bb.ylen == pytest.approx(c.outside_mm + c.beam_mm + c.inside_mm, abs=0.1)
    assert bb.zmin == pytest.approx(0.0, abs=0.01) and bb.xmin == pytest.approx(-bb.xmax, abs=0.01)


def test_the_plug_gauge_is_its_members_and_handle_end_to_end():
    g = GAUGES[0]
    bb = _box(plug_gauge(g))
    assert bb.xlen == pytest.approx(g.go_mm + g.handle_mm + g.nogo_mm, abs=0.05)
    assert bb.zlen == pytest.approx(g.handle_dia_mm, abs=0.05) and bb.zmin == pytest.approx(0.0, abs=0.01)
