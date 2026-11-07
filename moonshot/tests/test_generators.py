"""The catalogue's parametric tool generators (moonshot/library/generators.py) make tools of the stated size and a
plausible mass: lighter than a solid bar of the same material (the flutes are cut out), not hollow; and gauges of
their published size."""
import math

import cadquery as cq
import pytest

from moonshot.library.generators import (CALIPERS, DENSITY_G_CC, GAUGES, MICROMETERS, SOURCED, SOURCES, STONES,
                                         TOOLS, bench_stone, build, caliper, micrometer, plug_gauge, record)


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
    assert ({t.id for t in TOOLS + SOURCED} | {g.id for g in GAUGES + CALIPERS + MICROMETERS + STONES}
            <= catalogue())


def test_every_sourced_tool_says_where_its_dimensions_came_from():
    assert {t.id for t in SOURCED} == set(SOURCES)


@pytest.mark.data_root
def test_the_dovetail_cuts_ll_1005337s_undercut_walls():
    """Its flank is the end notches' undercut wall as the part's STEP has it (not a catalogue's naming of the
    angle); its widest radius fits the walls' R15 corners and its flank spans the plate."""
    import math

    from OCP.BRepAdaptor import BRepAdaptor_Surface

    from moonshot.config import data_root
    step = data_root() / "parts" / "ll-1005337" / "part.step"
    if not step.exists():
        pytest.skip("no STEP for ll-1005337 in the data root")
    part = cq.importers.importStep(str(step))
    lean = lambda f: round(90 - math.degrees(math.acos(abs(f.normalAt().z))), 3)  # noqa: E731
    inclined = [f for f in part.faces().vals() if f.geomType() == "PLANE" and 0.001 < abs(f.normalAt().z) < 0.999]
    walls = [f for f in inclined if lean(f) != 45.0]                # the rest are the 45 deg chamfers
    assert len(walls) == 2                                          # one per end notch
    leans = {lean(f) for f in walls}
    corners = [BRepAdaptor_Surface(f.wrapped).Cylinder() for f in part.faces().vals() if f.geomType() == "CYLINDER"
               and 0.01 < abs(BRepAdaptor_Surface(f.wrapped).Cylinder().Axis().Direction().Y()) < 0.99]
    t = next(t for t in SOURCED if t.id == "dovetail-20")
    assert leans == {t.flank_deg}
    assert corners and t.dia_mm / 2 <= min(c.Radius() for c in corners) + 1e-6
    bb = part.val().BoundingBox()
    assert t.flute_mm >= bb.zlen


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


def test_the_micrometer_reads_its_opening_and_reaches_its_range():
    """Shown at its reading: the anvil's face to the spindle's is the reading, the spindle's travel out of the barrel
    reaches the range's start, and the frame's throat is the datasheet's c below the axis."""
    m = MICROMETERS[0]
    parts = {n: s.val().BoundingBox() for n, s, _ in micrometer(m)}
    assert parts["spindle"].xmin - parts["anvil"].xmax == pytest.approx(m.reading_mm, abs=0.01)
    assert parts["spindle"].xmax - parts["anvil"].xmax >= m.min_mm
    axis_y = (parts["anvil"].ymin + parts["anvil"].ymax) / 2
    assert axis_y - parts["frame"].ymin == pytest.approx(m.throat_mm + m.frame_w_mm, abs=0.01)
    assert _box(micrometer(m)).zmin == pytest.approx(0.0, abs=0.01)


def test_the_bench_stone_is_its_size_lying_flat():
    s = STONES[0]
    bb = _box(bench_stone(s))
    assert (bb.xlen, bb.ylen, bb.zlen) == pytest.approx((s.length_mm, s.width_mm, s.thickness_mm), abs=0.01)
    assert bb.zmin == pytest.approx(0.0, abs=0.01)
