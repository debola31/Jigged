"""The turning and grinding engines (moonshot/sim/turn.py, grind.py) on shapes whose answer is known: an insert's
edge and a pass's sweep, a shaft turned to size, its inside corner left as the nose's radius, a part-off, the stock
revolved, and a ground slot's floor and run-out."""
import math

import numpy as np
import pytest

from moonshot.sim import turn as T


def shaft(stock: T.Profile) -> T.Profile:
    """The part: a pilot r 3 from u 0 to 5, its free end at u 0, then a shoulder up to r 5 from 5 to 15 (toward +u,
    the chuck), as the pin's pilot and shoulder."""
    u = stock.u
    r = np.where((u >= 0) & (u <= 5), 3.0, np.where((u > 5) & (u <= 15), 5.0, 0.0))
    return T.Profile(stock.u0, np.zeros_like(r), r)


def dcgt() -> T.Tool:
    return T.Tool("t", "turn", "out", T.turning_edge(0.4, 93.0, 55.0, 11.6), 0.4, None, None, "carbide")


def test_a_turning_edge_is_tangent_to_its_nose_at_its_lead_angle():
    e = np.array(T.turning_edge(0.4, 93.0, 55.0, 11.6))
    arc = e[1:-1]
    assert np.allclose(np.hypot(*arc.T), 0.4)                               # the nose's arc about its centre
    lead = e[0] - arc[0]
    assert math.degrees(math.atan2(lead[1], lead[0])) == pytest.approx(87.0)   # 93 deg to the feed (-Z)
    trail = e[-1] - arc[-1]
    assert math.degrees(math.atan2(trail[1], trail[0])) == pytest.approx(32.0)  # 55 deg round from it
    assert abs(arc[:, 1].min() + 0.4) < 1e-9                                 # its lowest point under the centre


def test_a_straight_move_sweeps_the_hull_of_the_edge_at_its_ends():
    p = T.bar(-5.0, 20.0, 8.0, margin=1.0)
    s = T.Setup(-1.0, 0.0, (30.0, 40.0))
    T.sweep(p, T.in_model(dcgt(), s), "out", np.array([0.0, 6.4]), np.array([12.0, 6.4]))
    mid = (p.u > 1.0) & (p.u < 11.0)
    assert np.allclose(p.r_out[mid], 6.0, atol=1e-6)                         # the nose's bottom, 0.4 under its centre


def test_a_shaft_turned_rough_and_finish_is_the_part_but_its_inside_corner():
    stock = T.bar(-1.0, 40.0, 7.0, margin=2.0)
    part = shaft(stock)
    s = T.Setup(-1.0, 0.0, (25.0, 40.0))                                    # the free end at -u, the jaws past 25
    t = dcgt()
    T.run(stock, [T.face(stock, s, t, 0.0, 1.0, 1000, 0.1)], s)
    for finish, allowance in ((False, 0.25), (True, 0.0)):
        keep = T.keep_for(stock, part, (-2.0, 16.0))
        T.run(stock, [T.contour(stock, s, t, keep, -2.0, 16.0, allowance, 1.5, 1000, 0.1, finish)], s)
    u = stock.u
    inside = (u > T.GRID_MM) & (u < 16)                                      # past the faced end's own station
    # no gouge: 20 µm at most, at a vertical face's top corner, which lies between two stations
    assert (stock.r_out >= np.where(part.solid(), part.r_out, -1) - 0.02)[inside].all()
    away = ((u > 0.05) & (u < 4.5)) | ((u > 5.05) & (u < 15.0))
    assert np.abs(stock.r_out[away] - part.r_out[away]).max() < 0.005
    corner = (u > 4.5) & (u <= 5.0)                                          # the nose's 0.4 in the step's corner
    assert 0.0 < (stock.r_out[corner] - 3.0).max() <= 0.4 + 1e-3
    lo, _ = stock.span()
    assert lo == pytest.approx(0.0, abs=2 * T.GRID_MM)                        # faced to u 0


def test_a_part_off_cuts_the_part_free_and_hands_on_the_part():
    stock = T.bar(-1.0, 40.0, 7.0, margin=2.0)
    part = shaft(stock)
    s = T.Setup(-1.0, 0.0, (25.0, 40.0))
    blade = T.Tool("b", "partoff", "out", T.blade_edge(3.0, 0.2), 0.2, None, None, "carbide", width=3.0)
    keep = T.keep_for(stock, part, (-2.0, 18.0))
    T.run(stock, [T.plunge(stock, s, blade, keep, 16.5, -0.3, 1000, 0.04)], s)
    assert len(stock.pieces()) == 2
    piece = stock.keep_piece(0.0, 15.0)
    lo, hi = piece.span()
    assert hi == pytest.approx(15.0, abs=2 * T.GRID_MM) and lo < 0.0


def test_the_stock_revolved_has_the_profile_s_volume():
    p = T.bar(0.0, 10.0, 5.0, margin=1.0)
    p.r_in[(p.u >= 0) & (p.u <= 4)] = 1.5                                    # a hole from the end
    brep = T.to_brep(p, T.Axis(np.zeros(3), np.array([0.0, 1.0, 0.0]), np.array([1.0, 0.0, 0.0])))
    assert brep.isValid()
    assert brep.Volume() == pytest.approx(math.pi * (25 * 10 - 1.5 ** 2 * 4), rel=1e-3)


def test_a_ground_slot_is_flat_over_the_stroke_and_rises_on_the_wheel_s_arc():
    import cadquery as cq
    from moonshot.sim import grind as G
    e = G.Edge(np.array([0.0, 0.0]), np.array([1.0, 0.0]), np.array([0.0, 1.0]), 20.0)   # along x, out +y
    box = cq.Solid.makeBox(20.0, 10.0, 3.0, cq.Vector(0, -10.0, 0))
    cut = G.cut(box, G.pass_solid(e, 0.5, 1.0, 2.8, (8.0, 12.0), 76.2, 3.0))
    removed = box.Volume() - cut.Volume()
    run_out = math.sqrt(2 * 76.2 * 0.2)                                     # 5.52 mm at 0.2 deep
    expect = 1.0 * (0.2 * 4.0 + 2 * (2 / 3) * 0.2 * run_out)                # the flat, and two parabolic ends
    assert removed == pytest.approx(expect, rel=0.01)
