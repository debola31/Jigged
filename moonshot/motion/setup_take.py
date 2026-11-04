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
                                 crank_for_opening, knob_center)

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
    def __init__(self, verbose=True, load: Load = REFERENCE, out=OUT, grips_from=None, start="stage"):
        """load: what goes in the vise; out: the folder the take and its grip cache go to; grips_from: a grips.json
        to use as solved instead of solving (to check the trajectory solver on its own against a known take);
        start: where the part starts, on the table ("stage") or in the vise, loosened, to be lifted out ("vise")."""
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
        self.home = np.array([VISE["x"], VISE["fixed_face_y"] - self.half[1], SEAT_Z + self.par_h + self.half[2]])
        # a part standing taller than it is wide swings in the hand (op30's 8 mm), so it is set down further off the
        # fixed jaw, with the jaws opened wider for it (loads.vise_load): at 6 mm it landed on the jaw's top
        self.place_gap = TALL_PLACE_GAP if self.size[2] > self.size[1] else PLACE_GAP
        self.set_down = self.home - np.array([0, self.place_gap, 0])
        # a part stood on the vise's floor goes against the stop at its -x end (vise.Load.stop): set down a little off
        # it too, as off the fixed jaw, and slid onto both
        self.stop = load.stop()
        if self.stop is not None:
            self.set_down += [STOP_GAP, 0, 0]
        self.hand = AnatomicalHand(Nimble(data_root() / "hand-model" / "nimble"))
        self.th = G.TorchHand(self.hand)
        self.prior = BS.ArmPrior()
        self.out.mkdir(parents=True, exist_ok=True)
        self.cons, self.fkeys, self.ekeys, self.gaze, self.events, self.clips = [], [], [], [], [], []
        self.start = start
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

    # --- grips (affordances), solved with the body, cached ----------------------------------------------
    def _grips(self):
        cache = self.out / "grips.json"
        src = ANATOMY.read_text(encoding="utf-8") + "".join(
            (MOONSHOT / f).read_text(encoding="utf-8") for f in ("motion/grasp.py", "body/hand.py", "motion/kinematics.py",
                                                                  "motion/solver.py"))
        src += inspect.getsource(Take._grip_specs) + json.dumps(list(LUMBAR)) + json.dumps(self.load.to_json())
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
            # the thumb opposite where the fingers' push lands: pinched halfway down a tall part, the index and middle
            # press harder than the ring and little, 15 mm toward the index, and centred the thumb's push turned the part
            # 27 degrees in the hand (op30)
            tx = (-14, 14) if proud < 30 else (-24, -6)
            targets = {"thumb": plane(c + [0, -hy, 0], [0, -1, 0], 2.0, bands(c + [0, 0, hz], depth=depth, x=tx)),
                       "index": far(-44, -24), "middle": far(-16, 2), "ring": far(8, 26), "little": far(30, 46)}
        else:                   # too short along the jaws for four fingers side by side (op50's 31 mm, standing on
            # end): thumb on the near face, index and middle side by side on the far one; the four fingers' bands ran
            # off a 31 mm face and knocked the part over, and a grip across its ends had the fingers where the stop is
            far = lambda lo, hi: plane(c + [0, hy, 0], [0, 1, 0], 2.0, bands(c + [0, 0, hz], depth=depth, x=(lo, hi)))  # noqa: E731
            targets = {"thumb": plane(c + [0, -hy, 0], [0, -1, 0], 2.0, bands(c + [0, 0, hz], depth=depth, x=(-8, 8))),
                       "index": far(-13, -2), "middle": far(2, 13)}
            # the ring and little tucked, as in a three-finger pinch: hanging straight along the far face, they pressed
            # it 4 N each outside the grip's regulation, and the fingers' side 2.4 times the slip force; tucked, they
            # lie over its top, so its top is 2.5 mm higher to them, as the jaws are bigger (the ring's knuckle rested
            # 0.4 mm into it, pressing it down as the hand lifted)
            q0 = dict(q0, ring_mcp_flex=60.0, ring_pip=80.0, little_mcp_flex=65.0, little_pip=85.0)
            cols.append(box(c + [0, 0, hz + 1.25], [hx, hy, 1.25]))
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
        specs["blank_press"] = dict(obj=c, colliders=[box(c, self.half)] + vise, q0=q0,
                                    targets={"index": topf(-30, -12), "middle": topf(-8, 8), "ring": topf(12, 30)}
                                    if hx >= 30 else {"index": topf(-hx + 2, -1), "middle": topf(1, hx - 2)},   # a narrow top
                                    starts=[S(24, 0, 8, 45, 45, -10, 75, p, 0, 0) for p in (40, 70)])
        # 4. rotate: power grip on the crank knob, solved at the start angle and clear of the lever at every angle
        k = knob_center(CRANK0)
        a0 = k - KNOB_AXIS * VISE["knob_grip"]
        A, U, R = torch.as_tensor(a0), torch.as_tensor(KNOB_AXIS), VISE["knob_r"]
        sc = VISE["screw_axis"]

        def on_knob(lo, hi, comp=2.0, w=1.0):
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
                     "thumb": on_knob(10, 50, w=0.2)},
            refine={"middle": on_knob(36, 52), "ring": on_knob(52, 68), "little": on_knob(68, 86),
                    "index": on_knob(8, 40, w=0.3), "thumb": on_knob(10, 60, w=0.5)},
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
            if covered:                          # the pad on the parallel's end face, under the part's overhang
                end = np.array([VISE["x"] + PAR_L / 2, pc[1], pc[2] - self.par_h / 2])
                target = plane(end, [1, 0, 0], 1.5, bands(end, y=(-1.0, 1.0), z=(-4.0, 4.0)))
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

    def transit(self, t0, t1, W_to, via=(), fade=None):
        """Free motion of the wrist from where it is to W_to through via points (min-jerk submovements that
        overlap); orientation is the body's choice; fade=(H, w_end) fades in the next grip's orientation over the
        last 0.5 s."""
        pts = [self.wrist] + [np.asarray(v, float) for v in via] + [np.asarray(W_to, float)]
        n = len(pts) - 1
        span = (t1 - t0) / n
        path = PosePath(np.eye(3), pts[0])
        for i in range(n):
            path.to(t0 + i * span * 0.85, span * 1.15 if i < n - 1 else span, np.eye(3), pts[i + 1])
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
    def grab(self, grip="blank_faces", reach=1.27, lift_mm=40.0):
        """Reach (up and out of the table's way, then a slower final approach from above), the hand opening wider
        than the part with the peak at ~74% of the reach (Jeannerod; Bhatia 2022), closing at contact; then the
        lifting studies' preload (0.23 s) and loading (0.21 s) before lift-off, and a short lift."""
        t0 = self.t
        ga = self.hand.spec["grip"]
        g = self.grips[grip]
        Hg, Wg = self.grip_pose(grip, t0)
        t_contact = t0 + 0.35 + reach
        self.look(t0, self.stage + [0, 0, self.half[2]])
        if self.start == "vise":       # high over the crank's disc (the knob up to z 1040), then down onto the part
            via = [np.array([self.wrist[0] - 60, -760.0, 1160.0]), Wg + [0, -30, 120]]
        else:                           # in over its top by as much as over op30's (72 mm), and over it with the hand
            # 110 mm above its top before coming down onto it, as the open fingers reach 95 mm below the hand: op50's
            # part, on end, pinched 57 mm under its top, stood above the reach planned for the shorter ones, and the
            # fingers met its top and knocked it over
            top = self.stage[2] + self.half[2]
            via = [self.wrist + [70, 40, max(150.0, top + 72 - self.wrist[2])], Wg + [0, -12, max(62.0, top + 110 - Wg[2])]]
        self.transit(t0 + 0.35, t_contact, Wg, via=via, fade=(Hg, 1.0))
        # widest at ~74% of the reach as the hand-opening check measures it: from the hand's first motion (~0.25 s
        # before the transit, as the trunk turns to look) to its first touch (~0.15 s before the planned contact,
        # the open fingers meeting the faces as they close), with the fingers ~0.1 s behind their keys: 0.50 of the
        # planned reach (0.62 measured 0.795, 0.55 0.778, 0.53 0.692-0.711, 0.50 0.667)
        # a lift-out's reach runs high over the crank first: 0.53 measured 0.571 there, 0.70 0.844
        t_peak = t0 + 0.35 + (0.63 if self.start == "vise" else 0.54) * reach
        self.fingers(t0 + 0.35, self.q_relax)
        opened = open_for(self.hand, g["q"], self.size[1])
        if self.half[0] < 30:   # the ring and little tucked out of a narrow part's way (_grip_specs) stay tucked: opened
            # with the hand, they closed onto op50's top as it came down over it, 11 mm into it
            opened.update({n: v for n, v in g["q"].items() if n.split("_")[0] in ("ring", "little", "cmc4", "cmc5")})
        self.fingers(t_peak, opened)
        self.fingers(t_contact, g["q"])
        t_load = t_contact + ga["preload_s"]
        t_lift = t_load + ga["loading_s"]
        self.effort(t_contact, 0.0, grip)
        self.effort(t_load, 0.25, grip)
        self.effort(t_lift, 1.0, grip)
        R, p = self.blank_at(t_lift)
        self.move_blank(t_lift, t_lift + 0.45, R, p + [0, 0, lift_mm])
        self.add(t_contact, t_lift + 0.6, lambda t: [("pose", *self.grip_pose(grip, t), 3.0)])
        self.event("grip", t_contact, None, grip=grip)
        self.event("hold_object", t_contact, None, obj="blank")
        self.event("place_correct", t_lift + 0.3, None)
        self.t = t_lift + 0.6
        self.wrist = self.grip_pose(grip, self.t)[1]
        self.clip("grab", t0, self.t + 0.3, "GRAB  reach, open wider than the part, close, preload, load, lift")
        self.t_lift = t_lift

    def hold(self, grip="blank_faces", dur=2.6, tilt_deg=None):
        """Hold the part up in front and turn it to look at a face, steady (tremor only), and back. The reference
        part turns 28 deg; a heavier or longer one turns less, no further than the wrist torque that took (its
        weight times its length), as a part held one-handed is turned only so far."""
        if tilt_deg is None:
            torque, ref = self.load.mass_kg * self.size[0], REFERENCE.mass_kg * REFERENCE.size[0]
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
        self.move_blank(t0, t0 + 0.9, np.eye(3), high)
        self.move_blank(t0 + 0.85, t0 + 1.6, np.eye(3), over)
        self.move_blank(t0 + 1.55, t0 + 2.05, np.eye(3), above)
        t_down = t0 + 2.55
        self.move_blank(t0 + 2.05, t_down, np.eye(3), self.set_down)
        self.add(t0, t_down + 0.1, lambda t: [("pose", *self.grip_pose(grip, t), 3.0)])
        self.effort(t_down - 0.05, 1.0, grip)
        self.t_down = t_down
        if self.stop is not None:       # kept hold of, and slid along the floor onto the fixed jaw and the stop (slide)
            self.t, self.wrist = t_down, self.grip_pose(grip, t_down)[1]
            self.clip("place", t0 - 0.3, self.t + 0.2, "PLACE  over the jaw, down onto the vise's floor")
            return
        self.effort(t_down + 0.1, 0.0, grip)
        self.let_go(grip, t_down + 0.1)
        self.clip("place", t0 - 0.3, self.t + 0.2, "PLACE  over the jaw, down onto the parallels, let go by lifting off")

    def let_go(self, grip, t_rel):
        """The grip eased, let go of the part by lifting off it, not by opening into the jaws."""
        g = self.grips[grip]
        _, W_set = self.grip_pose(grip, t_rel)
        self.fingers(t_rel, g["q"])
        self.fingers(t_rel + 0.3, open_like(self.hand, g["q"], 0.12))
        self.fingers(t_rel + 0.6, open_like(self.hand, g["q"], 0.5))
        Hs = g["H_rel"]
        lift = PosePath(np.eye(3), W_set).to(t_rel, 0.3, np.eye(3), W_set + [0, -4, 22]).to(t_rel + 0.22, 0.45, np.eye(3), W_set + [0, -35, 70])
        def fn(t, lift=lift):
            p = lift.at(t)[1]
            w = 1 - min_jerk((t - t_rel) / 0.5)
            return [("pos", p, 1.0)] + ([("pose", Hs, p, w)] if w > 0 else [])
        self.add(t_rel, t_rel + 0.7, fn)
        self.event("hold_object", None, t_rel, obj="blank")
        self.event("place_correct", None, t_rel + 0.3)
        self.event("grip", None, t_rel + 0.1, grip=grip)
        self.t = t_rel + 0.7
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
        self.effort(t_down - 0.05, 1.0, grip)
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
        if self.stop is not None:
            return self.slide_held()
        mm = self.place_gap if mm is None else mm
        t0 = self.t
        g = self.grips[grip]
        Hs, Ws = g["H_rel"], self.set_down + g["W_rel"]
        self.look(t0, self.set_down + [0, self.half[1], self.half[2]])
        self.transit(t0, t0 + approach, Ws, via=[Ws + [0, -25, 40]], fade=(Hs, 1.0))
        self.fingers(t0 + 0.2, open_like(self.hand, g["q"], 0.5))
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
        self.t = t1 + 0.4
        self.clip("slide", t0 - 0.2, self.t + 0.2, "SLIDE  the thumb pushes the part along the parallels onto the fixed jaw")

    def slide_held(self, grip="blank_faces", dur=0.8, push_N=5.0):
        """A part stood on end against a stop, kept hold of from its set-down: slid along the vise's floor onto the
        fixed jaw, then along the jaw onto the stop, in the same grip, each push a set force until the jaw or the stop
        stops it, then let go. Pushed by the thumb near its top, as a shorter part is, op50's 158 mm part tipped over
        onto the fixed jaw; carried there by the plan alone, it stopped 4 mm short of the jaw; pushed onto both at
        once, it met the jaw first, and the 2 N left along the jaw didn't move it the 4 mm onto the stop. Pushed at
        9 N, where its 0.25 friction on the floor takes 2.4, it lurched onto the jaw and leaned 8 deg."""
        t0 = self.t
        self.look(t0, self.home + [0, self.half[1], self.half[2]])
        # nearly all its weight still carried, so it skims the floor: eased to 0.4, the floor's drag on its foot held
        # the foot back as the hand pushed 101 mm up, and it leaned on the stop's top with its foot 2.6 mm off it
        self.effort(t0 + 0.1, 0.9, grip)
        t1 = t0 + 0.1 + dur
        self.move_blank(t0 + 0.1, t1, np.eye(3), np.array([self.set_down[0], self.home[1], self.home[2]]))
        self.event("press", t0 + 0.2, t1, normal=[0, -1.0, 0], force=push_N, contact="blank")
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
        self.t = t1 + 0.45
        self.clip("push", t0 - 0.2, self.t + 0.2, f"PUSH  flat fingers press the part down onto the parallels ({force_N:.0f} N)")

    def rotate(self, grip="knob", rev_s=0.45, snug_deg=2.0, snug_N=15.0, final=False, tighten_deg=40.0):
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
        # from over the vise: out over the crank disc, then onto the knob from the operator's side
        self.transit(t0, t0 + 1.2, Wk, via=[over, Wk + Hk[:, 2] * 45 + [0, -10, 15]], fade=(Hk, 1.0))
        ko = open_like(self.hand, g["q"], 0.9)
        # widest ~74% into the reach as the check measures it: from the hand leaving the pause to its first touch on
        # the knob (~0.35 s before tg), with the fingers ~0.1 s behind their keys
        # the fingers, opening out of the fist's shape, reach ~10 mm short of it before closing on the knob (67 of 77);
        # at 12 op10's part and the knob opened only 0.73 mm apart per mm
        self.fingers(t0 + (0.63 if final else 0.7), open_for(self.hand, g["q"], 2 * VISE["knob_r"], lag_mm=10.0))   # 0.7: 74%, 81% final
        tg = t0 + 1.2
        self.fingers(tg, g["q"])
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
        self.add(tg, t_t1 + 0.35, lambda t: [("pose", Hk, knob_center(self.crank_angle(t)) - Hk @ pt, 3.0)])
        self.look(t_c0 + 0.3, 0.5 * np.array([VISE["x"], VISE["fixed_face_y"] - 52, JAW_TOP])
                  + 0.5 * np.array([VISE["x"], sc[1] - 40, sc[2] + 20]))
        self.effort(tg, 0.6, grip)
        self.effort(t_c1, 0.6, grip)
        self.effort(t_c1 + 0.1, 1.0 if final else 0.7, grip)
        self.effort(t_t1 + 0.35, 0.0, grip)
        self.event("grip", tg, t_t1 + 0.35, grip=grip)
        self.event("enclose", tg + 0.1, t_t1 + 0.35)
        self.event("crank", t_c0, t_t1 + 0.35, plan=dict(plan))
        tl = t_t1 + 0.35
        self.fingers(tl, g["q"])
        self.fingers(tl + 0.12, open_like(self.hand, g["q"], 0.25))      # eased, so the hand slides off the knob
        self.fingers(tl + 0.35, ko)
        Wend = knob_center(plan["phi_t"]) - Hk @ pt
        self.wrist = Wend
        box_c, box_h = np.array([sc[0], sc[1] - VISE["knob_grip"], sc[2]]), np.array([140.0, 55.0, 140.0])
        self.hand_boxes.append((box_c, box_h, self._knob_free_from, tg - 0.7))
        self._knob_free_from = tl + 0.35
        # off the knob's end along its axis first, then away: let go and moved off it out to the right and up, the
        # fingers swept across the lever wherever the crank stopped with the lever that way (op30's and op40's turns)
        off = Wend + [0, -60, 10]
        away = np.array([sc[0] + 175, -820, 990]) if final else over
        self.transit(tl, tl + 0.9, away, via=[off, off + [60, -10, 40]])
        self.fingers(tl + 0.9, self.q_relax)
        self.t = tl + 0.9
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


def build_lift_out(verbose=True, load: Load = REFERENCE, out=TAKES / "lift-out", grips_from=None):
    """The part lifted out of the loosened vise and set on the table: the unload's last take."""
    take = Take(verbose, load, out, grips_from, start="vise")
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
    take.grip_digits = {name: list(spec["targets"]) for name, spec in take._grip_specs().items()}
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
