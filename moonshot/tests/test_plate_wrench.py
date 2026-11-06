"""The ratcheting wrench a plate setup's nuts are run down and snugged with (moonshot/world/wrench.py) and its planned
use (moonshot/motion/plate_wrench.py): its ring fits over a clamp's nut, square on its flats, inside its head; it lies
on the plate clear of every clamp; and on each nut its box end stays on the stud's axis through every stroke and swing
back, seated as far down as the nut has run, the strokes turning the nut from parked down onto its strap and on by
the snug (or back), each within the sector in front of the stud; carried between them, it clears the studs."""
import math

import numpy as np
import pytest

from moonshot.motion import plate_wrench as PW
from moonshot.motion import plates
from moonshot.world import spoilboard as SB
from moonshot.world import wrench as WR

PARTS = ["ll-1005337", "nist-ftc-09"]


def _corners(c, hh, R):
    return np.array([c + R @ (hh * s) for s in np.array(np.meshgrid(*[[-1, 1]] * 3)).T.reshape(-1, 3)])


def test_the_ring_fits_over_the_nut_square_on_its_flats_inside_the_head():
    rings = [(c, hh, R) for n, c, hh, R in WR.ring_boxes() if n.startswith("ring_")]
    assert len(rings) == 6
    for c, hh, R in rings:
        inner = np.linalg.norm(c[:2]) - hh[0]
        assert SB.NUT_AF / 2 < inner < SB.NUT_AF / 2 + 1.0
        a = math.atan2(R[1, 0], R[0, 0])
        assert min(abs(((a - math.pi / 6) % (math.pi / 3)) - x) for x in (0.0, math.pi / 3)) < 1e-9
    assert 0.0 < WR.play() < math.radians(12.0)                  # it turns the nut, a little loose on it
    for n, c, hh, R in WR.ring_boxes():                          # the ring inside the head's walls, clear of the nut's
        k = _corners(c, hh, R)                                    # corners as the head is
        assert np.linalg.norm(k[:, :2], axis=1).max() <= WR.RING_R / math.cos(math.pi / 6) + 1e-9, n
    for n, c, hh, R in WR.head_boxes():
        if n.startswith("head_"):
            u = c[:2] / np.linalg.norm(c[:2])
            assert (_corners(c, hh, R)[:, :2] @ u).min() >= WR.RING_R - 1e-9, n


def test_the_rings_chamfer_leads_it_onto_the_nut_without_reaching_below_it():
    """Every solid of the box end stays above the head's underside and outside the nut's hex, and the chamfer's face
    runs from the flat's inner face CHAMFER_MM up to CHAMFER_MM out on the ring's underside."""
    r_in, h, hr = WR.AF_IN / 2, WR.HEIGHT / 2, WR.HEIGHT / 2 - 0.5
    for n, c, hh, R in WR.boxes():
        corners = _corners(c, hh, R)
        assert corners[:, 2].min() > -h - 1e-9, n
        if n.startswith(("ring_", "foot_", "chamfer_")):
            u = c[:2] / np.linalg.norm(c[:2])
            assert (corners[:, :2] @ u).min() > r_in - 1e-9, n           # never inside the hexagon's opening
    for k in range(6):
        _, c, hh, R = next(b for b in WR.ring_boxes() if b[0] == f"chamfer_{k}")
        u = np.r_[c[:2] / np.linalg.norm(c[:2]), 0.0]
        face = [c - R[:, 0] * hh[0] + R[:, 2] * s * hh[2] for s in (-1, 1)]   # its face's low and high edges
        assert face[0] @ u == pytest.approx(r_in + WR.CHAMFER_MM) and face[0][2] == pytest.approx(-hr)
        assert face[1] @ u == pytest.approx(r_in) and face[1][2] == pytest.approx(-hr + WR.CHAMFER_MM)


def test_the_ratchet_is_a_hinge_in_the_head_locked_till_a_run_frees_it():
    import mujoco
    m = mujoco.MjModel.from_xml_string(
        '<mujoco><default><default class="steel"/></default><worldbody>\n' + WR.xml("wrench", [0, 0, 100], 0.0)
        + '</worldbody></mujoco>')
    j = m.joint("wrench_ratchet")
    assert m.body(j.bodyid[0]).name == "wrench_ring" and m.body(m.body("wrench_ring").parentid[0]).name == "wrench"
    assert np.allclose(j.axis, [0, 0, 1]) and j.limited and np.abs(j.range).max() < 1e-4
    assert WR.RATCHET_DRAG_NM < SB.NUT_FRICTION_NM               # swung back, it leaves the nut where the stroke put it


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
def test_on_each_nut_the_box_end_stays_on_the_stud_and_turns_it_the_whole_run(part, direction):
    plate = plates.plate(part, "op10")
    clamps = plates.clamps(part, "op10")
    keys, done, work = PW.keys(plate, clamps, 0.0, direction)
    whole = (SB.PARK_NUT_GAP_MM / SB.LEAD_MM * 2 * math.pi + PW.SNUG) * (-1 if direction == "tighten" else 1)
    for c in clamps:
        (t_on, t_off), = [(a, b) for k, a, b in work if k.name == c.name]
        mine = [(a, b, rad) for k, a, b, rad in done if k.name == c.name]
        assert sum(rad for _, _, rad in mine) == pytest.approx(whole)
        assert all(abs(rad) <= PW.STROKE + PW.SNUG + 1e-9 for _, _, rad in mine)
        # the box end on the nut from its first stroke until the last's swing back (eased off the snug nut)
        assert mine[0][0] == pytest.approx(t_on) and mine[-1][1] + PW.BACK_S == pytest.approx(t_off)
        on = [(t, R, p) for t, R, p in keys if t_on - 1e-9 <= t <= t_off + 1e-9]
        assert all(np.allclose(p[:2], c.stud) for _, _, p in on)        # the box end on the nut throughout
        start = PW.nut_yaw(c, plate, direction, clamps)
        # the handle swung clear of the other clamps' nuts (nist-ftc-09's ends three clamps 125 mm apart)
        assert PW.sweeps_clear(c, clamps, start, math.copysign(PW.STROKE + PW.SNUG + WR.play(), whole)), c.name
        for t, R, p in on:                                               # each swing within the sector before the stud
            off = (math.atan2(R[1, 0], R[0, 0]) - start + math.pi) % (2 * math.pi) - math.pi
            assert abs(off) <= PW.STROKE + PW.SNUG + WR.play() + 1e-9 and off * whole >= -1e-9
        z = c.nut_z("parked") if direction == "tighten" else c.nut_z("clamped")
        at = {round(t, 9): (R, p) for t, R, p in keys}
        for i, (a, b, rad) in enumerate(mine):
            (Ra, pa), (Rb, pb) = at[round(a, 9)], at[round(b, 9)]
            assert pa[2] == pytest.approx(z + SB.FLANGE_T + WR.HEIGHT / 2 + 0.5)       # seated on the nut as it is
            z += SB.LEAD_MM * rad / (2 * math.pi)
            turn = math.atan2(Rb[1, 0], Rb[0, 0]) - math.atan2(Ra[1, 0], Ra[0, 0])
            swing = rad + math.copysign(WR.play(), rad)                 # the ring's play taken up each stroke
            assert (turn - swing + math.pi) % (2 * math.pi) - math.pi == pytest.approx(0.0, abs=1e-9)
        assert z == pytest.approx(c.nut_z("clamped") - SB.LEAD_MM * PW.SNUG / (2 * math.pi) if direction == "tighten"
                                  else c.nut_z("parked") + SB.LEAD_MM * PW.SNUG / (2 * math.pi))
    assert np.allclose(keys[0][2], keys[-1][2])                  # laid back where it lay


@pytest.mark.parametrize("direction", ["tighten", "loosen"])
@pytest.mark.parametrize("part", PARTS)
def test_each_ends_nuts_are_its_own_hands_and_its_grip_is_solved_mid_stroke_on_its_first(part, direction):
    from moonshot.motion import plate_clamps as PC
    plate, clamps = plates.plate(part, "op10"), plates.clamps(part, "op10")
    rounds = PW.by_hand(clamps)
    assert [s for s, _ in rounds] == ["R", "L"]
    assert sorted(c.name for _, nuts in rounds for c in nuts) == sorted(c.name for c in clamps)
    for side, nuts in rounds:
        assert all(PC.side_of(c) == side for c in nuts)
        p, yaw = PW.grip_at(plate, clamps, side, direction)
        assert np.allclose(p[:2], nuts[0].stud)                      # the box end on the hand's first nut
        half = (yaw - PW.nut_yaw(nuts[0], plate, direction, nuts) + math.pi) % (2 * math.pi) - math.pi
        assert half == pytest.approx(PW.STROKE / 2 * (-1 if direction == "tighten" else 1))


@pytest.mark.parametrize("direction", ["tighten", "loosen"])
@pytest.mark.parametrize("part", PARTS)
def test_carried_between_nuts_the_wrench_clears_the_studs(part, direction):
    clamps = plates.clamps(part, "op10")
    keys, _, _ = PW.keys(plates.plate(part, "op10"), clamps, 0.0, direction)
    top = max(c.stud_z()[1] for c in clamps)
    for t, R, p in keys[1:-1]:
        if all(np.linalg.norm(p[:2] - np.asarray(c.stud)) > 5.0 for c in clamps):     # not on or over a nut
            assert p[2] - WR.HEIGHT / 2 >= top + PW.STUD_CLEAR_MM - 1e-9, (t, p)
