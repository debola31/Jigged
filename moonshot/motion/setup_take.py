"""Ported from trainual's motion/setup_take.py, unchanged in behaviour (its regeneration is tested against the
accepted take). The motion library (prototype item 3.3): grab, hold, place, slide, push, rotate, measure, as verbs that
compose into one continuous, physically simulated setup take.

    python -m moonshot.motion.setup_take     # -> <data root>/takes/setup-take/reference.npz (+ grips.json, take.json)

Each verb is a method on Take that appends, over its time span:
- task constraints for the body solver (a held grip relative to its object, a wrist path, a knob region),
- finger keys (pre-shape, close at contact, ease, release), grip effort (preload and loading timing),
- what the eyes look at (the next contact landmark, as people do), and
- physics events for moonshot/sim/vise_take.py (which grip squeezes, pushing with a force, the knob enclosure, closed-loop
  cranking, releasing a parallel for the check).

Every grip is solved per affordance with the body that holds it (grasp.Problem.solve_body), and the whole take's
body motion is one trajectory (body_solver) under the shared posture cost (research-based comfort, joint limits,
the GRAB/ARCTIC prior), effort, smoothness and speed limits. (trainual's docs/motion-pipeline.md and docs/motion-library.md.)

The take, in setup order (a machinist's sequence):
  grab    the blank off the table: reach, open wider than it (peak at ~74% of the reach), close, preload, load, lift
  hold    lift it in front and turn it to look at a face, steady, then back
  place   carry it over the moving jaw and set it on the parallels 6 mm short of the fixed jaw; let go by lifting
  slide   the thumb on its near face pushes it the 6 mm onto the fixed jaw
  rotate  crank the jaw onto the part until snug: the fist keeps its orientation, the knob spins in it
  push    flat fingers press it down onto the parallels (30 N) while the snug vise still lets it move down
  (rotate again: the final pull on the crank, ending on feel)
  measure the fingertip check: press each parallel's exposed end and feel that it can't move
"""
from __future__ import annotations

import hashlib
import inspect
import json
import math
import time
from pathlib import Path

import numpy as np
import torch
from scipy.spatial.transform import Rotation

from moonshot.body.hand import ANATOMY, AnatomicalHand
from moonshot.body.nimble import Nimble
from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion import kinematics as BM
from moonshot.motion import solver as BS
from moonshot.motion.primitives import FPS, PosePath, blend_q, min_jerk, open_for, open_like, relaxed, tremor
from moonshot.world.vise import (CRANK0_DEG, PARALLEL_L, PARALLEL_T, REFERENCE, STOP_MM, TABLE_Z, VISE, Load,
                                 crank_for_opening, knob_center, tip_y)

MOONSHOT = Path(__file__).resolve().parents[1]
TAKES = data_root() / "takes"
OUT = TAKES / "setup-take"                                # the reference load's take
# standing 120 mm further back than at first (2026-11-03): at -935 the elbow sat bent 70 deg at the median, where
# people standing at work keep it nearer 20 (AnDy), and the take's posture was unlike theirs
LUMBAR = np.array([-415.0, -1055.0, 955.0])
REST_W = np.array([-205.0, -1000.0, 850.0])               # hand hanging relaxed by the right thigh
KNOB_AXIS = np.array([0.0, -1.0, 0.0])
CRANK0 = CRANK0_DEG
SEAT_Z = VISE["seat_z"]
PAR_T, PAR_L = PARALLEL_T, PARALLEL_L
PLACE_GAP = 6.0
TALL_PLACE_GAP = 15.0
STOP_GAP = 1.5                     # a part set against a stop is set down this far off it, and slid onto it: from 4 mm,
                                   # pushed along the jaw at its pinch, op50's tall part leaned over the stop's top
# the usage card a take plays (moonshot/cards), whose footage the take is held to: loading is the Kurt card's; no card
# covers lifting a part out yet
CARD = {"stage": {"card": "kurt-vise-load-and-clamp"}}
INSPECT = np.array([-290.0, -640.0, 1080.0])              # held up in front, below the eyes, to look at it: at 1160 the
                                                          # elbow bent 93 deg to hold it there
JAW_TOP = VISE["jaw_top_z"]

# reach to grasp, as long as people's (person.reach_to_grasp_right_s 0.32-0.67 s, measured onset to first touch): the
# planned reach (s) and where in it the opening's key falls, for the blank and the crank's knob
REACH_S, REACH_PEAK = 0.66, 0.62
KNOB_REACH_S, KNOB_PEAK = 0.62, 0.66
# the final pull: out over the disc (slower than the reach, so the reach is the fastest move before the grasp), a
# moment's pause, then the reach, onto the knob from the back of the hand as the first crank's comes on, from this far
# out along the knob's axis (straight from behind, op40's fingers swept the lever for 17 frames). FINAL_AXIAL slides
# the hand on along the knob's axis instead (3e2b0545), by FINAL_SLIDE_MM, the opening's key at KNOB_PEAK_FINAL
FINAL_OVER_S, FINAL_REACH_S, KNOB_PEAK_FINAL, FINAL_SLIDE_MM = 1.1, 0.65, 0.57, 110.0
FINAL_APPROACH_OUT_MM, FINAL_AXIAL = 30.0, False
READY_FROM_GRIP = np.array([0.0, -240.0, 40.0])  # where the hand pauses before the blank's reach: short of its grip
# the blank's reach comes down onto the grip from this far back off the part's near face (mm): at 12 the thumb,
# fitted to its pad (f9cd68c3), rode down op10's near face from its top edge two frames before the grasp
GRAB_VIA_BACK_MM = 20.0
# a lift-out's grab (start "vise"): the raise to the ready point, up over the crank's disc, 0.6 m, slower than the
# reach; the hand there, still, LIFT_ARRIVE_EARLY_S before the fingers close: arriving as they closed (the stage's),
# the fingers met the part 0.14-0.19 s early while the hand still came down, op10's on its top edges (it fell out of
# them, 12 mm up) and the knock read as the load's onset 67-100 ms in. The fingers meet it that much sooner, so the
# hand opens widest earlier in the reach (at the stage's 0.65 it measured 82-83%, at 0.52 74-77%) and the phases count
# from a touch LIFT_TOUCH_LEAD_S before the close; the planned loading is shorter by the lift's lag off the parallels
# (at 0.21 it measured 267-300 ms against people's 163-265)
LIFT_RAISE_S, LIFT_ARRIVE_EARLY_S, LIFT_PEAK, LIFT_TOUCH_LEAD_S, LIFT_LOADING_S = 1.5, 0.12, 0.52, 0.22, 0.16
# a lift-out of a part standing 30 mm or more proud of the jaws (op30's and op40's on their side, op50's on end) weighs
# people's range at LIFT_PROUD_RANGE_W, as the loosen and the pendant's keys do: at the default 0.5 the shoulder turned
# out past people's range raising the hand over it and lowering it back, 18-21 frames (92.3-93.4% inside against 93%).
# Not the shorter parts': op10's touch came 0.1 s later and its hand opened widest at 63% of the reach
LIFT_PROUD_RANGE_W = 2.0
# of those, one on its side on parallels (op30's, op40's, pinched halfway down the 56 mm it stands proud) is taken
# LIFT_TALL_RAISE_MM higher than the load's grip, the ring LIFT_TALL_RING (MCP, PIP degrees) less curled: reaching over
# the 31 mm wide part to the load's grip, the ring's middle segment landed on its top as the hand came down, pressed it
# down 5.9 N and held it down, so the load came on 67-100 ms after the touch and the part rose 400-630 ms later
# (people's 163-265). 5 mm higher without the ring, it slipped 2.1-2.3 mm in the hand (2 mm reads as a fumble); with the
# ring alone, it still knocked. The hand meets it sooner, so it opens widest earlier (LIFT_TALL_PEAK)
LIFT_TALL_RAISE_MM, LIFT_TALL_RING, LIFT_TALL_PEAK = 3.0, (5.0, 10.0), 0.47
# one stood on end on the vise's floor (op50's) is pinched by two fingers and the thumb a little below full effort
# while carried: at full effort the pinch's least squeeze pressed 2.20 times its slip force, the top of people's 1.7-2.2
LIFT_END_PEAK, LIFT_END_EFFORT = 0.50, 0.95
TOUCH_LEAD_S = 0.12         # the fingers meet the blank's faces this long before the grip's planned close
# letting go of the first crank: the fist eases open this much and slides off the knob's end along its axis, this long
# and this far (the fist spans the 90 mm knob), held to the axis as it cranked, turning back to the grip's own
# orientation as it goes (the pose's weight rising to SLIDE_POSE_W); the final pull's release slides off the same
# way (FINAL_SLIDE_OFF_S). Then the hand opens to LETGO_WIDE (open_like): at 0.9 the 1 mm knob grip opened 126 mm,
# wider than the push's reach that follows, and that reach's widest fell at its start (the footage check)
LETGO_OPEN, SLIDE_OFF_S, SLIDE_OFF_MM, SLIDE_POSE_W = 0.3, 0.45, 100.0, 8.0
FINAL_SLIDE_OFF_S = SLIDE_OFF_S
LETGO_WIDE = 0.75
PRELOAD_FROM_TOUCH, PRELOAD_PRESS_N, PRELOAD_PRESS_LEAD_S, KNOB_LAG_MM = True, 1.5, 0.1, 4.0
KNOB_HOLD_OPEN = 0.0
STAND_MARGIN_MM = 3.0       # a part set down stands if its middle is this far inside the parallels under it
TALL_TOP_CLEAR_MM = 4.0     # a tall part's grip keeps the hand this far over its top (_grip_specs)
# a part standing far proud of the jaws is let go of (open_like PROUD_RELEASE_OPEN) PROUD_RELEASE_S before the hand
# lifts off it (let_go)
PROUD_RELEASE_S, PROUD_RELEASE_OPEN = 0.25, 0.25
# a key closing the hand FINAL_CLOSE_MM before the final pull's touch, at FINAL_CLOSE_AT of the reach (0: none): closing
# there, the index's tip met the knob at the lever's joint and stopped op10's hand 20-28 mm short of its grip
FINAL_CLOSE_AT, FINAL_CLOSE_MM = 0.0, 8.0
SLIDE_OPEN_AT, PUSH_LEAVE_OPEN, FINAL_OVER_OPEN, SLIDE_LEAVE_OPEN, LEAVE_OPEN_AT = 0.22, 0.4, 0.4, 0.3, 1.0
FINAL_PULL_EFFORT = 1.0
# how far into the knob the knob grip's pads are solved (mm), fingers and thumb: at 2 the index hooked round behind the
# knob, any opening of it went 6-11 mm through the knob, the physics hand was stopped 24 mm short on the final reach,
# and the hold's weld then pulled it on, shoving the thumb 12 deg and 3.6 mm into the knob (op20)
KNOB_GRIP_COMP_MM = 1.0
KNOB_THUMB_COMP_MM = 0.5
PRELOAD_EFFORT = 0.15       # the grip's effort the preload ends on, the arm not yet lifting
PRELOAD_LOAD_N = 1.8        # ... and at most this much of the part's weight fed forward (N): at 0.15 op10's 1.4 kg
                            # crossed the loading's onset a frame before its preload ended (233 ms), and its
                            # loading ran 267 ms (people: 163-265); op20's 1.2 kg ends on 1.77 N


# --- colliders for the grip solver (world mm) ------------------------------------------------------
def box(c, h):
    return lambda p, c=np.asarray(c, float), h=np.asarray(h, float): G.sdf_box(p, c, np.eye(3), h)


def vise_boxes(parallels, par_h, opening, include_table=True, margin=0.0):
    """The vise's solids, with the parallels (base centres, height par_h); margin (mm) keeps skin that far off the
    jaws and the body (a hand that must not lean on them, e.g. when its force should go into a parallel)."""
    fy, x, m = VISE["fixed_face_y"], VISE["x"], margin
    out = [box([x, fy + 20, (SEAT_Z + JAW_TOP) / 2], [76.2 + m, 20 + m, (JAW_TOP - SEAT_Z) / 2 + m]),            # fixed jaw
           box([x, fy - opening - 20, (SEAT_Z + JAW_TOP) / 2], [76.2 + m, 20 + m, (JAW_TOP - SEAT_Z) / 2 + m]),   # moving jaw
           box([x, fy - 160, (TABLE_Z + SEAT_Z) / 2], [100 + m, 160 + m, (SEAT_Z - TABLE_Z) / 2 + m])]            # vise body
    for p in parallels.values():
        out.append(box(p + [0, 0, par_h / 2], [PAR_L / 2, PAR_T / 2, par_h / 2]))
    if include_table:
        out.append(box([-381.0, -340.0, TABLE_Z - 50], [460, 184, 50]))
    return out


def bands(c, **lims):
    """Penalty keeping a pad centre inside bounds relative to c: x=(lo,hi), y=(lo,hi), depth=(lo,hi) below
    c's z."""
    c = np.asarray(c, float)
    def f(p):
        out = torch.zeros((), dtype=p.dtype)
        for k, (lo, hi) in lims.items():
            v = (c[2] - p[2]) if k == "depth" else (p["xyz".index(k)] - c["xyz".index(k)])
            out = out + torch.relu(lo - v) ** 2 + torch.relu(v - hi) ** 2
        return 0.5 * out
    return f


def plane(point, normal, comp=2.0, band=None):
    return G.plane_target(np.asarray(point, float), np.asarray(normal, float), comp, band)


class Take:
    def __init__(self, verbose=True, load: Load = REFERENCE, out=OUT, grips_from=None, start="stage", start_at=None):
        """load: what goes in the vise; out: the folder the take and its grip cache go to; grips_from: a grips.json
        to use as solved instead of solving (to check the trajectory solver on its own against a known take);
        start: where the part starts, on the table ("stage") or in the vise, loosened, to be lifted out ("vise");
        start_at: for a lift-out, the part's centre (mm) where the load left it, if not where it was planned (home)."""
        torch.set_num_threads(8)
        self.verbose = verbose
        self.load, self.out = load, Path(out)
        self.size, self.half, self.stage = load.size, load.half, load.stage
        self.opening0, self.par_h = load.opening0, load.parallel_h
        self.kg = round(load.mass_kg, 1)                 # the planner's effort estimate: the part's mass to 0.1 kg
        self.grips_from = grips_from
        # parallels a little inboard of the blank's edges, so it sits on both whether set down short or slid home
        self.parallels = load.parallels()
        # against the fixed jaw, and where it is set down
        self.home = self.home_of(load)
        # a part standing taller than it is wide swings in the hand (op30's 8 mm), so it is set down further off the
        # fixed jaw, with the jaws opened wider for it (loads.vise_load): at 6 mm it landed on the jaw's top
        self.place_gap = TALL_PLACE_GAP if self.size[2] > self.size[1] else PLACE_GAP
        self.set_down = self.home - np.array([0, self.place_gap, 0])
        # a part stood on the vise's floor goes against the stop at its -x end (vise.Load.stop): set down a little off
        # it too, as off the fixed jaw, and slid onto both
        self.stop = load.stop()
        if self.stop is not None:
            self.set_down += [STOP_GAP, 0, 0]
        # kept hold of from its set-down and slid home in the grip (slide_held): a part against the stop, and one that
        # can't stand where it is set down. op30's and op40's 31 mm wide part stands on two parallels 7 mm apart under
        # its middle; set down 15 mm off the fixed jaw, only one was under it, at its edge, and it fell over (29 deg)
        under = [y for y in load.parallels_y.values() if abs(y - self.set_down[1]) <= self.half[1]]
        self.held_slide = self.stop is not None or not under or not (
            min(under) - PAR_T / 2 + STAND_MARGIN_MM <= self.set_down[1] <= max(under) + PAR_T / 2 - STAND_MARGIN_MM)
        self.hand = AnatomicalHand(Nimble(data_root() / "hand-model" / "nimble"))
        self.th = G.TorchHand(self.hand)
        self.prior = BS.ArmPrior()
        self.out.mkdir(parents=True, exist_ok=True)
        self.cons, self.fkeys, self.ekeys, self.gaze, self.events, self.clips = [], [], [], [], [], []
        self.start = start
        if start_at is not None:            # a lift-out's part where its load's run left it (build_lift_out)
            self.home = np.asarray(start_at, float)
        start_p = self.stage.copy() if start == "stage" else self.home.copy()
        self.blank_keys = [(0.0, np.eye(3), start_p)]                 # (t, R, p) the planned blank pose, piecewise min-jerk
        self.crank_keys = [(0.0, CRANK0)]
        self.crank_plans = []
        self._knob_free_from = 0.0
        self.hand_boxes = []                                     # (centre, half, t0, t1) the hand must stay out of
        self.t = 0.0
        self.q_relax = relaxed(self.hand)
        self.fkeys.append((0.0, self.q_relax))
        self.ekeys.append((0.0, 0.0, None))
        self.wrist = REST_W.copy()
        self._grips()
        # a lift-out of a part standing far proud of the jaws (LIFT_PROUD_RANGE_W): on its side on parallels (op30's,
        # op40's), taken a little higher than the load's grip, the ring held up off its top; on end (op50's)
        self.proud_lift = start == "vise" and self.set_down[2] + self.half[2] - JAW_TOP >= 30
        self.tall_lift, self.end_lift = self.proud_lift and self.stop is None, self.proud_lift and self.stop is not None
        if self.tall_lift:
            g = self.grips["blank_faces"]
            g["W_rel"] = g["W_rel"] + [0.0, 0.0, LIFT_TALL_RAISE_MM]
            q = dict(g["q"])
            q["ring_mcp_flex"] -= LIFT_TALL_RING[0]
            q["ring_pip"] -= LIFT_TALL_RING[1]
            g["q"] = self.hand.clamp(q)

    @staticmethod
    def home_of(load: Load) -> np.ndarray:
        """Where the load sits clamped: against the fixed jaw, on its parallels or the vise's floor (mm)."""
        return np.array([VISE["x"], VISE["fixed_face_y"] - load.half[1], SEAT_Z + load.parallel_h + load.half[2]])

    # --- grips (affordances), solved with the body, cached ----------------------------------------------
    def _grips(self):
        cache = self.out / "grips.json"
        src = ANATOMY.read_text(encoding="utf-8") + "".join(
            (MOONSHOT / f).read_text(encoding="utf-8") for f in ("motion/grasp.py", "body/hand.py", "motion/kinematics.py",
                                                                  "motion/solver.py"))
        src += inspect.getsource(Take._grip_specs) + json.dumps(list(LUMBAR)) + json.dumps(self.load.to_json())
        # and the module's constants the specs read (the knob's interference, ...): a value changed alone left the
        # source the same, and the cache served grips solved with the old one
        src += repr([(n, repr(globals()[n])) for n in sorted(set(Take._grip_specs.__code__.co_names))
                     if n.isupper() and n in globals()])
        key = hashlib.sha1(src.encode()).hexdigest()
        if self.grips_from is not None:
            data = json.loads(Path(self.grips_from).read_text(encoding="utf-8"))
            data["key"] = key
        else:
            data = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else {}
        if data.get("key") != key:
            data = {"key": key}
            for name, spec in self._grip_specs().items():
                t0 = time.time()
                best = G.solve_spec(self.th, spec, LUMBAR, self.prior)
                data[name] = {k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in best.items()}
                if self.verbose:
                    print(f"grip {name}: loss {best['loss']:.1f} ({time.time() - t0:.0f} s) body "
                          f"{dict(zip(BM.NAMES, np.round(best['theta'])))}")
            cache.write_text(json.dumps(data, indent=1), encoding="utf-8")
        self.grips = {}
        for name, g in data.items():
            if name == "key":
                continue
            H, W, obj = np.array(g["H"]), np.array(g["W"]), np.array(g["obj"])
            self.grips[name] = {"q": self.hand.clamp(g["q"]), "H": H, "W": W, "obj": obj, "theta": np.array(g["theta"]),
                                "H_rel": H, "W_rel": W - obj, "loss": g["loss"]}

    def _grip_specs(self):
        hx, hy, hz = self.half
        h = self.hand
        # starting postures for the body (12 angles: trunk 3, arm 7, girdle 2)
        S = lambda *a: list(a) + [0.0, 0.0]
        specs = {}
        # 1. blank by its near and far faces (grab, hold, place): solved at the staging spot, with the jaws where
        # they will be when it is set down, so the same grip clears them
        c = self.stage.copy()
        top = c[2] + hz
        jaw_clear = JAW_TOP - (self.set_down[2] + hz)
        near_gap = self.opening0 - self.size[1] - self.place_gap
        cols = [box(c, self.half), box([c[0], c[1], TABLE_Z - 50], [400, 300, 50])]
        # the jaws where it is set down, 2.5 mm bigger: the physics fingers reach up to 2 mm past the skin at their
        # backs and sides, and a thumb on the moving jaw nudges the part as it goes down
        for y0, y1 in ((hy + self.place_gap - 2.5, hy + self.place_gap + 45), (-hy - near_gap - 45, -hy - near_gap + 2.5)):
            cols.append(box([c[0], c[1] + (y0 + y1) / 2, top + jaw_clear - 40 + 1.25], [76.2, (y1 - y0) / 2, 41.25]))
        if self.stop is not None:                        # the stop where it is set down, as big again as the jaws
            cols.append(box(c + self.stop + [0, 0, STOP_MM[2] / 2] - self.set_down, np.array(STOP_MM) / 2 + 2.5))
        q0 = h.neutral()
        for n in ("index", "middle", "ring", "little"):
            q0[f"{n}_mcp_flex"], q0[f"{n}_pip"] = 25.0, 40.0
        q0.update(thumb_cmc_abd=22.0, thumb_cmc_flex=-5.0, thumb_mcp_flex=30.0, thumb_ip=20.0)
        # the pads 4-10 mm below the top, where the reference part stands 19 mm proud of the jaws; a part standing
        # far prouder (op30's, 56 mm, on its side) is pinched halfway down what stands proud, nearer its centre of mass,
        # or it swings in the hand
        proud = -jaw_clear
        depth = (4, 10) if proud < 30 else (proud / 2 - 3, proud / 2 + 3)
        if hx >= 30:            # straddling it from above across its width: thumb on the near face, fingers on the far
            far = lambda lo, hi: plane(c + [0, hy, 0], [0, 1, 0], 2.0, bands(c + [0, 0, hz], depth=depth, x=(lo, hi)))  # noqa: E731
            # the thumb opposite where the fingers' push lands: each finger's force is regulated to its share, so it
            # lands at their middle, 3-4 mm toward the little finger. With the thumb 15 mm toward the index (when the
            # index and middle pressed harder, op30), the push twisted op40's part 16-20 deg as the grip closed, and it
            # was carried leaning 5 deg
            tx = (-14, 14) if proud < 30 else (-6, 12)
            targets = {"thumb": plane(c + [0, -hy, 0], [0, -1, 0], 2.0, bands(c + [0, 0, hz], depth=depth, x=tx)),
                       "index": far(-44, -24), "middle": far(-16, 2), "ring": far(8, 26), "little": far(30, 46)}
            if proud >= 30:
                # reaching down the far face from over the top, the fingers' bases clear the top's edge: solved on its
                # skin, the little finger's proximal shell (proud of its skin) landed on op40's far top edge as the hand
                # came down, held the hand 3 mm high and started the preload two frames early (67 ms)
                cols[0] = box(c + [0, 0, TALL_TOP_CLEAR_MM / 2], self.half + [0, 0, TALL_TOP_CLEAR_MM / 2])
        else:                   # too short along the jaws for four fingers side by side (op50's 31 mm, standing on
            # end): held from its +x end, the index and middle round onto the far face one above the other, the thumb
            # on the near face opposite them; side by side at one depth, the index couldn't reach round the corner and
            # pressed it with its middle segment, unregulated (the fingers' side 23.5 N); four side by side ran off
            # the 31 mm face and knocked the part over, and a grip across its ends had the fingers where the stop is
            # just above its centre of mass: held by two of its edges, it swings in the pinch as the hand moves, and
            # pinched 19 mm above it (halfway down what stands proud) it slipped 2.1-2.3 mm in the hand
            d = hz - 4
            far = lambda lo, hi, x: plane(c + [0, hy, 0], [0, 1, 0], 2.0, bands(c + [0, 0, hz], depth=(d + lo, d + hi), x=x))  # noqa: E731
            targets = {"thumb": plane(c + [0, -hy, 0], [0, -1, 0], 2.0, bands(c + [0, 0, hz], depth=(d - 6, d + 6), x=(-8, 8))),
                       "index": far(-14, -4, (-4, 12)), "middle": far(2, 12, (-10, 6))}
            # the ring and little tucked, as in a three-finger pinch: hanging straight along the far face, they pressed
            # it 4 N each outside the grip's regulation; tucked, they lie against its +x end below the fingers, so that
            # end is 6.5 mm further out to them: the physics hand carries the part about 7 mm nearer that end than
            # planned, and 2.5 mm further out left the ring on it at 3 N
            q0 = dict(q0, ring_mcp_flex=60.0, ring_pip=80.0, little_mcp_flex=65.0, little_pip=85.0)
            low = (2 * hz - d - 14) / 2                  # half its height, from its foot to 2 mm under the middle's band
            cols.append(box(c + [hx + 3.25, 0, -hz + low], [3.25, hy, low]))
        specs["blank_faces"] = dict(obj=c, colliders=cols, q0=q0, load=self.kg, targets=targets,
                                    starts=[S(20, 0, r, 50, 50, -15, 65, p, -10, 5) for p in (0, 35, 60) for r in (0, 15)])
        # 2. slide: the thumb pad on the near face (above the moving jaw) pushes the part toward the fixed jaw, index
        # and middle resting on the top to steady it: a finger pad can't face away from the operator without the
        # hand reaching over, the thumb's does
        c = self.set_down.copy()
        q0 = h.neutral()
        for n in ("index", "middle", "ring", "little"):
            q0[f"{n}_mcp_flex"], q0[f"{n}_pip"] = 20.0, 25.0
        q0.update(ring_mcp_flex=45, ring_pip=60, little_mcp_flex=50, little_pip=65,
                  thumb_cmc_abd=22.0, thumb_cmc_flex=-5.0, thumb_mcp_flex=25.0, thumb_ip=15.0)
        topf = lambda lo, hi: plane(c + [0, 0, hz], [0, 0, 1], 2.0, bands(c, x=(lo, hi), y=(-15, 20)))
        vise = vise_boxes(self.parallels, self.par_h, self.opening0)
        if self.stop is not None:
            vise.append(box(self.stop + [0, 0, STOP_MM[2] / 2], np.array(STOP_MM) / 2))
        specs["blank_slide"] = dict(obj=c, colliders=[box(c, self.half)] + vise, q0=q0, iters=1000,
                                    targets={"thumb": plane(c + [0, -hy, 0], [0, -1, 0], 2.0,
                                                            bands(c + [0, 0, hz], depth=(3, 11), x=(-12, 12))),
                                             "index": topf(*((-30, -10) if hx >= 30 else (-hx + 2, -1))),
                                             "middle": topf(*((-6, 14) if hx >= 30 else (1, hx - 2)))},
                                    starts=[S(20, 0, r, 50, 50, -15, 65, p, -10, 5) for p in (0, 35, 60) for r in (0, 15)])
        # 3. push: index, middle and ring pads flat on the top, fingers forward, palm low over it
        c = self.home.copy()
        q0 = h.neutral()
        for n in ("index", "middle", "ring", "little"):
            q0[f"{n}_mcp_flex"], q0[f"{n}_pip"] = 15.0, 15.0
        topf = lambda lo, hi: plane(c + [0, 0, hz], [0, 0, 1], 2.0, bands(c, x=(lo, hi), y=(-10, 30)))
        # clear of the jaws as the first crank left them, snug on the part, by as much as a fingertip check keeps off
        # them: solved with the jaws where they were when the part was slid, the thumb rested on the snug moving jaw's
        # top, and the press, pushing until the part took its force, put up to 33 N more into the jaw (op20)
        snug = vise_boxes(self.parallels, self.par_h, self.size[1], margin=6.0)
        specs["blank_press"] = dict(obj=c, colliders=[box(c, self.half)] + snug, q0=q0,
                                    targets={"index": topf(-30, -12), "middle": topf(-8, 8), "ring": topf(12, 30)}
                                    if hx >= 30 else {"index": topf(-hx + 2, -1), "middle": topf(1, hx - 2)},   # a narrow top
                                    starts=[S(24, 0, 8, 45, 45, -10, 75, p, 0, 0) for p in (40, 70)])
        # 4. rotate: power grip on the crank knob, solved at the start angle and clear of the lever at every angle
        k = knob_center(CRANK0)
        a0 = k - KNOB_AXIS * VISE["knob_grip"]
        A, U, R = torch.as_tensor(a0), torch.as_tensor(KNOB_AXIS), VISE["knob_r"]
        sc = VISE["screw_axis"]

        def on_knob(lo, hi, comp=KNOB_GRIP_COMP_MM, w=1.0):
            def f(cc, n):
                rel = cc - A
                t = rel @ U
                radial = torch.linalg.norm(rel - t * U)
                to_axis = -(rel - t * U) / radial
                return w * ((radial - (R - comp)) ** 2 + 20 * (1.0 - n @ to_axis) ** 2
                            + 0.5 * (torch.relu(lo - t) ** 2 + torch.relu(t - hi) ** 2))
            return f
        q0 = h.neutral()
        for n in ("index", "middle", "ring", "little"):
            q0[f"{n}_mcp_flex"], q0[f"{n}_pip"] = 55.0, 70.0
        q0.update(thumb_cmc_abd=15.0, thumb_cmc_flex=10.0, thumb_mcp_flex=30.0, thumb_ip=25.0)
        specs["knob"] = dict(obj=k, q0=q0, colliders=[
            lambda p: G.sdf_cyl(p, a0, a0 + KNOB_AXIS * VISE["knob_len"], R),
            # the lever, swept: the fist keeps its orientation while cranking, so relative to it the lever turns a
            # full circle round the knob's root, through anything near it (docs/moonshot/physics.md). One-sided, from
            # 6 mm off the lever's outer face (the physics hand settles a few millimetres from its planned grip) back
            # past the vise's end 2 mm behind it: a thin disc let the solver push the hand out through its back,
            # between the lever and the vise
            lambda p: G.sdf_cyl(p, a0 + np.array([0, -12.0, 0]), a0 + np.array([0, 150.0, 0]), VISE["lever"] + 8.0),
            box([VISE["x"], sc[1] + 120, 880], [110, 120, 30])],
            # clear of the lever, the fist sits out along the 90 mm knob: middle, ring and little wrap it, then the
            # index and thumb settle onto it lightly. Solved all at once, the five fall into poorer optima (pads off
            # the knob, fingers out of order), so the second stage refines from the first
            targets={"middle": on_knob(26, 38), "ring": on_knob(46, 58), "little": on_knob(66, 80),
                     "thumb": on_knob(10, 50, comp=KNOB_THUMB_COMP_MM, w=0.2)},
            refine={"middle": on_knob(36, 52), "ring": on_knob(52, 68), "little": on_knob(68, 86),
                    "index": on_knob(8, 40, w=0.3), "thumb": on_knob(10, 60, comp=KNOB_THUMB_COMP_MM, w=0.5)},
            iters=1500,
            starts=[S(8, 0, 5, pl, 25, 0, 70, p, wf, 0) for p in (-20, 10) for wf in (-10, 15) for pl in (30, 60)])
        # 5. measure: the index pad on a parallel's exposed end (beyond the blank's end, between the jaws); the other
        # fingers curled out of the way, thumb tucked
        q0 = h.neutral()
        q0.update(index_mcp_flex=20, index_pip=25, middle_mcp_flex=75, middle_pip=95, ring_mcp_flex=80, ring_pip=95,
                  little_mcp_flex=80, little_pip=90, thumb_cmc_flex=15, thumb_cmc_abd=5, thumb_mcp_flex=40, thumb_ip=35)
        x_end = VISE["x"] + self.half[0] + (PAR_L / 2 - self.half[0]) / 2                  # middle of the exposed end
        covered = self.half[0] >= PAR_L / 2      # a part longer than the parallels hides their tops: push an end instead
        for name in [n for n in ("para_b", "para_a") if n in self.parallels]:
            pc = self.parallels[name] + np.array([0, 0, self.par_h])
            pc[1] = tip_y(self.parallels, name)
            if covered:                          # the pad on the parallel's end face, under the part's overhang
                end = np.array([VISE["x"] + PAR_L / 2, pc[1], pc[2] - self.par_h / 2])
                # low on it beside a neighbour (tip_y), under the part's overhang: aimed at the end's middle, the pad
                # caught on the bottom edge of op40's part, 2.8 mm over the parallels' ends
                shared = pc[1] != self.parallels[name][1]
                target = plane(end, [1, 0, 0], 1.5, bands(end, y=(-1.0, 1.0), z=(-9.0, -3.0) if shared else (-4.0, 4.0)))
            else:
                target = plane([x_end, pc[1], pc[2]], [0, 0, 1], 1.5, bands([x_end, pc[1], pc[2]], x=(-6, 6), y=(-1.0, 1.0)))
            specs[f"tip_{name}"] = dict(obj=self.parallels[name].copy(), q0=q0,
                                        colliders=[box(self.home, self.half + 4)]
                                        + vise_boxes(self.parallels, self.par_h, self.size[1], margin=6.0),
                                        targets={"index": target},
                                        iters=1200,
                                        starts=[S(25, 0, r, 45, 40, -5, 80, p, w, 0) for p in (20, 45, 70) for r in (5, 20)
                                                for w in (-15, 10)])
        return specs

    # --- building blocks --------------------------------------------------------------------------------
    def add(self, t0, t1, fn):
        """fn(t) -> list of constraints: ("pos", W, w) | ("pose", H, W, w) | ("tsr", pt_hand, world, ax_hand, ax_world, w)."""
        self.cons.append((t0, t1, fn))

    def blank_at(self, t):
        keys = self.blank_keys
        R, p = keys[0][1], keys[0][2]
        for (t0, R0, p0), (t1, R1, p1) in zip(keys, keys[1:]):
            if t <= t0:
                break
            w = min_jerk((t - t0) / max(t1 - t0, 1e-9))
            dR = Rotation.from_matrix(R1) * Rotation.from_matrix(R0).inv()
            R = (Rotation.from_rotvec(dR.as_rotvec() * w) * Rotation.from_matrix(R0)).as_matrix()
            p = p0 + (p1 - p0) * w
            if t < t1:
                return R, p
        return keys[-1][1], keys[-1][2]

    def move_blank(self, t0, t1, R, p):
        """Plan the blank's motion (it is held during this span); keys are held between."""
        last = self.blank_keys[-1]
        if last[0] < t0:
            self.blank_keys.append((t0, last[1], last[2]))
        self.blank_keys.append((t1, np.asarray(R, float), np.asarray(p, float)))

    def grip_pose(self, name, t=None, obj=None):
        g = self.grips[name]
        if obj is None:
            R, p = self.blank_at(t)
        else:
            R, p = np.eye(3), np.asarray(obj, float)
        return R @ g["H_rel"], p + R @ g["W_rel"]

    def transit(self, t0, t1, W_to, via=(), fade=None, paced=False):
        """Free motion of the wrist from where it is to W_to through via points (min-jerk submovements that
        overlap); orientation is the body's choice; fade=(H, w_end) fades in the next grip's orientation over the
        last 0.5 s. The submovements share the time equally, or, paced, each in proportion to the square root of its
        length, so each peaks at the same acceleration (a min-jerk move's is 5.77 d / T^2): a quick reach's long leg
        doesn't spike while its short final approach dawdles."""
        pts = [self.wrist] + [np.asarray(v, float) for v in via] + [np.asarray(W_to, float)]
        n = len(pts) - 1
        if paced:
            w = np.sqrt([max(float(np.linalg.norm(b - a)), 1.0) for a, b in zip(pts, pts[1:])])
            spans = list((t1 - t0) * w / w.sum())
            starts = list(t0 + 0.85 * np.r_[0.0, np.cumsum(spans[:-1])])
        else:
            span = (t1 - t0) / n
            spans, starts = [span] * n, [t0 + i * span * 0.85 for i in range(n)]
        path = PosePath(np.eye(3), pts[0])
        for i in range(n):
            path.to(starts[i], spans[i] * 1.15 if i < n - 1 else spans[i], np.eye(3), pts[i + 1])
        def fn(t, path=path):
            out = [("pos", path.at(t)[1], 1.0)]
            if fade is not None:
                w = min_jerk((t - (t1 - 0.5)) / 0.5)
                if w > 0:
                    out.append(("pose", fade[0], path.at(t)[1], w * fade[1]))
            return out
        self.add(t0, t1, fn)
        self.wrist = np.asarray(W_to, float)

    def fingers(self, t, q):
        self.fkeys.append((t, q))

    def effort(self, t, value, grip=None):
        self.ekeys.append((t, value, grip))

    def look(self, t, point):
        self.gaze.append((t, np.asarray(point, float)))

    def event(self, kind, t0, t1, **kw):
        self.events.append(dict(kind=kind, t0=t0, t1=t1, **kw))

    def clip(self, verb, t0, t1, caption):
        self.clips.append(dict(verb=verb, t0=t0, t1=t1, caption=caption))

    # --- the verbs ---------------------------------------------------------------------------------------
    def grab(self, grip="blank_faces", reach=None, lift_mm=40.0, raise_s=0.75, settle_s=0.2):
        """Raise the hand up and out of the table's way, a moment's pause as it nears the part, then the reach (over
        it, then a slower final approach from above) in as long as people's take (person.reach_to_grasp_right_s),
        the hand opening wider than the part with the peak at ~74% of the reach (Jeannerod; Bhatia 2022), closing
        at contact; then the lifting studies' preload (0.23 s) and loading (0.21 s) before lift-off, and a short
        lift. A lift-out's grab (start "vise") is the same reach from the same ready point, the hand raised to it
        high over the crank's disc."""
        t0 = self.t
        ga = self.hand.spec["grip"]
        g = self.grips[grip]
        Hg, Wg = self.grip_pose(grip, t0)
        self.look(t0, self.blank_at(t0)[1] + [0, 0, self.half[2]])
        # from the thigh the whole 0.53 m in people's 0.32-0.67 s, the hand would peak near the nothing-moves check's
        # 20 m/s^2 (5.77 d / T^2 per leg): it comes up beside the table first, slower than the reach (so the reach
        # is the fastest move before the grasp, which is how the grasp-timing check finds its start), and the
        # reach starts from there, still. Its two legs share the time, so the final approach from above is slow:
        # paced, it touched the part at 0.3-0.5 m/s, and the knock read as the load's onset 67 ms in. The ready
        # point is set from the grip, so the reach is the same length whatever the load and wherever the operator
        # stands. A part in the vise is reached for over the crank: the hand is raised to the ready point high over
        # its disc (the knob up to z 1040), paced and slower, so that raise stays slower than the reach. Reached for
        # in one 1.27 s move from the thigh, the lift-outs' reaches measured 1.23-1.30 s against people's 0.67
        reach = REACH_S if reach is None else reach
        # a part on end stands above the reach planned for the shorter ones (op50's, pinched 75 mm under its top):
        # the hand pauses 40 mm over its top and comes in 75 mm over it; from the shorter ones' pause, level with
        # its top, the hand rising behind the plan swept its fingers into it, and with the shorter ones' approach
        # the opening fingers, 42 mm under the hand, went 17 mm into it; from 110 mm over it, the hand came down
        # onto it at 0.54 m/s, early, and the lift's phases ran long
        top = self.blank_at(t0)[1][2] + self.half[2]
        ready = Wg + READY_FROM_GRIP + [0, 0, max(0.0, top + 40 - (Wg[2] + READY_FROM_GRIP[2]))]
        if self.start == "vise":                  # the lift-out's own timing (LIFT_*)
            raise_s, via = LIFT_RAISE_S, [np.array([self.wrist[0] - 60, -760.0, 1160.0])]
            peak, touch_lead, early, loading_s = LIFT_PEAK, LIFT_TOUCH_LEAD_S, LIFT_ARRIVE_EARLY_S, LIFT_LOADING_S
            peak = LIFT_TALL_PEAK if self.tall_lift else LIFT_END_PEAK if self.end_lift else peak
        else:
            # a part stood on end is held from its end, and the thumb meets its near face as the hand arrives, 0.16 s
            # before the close, and it rises off the table 0.09 s after the plan lifts it: timed from the other loads'
            # touch and rise, op50's preload and loading measured 300 and 267 ms
            lead, rise = (TOUCH_LEAD_S, 0.0) if self.half[0] >= 30 else (0.16, 0.06)
            via, peak, touch_lead, early, loading_s = [], REACH_PEAK, lead, 0.0, ga["loading_s"] - rise
        t_ready = t0 + 0.35 + raise_s
        self.transit(t0 + 0.35, t_ready, ready, via=via, paced=bool(via))
        self.add(t_ready, t_ready + settle_s, lambda t, W=ready: [("pos", W, 1.0)])
        t_reach = t_ready + settle_s
        back = 12.0 if self.start == "vise" else GRAB_VIA_BACK_MM
        self.transit(t_reach, t_reach + reach - early, Wg, via=[Wg + [0, -back, max(62.0, top + 75 - Wg[2])]],
                     fade=(Hg, 1.0), paced=bool(early))
        if early:                                 # there, still, as the fingers close
            self.add(t_reach + reach - early, t_reach + reach, lambda t, H=Hg, W=Wg: [("pose", H, W, 3.0)])
        # widest at ~74% of the reach as the hand-opening check measures it, from the pause to the first touch; the
        # physics hand is widest ~0.03 s before the key
        t_peak = t_reach + peak * reach
        t_contact = t_reach + reach
        self.fingers(t_reach, self.q_relax)
        opened = open_for(self.hand, g["q"], self.size[1])
        if self.half[0] < 30:   # the ring and little tucked out of a narrow part's way (_grip_specs) stay tucked: opened
            # with the hand, they closed onto op50's top as it came down over it, 11 mm into it
            opened.update({n: v for n, v in g["q"].items() if n.split("_")[0] in ("ring", "little", "cmc4", "cmc5")})
        self.fingers(t_peak, opened)
        self.fingers(t_contact, g["q"])
        # the phases from the fingers' first touch on the faces, touch_lead before the grip's planned close. The
        # take's effort sets the load the arm lifts with as well as the squeeze, so the preload (grip rising, no
        # load yet) stays under the loading's onset, 5% of the weight (person.force_onset_frac); at 0.25 there
        # the load rose from the first touch and the loading phase measured 367 ms
        t_touch = t_contact - touch_lead
        t_load = t_touch + ga["preload_s"]
        t_lift = t_load + loading_s
        if self.start == "vise":                  # a lift-out's grab, as its own timing passed (LIFT_*)
            self.effort(t_contact, 0.0, grip)
            t_hold = t_contact
        else:
            self.effort(t_touch if PRELOAD_FROM_TOUCH else t_contact, 0.0, grip)
            if PRELOAD_PRESS_N:
                self.event("press", t_touch - PRELOAD_PRESS_LEAD_S, t_load, normal=[0, 0, 1.0], force=PRELOAD_PRESS_N,
                           contact="blank")
            t_hold = t_load if PRELOAD_FROM_TOUCH else t_contact
        self.effort(t_load, PRELOAD_EFFORT if self.start == "vise"
                    else min(PRELOAD_EFFORT, PRELOAD_LOAD_N / (self.kg * 9.81)), grip)
        self.effort(t_lift, LIFT_END_EFFORT if self.end_lift else 1.0, grip)
        R, p = self.blank_at(t_lift)
        self.move_blank(t_lift, t_lift + 0.45, R, p + [0, 0, lift_mm])
        self.add(t_contact, t_lift + 0.6, lambda t: [("pose", *self.grip_pose(grip, t), 3.0)])
        self.event("grip", t_contact, None, grip=grip)
        self.event("hold_object", t_hold, None, obj="blank")
        self.event("place_correct", t_lift + 0.3, None)
        self.t = t_lift + 0.6
        self.wrist = self.grip_pose(grip, self.t)[1]
        self.clip("grab", t0, self.t + 0.3, "GRAB  reach, open wider than the part, close, preload, load, lift")
        self.t_lift = t_lift

    def hold(self, grip="blank_faces", dur=2.6, tilt_deg=None):
        """Hold the part up in front and turn it to look at a face, steady (tremor only), and back. The reference
        part turns 28 deg; a heavier or longer one turns less, no further than the wrist torque that took (its
        weight times its length), as a part held one-handed is turned only so far. Its length is its longest side:
        op50's part, on end, turned as far as its 31 mm length allowed, 28 deg, slipped 2.2 mm in the hand."""
        if tilt_deg is None:
            torque, ref = self.load.mass_kg * max(self.size), REFERENCE.mass_kg * REFERENCE.size[0]
            tilt_deg = 28.0 * min(1.0, ref / torque)
        t0 = self.t
        R0, p0 = self.blank_at(t0)
        Rt = Rotation.from_euler("x", -tilt_deg, degrees=True).as_matrix()
        self.move_blank(t0, t0 + 0.9, np.eye(3), INSPECT)
        # the turn takes 0.9 s: stopping a 28 deg turn in trainual's 0.6 s slips the blank over 2 mm in the grip
        self.move_blank(t0 + 0.9, t0 + 1.8, Rt, INSPECT + [0, 0, 10])
        self.move_blank(t0 + 2.0, t0 + dur, np.eye(3), INSPECT)
        self.look(t0 + 0.1, INSPECT)
        self.add(t0, t0 + dur, lambda t: [("pose", *self.grip_pose(grip, t), 3.0)])
        self.t = t0 + dur
        self.wrist = self.grip_pose(grip, self.t)[1]
        self.clip("hold", t0 - 0.3, self.t, "HOLD  the grip carries the part's weight; turn it to look, steady, back")

    def place(self, grip="blank_faces", dur=3.0):
        """Carry over the moving jaw (20 mm clear) and set it down on the parallels, short of the fixed jaw; the
        grip eases once it is down and lets go by lifting off, not by opening into the jaws."""
        t0 = self.t
        high = np.array([VISE["x"] + 70, VISE["fixed_face_y"] - self.opening0 - self.half[1] - 42, JAW_TOP + self.half[2] + 20])
        over, above = self.set_down + [0, -6, 58], self.set_down + [0, -3, 12]
        self.look(t0 - 0.6, self.set_down + [0, 0, self.half[2]])
        # a part heavier than the reference, pinched near its top, is carried over more slowly, as it is carried out of
        # the vise (set_on_table): planned with people's range (2026-11-03), op10's 1.4 kg part turned in the pinch as
        # the 0.9 s carry slowed over the moving jaw, and fell; the reference's part is carried as before
        slow = max(1.0, self.load.mass_kg / REFERENCE.mass_kg)
        t_high = t0 + 0.9 * slow
        t_over = t_high - 0.05 + 0.75 * slow
        self.move_blank(t0, t_high, np.eye(3), high)
        self.move_blank(t_high - 0.05, t_over, np.eye(3), over)
        self.move_blank(t_over - 0.05, t_over + 0.45, np.eye(3), above)
        t_down = t_over + 0.95
        self.move_blank(t_over + 0.45, t_down, np.eye(3), self.set_down)
        self.add(t0, t_down + 0.1, lambda t: [("pose", *self.grip_pose(grip, t), 3.0)])
        self.effort(t_down - 0.05, 1.0, grip)
        self.t_down = t_down
        if self.held_slide:             # kept hold of, and slid onto the fixed jaw (and the stop) in the grip (slide)
            self.t, self.wrist = t_down, self.grip_pose(grip, t_down)[1]
            self.clip("place", t0 - 0.3, self.t + 0.2, "PLACE  over the jaw, down onto the vise's floor"
                      if self.stop is not None else "PLACE  over the jaw, down onto the parallels")
            return
        self.effort(t_down + 0.1, 0.0, grip)
        self.let_go(grip, t_down + 0.1)
        self.clip("place", t0 - 0.3, self.t + 0.2, "PLACE  over the jaw, down onto the parallels, let go by lifting off")

    def let_go(self, grip, t_rel):
        """The grip eased, let go of the part by lifting off it, not by opening into the jaws."""
        g = self.grips[grip]
        _, W_set = self.grip_pose(grip, t_rel)
        self.fingers(t_rel, g["q"])
        # a part standing far proud of the jaws, pinched well above them, is let go of first, then lifted off: lifted
        # off still pinched, op40's 75 mm tall, 31 mm wide part was dragged by its top as the hand rose and fell
        # against the jaw (29 deg)
        Hs = g["H_rel"]
        proud = self.set_down[2] + self.half[2] - JAW_TOP >= 30
        t_off = t_rel + (PROUD_RELEASE_S if proud else 0.0)
        if proud:                      # opened in place: the part, slid home (held_slide), leans on the fixed jaw if
            # anything; backed off its near face as it opened, the fingers on the far one dragged op40's part 5.7 deg
            # over toward the operator
            self.fingers(t_off, open_like(self.hand, g["q"], PROUD_RELEASE_OPEN))
            self.add(t_rel, t_off, lambda t, W=W_set: [("pose", Hs, W, 3.0)])
        self.fingers(t_off + 0.3, open_like(self.hand, g["q"], PROUD_RELEASE_OPEN if proud else 0.12))
        self.fingers(t_off + 0.6, open_like(self.hand, g["q"], 0.5))
        lift = PosePath(np.eye(3), W_set).to(t_off, 0.3, np.eye(3), W_set + [0, -4, 22]).to(t_off + 0.22, 0.45, np.eye(3), W_set + [0, -35, 70])
        def fn(t, lift=lift):
            p = lift.at(t)[1]
            w = 1 - min_jerk((t - t_off) / 0.5)
            return [("pos", p, 1.0)] + ([("pose", Hs, p, w)] if w > 0 else [])
        self.add(t_off, t_off + 0.7, fn)
        self.event("hold_object", None, t_rel, obj="blank")
        self.event("place_correct", None, t_off + 0.3)
        self.event("grip", None, t_rel + 0.1, grip=grip)
        self.t = t_off + 0.7
        self.wrist = W_set + [0, -35, 70]

    def set_on_table(self, grip="blank_faces", dur=3.0):
        """Carry the part, lifted out of the vise, back to the table where the load take found it and set it down;
        let go by lifting off, as the vise take lets go in the vise."""
        t0 = self.t
        R, p = self.blank_at(t0)
        high = np.array([self.stage[0], self.stage[1], JAW_TOP + self.half[2] + 30])
        self.look(t0 - 0.4, self.stage)
        # a part heavier than the reference, pinched near its top (all that stands above the jaws), is carried over
        # more slowly: op20's 1.2 kg swung out of the pinch as the 1.25 s carry slowed over the table
        slow = max(1.0, self.kg / REFERENCE.mass_kg)
        t_high = t0 + 0.55 + 1.25 * slow
        dur = dur + 1.25 * (slow - 1.0)
        self.move_blank(t0, t0 + 0.6, R, p + [0, 0, 45])
        self.move_blank(t0 + 0.55, t_high, np.eye(3), high)
        t_down = t0 + dur - 0.2
        self.move_blank(t_high - 0.05, t_down, np.eye(3), self.stage)
        self.add(t0, t_down + 0.1, lambda t: [("pose", *self.grip_pose(grip, t), 3.0)])
        self.effort(t_down - 0.05, LIFT_END_EFFORT if self.end_lift else 1.0, grip)
        self.effort(t_down + 0.1, 0.0, grip)
        g = self.grips[grip]
        W_set = self.grip_pose(grip, t_down)[1]
        t_rel = t_down + 0.1
        self.fingers(t_rel, g["q"])
        self.fingers(t_rel + 0.3, open_like(self.hand, g["q"], 0.5))
        self.wrist = W_set                                   # off the part from where it set it down
        self.transit(t_rel, t_rel + 0.7, W_set + [0, -35, 70], via=[W_set + [0, -4, 22]])
        self.event("hold_object", None, t_rel, obj="blank")
        self.event("place_correct", None, t_rel + 0.3)
        self.event("grip", None, t_rel + 0.1, grip=grip)
        self.wrist = W_set + [0, -35, 70]
        self.t = t_rel + 0.7
        # back to the side round the crank (its knob sweeps x -515 to -247, y -636 to -726, z 760 to 1025), not
        # through it: out to the right first, then back past the knob's end
        self.transit(self.t, self.t + 1.3, REST_W, via=[np.array([-100.0, -800.0, 950.0])])
        self.fingers(self.t + 1.3, self.q_relax)
        self.t += 1.4
        self.clip("set_on_table", t0 - 0.3, self.t + 0.2, "SET DOWN  out of the vise and onto the table beside it")
        self.t_down = t_down

    def slide(self, grip="blank_slide", mm=None, approach=0.9, dur=0.8, push_N=9.0):
        """The thumb pad comes down onto the near face above the moving jaw (index and middle on the top) and pushes
        the part along the parallels until it meets the fixed jaw (friction on the parallels resists; the physics
        decides)."""
        if self.held_slide:
            return self.slide_held()
        mm = self.place_gap if mm is None else mm
        t0 = self.t
        g = self.grips[grip]
        Hs, Ws = g["H_rel"], self.set_down + g["W_rel"]
        self.look(t0, self.set_down + [0, self.half[1], self.half[2]])
        self.transit(t0, t0 + approach, Ws, via=[Ws + [0, -25, 40]], fade=(Hs, 1.0))
        self.fingers(t0 + SLIDE_OPEN_AT * approach, open_like(self.hand, g["q"], 0.5))
        tc = t0 + approach
        self.fingers(tc, g["q"])
        self.move_blank(tc + 0.15, tc + 0.15 + dur, np.eye(3), self.set_down + [0, mm, 0])
        self.add(tc, tc + dur + 0.35, lambda t: [("pose", Hs, self.blank_at(t)[1] + g["W_rel"], 3.0)])
        self.effort(tc, 0.0, grip)
        self.effort(tc + 0.12, 0.6, grip)
        self.effort(tc + dur + 0.2, 0.6, grip)
        self.effort(tc + dur + 0.35, 0.0, grip)
        self.event("grip", tc, tc + dur + 0.35, grip=grip)
        # the pads push with a set force toward the fixed jaw (more than the parallels' friction); the part moves
        # until the jaw stops it
        self.event("press", tc + 0.1, tc + dur + 0.2, normal=[0, -1.0, 0], force=push_N, contact="blank")
        t1 = tc + dur + 0.35
        self.fingers(t1 - 0.1, g["q"])
        W_end = self.home + g["W_rel"]
        self.wrist = W_end
        # not opened as it comes off: the hand relaxes in the pause before the knob's reach, and a hand still open from
        # here (102 mm) was widest at the start of that reach, not 74% into it (the hand-opening check)
        self.transit(t1, t1 + 0.4, W_end + [0, -30, 45])
        if SLIDE_LEAVE_OPEN:                                 # the fingers lift off the part as the hand does
            self.fingers(t1 + 0.4 * LEAVE_OPEN_AT, open_like(self.hand, g["q"], SLIDE_LEAVE_OPEN))
        self.t = t1 + 0.4
        self.clip("slide", t0 - 0.2, self.t + 0.2, "SLIDE  the thumb pushes the part along the parallels onto the fixed jaw")

    def slide_held(self, grip="blank_faces", dur=0.8, push_N=5.0):
        """A part stood on end against a stop, kept hold of from its set-down: slid along the vise's floor onto the
        fixed jaw, then along the jaw onto the stop, in the same grip, each push a set force until the jaw or the stop
        stops it, then let go. Pushed by the thumb near its top, as a shorter part is, op50's 158 mm part tipped over
        onto the fixed jaw; carried there by the plan alone, it stopped 4 mm short of the jaw; pushed onto both at
        once, it met the jaw first, and the 2 N left along the jaw didn't move it the 4 mm onto the stop. Pushed at
        9 N, where its 0.25 friction on the floor takes 2.4, it lurched onto the jaw and leaned 8 deg; pressed at 5 N
        from 15 mm off, it covered 17 mm in 0.2 s, leaned 3.5 deg over the jaw's top and stood up 2.2 mm off it, so
        the plan carries it most of the way and the press closes the last few mm."""
        t0 = self.t
        self.look(t0, self.home + [0, self.half[1], self.half[2]])
        if self.stop is None:
            # on parallels it can't stand on where it was set down (held_slide): slid home across them in the grip as
            # carried, pressed onto the fixed jaw, and let go there, standing on both
            t1 = t0 + 0.1 + dur
            self.move_blank(t0 + 0.1, t1, np.eye(3), self.home)
            t_rel = t1 + 0.2
            self.event("press", t1 - 0.25, t_rel - 0.15, normal=[0, -1.0, 0], force=push_N, contact="blank")
            self.add(t0, t_rel, lambda t: [("pose", *self.grip_pose(grip, t), 3.0)])
            self.effort(t_rel - 0.15, 0.9, grip)
            self.effort(t_rel, 0.0, grip)
            self.let_go(grip, t_rel)
            self.clip("slide", t0 - 0.2, self.t + 0.2, "SLIDE  held, across the parallels onto the fixed jaw")
            return
        # set down leaning in the pinch, the grip eases so it stands up on its foot before it is slid: op50's, turned
        # 2.7 deg about the pinch as it was lifted, stood on its edge on the vise's floor, and eased to 0.3 stood
        # only to 1.5 deg
        self.effort(t0 + 0.1, 0.1, grip)
        ts = t0 + 0.35
        self.effort(ts, 0.1, grip)
        # nearly all its weight still carried, so it skims the floor: eased to 0.4, the floor's drag on its foot held
        # the foot back as the hand pushed 101 mm up, and it leaned on the stop's top with its foot 2.6 mm off it
        self.effort(ts + 0.1, 0.9, grip)
        t1 = ts + 0.1 + dur
        self.move_blank(ts + 0.1, t1, np.eye(3), np.array([self.set_down[0], self.home[1], self.home[2]]))
        self.event("press", t1 - 0.25, t1 + 0.1, normal=[0, -1.0, 0], force=push_N, contact="blank")
        t2 = t1 + 0.1 + dur
        self.move_blank(t1 + 0.1, t2, np.eye(3), self.home)
        t_rel = t2 + 0.2
        along = np.array([1.0, -0.35, 0.0]) / np.linalg.norm([1.0, -0.35])      # onto the stop, still into the jaw
        self.event("press", t1 + 0.1, t_rel - 0.15, normal=along.tolist(), force=push_N, contact="blank")
        self.add(t0, t_rel, lambda t: [("pose", *self.grip_pose(grip, t), 3.0)])
        self.effort(t_rel - 0.15, 0.9, grip)
        self.effort(t_rel, 0.0, grip)
        self.let_go(grip, t_rel)
        self.clip("slide", t0 - 0.2, self.t + 0.2, "SLIDE  held, along the floor onto the fixed jaw and the stop")

    def push(self, grip="blank_press", force_N=30.0, approach=0.8, hold_s=0.7):
        """Flat fingers onto the top and press down with a set force (the hand's way of seating a part); the
        physics pushes the wrist until the contact force reaches it."""
        t0 = self.t
        g = self.grips[grip]
        Hp, Wp = g["H_rel"], self.home + g["W_rel"]
        self.look(t0, self.home + [0, 0, self.half[2]])
        self.transit(t0, t0 + approach, Wp, via=[Wp + [0, -20, 45]], fade=(Hp, 1.0))
        self.fingers(t0 + 0.2, open_like(self.hand, g["q"], 0.4))
        tc = t0 + approach
        self.fingers(tc, g["q"])
        self.add(tc, tc + hold_s + 0.4, lambda t: [("pose", Hp, Wp, 3.0)])
        self.effort(tc, 0.0, grip)
        self.effort(tc + 0.1, 0.4, grip)
        self.effort(tc + hold_s + 0.3, 0.4, grip)
        self.effort(tc + hold_s + 0.4, 0.0, grip)
        self.event("grip", tc, tc + hold_s + 0.4, grip=grip)
        # down, and a little toward the fixed jaw (10 deg), as machinists seat a part: it can't creep off the jaw
        self.event("press", tc + 0.05, tc + hold_s + 0.25, normal=[0, -0.174, 0.985], force=force_N, contact="blank")
        t1 = tc + hold_s + 0.4
        self.fingers(t1 - 0.1, g["q"])                       # the fingers hold their shape while pressing and coming
        # off, and relax in the pause before the knob's reach (relaxing as they came off, they curled into the part)
        self.wrist = Wp
        self.transit(t1, t1 + 0.45, Wp + [0, -30, 50], via=[Wp + [0, 0, 22]])     # off the part straight up first
        if PUSH_LEAVE_OPEN:                                  # the fingers lift off the part as the hand does
            self.fingers(t1 + 0.45 * LEAVE_OPEN_AT, open_like(self.hand, g["q"], PUSH_LEAVE_OPEN))
        self.t = t1 + 0.45
        self.clip("push", t0 - 0.2, self.t + 0.2, f"PUSH  flat fingers press the part down onto the parallels ({force_N:.0f} N)")

    def rotate(self, grip="knob", rev_s=0.45, snug_deg=2.0, snug_N=15.0, final=False, tighten_deg=40.0,
               reach=None):
        """Crank the vise: the fist keeps its orientation and the knob spins in it (the elbow, the shoulder and the
        shoulder girdle carry the circle, the wrist absorbs a little); speed varies around each turn.

        As machinists do it: first crank the jaw onto the part and stop when it is snug (snug_N of clamp: the part
        is held but can still be pushed down onto the parallels); final=True is the last pull after seating, which
        ends on feel. Both are closed loops on the real knob in the physics."""
        # a moment's pause off the part before reaching for the knob, the hand relaxing: run straight on from the
        # part, the reach started with the hand still open from it and was widest at its start (the hand-opening check)
        W_hold = self.wrist.copy()
        self.add(self.t, self.t + 0.35, lambda t, W=W_hold: [("pos", W, 1.0)])
        self.fingers(self.t + 0.3, self.q_relax)
        t0 = self.t + 0.35
        g = self.grips[grip]
        Hk = g["H_rel"]
        pt = Hk.T @ (knob_center(CRANK0) - g["W"])                # knob middle in the hand
        phi_g = self.crank_plans[-1]["phi_t"] if self.crank_plans else CRANK0
        Wk = knob_center(phi_g) - Hk @ pt
        sc = VISE["screw_axis"]
        over = np.array([sc[0] + 205, -640, 1070])                # out to the right, over the crank disc
        self.look(t0, knob_center(phi_g))
        # from over the vise: out over the crank disc, then onto the knob from the operator's side, in as long as
        # people's reach (1.2 s measured 0.90 and 0.97, onset to first touch); paced, so the long leg out over the disc
        # doesn't spike
        if final:
            # the final pull's comes onto the knob along its axis from beyond its end, the hand open past it, and slides
            # on, as the hand backs off it: across it from the side along the hand's own axis, at op40's crank angle the
            # fingers swept over the lever on the way in. That way round is 0.55 m from the part, so the hand goes out
            # over the crank disc first and pauses there, turned to the grip, and the reach starts from there (as the
            # blank's does): the whole way in people's 0.67 s it planned 28 m/s^2. It stays high until the whole hand is
            # out past the knob's end, then comes down onto its axis and slides on, open: the fist spans the knob's
            # length (index 8-40 mm from its root, little finger 66-80), so 60 mm out its index side was still over the
            # 90 mm knob, and coming down there the open fingers met it 0.2-0.3 s into the reach
            reach = FINAL_REACH_S if reach is None else reach
            t_over = t0 + FINAL_OVER_S
            self.transit(t0, t_over, over)
            if FINAL_OVER_OPEN:                              # opening on the way over, relaxed again for the reach
                self.fingers(t0 + LEAVE_OPEN_AT * FINAL_OVER_S, open_like(self.hand, g["q"], FINAL_OVER_OPEN))
            self.add(t_over, t_over + 0.3, lambda t, W=over: [("pose", Hk, W, 1.0)])
            t0 = t_over + 0.3
            if FINAL_AXIAL:
                on = Wk + KNOB_AXIS * FINAL_SLIDE_MM + [0, 0, 10]
                via = [on + [0, 0, 60], on]
                # open before it slides on, less than the opening's peak (open_like isn't: 0.6 was 104 mm on the
                # reference's grip and 42 on op10's)
                self.fingers(t0 + 0.55 * reach, open_for(self.hand, g["q"], 2 * VISE["knob_r"]))
            else:
                # onto the knob from the back of the hand, as the first crank's reach comes onto it: slid on along its
                # axis, the open index's base met the knob's end, and blocked there the hand was 90 mm and 14 deg off
                # its grip when the fist closed on the knob, which snapped it on (180 N)
                via = [Wk + Hk[:, 2] * 45 + [0, -10, 15] + KNOB_AXIS * FINAL_APPROACH_OUT_MM]
                # relaxed as the reach starts, so the hand opens during it: opening through the 1.4 s out over the disc
                # and the pause, it reached its widest (78 mm) before the reach began and stayed there, and the reach's
                # widest point fell anywhere along it
                self.fingers(t0, self.q_relax)
        else:
            reach = KNOB_REACH_S if reach is None else reach
            via = [over, Wk + Hk[:, 2] * 45 + [0, -10, 15]]
        self.transit(t0, t0 + reach, Wk, via=via, fade=(Hk, 1.0), paced=True)
        ko = open_like(self.hand, g["q"], LETGO_WIDE)
        # widest ~74% into the reach as the check measures it: from the hand leaving the pause to its first touch on
        # the knob (before tg), with the fingers ~0.1 s behind their keys
        # the fingers, opening out of the fist's shape, reach ~10 mm short of it before closing on the knob (67 of 77);
        # at 12 op10's part and the knob opened only 0.73 mm apart per mm
        self.fingers(t0 + (KNOB_PEAK_FINAL if final else KNOB_PEAK) * reach,
                     open_for(self.hand, g["q"], 2 * VISE["knob_r"], lag_mm=KNOB_LAG_MM))
        if final and FINAL_CLOSE_AT:
            # closing before it touches: the touch's knock opened the hand 3-4 mm at the touch, past its widest
            self.fingers(t0 + FINAL_CLOSE_AT * reach,
                         open_for(self.hand, g["q"], 2 * VISE["knob_r"], lag_mm=KNOB_LAG_MM - FINAL_CLOSE_MM))
        tg = t0 + reach
        q_fist = open_like(self.hand, g["q"], KNOB_HOLD_OPEN) if KNOB_HOLD_OPEN else g["q"]
        self.fingers(tg, q_fist)
        t_c0 = tg + 0.25
        if final:
            t_c1, t_t1 = t_c0, t_c0 + 0.75
            plan = dict(t0=t_c0, t1=t_c1, t2=t_t1, phi0=phi_g, phi_c=phi_g, phi_t=phi_g + tighten_deg)
        else:
            phi_c = crank_for_opening(self.size[1], self.opening0)
            turns = (phi_c - phi_g) / 360.0
            t_c1 = t_c0 + turns / rev_s
            t_t1 = t_c1 + 0.8
            plan = dict(t0=t_c0, t1=t_c1, t2=t_t1, phi0=phi_g, phi_c=phi_c, phi_t=phi_c + snug_deg, snug_N=snug_N)
        self.crank_plans.append(plan)
        self.knob_pt_hand = pt
        # the knob's axis held in the fist, and the fist's orientation only softly: where the arm can't keep both round
        # the circle it gives up a turn about the knob's axis, not a tilt off it. Held as one (a pose at 3), the
        # operator standing 120 mm further back tilted the planned fist 15-17 deg off its grip at two places a turn,
        # and op10's index sank 7.25 mm into the knob
        ax = Hk.T @ KNOB_AXIS
        tl = t_t1 + 0.35
        # the final pull's let-go slides off too: moved straight off to the side, the planned index's base went 13 mm
        # into the knob and op20's 5.8 in the physics
        slide_s = FINAL_SLIDE_OFF_S if final else SLIDE_OFF_S

        def on_knob(t):
            # let go, the fist slides off the knob's end along its axis as it held it, turning back to the grip's own
            # orientation as it goes: moved off from the grip's orientation, wherever the crank had left the fist
            # turned about the axis, the fingers still round the knob were dragged through it (the index's skin 7.0-7.2
            # mm into it after every load's first crank; slid off, 2.3-3.0)
            c = knob_center(self.crank_angle(t))
            w = 1.0
            if t > tl and slide_s:
                u = min_jerk((t - tl) / slide_s)
                c = c + KNOB_AXIS * SLIDE_OFF_MM * u
                w = 1.0 + (SLIDE_POSE_W - 1.0) * u
            return [("pose", Hk, c - Hk @ pt, w), ("tsr", pt, c, ax, KNOB_AXIS, 6.0)]
        self.add(tg, tl + slide_s, on_knob)
        self.look(t_c0 + 0.3, 0.5 * np.array([VISE["x"], VISE["fixed_face_y"] - 52, JAW_TOP])
                  + 0.5 * np.array([VISE["x"], sc[1] - 40, sc[2] + 20]))
        self.effort(tg, 0.6, grip)
        self.effort(t_c1, 0.6, grip)
        self.effort(t_c1 + 0.1, FINAL_PULL_EFFORT if final else 0.7, grip)
        self.effort(t_t1 + 0.35, 0.0, grip)
        self.event("grip", tg, t_t1 + 0.35, grip=grip)
        self.event("enclose", tg + 0.1, t_t1 + 0.35)
        self.event("crank", t_c0, t_t1 + 0.35, plan=dict(plan))
        self.fingers(tl, q_fist)
        # eased, so the hand slides off the knob
        self.fingers(tl + 0.12, open_like(self.hand, g["q"], LETGO_OPEN if slide_s else 0.25))
        self.fingers(tl + 0.35, ko)
        Wend = knob_center(plan["phi_t"]) - Hk @ pt
        self.wrist = Wend
        box_c, box_h = np.array([sc[0], sc[1] - VISE["knob_grip"], sc[2]]), np.array([140.0, 55.0, 140.0])
        # clear of the crank's sweep until the hand is out over its disc, 0.42 of the way into the reach
        self.hand_boxes.append((box_c, box_h, self._knob_free_from, t0 + 0.42 * reach))
        self._knob_free_from = tl + (slide_s + 0.1 if slide_s else 0.35)
        # off the knob's end along its axis first, then away: let go and moved off it out to the right and up, the
        # fingers swept across the lever wherever the crank stopped with the lever that way (op30's and op40's turns)
        off = Wend + [0, -60, 10]
        away = np.array([sc[0] + 175, -820, 990]) if final else over
        if slide_s:
            t_away = tl + slide_s + 0.6
            self.wrist = Wend + KNOB_AXIS * SLIDE_OFF_MM
            self.transit(tl + slide_s, t_away, away, via=[off + [60, -10, 40]])
        else:
            t_away = tl + 0.9
            self.transit(tl, t_away, away, via=[off, off + [60, -10, 40]])
        self.fingers(t_away, self.q_relax)
        self.t = t_away
        if not final:
            self.clip("rotate", t0 - 0.2, self.t, "ROTATE  crank the jaw onto the part until snug: the fist keeps its orientation, the knob spins in it")

    def crank_angle(self, t):
        """The planned knob angle: each crank plan is a run (speed varying around the turn) and then a short
        min-jerk snug or tightening pull; held between plans."""
        phi = CRANK0
        for cp in self.crank_plans:
            if t <= cp["t0"]:
                return phi
            if t <= cp["t1"] and cp["t1"] > cp["t0"]:
                x = (t - cp["t0"]) / (cp["t1"] - cp["t0"])
                base = 0.6 * min_jerk(x) + 0.4 * x
                turns = (cp["phi_c"] - cp["phi0"]) / 360.0
                wob = 0.012 * math.sin(2 * math.pi * turns * base * 2) * math.sin(math.pi * x)
                return cp["phi0"] + (cp["phi_c"] - cp["phi0"]) * (base + wob)
            if t <= cp["t2"]:
                return cp["phi_c"] + (cp["phi_t"] - cp["phi_c"]) * min_jerk((t - cp["t1"]) / (cp["t2"] - cp["t1"]))
            phi = cp["phi_t"]
        return phi

    def measure(self, parallels=("para_a", "para_b"), press_N=3.0, feel_mm=1.0, clip_from=None):
        """The fingertip check that the part is seated: press each parallel's exposed end down and try to slide it
        along its length; seated parallels are pinched under the part and don't move (the physics decides). Under a
        part longer than the parallels no end shows, so the fingertip pushes each one's end face along its length."""
        t0 = self.t
        for i, name in enumerate(parallels):
            g = self.grips[f"tip_{name}"]
            Hm, Wm = g["H_rel"], self.parallels[name] + g["W_rel"]
            ta = self.t
            # reach time grows with distance (Fitts-like): about 1 m/s peak for the long reach from the crank
            dur = float(np.clip(0.5 + np.linalg.norm(Wm - self.wrist) / 600.0, 0.9, 1.5))
            self.look(ta - 0.3, self.parallels[name] + [self.half[0] + 12, 0, self.par_h])
            self.transit(ta, ta + dur, Wm, via=[Wm + [10, -20, 50]], fade=(Hm, 1.0))
            self.fingers(ta + 0.3, open_like(self.hand, g["q"], 0.3))
            tc = ta + dur
            self.fingers(tc, g["q"])
            feel = np.array([-feel_mm, 0, 0])
            path = PosePath(np.eye(3), Wm).to(tc + 0.25, 0.35, np.eye(3), Wm + feel).to(tc + 0.6, 0.3, np.eye(3), Wm)
            self.add(tc, tc + 1.0, lambda t, path=path, Hm=Hm: [("pose", Hm, path.at(t)[1], 3.0)])
            self.effort(tc, 0.0, f"tip_{name}")
            self.effort(tc + 0.1, 0.5, f"tip_{name}")             # a firm fingertip: the finger braced to press
            self.effort(tc + 0.9, 0.5, f"tip_{name}")
            self.effort(tc + 1.0, 0.0, f"tip_{name}")
            self.event("grip", tc, tc + 1.0, grip=f"tip_{name}")
            covered = self.half[0] >= PAR_L / 2   # its end face, pushed along its length (see _grip_specs)
            self.event("press", tc + 0.05, tc + 0.95, normal=[1.0, 0, 0] if covered else [0, 0, 1.0], force=press_N,
                       contact=name)
            self.event("free_parallel", tc - 0.2, 1e9, name=name)
            self.fingers(tc + 0.95, g["q"])
            self.fingers(tc + 1.2, open_like(self.hand, g["q"], 0.3))
            self.wrist = Wm
            self.transit(tc + 1.0, tc + 1.3, Wm + [0, -10, 40], via=[Wm + [0, 0, 15]])
            self.t = tc + 1.3
        self.to_rest()
        self.clip("measure", (t0 if clip_from is None else clip_from) - 0.2, self.t,
                  "MEASURE  final pull on the crank, then the fingertip check: press each parallel and feel that it can't move")

    def to_rest(self):
        """The fingers relaxed and the hand back down by the thigh as the take ends: with nothing planned after its
        last step, the body solve pulls it there in the take's last 0.3 s (op50's at 1.7 m/s)."""
        self.fingers(self.t + 0.2, self.q_relax)
        dur = float(np.clip(0.5 + np.linalg.norm(REST_W - self.wrist) / 600.0, 1.1, 1.6))
        self.transit(self.t, self.t + dur, REST_W, via=[self.wrist + [80, -60, 40]])
        self.t += dur + 0.3

    # --- assembling the take ---------------------------------------------------------------------------
    def finger_at(self, t):
        keys = sorted(self.fkeys, key=lambda k: k[0])
        if t <= keys[0][0]:
            return keys[0][1]
        for (t0, a), (t1, b) in zip(keys, keys[1:]):
            if t0 <= t < t1:
                return blend_q(a, b, min_jerk((t - t0) / max(t1 - t0, 1e-9)))
        return keys[-1][1]

    def effort_at(self, t):
        """(effort 0..1, grip name) piecewise linear between keys."""
        keys = self.ekeys
        if t <= keys[0][0]:
            return keys[0][1], keys[0][2]
        for (t0, a, ga), (t1, b, gb) in zip(keys, keys[1:]):
            if t0 <= t < t1:
                w = (t - t0) / max(t1 - t0, 1e-9)
                return a + (b - a) * w, ga or gb
        return keys[-1][1], keys[-1][2]

    def intervals(self, kind):
        """Close each event's open ends (t0/t1 None) against the matching opposite event, in order."""
        out = []
        for e in self.events:
            if e["kind"] != kind:
                continue
            if e["t0"] is not None and e["t1"] is not None:
                out.append(e)
            elif e["t0"] is not None:
                out.append(dict(e))
            else:
                for o in reversed(out):
                    if o["t1"] is None:
                        o["t1"] = e["t1"]
                        break
        return out

    def solve(self):
        self.T = self.t + 0.3
        n = int(self.T * FPS) + 1
        self.n = n
        boxes = [([-381.5, -340.0, TABLE_Z - 50], [460, 184, 50]),
                 ([VISE["x"], VISE["fixed_face_y"] - 60, (TABLE_Z + JAW_TOP) / 2], [110, 120, (JAW_TOP - TABLE_Z) / 2])]
        s = BS.BodySolver(n, FPS, LUMBAR, self.prior, boxes=boxes)
        if self.proud_lift:
            s.W = BS.BodySolver.W | {"range": LIFT_PROUD_RANGE_W}
        for k in range(n):
            t = k / FPS
            active = [c for c in self.cons if c[0] <= t < c[1]]
            if not active and t < self.cons[0][0]:
                s.pos(k, REST_W, 0.6)
            for _, _, fn in active:
                for c in fn(t):
                    if c[0] == "pos":
                        s.pos(k, c[1], c[2])
                    elif c[0] == "pose":
                        s.pose(k, c[1], c[2], c[3])
                    elif c[0] == "tsr":
                        s.tsr(k, *c[1:5], w=c[5])
            if not active and t >= self.cons[-1][1]:
                s.pos(k, REST_W, 0.6)
        holding = self.intervals("hold_object")
        for k in range(n):
            t = k / FPS
            s.load[k] = self.kg if any(e["t0"] + 0.4 <= t < e["t1"] - 0.1 for e in holding) else 0.0
        boxes = self.hand_boxes + ([(self.hand_boxes[-1][0], self.hand_boxes[-1][1], self._knob_free_from, 1e9)]
                                   if self.hand_boxes else [])         # a take with no crank (the lift-out) has none
        for c, h, a, b in boxes:
            mask = torch.as_tensor([1.0 if a <= k / FPS < b else 0.0 for k in range(n)], dtype=torch.float64)
            s.hand_boxes.append((torch.as_tensor(c, dtype=torch.float64), torch.as_tensor(h, dtype=torch.float64), mask))
        t0 = time.time()
        th0 = np.array(self.grips["blank_faces"]["theta"], float)
        self.theta, self.dp, self.frames, terms = s.solve(th0, iters=3000, lr=0.03)
        if self.verbose:
            print(f"body: {n} frames solved in {time.time() - t0:.0f} s; {({k: round(v, 1) for k, v in terms.items()})}")
        self._knob_tables()

    def load_solution(self, path=None):
        d = np.load(path or self.out / "reference.npz")
        self.theta, self.dp = d["theta"], d["dp"]
        self.T = self.t + 0.3
        self.n = len(self.theta)
        self._knob_tables()

    def _knob_tables(self):
        """Body pose on the knob as a function of knob angle (from the solved trajectory), for the closed-loop crank."""
        if not self.crank_plans:
            self.knob_phi = self.knob_theta = self.knob_dp = np.zeros(0)
            return
        ks = [k for k in range(self.n) if any(cp["t0"] <= k / FPS <= cp["t2"] for cp in self.crank_plans)]
        phi = np.array([self.crank_angle(k / FPS) for k in ks])
        keep = np.r_[True, np.diff(phi) > 1e-6]               # strictly increasing for the lookup
        ks = np.array(ks)[keep]
        self.knob_phi = phi[keep]
        self.knob_theta, self.knob_dp = self.theta[ks], self.dp[ks]

    def body_on_knob(self, phi):
        i = int(np.clip(np.searchsorted(self.knob_phi, phi), 1, len(self.knob_phi) - 1))
        a, b = self.knob_phi[i - 1], self.knob_phi[i]
        w = float(np.clip((phi - a) / max(b - a, 1e-9), 0, 1))
        th = self.knob_theta[i - 1] * (1 - w) + self.knob_theta[i] * w
        dp = self.knob_dp[i - 1] * (1 - w) + self.knob_dp[i] * w
        return BM.fk(th, LUMBAR + dp)

    def sample(self, t):
        x = t * FPS
        k0 = int(np.clip(math.floor(x), 0, self.n - 1))
        k1 = min(self.n - 1, k0 + 1)
        w = x - k0
        th = self.theta[k0] * (1 - w) + self.theta[k1] * w
        dp = self.dp[k0] * (1 - w) + self.dp[k1] * w
        f = BM.fk(th, LUMBAR + dp)
        e, grip = self.effort_at(t)
        touching = any(ev["t0"] - 0.1 <= t < (ev["t1"] if ev["t1"] is not None else 1e9) for ev in self.intervals("grip"))
        return {"t": t, "H": f["H"], "W": f["W"] + tremor(t, 0.35 if touching else 1.0), "F": f["F"], "S": f["S"], "E": f["E"],
                "q": self.hand.vector(self.finger_at(t)), "effort": e, "grip": grip}

    def save(self):
        rows = [self.sample(k / FPS) for k in range(self.n)]
        eyes, looks, ups = head_camera(self, self.theta, self.dp)
        blank = [self.blank_at(r["t"]) for r in rows]
        np.savez(self.out / "reference.npz", t=np.array([r["t"] for r in rows]), q=np.stack([r["q"] for r in rows]),
                 H=np.stack([r["H"] for r in rows]), W=np.stack([r["W"] for r in rows]), S=np.stack([r["S"] for r in rows]),
                 E=np.stack([r["E"] for r in rows]), forearm=np.stack([r["F"] for r in rows]), theta=self.theta, dp=self.dp,
                 blank=np.stack([b[1] for b in blank]), blank_R=np.stack([b[0] for b in blank]),
                 crank=np.array([self.crank_angle(r["t"]) for r in rows]),
                 effort=np.array([r["effort"] for r in rows]), grip=np.array([r["grip"] or "" for r in rows]),
                 eye=eyes, look=looks, up=ups, names=np.array(self.hand.names), fps=FPS)
        (self.out / "take.json").write_text(json.dumps({
            "events": [{k: (v if not isinstance(v, np.ndarray) else v.tolist()) for k, v in e.items()} for e in self.events],
            "clips": self.clips, "T": self.T, "lumbar": LUMBAR.tolist(),
            "parallels": {k: v.tolist() for k, v in self.parallels.items()}, "home": self.home.tolist(), "set": self.set_down.tolist(),
            "crank_plans": self.crank_plans, "knob_pt_hand": getattr(self, "knob_pt_hand", np.zeros(3)).tolist(),
            "opening0": self.opening0, "start": self.start,
            "grip_digits": {name: list(spec["targets"]) for name, spec in self._grip_specs().items()},
            "load": self.load.to_json()} | CARD.get(self.start, {}), indent=1),
            encoding="utf-8")


def head_camera(take, theta, dp, lumbar=LUMBAR):
    """Head-mounted camera from the gaze schedule (the verbs' look() calls): the head turns ~62% of the way to
    the eyes' target, ~30 ms behind them, smoothed like a neck (0.12 s); up from the head."""
    n = len(theta)
    sched = sorted(take.gaze, key=lambda g: g[0])
    eyes, looks, ups = [], [], []
    head_dir = None
    a = (1 / FPS) / (0.12 + 1 / FPS)
    for k in range(n):
        t = k / FPS - 0.03
        tgt = sched[0][1]
        for t0, p in sched:
            if t >= t0:
                tgt = p
        f = BM.fk(theta[k], lumbar + dp[k])
        eye0 = f["neck"] + f["thorax"] @ np.array([0, 60.0, 175.0])
        fwd = f["thorax"] @ np.array([0, math.cos(math.radians(30)), -math.sin(math.radians(30))])
        g = tgt - eye0
        g /= np.linalg.norm(g)
        want = fwd + 0.62 * (g - fwd)
        want /= np.linalg.norm(want)
        head_dir = want if head_dir is None else head_dir + a * (want - head_dir)
        head_dir /= np.linalg.norm(head_dir)
        eye = f["neck"] + f["thorax"] @ np.array([0, 20.0, 150.0]) + head_dir * 75.0
        eyes.append(eye)
        looks.append(eye + head_dir * 500.0)
        up_ref = f["thorax"] @ np.array([0, 0.7, 0.7])
        up = up_ref - head_dir * up_ref.dot(head_dir)
        ups.append(up / np.linalg.norm(up))
    sm = lambda A: np.stack([np.convolve(np.pad(A[:, i], 6, mode="edge"), np.hanning(13) / np.hanning(13).sum(), "valid")
                             for i in range(3)], 1)
    return sm(np.array(eyes)), sm(np.array(looks)), np.array(ups)


def build_lift_out(verbose=True, load: Load = REFERENCE, out=TAKES / "lift-out", grips_from=None, start_from=None):
    """The part lifted out of the loosened vise and set on the table: the unload's last take. start_from: the load's
    physics run (a take folder with its sim.npz), to start the part along the jaws where that run left it, against
    the fixed jaw on what it stood on: op50's, clamped against the stop, ended 3.1 mm off it."""
    start_at = None
    if start_from is not None:
        end = np.load(Path(start_from) / "sim.npz")["blank"][-1]
        home = Take.home_of(load)
        start_at = home + [end[0] - home[0], 0.0, 0.0]
    take = Take(verbose, load, out, grips_from, start="vise", start_at=start_at)
    take.grab()
    take.set_on_table()
    take.solve()
    take.save()
    if verbose:
        print(f"lift-out: {take.T:.1f} s, {take.n} frames; clips " + ", ".join(f"{c['verb']} {c['t0']:.1f}-{c['t1']:.1f}" for c in take.clips))
    return take


def build(verbose=True, solve=True, load: Load = REFERENCE, out=OUT, grips_from=None):
    """Compose the take for a load into out; solve=False loads the body trajectory already in reference.npz (for the
    physics)."""
    take = Take(verbose, load, out, grips_from)
    take.grab()
    take.hold()
    take.place()
    take.slide()
    take.rotate()                   # crank the jaw on until snug
    take.push()                     # seat the part on the parallels while it can still move down
    t_final = take.t
    take.rotate(final=True)         # the last pull, ends on feel
    if take.parallels:
        take.measure(clip_from=t_final)
    else:                           # on the vise's floor: no parallels to try; it is checked square by indicator
        take.to_rest()
        take.clip("measure", t_final - 0.2, take.t, "TIGHTEN  the last pull on the crank, ending on feel")
    if not solve:
        take.load_solution()
        return take
    take.solve()
    take.save()
    if verbose:
        print(f"take: {take.T:.1f} s, {take.n} frames; clips " + ", ".join(f"{c['verb']} {c['t0']:.1f}-{c['t1']:.1f}" for c in take.clips))
    return take


if __name__ == "__main__":
    build()
