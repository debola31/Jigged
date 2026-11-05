"""The wrench a plate setup's nuts are run down and snugged with (moonshot/world/wrench.py) and its planned use
(moonshot/motion/plate_wrench.py): its box end fits over a clamp's nut, square on its flats; it lies on the plate clear
of every clamp; and on each nut its box end is on the stud's axis through every stroke, seated as far down as the
nut has run, the strokes turning the nut from parked down onto its strap and on by the snug (or back)."""
import math

import numpy as np
import pytest

from moonshot.motion import plate_wrench as PW
from moonshot.motion import plates
from moonshot.world import spoilboard as SB
from moonshot.world import wrench as WR

PARTS = ["ll-1005337", "nist-ftc-09"]


def test_the_box_end_fits_over_the_nut_square_on_its_flats():
    rings = [(c, R) for n, c, _, R in WR.boxes() if n.startswith("ring_")]
    assert len(rings) == 6
    for c, R in rings:
        inner = np.linalg.norm(c[:2]) - WR.WALL / 2
        assert SB.NUT_AF / 2 < inner < SB.NUT_AF / 2 + 1.0
        a = math.atan2(R[1, 0], R[0, 0])
        assert min(abs(((a - math.pi / 6) % (math.pi / 3)) - x) for x in (0.0, math.pi / 3)) < 1e-9
    assert 0.0 < WR.play() < math.radians(12.0)                  # it turns the nut, a little loose on it


def test_the_box_ends_chamfer_leads_it_onto_the_nut_without_reaching_below_it():
    """Every solid of the box end stays above its underside and outside the nut's hex, and the chamfer's face runs
    from the wall's inner face CHAMFER_MM up to CHAMFER_MM out on the underside."""
    r_in, h = WR.AF_IN / 2, WR.HEIGHT / 2
    for n, c, hh, R in WR.boxes():
        corners = np.array([c + R @ (hh * s) for s in np.array(np.meshgrid(*[[-1, 1]] * 3)).T.reshape(-1, 3)])
        assert corners[:, 2].min() > -h - 1e-9, n
        if n.startswith(("ring_", "foot_", "chamfer_")):
            u = c[:2] / np.linalg.norm(c[:2])
            assert (corners[:, :2] @ u).min() > r_in - 1e-9, n           # never inside the hexagon's opening
    for k in range(6):
        _, c, hh, R = next(b for b in WR.boxes() if b[0] == f"chamfer_{k}")
        u = np.r_[c[:2] / np.linalg.norm(c[:2]), 0.0]
        face = [c - R[:, 0] * hh[0] + R[:, 2] * s * hh[2] for s in (-1, 1)]   # its face's low and high edges
        assert face[0] @ u == pytest.approx(r_in + WR.CHAMFER_MM) and face[0][2] == pytest.approx(-h)
        assert face[1] @ u == pytest.approx(r_in) and face[1][2] == pytest.approx(-h + WR.CHAMFER_MM)


@pytest.mark.parametrize("part", PARTS)
def test_the_wrench_lies_on_the_plate_clear_of_its_clamps(part):
    plate = plates.plate(part, "op10")
    p, yaw = PW.rest(plate)
    assert p[2] == pytest.approx(plate.top + WR.HEIGHT / 2)
    ends = [p[:2], p[:2] + np.array([math.cos(yaw), math.sin(yaw)]) * (WR.LENGTH - 12.0)]
    lo, hi = plate.centre[:2] - plate.size[:2] / 2, plate.centre[:2] + plate.size[:2] / 2
    for e in ends:
        assert np.all(e > lo + 15.0) and np.all(e < hi - 15.0)
    for c in plates.clamps(part, "op10"):
        for state in ("parked", "clamped"):
            at, _ = c.pose(state)
            d = min(np.linalg.norm(at[:2] - (ends[0] + s * (ends[1] - ends[0]))) for s in np.linspace(0, 1, 50))
            assert d > SB.CLAMP_L / 2 + WR.HANDLE_W, (c.name, state, d)


@pytest.mark.parametrize("direction", ["tighten", "loosen"])
@pytest.mark.parametrize("part", PARTS)
def test_on_each_nut_the_box_end_is_on_the_stud_and_turns_it_the_whole_run(part, direction):
    plate = plates.plate(part, "op10")
    clamps = plates.clamps(part, "op10")
    keys, done = PW.keys(plate, clamps, 0.0, direction)
    at = {round(t, 9): (R, p) for t, R, p in keys}
    whole = (SB.PARK_NUT_GAP_MM / SB.LEAD_MM * 2 * math.pi + PW.SNUG) * (-1 if direction == "tighten" else 1)
    for c in clamps:
        mine = [(a, b, rad) for k, a, b, rad in done if k.name == c.name]
        assert sum(rad for _, _, rad in mine) == pytest.approx(whole)
        assert all(abs(rad) <= PW.STROKE + 1e-9 for _, _, rad in mine)
        z = c.nut_z("parked") if direction == "tighten" else c.nut_z("clamped")
        for a, b, rad in mine:
            (Ra, pa), (Rb, pb) = at[round(a, 9)], at[round(b, 9)]
            assert np.allclose(pa[:2], c.stud) and np.allclose(pb[:2], c.stud)
            assert pa[2] == pytest.approx(z + SB.FLANGE_T + WR.HEIGHT / 2 + 0.5)       # seated on the nut as it is
            z += SB.LEAD_MM * rad / (2 * math.pi)
            turn = math.atan2(Rb[1, 0], Rb[0, 0]) - math.atan2(Ra[1, 0], Ra[0, 0])
            swing = rad + math.copysign(WR.play(), rad)                 # the nut's turn and the box end's play
            assert (turn - swing + math.pi) % (2 * math.pi) - math.pi == pytest.approx(0.0, abs=1e-9)
        assert z == pytest.approx(c.nut_z("clamped") - SB.LEAD_MM * PW.SNUG / (2 * math.pi) if direction == "tighten"
                                  else c.nut_z("parked") + SB.LEAD_MM * PW.SNUG / (2 * math.pi))
    assert np.allclose(keys[0][2], keys[-1][2])                  # laid back where it lay
