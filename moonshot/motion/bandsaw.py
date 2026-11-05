"""Cutting bar stock to length on the band saw (the bandsaw-cut-to-length card), planned as the person's takes at the
saw (plan §4, §5.4), cut together: the machine's own cut between them is simulated, not filmed (the scope rule,
2026-11-03: only the person's work is rendered). Each of G1's bar parts has its own (use_part: its bar, its blank's
length, the takes' names in moonshot/planning/takes.py).

The saw (McMaster 8962N13) is laid out the mirror of the JET the card was written from: its vise handwheel, bow
handle and control box are at its left end and its work stop at the front right, a metre and more apart, and the
body model faces one way and doesn't walk. So the person works it from three places, each a take, and the saw is
turned under the body for each (moonshot/world/saw_cell.py Place):

1. <part>-saw, behind the saw at its infeed (card phase 6): the right hand's fingers on the bar's tail push it
   along the bed until its other end, which shows OUT_MM past the blade, meets the stop block; it holds it there
   and against the fixed jaw a moment, and lets go.
2. <part>-saw-clamp, at the left end (phases 8-9): the right hand turns the vise handwheel by its knob until the jaw
   is snug on the bar (the card's half turn, as the jaw is left).
3. saw-start, in front of the control box, the same for every bar (phases 10-12): the index presses Start, and the
   blade runs up to speed; thumb and index turn the feed valve's knob a quarter turn open, and the bow comes down at
   the cutting feed; hands at the sides while it cuts.
4. <part>-saw-cut, the machine's (moonshot/sim/bandsaw.py cut): no person.
5. lift-out-<part>-saw, at the front (phases 14-15): the right hand slides the cut piece off the fixed jaw's plate,
   takes it by its sides with thumb, index and middle, lifts it off the bed and sets it down on the bench beside the
   right hip.

Where the card can't be followed on this saw, and why (each for review):
- The bar is pushed from the infeed side, as a bar is fed: its end is at the blade, under the raised bow, and from
  the front the person reaching it leaned their head into the idler wheel's guard (raising the bow brings the guard
  no higher there).
- Sides: the card's steadying hand (left) feeds the bar and takes the piece while its working hand (right) works the
  vise. Here the two are never at once (the jaw and the handwheel are a metre from the bar), and from the front the
  bar and the piece are on the right of the stop's left side, so the right hand does both; the left hangs.
- Phases 1-5 (feed off, lift the bow, set the rate, open the jaw) come before these takes: the bow is up at
  RAISED_DEG, the jaw open JAW_GAP_MM past the bar, the bar pushed through from the infeed until it shows OUT_MM
  past the blade (saw_cell.OUT_MM). Phase 7 (slide the jaw
  to the bar, drop the rack block) is left out: with the jaw left that close the handwheel's half turn closes it. The
  steadying hand can't stay on the bar while the jaw bites (phase 8).
- The length: the saw's own work stop can't come nearer the blade than 226 mm (its arm would run into the fixed jaw's
  front plate), and G1's blanks are 3-1/4 in, so the stop is a block clamped on the bed at the blank's length from the
  kerf (saw_cell.stop_block_body), set before the takes as the stop is (phase 5).
- The station's control box has start, stop and a feed valve (its record's guesses for the STEP's three knobs), no
  feed selector, rate knob or coolant switch: the valve is shut for the bow to hold up, and a quarter turn opens it to
  the cutting feed (phases 2, 4 and 12); there is no coolant (phase 11). Start has no collider in the record, so it
  is worked by the index's pad at its site (moonshot/sim/bandsaw.py); the valve's knob is jointed and turned by
  contact.
- The bow is raised RAISED_DEG, its blade 177 mm over the bar, not the card's 25 mm: the bow's collider spans its
  window and would stand in the bar at 25, and lower its idler guard meets the head of someone bent over the
  handwheel.
- The piece is taken with the thumb, index and middle, not four fingers, after sliding it off the fixed jaw's plate
  (its far side lies against the plate its whole length): with the bow down, its box spans the window from 33.6 mm
  in front of the blade, which leaves 50 mm of the piece for the hand.

    python -m moonshot.motion.bandsaw <part> load|clamp|start|unload     # -> <data root>/takes/<take>
"""
from __future__ import annotations

import json
import math
import sys

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.bench import (CARRY_EASE_S, HANGING, LIFT_S, PRELOAD_S, RISE_S, STILL_S, TAKE_MM, TAKE_S,
                                   BenchPlan, bands, oriented_box)
from moonshot.motion.primitives import FPS, blend_q, min_jerk, open_like
from moonshot.world import bandsaw as BS
from moonshot.world import saw_cell as SC

TAKES = data_root() / "takes"
CARD = "bandsaw-cut-to-length"
OUT: dict = {"start": TAKES / "saw-start"}       # the part's takes by use_part (moonshot/planning/takes.py names)


def use_part(part: str) -> None:
    """Plan for a part's bar: its stock (saw_cell.use_part) and its takes' folders."""
    SC.use_part(part)
    OUT.update(load=TAKES / f"{part}-saw", clamp=TAKES / f"{part}-saw-clamp", cut=TAKES / f"{part}-saw-cut",
               unload=TAKES / f"lift-out-{part}-saw")

RAISED_DEG = 10.0           # the head lowered this far from its top stop: the blade 177 mm over the bar (at the card's
                            # 25 mm the bow's box stands 12 mm into the bar), and its idler guard clear of the head of
                            # someone bent over the handwheel (at 20 deg the guard met it and lifted the bow 3 deg)
JAW_GAP_MM = 2.3            # the jaw left open this far past the bar, so the handwheel's half turn (2.54 mm at its
                            # 5.08 mm lead) closes it and snugs it
CUT_FEED_MM_S = 1.5         # the feed valve opened to this (proposed): the blade down through 1 in of 4140 in about
                            # 17 s, 3.5 sq in a minute, and the whole stroke from the raised bow in under 3 minutes (the
                            # card: 1-3)
SLIDE_S = 3.0               # the bar's slide, 45 mm: the card's 4.5 s, from Dake's footage, was for 50 mm of a lighter
                            # bar, and pushing 4140 that long held the arm past people's sustained effort (0.42 of a
                            # muscle's maximum for 5.4 s, against 0.30 held 5 s or more)
PUSH_EFFORT = 0.05          # the fingers on the bar's end barely squeezed: welded to the hand it no longer meets the
                            # skin, and at the grips' 0.3 the pads sank 5.5 mm into it
STOP_INTO_MM = 2.0          # the slide is aimed this far past the stop's face, and JAW_INTO_MM into the fixed jaw, so
JAW_INTO_MM = 1.0           # the bar meets both, as people push a bar up to a stop and its fence: aimed 0.5 mm in and
                            # at the jaw's face, it ended 0.64 mm short of the stop and 1.25 mm off the jaw
SLIDE_OFF_JAW_MM = 0.3      # ... and slid this far off the fixed jaw till it is held at the stop
HOLD_S = 0.6               # held against the stop before letting go
HOLD_N = 10.0               # ... this hard (proposed: the card's 10 N push on the jaw, as no source gives this one),
JAW_N, DOWN_N = 4.0, 5.0    # against the fixed jaw and down on the bed (proposed: the card's 20 N hold, split)
FRONT_LUMBAR = np.array([-200.0, -490.0, 955.0])   # the station's mm: at the front, left of the work stop, the bar
                                                    # before the right shoulder, the knees at the base's recessed front
                                                    # (233 mm in front of the blade from 300 to 600 mm up, its foot at
                                                    # 450), the hanging hand clear of the work stop's arm
BACK_LUMBAR = np.array([255.0, 525.0, 955.0])      # behind the saw at its infeed, facing it (BACK): the bar's tail
                                                    # before the right hip, where the hand hangs, the body clear of the
                                                    # motor
START_LUMBAR = np.array([-1540.0, -452.0, 955.0])  # in front of the control box, facing it (START place)
END_LUMBAR = np.array([-1150.0, 240.0, 955.0])     # at the left end, facing the station's +X: the handwheel's knob
                                                    # ahead at the thigh, under the right shoulder, the thighs 90 mm
                                                    # short of it. Crouched 115 mm (the body model has no legs), the
                                                    # knob turn was no more like people's
KNOB_TURN_DEG = 180.0       # the card's half turn, at most
SNUG_DEG = 20.0             # the handwheel turned this far past where the jaw meets the bar: snug (the card's end)
KNOB_START_DEG = -104.2     # where the handwheel is left: its knob level on the operator's left (at joint zero it is
                            # 14.2 deg past the top), so the half turn takes it over the top to their right, not down
                            # to their knees
KNOB_TURN_S = 2.5           # the card's 2.5 s
START_TRAVEL_MM = 6.0       # Start pressed this far past its top (proposed: a mushroom button's travel)
KNOB_N = 40.0               # the card's 40 N, at the knob: 2 N m, a 1.2 kN clamp through the screw past its friction
VALVE_TURN_DEG = 90.0       # the feed valve opened a quarter turn, to the cutting feed (bandsaw.json feed_valve)
VALVE_TURN_S = 0.9          # ... over this long
SLIDE_OFF_MM = 35.0         # the cut piece slid this far off the fixed jaw's plate before it is taken: its far side lies
                            # against the plate its whole length, and the index and middle need the gap
SLIDE_OFF_S = 1.0           # ... over this long


def saw_box(place: SC.Place, name: str, grow: float = 0.0, q_head: float = 0.0):
    """A record collider as an SDF in the take's world (box, oriented box or cylinder along x), the head's at q_head."""
    c = BS.record()["colliders"][name]
    if "box_min_mm" in c:
        lo, hi = np.array(c["box_min_mm"], float), np.array(c["box_max_mm"], float)
        return oriented_box(place.world((lo + hi) / 2), place.R, (hi - lo) / 2 + grow)
    if "cylinder_x_mm" in c:
        x0, x1 = c["cylinder_x_mm"]
        _, y, z = c["at_mm"]
        a, b = place.world([x0, y, z]), place.world([x1, y, z])
        r = c["radius_mm"] + grow
        return lambda p, a=a, b=b, r=r: G.sdf_cyl(p, a, b, r)
    J = BS.record()["joints"]["head"]
    hinge = np.array(J["at_mm"], float)
    Rq = Rotation.from_rotvec(np.array(J["axis"], float) * q_head).as_matrix()
    Ry = Rotation.from_rotvec([0.0, math.radians(c["rot_y_deg"]), 0.0]).as_matrix()
    centre = hinge + Rq @ (np.array(c["centre_mm"], float) - hinge)
    return oriented_box(place.world(centre), place.R @ Rq @ Ry, np.array(c["half_mm"], float) + grow)


def world_box(place: SC.Place, name: str, grow: float = 0.0):
    """A record box collider as an axis-aligned (centre, half size) in the take's world, for the body solver."""
    c = BS.record()["colliders"][name]
    lo, hi = np.array(c["box_min_mm"], float), np.array(c["box_max_mm"], float)
    corners = place.world(np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]))
    a, b = corners.min(0) - grow, corners.max(0) + grow
    return (a + b) / 2, (b - a) / 2


def handwheel_pose(place: SC.Place, turn_rad: float, q0: float):
    """The handwheel body's pose (R, origin; the take's world) turned turn_rad past q0 (its joint angle)."""
    J = BS.record()["joints"]["handwheel"]
    axis, at = np.array(J["axis"], float), np.array(J["at_mm"], float)
    R = Rotation.from_rotvec(axis * (q0 + turn_rad)).as_matrix()
    return place.R @ R, place.world(at - R @ at)          # the body's origin is the station's at joint zero


class SawPlan(BenchPlan):
    """A take at the saw: where the person stands (lumbar, in the station's frame) and where the saw is put."""
    place = SC.FRONT
    lumbar_station = FRONT_LUMBAR
    # people's range weighed more than the shared 0.5: rising from the thigh over the work stop, the plan turned the
    # shoulder out to 53 deg (people's 99th percentile, 31), 92% of the load take's frames in their range. And their
    # likelihood more than the shared 0.3: the hanging left arm's plane of elevation, which means little while it
    # hangs, went to 37 deg toward the comfort centre's 50 (people's hanging arms ~15), less likely than their 95th
    # percentile all through the load take (30.0 against 28.7)
    solver_w = {"range": 3.0, "prior": 1.5}

    def __init__(self, out, state: dict | None = None, verbose: bool = True):
        self.lumbar = self.place.world(self.lumbar_station)
        self.state = state
        super().__init__(out, verbose)

    def solver_boxes(self) -> list:
        x0, x1 = SC.bar_x()
        B = SC.STOP_BLOCK
        lo = np.array([x0, SC.stop_face_y() - B["depth"], SC.bed_z()])
        hi = np.array([x1, SC.stop_face_y(), SC.bed_z() + B["height"]])
        corners = self.place.world(np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1])
                                             for z in (lo[2], hi[2])]))
        block = ((corners.min(0) + corners.max(0)) / 2, (corners.max(0) - corners.min(0)) / 2)
        return [world_box(self.place, n) for n in ("bed_front", "bed_back", "fixed_jaw_front", "work_stop")] + [block]

    def theta0(self, n) -> np.ndarray:
        """The body solve's start: the trunk and the right arm as its first grip holds them while it has a task, the
        trunk upright and the arm hanging relaxed before and after; the left, which has none, hanging throughout.
        Started from the grip's trunk throughout, the body leaned 21 deg standing at rest too."""
        r = next(g for g in self.grips.values() if g["side"] == "R")["theta"]
        th = np.tile(np.r_[r[:12], HANGING], (n, 1))
        first = min((x[0] for x in self.cons["R"]), default=0.0)
        last = max((x[1] for x in self.cons["R"]), default=0.0)
        for k in range(n):
            if not first <= k / FPS < last:
                th[k, 3:12] = HANGING
                th[k, :3] = 0.0
        return th

    def reach(self, side, grip, t0, ready, approach, opened, lead=0.12, reach_s=0.5, pre=0.25, rise_s=RISE_S,
              still_s=STILL_S, rise_via=()):
        """BenchPlan's reach to grasp: up from the thigh to ready, still, then onto the grip from approach, the hand
        widest `lead` before it comes to rest open round the grip, then closing on it. Here the rise and the pause
        are the take's (the physics arm trails a fast rise by 50-75 mm, and coming down behind its plan beside the
        saw's fixed jaw, its fingers struck the jaw's plate), and the hand pre-shapes as people's does through a
        movement: opened `pre` of the way by the middle of the rise, easing as it stops over the grip. Opened from the
        thigh straight through, it was widest at the end of the rise, unlike the card's footage, whose hand is widest
        half way through each movement. Returns when the grip has closed."""
        from moonshot.motion.bench import CLOSE_S
        g = self.grips[grip]
        t_ready = t0 + rise_s
        t_go = t_ready + still_s
        tc = t_go + reach_s
        H, W = self.grip_pose(grip, tc)
        self.transit(side, t0, t_ready, ready, via=rise_via)
        self.transit(side, t_ready, t_go, ready, fade=(H, 1.0))     # turned to the grip while it pauses over it
        self.transit(side, t_go, tc, W, via=[approach], fade=(H, 1.0))
        self.hold(side, tc, tc + CLOSE_S, H, W)
        self.fingers(side, t0 + rise_s / 2, open_like(self.hand, g["q"], pre))
        self.fingers(side, t_ready + still_s / 2, open_like(self.hand, g["q"], pre * 0.4))
        self.fingers(side, tc - lead, open_like(self.hand, g["q"], opened))
        self.fingers(side, tc, open_like(self.hand, g["q"], 0.15))
        self.fingers(side, tc + CLOSE_S, g["q"])
        return tc + CLOSE_S

    def to_rest(self, side, t0, t1, via=()):
        self.transit(side, t0, t1, self.rest, via=via)
        # the hand relaxing on the way, a little open half way: from an open hand it narrowed through the whole move,
        # widest at its start, unlike the card's footage (median half way)
        mid = blend_q(self.finger_at(side, t0), self.q_relax, 0.5)
        self.fingers(side, (t0 + t1) / 2, open_like(self.hand, mid, 0.3))
        self.fingers(side, t1, self.q_relax)

    def travel_keys(self, q, t0, t1, side="R"):
        """A hand carried between controls pre-shaped for the next: opened a little half way, as people's hands are
        widest about half way through a movement (the card's footage), then the grip's shape opened 0.2 on arrival."""
        self.fingers(side, (t0 + t1) / 2, open_like(self.hand, q, 0.4))
        self.fingers(side, t1, open_like(self.hand, q, 0.2))

    def release_keys(self, q, t_off, t0, t1, side="R"):
        """A hand let go of a grip and moved off it: still closed as it starts away, widest half way off."""
        self.fingers(side, t0, q)
        self.fingers(side, (t0 + t1) / 2, open_like(self.hand, q, 0.45))
        self.fingers(side, t1, open_like(self.hand, q, 0.3))

    def stop_block_box(self, grow=0.0):
        x0, x1 = SC.bar_x()
        B = SC.STOP_BLOCK
        lo = np.array([x0, SC.stop_face_y() - B["depth"], SC.bed_z()])
        hi = np.array([x1, SC.stop_face_y(), SC.bed_z() + B["height"]])
        return oriented_box(self.place.world((lo + hi) / 2), self.place.R, (hi - lo) / 2 + grow)

    def bar_box(self, centre, R=np.eye(3), length=None, grow=0.0):
        half = np.array([SC.STOCK["w"], length or SC.bar_mm(), SC.STOCK["h"]]) / 2 + grow
        return oriented_box(self.place.world(centre), self.place.R @ R, half)

    def save_take(self, extra: dict) -> None:
        self.save({"card": CARD, "station": "bandsaw", "place": {"at_mm": list(self.place.at_mm),
                                                                 "yaw_deg": self.place.yaw_deg}} | extra)


# --- 1. load: slide the bar to the stop ------------------------------------------------------------------------------
class LoadPlan(SawPlan):
    place = SC.BACK
    lumbar_station = BACK_LUMBAR

    def __init__(self, out=None, verbose=True):
        super().__init__(out or OUT["load"], None, verbose)
        self.bar0 = SC.bar_at(-SC.OUT_MM)
        self.paths["bar"] = [(0.0, self.place.R, self.place.world(self.bar0))]
        self.solve_grips(self.grip_specs(), {"bar": (self.place.world(self.bar0), self.place.R)})

    def solver_boxes(self) -> list:
        return [world_box(self.place, n) for n in ("bed_back", "fixed_jaw_back", "rail")] + [self.jaw_aabb()]

    def jaw_open_mm(self) -> float:
        """The movable jaw's joint (mm) as the take finds it: its face JAW_GAP_MM off the bar (moonshot/sim/bandsaw.py)."""
        return SC.bar_x()[0] - JAW_GAP_MM - SC.site_mm("jaw_face")[0]

    def jaw_box(self):
        c = BS.record()["colliders"]["jaw"]
        lo, hi = np.array(c["box_min_mm"], float), np.array(c["box_max_mm"], float)
        lo[0] += self.jaw_open_mm()
        hi[0] += self.jaw_open_mm()
        return lo, hi

    def jaw_aabb(self):
        lo, hi = self.jaw_box()
        corners = self.place.world(np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1])
                                             for z in (lo[2], hi[2])]))
        return (corners.min(0) + corners.max(0)) / 2, (corners.max(0) - corners.min(0)) / 2

    def grip_specs(self) -> dict:
        """The thumb's, index's and middle's pads together on the middle of the bar's tail, its end toward the person
        at the infeed, to push it straight along its axis: the fingers clear of the jaws, which stand 100 mm over the
        bar to 227 mm behind the blade, and of the raised bow's box, which ends 277 mm behind it. With the thumb tucked
        and the fingers anywhere on the end, the hold (between those three tips) was 46 mm off the bar's axis, and the
        push turned the bar's front into the fixed jaw."""
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731  (trunk 3, arm 7, girdle 2)
        c = self.bar0
        tail = c[1] + SC.bar_mm() / 2
        face = self.place.world([c[0], tail, c[2]])
        out = self.place.vec([0.0, 1.0, 0.0])             # its outward normal, toward the person
        hw, hh = SC.STOCK["w"] / 2, SC.STOCK["h"] / 2
        on_face = lambda x0, x1: G.plane_target(face, out, 1.0, bands(face, x=(x0, x1), z=(-hh + 6, hh - 5)))  # noqa: E731
        q0 = self.hand.neutral()
        for nm in ("index", "middle", "ring", "little"):
            q0[f"{nm}_mcp_flex"], q0[f"{nm}_pip"], q0[f"{nm}_dip"] = 30.0, 25.0, 10.0
        q0.update(ring_mcp_flex=50.0, ring_pip=60.0, little_mcp_flex=60.0, little_pip=70.0, thumb_cmc_abd=35.0,
                  thumb_cmc_flex=30.0, thumb_mcp_flex=15.0, thumb_ip=10.0)
        lo, hi = self.jaw_box()
        cols = [self.bar_box(c), saw_box(self.place, "bow", q_head=math.radians(RAISED_DEG)),
                oriented_box(self.place.world((lo + hi) / 2), self.place.R, (hi - lo) / 2)]
        cols += [saw_box(self.place, n) for n in ("bed_back", "fixed_jaw_back")]
        # and behind it, not over the bar: solved without this, the fingers hooked over the end from in front, and the
        # hand pushing the bar ran into the bow's box 85 mm on (planning only)
        top = SC.bed_z() + SC.STOCK["h"]
        over = (np.array([c[0] - 150.0, tail - 400.0, top + 3.0]), np.array([c[0] + 150.0, tail - 3.0, top + 300.0]))
        cols.append(oriented_box(self.place.world((over[0] + over[1]) / 2), self.place.R, (over[1] - over[0]) / 2))
        return {"bar": dict(of="bar", obj=self.place.world(c), q0=q0, iters=1000, colliders=cols,
                            targets={"thumb": on_face(-16, 16), "index": on_face(-16, 16), "middle": on_face(-16, 16)},
                            # from the arm hanging nearly straight, turned palm forward, as people's hand goes down
                            # to the end of a bar at their thigh: reaching from a bent elbow and a leaning trunk, the
                            # arm was less likely than people's 95th percentile, and the left, hanging from that
                            # trunk, too
                            starts=[S(f, 0, 0, 20, el, -30, eb, p, 15, 0) for f in (5, 12) for el in (15, 28)
                                    for eb in (20, 40) for p in (-45, -20)])}

    def compose(self):
        self.t = 0.5
        g = self.grips["bar"]
        R0, p0 = self.place.R, self.place.world(self.bar0)
        _, Wg = self.grip_pose("bar", self.t)
        up, back = self.place.vec([0, 0, 1.0]), self.place.vec([0, 1.0, 0])     # back: toward the person
        self.look(0.0, p0 + back * (SC.bar_mm() / 2 - 40))
        # up off the thigh to over the tail and back from it, a pause, then onto it: the rise slower than the reach
        # (a reach is timed from the last stop before the fastest frame of the 2 s before contact), the hand widest
        # 0.10 s before it comes to rest (its fingers meet the end as the wrist stops, and the hand is
        # widest 0.04 s before its key: 0.16 s before, it was widest 66% of the way)
        # level onto the end face over its last 35 mm: coming down onto it, the fingers caught its top edge, rolled the
        # bar 2.6 deg and lifted its tail 4 mm, and it jammed between the jaws
        tg = self.reach("R", "bar", self.t, ready=Wg + up * 50 + back * 110, approach=Wg + back * 35,
                        opened=0.6, lead=0.10, rise_s=2.0, still_s=0.45)
        self.effort("R", tg, 0.0, "bar")
        self.effort("R", tg + 0.25, PUSH_EFFORT, "bar")
        t_slide = tg + 0.3
        slide = SC.stop_face_y() - STOP_INTO_MM - (self.bar0[1] - SC.bar_mm() / 2)        # along +Y: negative
        self.look(t_slide, self.place.world([SC.fixed_face_x(), SC.stop_face_y(), SC.bed_z() + 20]))
        # slid a hair off the fixed jaw, then pressed onto it as it is held at the stop: its end starts in the gap
        # between the jaw's two plates, and aimed into the jaw as it slid, its corner caught the front plate's end
        p1 = p0 + self.place.vec([-SLIDE_OFF_JAW_MM, slide, 0.0])
        self.move("bar", t_slide, t_slide + SLIDE_S, R0, p1)
        t_held = t_slide + SLIDE_S
        t_off = t_held + HOLD_S
        self.move("bar", t_held, t_held + HOLD_S * 0.6, R0, p1 + self.place.vec([JAW_INTO_MM + SLIDE_OFF_JAW_MM, 0, 0]))
        self.carry("bar", tg, t_off)
        # the bar's friction on the bed, felt and pushed against as it slides, then a light push holding it to the stop
        # and against the fixed jaw (the card's phase 7), so it doesn't drift toward the open jaw
        friction = SC.STOCK["friction"] * SC.stock_kg(SC.bar_mm()) * 9.81
        along = np.array([0.0, -1.0, 0.0])     # straight along it: pushed toward the fixed jaw by its tail, it yawed
                                               # 0.65 deg and wedged between the jaws
        self.event("drag", t_slide - 0.1, t_held + 0.1, side="R", direction=(self.place.vec(along) / np.linalg.norm(along)).tolist(),
                   force=round(float(np.linalg.norm(along)) * friction, 2))
        hold = np.array([JAW_N, -HOLD_N, -DOWN_N])
        self.event("drag", t_held - 0.1, t_off - 0.05, side="R", direction=(self.place.vec(hold) / np.linalg.norm(hold)).tolist(),
                   force=round(float(np.linalg.norm(hold)), 2))
        self.event("grip", tg, t_off + 0.1, side="R", grip="bar", on="bar")
        self.event("carry", tg + 0.05, t_off, obj="bar", grip="bar", side="R")
        # pushed by its end, the bar keeps its own turn, which the bed and the jaws square: held to the hand's, a
        # degree's yaw from the arm wedged it between the jaws, 2.3 mm wider than it (the push is fed forward at the
        # fingers, moonshot/sim/bandsaw.py hand_forces, so the hand doesn't pivot on them)
        self.event("loose", tg + 0.05, t_off, obj="bar")
        self.effort("R", t_off - 0.1, PUSH_EFFORT, "bar")
        self.effort("R", t_off + 0.1, 0.0, "bar")
        _, W = self.grip_pose("bar", t_off)
        self.release_keys(g["q"], t_off, t_off + 0.05, t_off + 0.55)
        self.wrist["R"] = W
        self.transit("R", t_off + 0.05, t_off + 0.55, W + up * 40 + back * 50)
        self.to_rest("R", t_off + 0.55, t_off + 1.6)
        self.t = t_off + 1.8
        self.clip("load", 0.0, self.t, "LOAD  the bar pushed along the bed from the infeed until its end meets the stop")
        self.slide = {"t0": t_slide, "t1": t_held, "mm": -slide}


# --- 2. clamp: the handwheel ----------------------------------------------------------------------------------------------
CONTROL_BOX = {"centre": (-1250.3, -234.8), "u": (0.724, -0.689), "u_mm": (-142.3, 190.4), "v_mm": (-76.6, 106.4),
               "top": 836.0, "bottom": 702.0}   # measured on the base's GLB: the control box the record has no collider
                                                # for, for planning a hand onto its knobs (not a physics collider)
KNOBS = {"start": {"at": (-1171.6, -283.5), "top": 867.0, "r": 14.0},          # measured on the GLB, as above
         "feed_valve": {"at": (-1276.6, -164.4), "top": 852.5, "r": 13.0}}


def on_knob(a, u, r, lo, hi, comp=2.0, w=1.0):
    """A pad on a knob's barrel (its root at a, outward along u, radius r), facing its axis, between lo and hi from
    the root (the vise take's crank knob: moonshot/motion/setup_take.py)."""
    import torch
    A, U = torch.as_tensor(np.asarray(a, float)), torch.as_tensor(np.asarray(u, float))

    def f(c, n):
        rel = c - A
        t = rel @ U
        radial = rel - t * U
        dist = torch.linalg.norm(radial)
        return w * ((dist - (r - comp)) ** 2 + 20 * (1.0 + n @ (radial / dist)) ** 2
                    + 0.5 * (torch.relu(lo - t) ** 2 + torch.relu(t - hi) ** 2))
    return f


class ClampPlan(SawPlan):
    place = SC.END
    lumbar_station = END_LUMBAR

    # people's range weighed more again: bent to the knob, the trunk's side-bend went 1 deg past the left arm's view of
    # their range (-8.4 deg) for 14% of the take
    solver_w = {"range": 8.0, "prior": 1.5}

    def __init__(self, state: dict, out=None, verbose=True):
        super().__init__(out or OUT["clamp"], state, verbose)
        self.q_wheel = state["q"]["handwheel"]
        self.t_turn = None
        self.gap_mm = self.jaw_gap(state)
        self.turn_deg = min(KNOB_TURN_DEG, self.gap_mm / BS.record()["joints"]["handwheel"]["lead_mm"] * 360 + SNUG_DEG)
        self.paths["saw_handwheel"] = [(0.0, *handwheel_pose(self.place, 0.0, self.q_wheel))]
        p, R = handwheel_pose(self.place, 0.0, self.q_wheel)[::-1]
        self.solve_grips(self.grip_specs(), {"saw_handwheel": (p, R)})

    def solver_boxes(self) -> list:
        return [world_box(self.place, "rail")]

    @staticmethod
    def jaw_gap(state: dict) -> float:
        """How far the jaw has to close to pinch the bar against the fixed jaw (mm): the space between the jaws less
        the bar's width, wherever the bar lies in it. The screw closes that, then snugs."""
        jaw = SC.site_mm("jaw_face")[0] + state["q"]["jaw"] * 1000
        return float(SC.fixed_face_x() - jaw - SC.STOCK["w"])

    def obj_at(self, name, t):
        """The handwheel turns smoothly through its half turn (BenchPlan's keys would stop it at each)."""
        if name != "saw_handwheel" or self.t_turn is None:
            return super().obj_at(name, t)
        return handwheel_pose(self.place, math.radians(self.turn_deg) * min_jerk((t - self.t_turn) / KNOB_TURN_S),
                              self.q_wheel)

    def knob_axis(self, turn: float = 0.0):
        """The handwheel's knob: its root at the rim and its axis outward (world mm), the wheel turned by turn."""
        c = BS.record()["colliders"]["handwheel_knob"]
        x0, x1 = c["cylinder_x_mm"]
        _, y, z = c["at_mm"]
        R, o = handwheel_pose(self.place, turn, self.q_wheel)
        root = o + R @ np.array([x1, y, z])
        return root, self.place.vec([-1.0, 0.0, 0.0]), x1 - x0

    def knob_mid(self, t: float) -> np.ndarray:
        """The handwheel knob's middle at t, as the plan turns the wheel (world mm)."""
        R, o = self.obj_at("saw_handwheel", t)
        R0, o0 = handwheel_pose(self.place, 0.0, self.q_wheel)
        root, out, length = self.knob_axis()
        return o + R @ (R0.T @ (root + out * length / 2 - o0))

    def grip_specs(self) -> dict:
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731
        h = self.hand
        specs = {}
        # the fist round the handwheel's knob as round a suitcase's handle: the knob points at the person at their
        # thigh, so the arm reaches down nearly hanging, the palm toward the body's middle, the index by the wheel
        # and the ring by the knob's free end, the thumb over them
        root, out, length = self.knob_axis()
        r = BS.record()["colliders"]["handwheel_knob"]["radius_mm"]
        q0 = h.neutral()
        for n in ("index", "middle", "ring", "little"):
            q0[f"{n}_mcp_flex"], q0[f"{n}_pip"] = 55.0, 70.0
        q0.update(thumb_cmc_abd=15.0, thumb_cmc_flex=10.0, thumb_mcp_flex=30.0, thumb_ip=25.0)
        on = lambda lo, hi, w=1.0: on_knob(root, out, r, lo, hi, w=w)       # noqa: E731
        specs["knob"] = dict(of="saw_handwheel", obj=root + out * length / 2, q0=q0, iters=1200,
                             colliders=[lambda p: G.sdf_cyl(p, root, root + out * length, r),
                                        saw_box(self.place, "handwheel"), saw_box(self.place, "rail")],
                             # the 62 mm knob takes three fingers, the little curled past its end. Turned the other
                             # way, the index at its free end, the fist was pronated 60 deg and the wrist bent 65,
                             # far from people's (the posture's likelihood 47 against their 28.7)
                             targets={"index": on(6, 18), "middle": on(22, 34), "ring": on(38, 50),
                                      "thumb": on(10, 40, w=0.2)},
                             # from a deeper lean, the arm raised and the elbow bent, as people's arms work in front
                             # of them: from the arm hanging nearly straight under a 35 deg lean, the turn was still
                             # less likely than people's (30.7)
                             starts=[S(f, 0, 0, pl, el, -30, eb, 20, -10, 0) for f in (45, 55) for pl in (50, 70)
                                     for el in (45, 60) for eb in (45, 70)])
        return specs

    def compose(self):
        self.t = 0.4
        g = self.grips["knob"]
        root, out, length = self.knob_axis()
        self.look(0.0, root + out * length / 2)
        _, Wg = self.grip_pose("knob", self.t)
        up, back = np.array([0, 0, 1.0]), np.array([0, -1.0, 0])
        # timed as the bar's: the rise slower than the reach, and the fingers meeting the knob 0.1-0.25 s before the
        # wrist stops (widest 0.12 s before that, it was widest as it touched; 0.36, at 43% of the reach)
        tg = self.reach("R", "knob", self.t, ready=Wg + up * 150 + back * 140, approach=Wg + back * 50 + up * 10,
                        opened=0.7, lead=0.33, reach_s=0.6, rise_s=2.0, still_s=0.45)
        self.effort("R", tg, 0.0, "knob")
        self.effort("R", tg + 0.25, 0.4, "knob")
        self.t_turn = tg + 0.3
        t_off = self.t_turn + KNOB_TURN_S + 0.2
        # the fist keeps its turn and goes round with the knob, which spins in it (as the vise take's crank knob)
        H0, W0 = self.grip_pose("knob", tg)
        mid0 = self.knob_mid(tg)
        self.add("R", tg, t_off, lambda t: [("pose", H0, W0 + self.knob_mid(t) - mid0, 3.0)])
        self.event("grip", tg, t_off + 0.1, side="R", grip="knob", on="saw_handwheel")
        self.event("carry", tg + 0.1, t_off, obj="saw_handwheel", grip="knob", side="R")
        self.event("loose", tg + 0.1, t_off, obj="saw_handwheel")      # the knob spins in the fist
        self.event("turn", self.t_turn, self.t_turn + KNOB_TURN_S, side="R", obj="saw_handwheel", force=KNOB_N,
                   q0=self.q_wheel, turn_rad=math.radians(self.turn_deg))
        self.effort("R", t_off - 0.1, 0.4, "knob")
        self.effort("R", t_off + 0.1, 0.0, "knob")
        W = W0 + self.knob_mid(t_off) - mid0
        self.fingers("R", t_off, g["q"])
        self.release_keys(g["q"], t_off, t_off + 0.05, t_off + 0.5)
        self.wrist["R"] = W
        self.transit("R", t_off + 0.05, t_off + 0.5, W + back * 60 + up * 30)
        self.clip("clamp", 0.0, t_off + 0.4, "CLAMP  the handwheel turned until the jaw is snug on the bar")
        self.t = t_off + 0.5
        self.to_rest("R", self.t, self.t + 1.1)
        self.t += 1.3


# --- 3. start: Start and the feed valve, in front of the control box ----------------------------------------------
class StartPlan(SawPlan):
    """Press Start, then turn the feed valve's knob a quarter turn open: the blade runs up to speed, then the bow comes
    down at the cutting feed (the card's phases 10-12). The same for every bar (moonshot/planning/takes.py saw-start).
    Standing in front of the control box, which faces the saw's front-left corner: the saw turned under the body so
    the box faces it (START)."""
    place = SC.START
    lumbar_station = START_LUMBAR

    def __init__(self, state: dict, out=None, verbose=True):
        super().__init__(out or OUT["start"], state, verbose)
        self.valve0 = state["q"]["feed_valve"]
        self.t_turn = None
        self.paths["saw_feed_valve"] = [(0.0, *self.valve_pose(0.0))]
        p, R = self.valve_pose(0.0)[::-1]
        self.solve_grips(self.grip_specs(), {"saw_feed_valve": (p, R)})

    def solver_boxes(self) -> list:
        return []

    def valve_pose(self, turn: float):
        """The valve body's pose (R, origin; world) turned turn (rad) past where the take finds it."""
        J = BS.record()["joints"]["feed_valve"]
        R = Rotation.from_rotvec(np.array(J["axis"], float) * (self.valve0 + turn)).as_matrix()
        return self.place.R @ R, self.place.world(J["at_mm"])

    def obj_at(self, name, t):
        if name != "saw_feed_valve" or self.t_turn is None:
            return super().obj_at(name, t)
        return self.valve_pose(math.radians(VALVE_TURN_DEG) * min_jerk((t - self.t_turn) / VALVE_TURN_S))

    def box_colliders(self):
        """The control box and its knobs (planning only)."""
        B = CONTROL_BOX
        u = np.array([*B["u"], 0.0])
        v = np.array([-u[1], u[0], 0.0])
        lo = np.array([B["u_mm"][0], B["v_mm"][0], B["bottom"]])
        hi = np.array([B["u_mm"][1], B["v_mm"][1], B["top"]])
        c = np.array([*B["centre"], 0.0]) + u * (lo[0] + hi[0]) / 2 + v * (lo[1] + hi[1]) / 2
        c[2] = (lo[2] + hi[2]) / 2
        R = np.stack([u, v, [0, 0, 1.0]], 1)
        out = [oriented_box(self.place.world(c), self.place.R @ R, (hi - lo) / 2)]
        for k in KNOBS.values():
            a, b = self.place.world([*k["at"], B["top"]]), self.place.world([*k["at"], k["top"]])
            out.append(lambda p, a=a, b=b, r=k["r"]: G.sdf_cyl(p, a, b, r))
        return out

    def knob_top(self, name: str) -> np.ndarray:
        k = KNOBS[name]
        return self.place.world([*k["at"], k["top"]])

    def onto(self, grip, t0, t_on, t_off, rise=35.0, pose_off=None, press_mm=0.0):
        """A hand onto a control from above and off it again: down over its last rise mm onto the grip (press_mm
        past it, a button's travel), held (unless the caller holds it: pose_off, the hand's pose (H, W) at t_off), up."""
        g = self.grips[grip]
        up = np.array([0, 0, 1.0])
        H, W = g["H"], g["W"] - up * press_mm
        above = W + up * rise
        self.transit("R", t0, t_on - 0.35, above, fade=(H, 2.0))
        self.add("R", t_on - 0.35, t_on, lambda t: [("pose", H, above + (W - above) * min_jerk((t - t_on + 0.35) / 0.3),
                                                    3.0)])
        if pose_off is None:
            self.hold("R", t_on, t_off, H, W)
        Ho, Wo = pose_off or (H, W)
        self.add("R", t_off, t_off + 0.3, lambda t: [("pose", Ho, Wo + up * rise * min_jerk((t - t_off) / 0.25), 2.0)])
        self.wrist["R"] = Wo + up * rise
        self.travel_keys(g["q"], t0, t_on - 0.35)
        self.fingers("R", t_on - 0.05, g["q"])
        self.release_keys(g["q"], t_off, t_off, t_off + 0.3)

    def press_start(self):
        """The index's tip down onto Start: the blade runs up to speed before the bow is let down."""
        t0 = self.t
        self.look(t0, self.knob_top("start"))
        # held down through the button's travel for 0.6 s: for 0.35 s, the arm arriving late, the pad came within 13 mm
        # of its top and went
        t_on, t_off = t0 + 1.0, t0 + 1.6
        self.onto("start", t0, t_on, t_off, press_mm=START_TRAVEL_MM)
        self.event("button", t_on - 0.05, t_off, side="R", button="start", digit="index",
                   at=self.knob_top("start").tolist(), force=5.0, travel_mm=START_TRAVEL_MM)
        self.clip("start", t0, t_off + 0.4, "START  the blade runs up to speed before the bow comes down")
        self.t = t_off + 0.5

    def grip_specs(self) -> dict:
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731
        h = self.hand
        starts = [S(f, 0, 0, pl, 40, r, 45, p, -10, 0) for f in (10, 25) for pl in (55, 80) for r in (-10,)
                  for p in (40, 75)]
        # the index's pad down on Start's top, the other fingers curled (VF-2's Cycle Start: moonshot/motion/door_cycle.py)
        b = self.knob_top("start")
        q0 = h.neutral()
        q0.update(index_mcp_flex=15, index_pip=20, middle_mcp_flex=75, middle_pip=95, ring_mcp_flex=80, ring_pip=95,
                  little_mcp_flex=80, little_pip=90, thumb_cmc_flex=15, thumb_cmc_abd=5, thumb_mcp_flex=40, thumb_ip=35)
        specs = {"start": dict(of=None, obj=b, q0=q0, iters=900, colliders=self.box_colliders(),
                               targets={"index": G.plane_target(b, np.array([0, 0, 1.0]), 2.0,
                                                                bands(b, x=(-5, 5), y=(-5, 5)))},
                               starts=starts)}
        # thumb and index pinching the valve's knob, either side of it, the middle beside the index
        J = BS.record()["joints"]["feed_valve"]
        c = BS.record()["colliders"]["feed_valve"]
        z0, z1 = c["cylinder_z_mm"]
        axis_p = self.place.world([J["at_mm"][0], J["at_mm"][1], z0])
        up = np.array([0, 0, 1.0])
        from moonshot.motion.deburr import on_cylinder
        toward = -self.place.vec(np.array([*CONTROL_BOX["u"], 0.0]))     # the person's left, along the box
        barrel = lambda side, lo=4.0, hi=13.0: on_cylinder(axis_p, up, c["radius_mm"], lo, hi, side=side)   # noqa: E731
        q0 = h.neutral()
        q0.update(index_mcp_flex=40, index_pip=45, middle_mcp_flex=45, middle_pip=50, ring_mcp_flex=65, ring_pip=80,
                  little_mcp_flex=70, little_pip=80, thumb_cmc_abd=35, thumb_cmc_flex=20, thumb_mcp_flex=20, thumb_ip=15)
        specs["valve"] = dict(of="saw_feed_valve", obj=axis_p + up * (z1 - z0) / 2, q0=q0, iters=1000,
                              colliders=[c_ for c_ in self.box_colliders()[:1]] +
                              [lambda q: G.sdf_cyl(q, axis_p, axis_p + up * (z1 - z0), c["radius_mm"])],
                              targets={"thumb": barrel(toward), "index": barrel(-toward)},
                              starts=starts)
        return specs

    def compose(self):
        self.t = 0.4
        self.look(0.0, self.knob_top("start"))
        self.press_start()
        g = self.grips["valve"]
        J = BS.record()["joints"]["feed_valve"]
        knob = self.place.world(J["at_mm"])
        self.look(self.t, knob)
        _, Wg = self.grip_pose("valve", self.t)
        up, back = np.array([0, 0, 1.0]), np.array([0, -1.0, 0])
        tg = self.reach("R", "valve", self.t, ready=Wg + up * 90 + back * 60, approach=Wg + up * 30, opened=0.6,
                        lead=0.2, rise_s=1.0, still_s=0.35, reach_s=0.5)
        self.effort("R", tg, 0.0, "valve")
        self.effort("R", tg + 0.2, 0.3, "valve")
        self.t_turn = tg + 0.25
        t_off = self.t_turn + VALVE_TURN_S + 0.15
        self.carry("valve", tg, t_off)
        self.event("grip", tg, t_off + 0.1, side="R", grip="valve", on="saw_feed_valve")
        self.event("carry", tg + 0.05, t_off, obj="saw_feed_valve", grip="valve", side="R")
        self.effort("R", t_off - 0.1, 0.3, "valve")
        self.effort("R", t_off + 0.1, 0.0, "valve")
        _, W = self.grip_pose("valve", t_off)
        self.release_keys(g["q"], t_off, t_off + 0.05, t_off + 0.45)
        self.wrist["R"] = W
        self.transit("R", t_off + 0.05, t_off + 0.45, W + up * 50)
        self.clip("feed", tg - 1.5, t_off + 0.4, "FEED  the valve a quarter turn open: the bow comes down")
        self.to_rest("R", t_off + 0.45, t_off + 1.5)
        self.look(t_off + 0.5, self.place.world([60.0, 0.0, 750.0]))
        self.t = t_off + 2.8
        self.clip("cut", t_off + 0.5, self.t, "CUT  hands off while the bow comes down and cuts")


# --- 5. lift-out: the cut piece to the bench ------------------------------------------------------------------------
class UnloadPlan(SawPlan):
    """The cut piece off the bed and onto the bench: slid off the fixed jaw's plate by the fingers on its top, then taken
    by its sides, thumb against index and middle, lifted over the stop block and set down beside the right hip."""

    def __init__(self, state: dict, out=None, verbose=True):
        super().__init__(out or OUT["unload"], state, verbose)
        s = state["stock"]["piece"]
        self.piece0 = (np.array(s["centre"], float), np.array(s["R"], float))
        self.length = s["length"]
        self.head = state["q"]["head"]
        c, R = self.piece0
        self.slid = c + np.array([-SLIDE_OFF_MM, 0.0, 0.0])
        self.paths["piece"] = [(0.0, self.place.R @ R, self.place.world(c))]
        specs = self.grip_specs()
        specs["pinch"]["at"] = (self.place.world(self.slid), self.place.R @ R)
        self.solve_grips(specs, {"piece": (self.place.world(c), self.place.R @ R)})

    def colliders(self, centre):
        c, R = centre, self.piece0[1]
        return ([self.bar_box(c, R, self.length), self.stop_block_box(), saw_box(self.place, "bow", q_head=self.head)]
                + [saw_box(self.place, n) for n in ("bed_front", "fixed_jaw_front")])

    def grip_specs(self) -> dict:
        """On its top, the fingers' pads along it toward the blade, their tips short of the bow (its box spans the
        window from 33.6 mm in front of the blade with the bow down), the palm over the stop block. Then, slid off
        the plate, by its sides: the thumb on its near side, the index and middle on its far side in the gap the slide
        opened, the card's prismatic grasp from above with two fingers, not four (between the stop block and the bow
        there is 50 mm of it)."""
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731  (trunk 3, arm 7, girdle 2)
        c, R = self.piece0
        end = c[1] - self.length / 2                       # its end against the stop block
        hw, hh = SC.STOCK["w"] / 2, SC.STOCK["h"] / 2
        up = self.place.vec([0.0, 0.0, 1.0])
        top = self.place.world([c[0], end + 30.0, c[2] + hh])
        on_top = lambda lo, hi: G.plane_target(top, up, 2.0, bands(top, x=(-hw + 4, hw - 4), y=(lo, hi)))   # noqa: E731
        q0 = self.hand.neutral()
        for nm in ("index", "middle", "ring", "little"):
            q0[f"{nm}_mcp_flex"], q0[f"{nm}_pip"] = 25.0, 15.0
        q0.update(thumb_cmc_abd=20.0, thumb_cmc_flex=0.0, thumb_mcp_flex=10.0, thumb_ip=5.0)
        starts = [S(f, 0, 0, pl, 40, r, 50, p, 0, 0) for f in (25, 40) for pl in (60, 80) for r in (-20,)
                  for p in (60, 85)]
        specs = {"top": dict(of="piece", obj=self.place.world(c), q0=q0, iters=1000, colliders=self.colliders(c),
                             targets={"index": on_top(-6, 10), "middle": on_top(-6, 10), "ring": on_top(-12, 6)},
                             starts=starts)}
        cs = self.slid
        at = np.array([cs[0], end + 24.0, cs[2]])
        near, far = self.place.world(at - [hw, 0, 0]), self.place.world(at + [hw, 0, 0])
        nx = self.place.vec([1.0, 0.0, 0.0])
        side = lambda p, n, lo, hi: G.plane_target(p, n, 2.0, bands(p, y=(lo, hi), z=(-hh + 7, hh - 3)))  # noqa: E731
        q0 = self.hand.neutral()
        for nm in ("index", "middle"):
            q0[f"{nm}_mcp_flex"], q0[f"{nm}_pip"], q0[f"{nm}_dip"] = 50.0, 55.0, 25.0
        for nm in ("ring", "little"):                       # curled out of the way
            q0[f"{nm}_mcp_flex"], q0[f"{nm}_pip"], q0[f"{nm}_dip"] = 75.0, 90.0, 40.0
        q0.update(thumb_cmc_abd=40.0, thumb_cmc_flex=20.0, thumb_mcp_flex=15.0, thumb_ip=10.0)
        specs["pinch"] = dict(of="piece", obj=self.place.world(at), q0=q0, iters=1000, colliders=self.colliders(cs),
                              load=round(SC.stock_kg(self.length), 2),
                              targets={"thumb": side(near, -nx, -8, 6), "index": side(far, nx, 3, 11),
                                       "middle": side(far, nx, -14, -6)},
                              starts=[S(f, 0, 0, pl, 40, r, 60, p, 0, 0) for f in (25, 40) for pl in (60, 80)
                                      for r in (-20,) for p in (70, 95)])
        return specs

    def set_down_at(self):
        """Where the piece is set down: on the bench beside the right hip, along it as it lay, by the bench's back edge
        (centre mm, world)."""
        lo, hi = np.array(SC.BENCH["lo"]), np.array(SC.BENCH["hi"])
        c = np.array([lo[0] + 90.0, hi[1] - self.length / 2 - 25.0, SC.bench_top_mm() + SC.STOCK["h"] / 2 + 0.3])
        return self.place.world(c)

    def compose(self):
        self.t = 0.5
        R0, p0 = self.place.R @ self.piece0[1], self.place.world(self.piece0[0])
        p1 = self.place.world(self.slid)
        up, back = self.place.vec([0, 0, 1.0]), self.place.vec([0, -1.0, 0])
        left = self.place.vec([-1.0, 0, 0])
        self.look(0.0, p0)
        # 1. the fingers onto its top, as the load take's onto the bar: up off the thigh, paused low and back from it,
        # then on
        g = self.grips["top"]
        _, Wg = self.grip_pose("top", self.t)
        tg = self.reach("R", "top", self.t, ready=Wg + up * 40 + back * 120, approach=Wg + up * 20 + back * 30,
                        opened=0.6, lead=0.21, rise_s=2.0, still_s=0.45)
        self.effort("R", tg, 0.0, "top")
        self.effort("R", tg + 0.25, 0.3, "top")
        t_slide = tg + 0.3
        self.move("piece", t_slide, t_slide + SLIDE_OFF_S, R0, p1)
        t_off = t_slide + SLIDE_OFF_S + 0.15
        self.carry("top", tg, t_off)
        # its friction on the bed, pushed against as it slides, and the fingers' press down on it (a press, not a
        # grasp: the grasp is the next; moonshot/validate/grasp_timing.py)
        friction = SC.STOCK["friction"] * SC.stock_kg(self.length) * 9.81
        along = np.array([-1.0, 0.0, -DOWN_N / friction])
        self.event("drag", t_slide - 0.1, t_off - 0.05, side="R", direction=(self.place.vec(along) / np.linalg.norm(along)).tolist(),
                   force=round(float(np.linalg.norm(along)) * friction, 2))
        self.event("grip", tg, t_off + 0.1, side="R", grip="top")
        self.event("carry", tg + 0.1, t_off, obj="piece", grip="top", side="R")
        self.effort("R", t_off - 0.1, 0.3, "top")
        self.effort("R", t_off + 0.1, 0.0, "top")
        _, W = self.grip_pose("top", t_off)
        self.release_keys(g["q"], t_off, t_off + 0.05, t_off + 0.4)
        self.wrist["R"] = W
        self.transit("R", t_off + 0.05, t_off + 0.4, W + up * 45 + left * 10)
        self.clip("slide", 0.0, t_off + 0.3, "SLIDE  the cut piece off the fixed jaw's plate")
        # 2. round its sides from above, thumb to the near side, index and middle into the gap by the plate
        g = self.grips["pinch"]
        _, Wg = self.grip_pose("pinch", t_off)
        t0 = t_off + 0.5
        tg = self.reach("R", "pinch", t0, ready=Wg + up * 70, approach=Wg + up * 30, opened=0.8, lead=0.21,
                        rise_s=0.5, still_s=0.3, reach_s=0.5)
        self.effort("R", tg, 0.0, "pinch")
        self.effort("R", tg + 0.25, 0.5, "pinch")
        self.t_lift = tg + PRELOAD_S
        self.move("piece", self.t_lift, self.t_lift + TAKE_S, R0, p1 + up * TAKE_MM)
        self.move("piece", self.t_lift + TAKE_S, self.t_lift + LIFT_S, R0, p1 + up * 50)    # over the stop block
        down = self.set_down_at()
        # back from the saw and up over the work stop's arm, to over the bench, then down onto it
        t_over = self.t_lift + LIFT_S + 1.4
        self.look(self.t_lift + LIFT_S, down)
        self.move("piece", self.t_lift + LIFT_S, t_over, R0, down + up * 50)
        t_down = t_over + 0.6
        self.move("piece", t_over, t_down, R0, down)
        t_off = t_down + 0.1
        self.carry("pinch", tg, t_off)
        self.event("grip", tg, t_off + 0.1, side="R", grip="pinch", on="piece")
        self.event("carry", self.t_lift, t_off, obj="piece", grip="pinch", side="R", ease_in=CARRY_EASE_S)
        # its weight, which the hand knows and bears as it lifts, fed forward through the arm (carried on the plan
        # alone, a 1.5 kg piece sagged the hand 116 mm and was let go in the air)
        self.event("drag", self.t_lift, t_down - 0.05, side="R", direction=[0.0, 0.0, 1.0],
                   force=round(SC.stock_kg(self.length) * 9.81, 2))
        self.effort("R", t_off - 0.1, 0.5, "pinch")
        self.effort("R", t_off + 0.1, 0.0, "pinch")
        _, W = self.grip_pose("pinch", t_off)
        self.release_keys(g["q"], t_off, t_off + 0.05, t_off + 0.5)
        self.wrist["R"] = W
        self.transit("R", t_off + 0.05, t_off + 0.5, W + up * 60)
        self.to_rest("R", t_off + 0.5, t_off + 1.5)
        self.t = t_off + 1.7
        self.clip("unload", t0 - 0.2, self.t, "UNLOAD  the cut piece lifted off the bed and set on the bench")
        self.down = {"t": t_down, "at_mm": down.tolist()}


def state_of(take: str) -> dict:
    return json.loads((OUT[take] / "state.json").read_text(encoding="utf-8"))


def build(take: str, solve=True, verbose=True):
    """Plan a take of the part use_part set. The controls' take starts from the part's clamp take: the same for every
    bar, it is planned once, with the first part's bar in the vise."""
    if take == "load":
        plan = LoadPlan(verbose=verbose)
    elif take == "clamp":
        plan = ClampPlan(state_of("load"), verbose=verbose)
    elif take == "start":
        plan = StartPlan(state_of("clamp"), verbose=verbose)
    else:
        plan = UnloadPlan(state_of("cut"), verbose=verbose)
    plan.compose()
    if solve:
        plan.solve()
        extra = ({"slide": plan.slide} if take == "load" else {"set_down": plan.down} if take == "unload" else
                 {"valve_turn_deg": VALVE_TURN_DEG} if take == "start" else
                 {"jaw_off_bar_mm": round(plan.gap_mm, 3), "turn_deg": round(plan.turn_deg, 1)})
        plan.save_take(extra | {"part": SC.STOCK["part"], "blank_mm": SC.STOCK["blank_mm"], "jaw_gap_mm": JAW_GAP_MM,
                                "raised_deg": RAISED_DEG, "feed_mm_s": CUT_FEED_MM_S})
    return plan


if __name__ == "__main__":
    use_part(sys.argv[1])
    build(sys.argv[2])
