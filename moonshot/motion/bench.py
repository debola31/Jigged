"""Two-handed takes at the inspection bench (plan §5.4): what nist-ftc-10's bench steps share. Each step's plan
(moonshot/motion/deburr.py, moonshot/motion/inspect.py) composes these verbs into one take, as
moonshot/motion/setup_take.py does for the vise, with both arms on one trunk.

The left hand is planned as the right hand of the mirrored world (moonshot/motion/kinematics.py): its grips are
solved mirrored (grasp.solve_spec, side "L") and its wrist targets are given mirrored, so every left-hand position
here is in that world. What the right hand carries is planned as the object's own path; the hand follows it through
the grip, solved once at the object's rest.

    plan = BenchPlan(out)                 # then a step's verbs, then plan.solve(); plan.save()

A step may stand elsewhere at the bench (`lumbar`), solve its grips weighing people's posture more than the
shared solver does (`grip_weights`, or one grip's own: its spec's `weights`), and its body with its own weights
(`solver_w`).
"""
from __future__ import annotations

import hashlib
import inspect
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import mujoco
import numpy as np
import torch
from scipy.spatial.transform import Rotation

from moonshot.body.hand import ANATOMY, AnatomicalHand
from moonshot.body.nimble import Nimble
from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion import kinematics as BM
from moonshot.motion.step_take import HANGING
from moonshot.motion import solver as BS
from moonshot.motion.primitives import FPS, PosePath, blend_q, min_jerk, open_like, relaxed, tremor
from moonshot.motion.setup_take import head_camera
from moonshot.world import bench_cell as BC
from moonshot.world import inspection_bench as IB

MOONSHOT = Path(__file__).resolve().parents[1]
LUMBAR = np.array([-60.0, -650.0, 955.0])          # standing at the bench's front, the part in front of the belly
REST_OFFSET = np.array([210.0, 55.0, -105.0])     # a hand hanging relaxed by its thigh, from where the body stands (the
                                                  # left's, mirrored)
TOP = IB.tops_mm()["bench"]
SIDES = ("R", "L")


def part_at(part: BC.BenchPart = BC.NIST_FTC_10, xy=(-80.0, -110.0)) -> np.ndarray:
    """Where a finished part lies on the mat: its STEP origin, a little over its resting height (it is let settle)."""
    return np.array([*xy, TOP + BC.MAT["size"][2] + part.lies_mm])


PART_AT = part_at()                               # nist-ftc-10, pocket up, dropped 0.2 mm onto its boss and slab
STEADY_N = 5.0                                    # the steadying hand's push (the caliper card's, proposed): on the
                                                  # rubber mat it holds the part; at 10 N the loaded arm sagged and
                                                  # crept the part 6 mm
RISE_S, STILL_S, REACH_S = 1.1, 0.25, 0.5         # a pickup: up from the thigh, still, then the reach to grasp. The
                                                  # rise is the slower: a reach is timed from the last stop before
                                                  # the fastest frame of the 2 s before contact, and risen in 0.7 s
                                                  # (1,046 mm/s, the reach 757) the reach was timed from the thigh
OPEN_LEAD_S = 0.12                                # its hand widest this long before it comes to rest (proposed): at
                                                  # 0.06 s the hand was widest 83-84% of the way through the reach.
                                                  # A pickup sets its own: one frame is 5% of a reach
CLOSE_S = 0.1                                     # ... then closing on the tool over this long (proposed)
PRELOAD_S = 0.1                                   # a lift, and the carry bearing it, start this long after the grip
                                                  # has closed: the hand's press into the tool takes ~0.15 s to let go
                                                  # as the carry eases in, so the grip rises for about people's 0.23 s
                                                  # (anatomy.json grip preload_s) before the load; from 0.07 s, 0.33 s.
                                                  # Carried from 0.1 s after contact, the carry's closing pressed the
                                                  # calipers 3.4 N into the bench and loaded the deburring tool at once.
                                                  # On the body whose colliders fit its skin, at once: 67 ms
CARRY_EASE_S = 0.3                                # ... the carry's correction of the hand easing in over this long
                                                  # (moonshot/sim/bench.py carry_offset)
TAKE_MM, TAKE_S = 4.5, 0.45                       # a lift first takes the tool's weight, so the load comes on over
                                                  # people's loading time (anatomy.json grip loading_s) before it
                                                  # leaves the bench: lifted straight off, the load took 33 and 100 ms
                                                  # to lift the tools; taking 1.5 mm over 0.6 s, the hand's give left
                                                  # the deburring tool down until the lift went on (533 ms); 2 mm
                                                  # over 0.5 s, 400 ms; 2.5 mm over 0.45 s, 100 ms, over 0.55 s,
                                                  # 133-167 ms. The body whose colliders fit its skin (37b295a8) gives
                                                  # 2.3 mm before the tool leaves the bench: 2.5 mm over 0.65 s, 467 ms;
                                                  # 4 mm over 0.45 s, 333 ms; 5 mm over 0.4 s and 6 mm over 0.35 s,
                                                  # 100 ms
LIFT_S = 1.0                                      # ... and is up its 30-35 mm this long after it starts


@dataclass(frozen=True)
class Steady:
    """Where the left hand holds the part down (BenchPlan.steady_spec), in the part's frame: the point it comes onto,
    each finger pad's target (the finger, a point on the face it lies on, the face's outward normal, and its band about
    that point along the world's axes, as bands' x=, y=, z=), the face it pushes on (its outward normal) and the arm's
    starting angles for the solve. nist-ftc-10's: flat on its wide rim, fingers forward."""
    at: tuple = (41.0, 0.0, 0.0)
    pads: tuple = tuple((f, (41.0, 0.0, 0.0), (0.0, -1.0, 0.0), (("x", b), ("y", (-12, 14))))
                        for f, b in (("index", (8, 20)), ("middle", (-7, 5)), ("ring", (-22, -10))))
    push: tuple = (0.0, -1.0, 0.0)
    starts: tuple = tuple((20, 0, r, 45, 45, -10, 75, p, 0, 0) for p in (40, 70) for r in (0, -10))
    # the hand's way up from the thigh, from where it hangs (mirrored: +x out), and off again, from where it held: not
    # the grip's, so out of the grips' cache key
    rise: tuple = field(default=(40.0, 60.0, 160.0), repr=False)
    away: tuple = field(default=(0.0, -25.0, 110.0), repr=False)


def box(c, h):
    return lambda p, c=np.asarray(c, float), h=np.asarray(h, float): G.sdf_box(p, c, np.eye(3), h)


def oriented_box(c, R, h):
    return lambda p, c=np.asarray(c, float), R=np.asarray(R, float), h=np.asarray(h, float): G.sdf_box(p, c, R, h)


def bench_box():
    lo, hi = (np.array(v, float) for v in IB.record()["bench"]["top_mm"].values())
    return (lo + hi) / 2, (hi - lo) / 2


def bands(c, **lims):
    """Penalty keeping a pad centre inside world-axis bounds relative to c: x=(lo, hi), y=(lo, hi), z=(lo, hi)."""
    c = np.asarray(c, float)

    def f(p):
        out = torch.zeros((), dtype=p.dtype)
        for k, (lo, hi) in lims.items():
            v = p["xyz".index(k)] - c["xyz".index(k)]
            out = out + torch.relu(lo - v) ** 2 + torch.relu(v - hi) ** 2
        return 0.5 * out
    return f


def instrument_colliders(rests: dict, names: tuple[str, ...], grow: float = 0.0) -> list:
    """The station's instruments named, where they settled (settle's rests), as a grip's colliders grown grow mm: what
    a hand coming onto the part beside them keeps off."""
    out = []
    for k in names:
        p, R = rests[f"insp_{k}"]
        for lo, hi in IB.record()["rests"][k]["boxes_mm"]:
            lo, hi = np.asarray(lo, float), np.asarray(hi, float)
            out.append(oriented_box(p + R @ ((lo + hi) / 2), R, (hi - lo) / 2 + grow))
    return out


def settle(loose: str, skip: tuple[str, ...] = (), seconds: float = 1.0, cell=BC) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Each loose body's pose (mm, rotation) once it has come to rest on the bench (or in another cell, a module with
    bench_cell's standalone_xml), no body model: what the plan aims at is where the physics will find it."""
    m = mujoco.MjModel.from_xml_string(cell.standalone_xml(loose, skip))
    d = mujoco.MjData(m)
    for _ in range(int(seconds / m.opt.timestep)):
        mujoco.mj_step(m, d)
    return {m.body(b).name: (d.xpos[b] * 1000, d.xmat[b].reshape(3, 3).copy()) for b in range(1, m.nbody)
            if m.body_jntnum[b]}


class BenchPlan:
    """A take's plan, verb by verb, for both hands: wrist tasks, finger keys, grip effort, gaze, objects' paths and the
    physics events (moonshot/sim/bench.py)."""
    lumbar = LUMBAR                 # where the body stands
    grip_weights: tuple[float, float] | None = None   # (people's posture, the pads' contact) for its grip solves, or
                                                      # the shared solver's (posture_cost's, 1)
    solver_w: dict = {}             # its own weights over the body solver's (BodySolver.W), as a step take's SOLVER_W
    bench_part = BC.NIST_FTC_10     # the finished part on the mat
    steady_on = Steady()            # where the left hand holds it down

    def __init__(self, out: Path, verbose: bool = True):
        torch.set_num_threads(8)
        self.out, self.verbose = Path(out), verbose
        self.out.mkdir(parents=True, exist_ok=True)
        self.hand = AnatomicalHand(Nimble(data_root() / "hand-model" / "nimble"))
        self.th = G.TorchHand(self.hand)
        self.prior = BS.ArmPrior()
        self.q_relax = relaxed(self.hand)
        self.cons = {s: [] for s in SIDES}
        self.fkeys = {s: [(0.0, self.q_relax)] for s in SIDES}
        self.ekeys = {s: [(0.0, 0.0, None)] for s in SIDES}
        self.rest = self.lumbar + REST_OFFSET
        self.wrist = {s: self.rest.copy() for s in SIDES}
        self.gaze, self.events, self.clips = [], [], []
        self.paths: dict[str, list] = {}           # object -> [(t, R, p)], planned while carried
        self.grips: dict[str, dict] = {}
        self.t = 0.0

    # --- grips, solved with the body, cached --------------------------------------------------------------------
    def solve_grips(self, specs: dict[str, dict], rests: dict[str, tuple[np.ndarray, np.ndarray]]) -> None:
        """specs: name -> grasp.solve_spec's spec, plus "of": the object it holds (its rest pose in rests, to carry
        it) or None. Cached in grips.json under a key of everything that decides them."""
        cache = self.out / "grips.json"
        src = ANATOMY.read_text(encoding="utf-8") + "".join(
            (MOONSHOT / f).read_text(encoding="utf-8") for f in ("motion/grasp.py", "body/hand.py", "motion/kinematics.py",
                                                                  "motion/solver.py"))
        src += inspect.getsource(type(self).grip_specs) + inspect.getsource(BenchPlan.steady_spec)
        src += repr(self.bench_part) + repr(self.steady_on)
        src += json.dumps(np.asarray(self.lumbar).tolist() + list(self.grip_weights or ()))
        src += json.dumps({k: [np.round(p, 2).tolist(), np.round(R, 4).tolist()] for k, (p, R) in sorted(rests.items())})
        src += json.dumps({k: [np.round(s["at"][0], 2).tolist(), np.round(s["at"][1], 4).tolist()]
                           for k, s in sorted(specs.items()) if s.get("at") is not None})
        key = hashlib.sha1(src.encode()).hexdigest()
        data = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else {}
        if data.get("key") != key:
            data = {"key": key}
            for name, spec in specs.items():
                t0 = time.time()
                weights = spec.get("weights", self.grip_weights)
                spec = {k: v for k, v in spec.items() if k not in ("of", "weights")}
                if weights:
                    w_prior, w_pad = weights
                    spec |= {"w_prior": w_prior,
                             "targets": {d: (lambda c, n, f=f: w_pad * f(c, n)) for d, f in spec["targets"].items()}}
                best = G.solve_spec(self.th, spec, self.lumbar, self.prior)
                data[name] = {k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in best.items()}
                if self.verbose:
                    print(f"grip {name}: loss {best['loss']:.1f} ({time.time() - t0:.0f} s) "
                          f"{ {k: round(v, 1) for k, v in best['terms'].items()} }", flush=True)
            cache.write_text(json.dumps(data, indent=1), encoding="utf-8")
        for name, spec in specs.items():
            g = data[name]
            H, W = np.array(g["H"]), np.array(g["W"])
            entry = {"q": self.hand.clamp(g["q"]), "H": H, "W": W, "theta": np.array(g["theta"]), "side": g["side"],
                     "loss": g["loss"], "terms": g["terms"], "of": spec.get("of")}
            if spec.get("of"):                      # carried: the grip in the object's frame, where it was solved
                p0, R0 = spec.get("at") or rests[spec["of"]]
                entry |= {"H_rel": R0.T @ H, "W_rel": R0.T @ (W - p0), "at": (p0, R0)}
            self.grips[name] = entry

    # --- the part, and the left hand holding it still -----------------------------------------------------------
    def mirror(self, p) -> np.ndarray:
        """A world point as the left hand's planner sees it, and back."""
        return BM.mirror_points(p, self.lumbar)

    def to_world(self, p_part, vec=False):
        """A point (or, vec, a direction) in the part's frame, its STEP's, in the world, where the part rests."""
        p, R = self.part
        return R @ np.asarray(p_part, float) + (0 if vec else p)

    def part_colliders(self, grow=0.0):
        p, R = self.part
        return [oriented_box(p + R @ ((np.array(lo) + hi) / 2), R, (np.array(hi) - lo) / 2 + grow)
                for lo, hi in self.bench_part.boxes.values()]

    def steady_spec(self) -> dict:
        """The left hand on the part where steady_on says: nist-ftc-10's, flat on its wide rim (its +X end, to the
        operator's left), fingers forward."""
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731  (trunk 3, arm 7, girdle 2)
        bc, bh = bench_box()
        st = self.steady_on
        c = self.to_world(st.at)

        # the pads on their faces, not into them: the press holds the part down. 2 mm in, on the body whose pads meet
        # what they touch (37b295a8), the arm landed as a strut and leant the trunk 16 deg to the right
        def pad(at, n, lims):
            p = self.to_world(at)
            return G.plane_target(p, self.to_world(n, vec=True), 0.0, bands(p, **dict(lims)))
        q0 = self.hand.neutral()
        for nm in ("index", "middle", "ring", "little"):
            q0[f"{nm}_mcp_flex"], q0[f"{nm}_pip"] = 15.0, 15.0
        q0.update(thumb_cmc_abd=10.0, thumb_cmc_flex=0.0, thumb_mcp_flex=15.0, thumb_ip=10.0)   # the thumb along the
        # index: tucked under the hand, it caught the part's edge as the hand lifted and raised it 2.4 mm; held out, it
        # came to rest on the micrometer in front and held the hand off the part
        return dict(side="L", obj=c, q0=q0, iters=900, colliders=self.part_colliders() + [box(bc, bh)],
                    targets={f: pad(at, n, lims) for f, at, n, lims in st.pads},
                    starts=[S(*a) for a in st.starts])

    def steady(self, t_reach, t_off):
        """The left hand comes onto the rim, fingers flat, and holds the part down until t_off."""
        g = self.grips["steady"]
        H, W = g["H"], g["W"]                              # the mirrored world
        tc = t_reach + 1.1
        # up out of the bench's way first: from the thigh, the knuckles catch its front edge. And out to its side as it
        # rises (+x, the mirrored world's outward): straight up in front of the thigh, the shoulder turned in to 35 deg
        # (people's 31)
        self.transit("L", t_reach, tc, W, via=[self.rest + self.steady_on.rise, W + [0, -30, 60]], fade=(H, 1.0))
        self.fingers("L", t_reach + 0.3, open_like(self.hand, g["q"], 0.4))
        self.fingers("L", tc, g["q"])
        self.hold("L", tc, t_off, H, W)
        self.effort("L", tc, 0.0, "steady")
        self.effort("L", tc + 0.15, 0.4, "steady")
        self.effort("L", t_off - 0.1, 0.4, "steady")
        self.effort("L", t_off, 0.0, "steady")
        self.event("grip", tc, t_off, side="L", grip="steady", on="part")
        # the push ends, and the hand is still a moment, before it lifts: lifting as it still pressed, its fingertips
        # dragged the part 9 mm
        push = self.to_world(self.steady_on.push, vec=True)
        self.event("press", tc + 0.3, t_off - 0.4, side="L", normal=push.tolist(),
                   force=STEADY_N, contact="part")
        self.fingers("L", t_off + 0.3, open_like(self.hand, g["q"], 0.3))
        # well up before back past the bench's edge: the wrist rests over the calipers, and lifted 40 mm the relaxing
        # fingers swept them 107 mm toward the operator and wedged them on the bench, which threw them
        self.transit("L", t_off, t_off + 0.5, W + self.steady_on.away, via=[W + [0, 0, 18]])
        self.fingers("L", t_off + 1.2, self.q_relax)
        self.transit("L", t_off + 0.5, t_off + 1.6, self.rest, via=[W + np.add(self.steady_on.away, [0, -205, 0])])
        self.clip("steady", tc - 0.3, tc + 0.6, "STEADY  the left hand holds the part down on the bench")

    # --- building blocks ---------------------------------------------------------------------------------------
    def add(self, side, t0, t1, fn):
        """fn(t) -> constraints ("pos", W, w) | ("pose", H, W, w) | ("tsr", point_hand, point, axis_hand, axis, w), in
        the side's world (moonshot/motion/solver.py)."""
        self.cons[side].append((t0, t1, fn))

    def transit(self, side, t0, t1, W_to, via=(), fade=None):
        """Free motion of a wrist from where it is to W_to through via points (overlapping min-jerk submovements),
        its orientation the body's choice; fade=(H, w) fades in the next grip's orientation over the last 0.5 s."""
        pts = [self.wrist[side]] + [np.asarray(v, float) for v in via] + [np.asarray(W_to, float)]
        n = len(pts) - 1
        span = (t1 - t0) / n
        path = PosePath(np.eye(3), pts[0])
        for i in range(n):
            path.to(t0 + i * span * 0.85, span * 1.15 if i < n - 1 else span, np.eye(3), pts[i + 1])

        def fn(t, path=path):
            out = [("pos", path.at(t)[1], 1.0)]
            w = min_jerk((t - (t1 - 0.5)) / 0.5) if fade is not None else 0.0
            return out + ([("pose", fade[0], path.at(t)[1], w * fade[1])] if w > 0 else [])
        self.add(side, t0, t1, fn)
        self.wrist[side] = np.asarray(W_to, float)

    def hold(self, side, t0, t1, H, W, w=3.0):
        self.add(side, t0, t1, lambda t: [("pose", H, W, w)])
        self.wrist[side] = np.asarray(W, float)

    def reach(self, side, grip, t0, ready, approach, opened, lead=OPEN_LEAD_S, reach_s=REACH_S, above=0.0,
              open_s=None, close_s=CLOSE_S, rest_open=0.15, closed=0.0, thumb_open=None, keep=None):
        """Up from where the hand hangs to ready, still a moment as the eyes find the grip, then the reach to grasp it,
        down onto it from approach, the hand widest (opened of the way to open_like's widest) lead before it comes to
        rest open round the tool, then closing on it. People's reaches to grasp last 0.32-0.67 s from the
        hand's onset (person.reach_to_grasp_right_s) and open widest 71-77% of the way
        (person.peak_aperture_reach_frac): run as one movement from the thigh, the calipers' reach measured 1.1 s,
        widest at 85% of it. Closing as the hand arrived, the fingers struck the tool: they threw the deburring tool
        13 mm up and shoved the calipers 6 mm. The grip is where the tool is when the hand comes to rest on it: the
        calipers' slider is still being stood on end as the right hand rises for it. A hand whose opened fingers
        reach below its closed ones comes to rest `above` (mm) the grip and closes as it comes down onto it: the
        left hand's on the calipers lying on the bench struck the bench, bounced 15 mm and closed on nothing. A hand
        opening only a little opens over the last `open_s` of the way: opened over all of it, its last 0.15 s were
        level to 0.3 mm, and its widest came where the noise put it. A hand coming down far onto its grip closes over
        `close_s`. The hand comes to rest open `rest_open` of the way: a hand whose pads touch its grip only as it
        closes there rests wider than 0.15. It closes to `closed` of the way open, the grip's squeeze closing it the
        rest: a pinch closed onto the faces' planes drags what it pinches along the fingers' arcs. Given
        `thumb_open`, the thumb comes to rest that far open, nearer its face than the fingers theirs, so it meets its
        face first and holds what the fingers close against: a pinch from above whose fingers met the far face first
        shoved a part standing on a shelf 20 mm toward the operator. `keep` (joint -> angle) holds the digits that take
        no part in the grip where they are out of the way, the reach through: opened with the rest, the L-block's ring
        finger swept through its upright as the hand closed.
        Returns when the grip has closed."""
        g = self.grips[grip]
        t_ready = t0 + RISE_S
        t_go = t_ready + STILL_S
        tc = t_go + reach_s
        H, W = self.grip_pose(grip, tc)
        up = np.array([0.0, 0.0, above])
        self.transit(side, t0, t_ready, ready)
        self.transit(side, t_ready, t_go, ready)
        self.transit(side, t_go, tc, W + up, via=[approach], fade=(H, 1.0))
        self.add(side, tc, tc + close_s, lambda t: [("pose", H, W + up * (1 - min_jerk((t - tc) / close_s)), 3.0)])
        self.wrist[side] = W
        self.fingers(side, t0 + 0.3, self.q_relax)
        if open_s is not None:
            self.fingers(side, tc - lead - open_s, self.q_relax)
        held = dict(keep or {})
        self.fingers(side, tc - lead, open_like(self.hand, g["q"], opened) | held)
        at_rest = open_like(self.hand, g["q"], rest_open)
        if thumb_open is not None:
            at_rest |= {k: v for k, v in open_like(self.hand, g["q"], thumb_open).items() if k.startswith("thumb")}
        self.fingers(side, tc, at_rest | held)
        self.fingers(side, tc + close_s, (open_like(self.hand, g["q"], closed) if closed else g["q"]) | held)
        return tc + close_s

    def obj_at(self, name, t):
        """The planned pose (R, p) of a carried object at t: min-jerk between its keys, held between them."""
        keys = self.paths[name]
        R, p = keys[0][1], keys[0][2]
        for (t0, R0, p0), (t1, R1, p1) in zip(keys, keys[1:]):
            if t <= t0:
                return R, p                            # on a key's time: where the last segment ended
            w = min_jerk((t - t0) / max(t1 - t0, 1e-9))
            dR = Rotation.from_matrix(R1) * Rotation.from_matrix(R0).inv()
            R = (Rotation.from_rotvec(dR.as_rotvec() * w) * Rotation.from_matrix(R0)).as_matrix()
            p = p0 + (p1 - p0) * w
            if t < t1:
                return R, p
        return keys[-1][1], keys[-1][2]

    def move(self, name, t0, t1, R, p):
        """Plan an object's motion over [t0, t1]; it is held where it was before t0."""
        last = self.paths[name][-1]
        if last[0] < t0:
            self.paths[name].append((t0, last[1], last[2]))
        self.paths[name].append((t1, np.asarray(R, float), np.asarray(p, float)))

    def grip_pose(self, grip, t):
        """The hand on a carried object at t (H, W in the hand's planning world). A left hand's grip is solved in the
        mirrored world, so the object's motion since it was solved is mirrored onto it there."""
        g = self.grips[grip]
        R, p = self.obj_at(g["of"], t)
        if g["side"] == "R":
            return R @ g["H_rel"], p + R @ g["W_rel"]
        p0, R0 = g["at"]
        D = R @ R0.T                                       # the object's turn since the grip was solved
        return BM.mirror_frames(D) @ g["H"], self.mirror(p + D @ (self.mirror(g["W"]) - p0))

    def carry(self, grip, t0, t1, w=3.0, free=None, point=(0.0, 0.0, 0.0), axis=(1.0, 0.0, 0.0)):
        """A hand on a carried object over [t0, t1]. Within each of free's (ta, tb) (the right hand's) only a point of
        the object and an axis through it are held to their plan, its turn about that axis the body's choice: nobody
        minds how a pen is rolled, and a roll fixed by the plan took more wrist than the plan allows. w may vary with
        t (a function of it)."""
        g = self.grips[grip]
        ph = g["H_rel"].T @ (np.asarray(point, float) - g["W_rel"])          # the point in the hand's frame
        ah = g["H_rel"].T @ np.asarray(axis, float)

        def fn(t):
            R, p = self.obj_at(g["of"], t)
            wt = w(t) if callable(w) else w
            if any(a <= t < b for a, b in free or ()):
                return [("tsr", ph, p + R @ np.asarray(point, float), ah, R @ np.asarray(axis, float), wt)]
            return [("pose", *self.grip_pose(grip, t), wt)]
        self.add(g["side"], t0, t1, fn)
        self.wrist[g["side"]] = self.grip_pose(grip, t1)[1]

    def fingers(self, side, t, q):
        self.fkeys[side].append((t, q))

    def effort(self, side, t, value, grip=None):
        self.ekeys[side].append((t, value, grip))

    def look(self, t, point):
        self.gaze.append((t, np.asarray(point, float)))

    def event(self, kind, t0, t1, **kw):
        self.events.append(dict(kind=kind, t0=t0, t1=t1, **kw))

    def clip(self, verb, t0, t1, caption):
        self.clips.append(dict(verb=verb, t0=t0, t1=t1, caption=caption))

    # --- assembling --------------------------------------------------------------------------------------------
    def finger_at(self, side, t):
        keys = sorted(self.fkeys[side], key=lambda k: k[0])
        if t <= keys[0][0]:
            return keys[0][1]
        for (t0, a), (t1, b) in zip(keys, keys[1:]):
            if t0 <= t < t1:
                return blend_q(a, b, min_jerk((t - t0) / max(t1 - t0, 1e-9)))
        return keys[-1][1]

    def effort_at(self, side, t):
        keys = self.ekeys[side]
        if t <= keys[0][0]:
            return keys[0][1], keys[0][2]
        for (t0, a, ga), (t1, b, gb) in zip(keys, keys[1:]):
            if t0 <= t < t1:
                return a + (b - a) * (t - t0) / max(t1 - t0, 1e-9), ga or gb
        return keys[-1][1], keys[-1][2]

    def obstacles(self) -> list[tuple[np.ndarray, np.ndarray]]:
        """What the arms' forearms keep clear of, as (centre, half size) boxes: the bench's top."""
        return [bench_box()]

    def solve(self, iters=3000):
        self.T = self.t + 0.3
        n = self.n = int(self.T * FPS) + 1
        s = BS.BodySolver(n, FPS, self.lumbar, self.prior, boxes=self.obstacles(), arms=SIDES)
        s.W = BS.BodySolver.W | self.solver_w
        for side in SIDES:
            first = min((x[0] for x in self.cons[side]), default=0.0)
            last = max((x[1] for x in self.cons[side]), default=0.0)
            for k in range(n):
                t = k / FPS
                active = [x for x in self.cons[side] if x[0] <= t < x[1]]
                if not active and (t < first or t >= last):
                    s.pos(k, self.rest, 0.6, side=side)
                for _, _, fn in active:
                    for con in fn(t):
                        if con[0] == "pos":
                            s.pos(k, con[1], con[2], side=side)
                        elif con[0] == "tsr":
                            s.tsr(k, *con[1:5], w=con[5], side=side)
                        else:
                            s.pose(k, con[1], con[2], con[3], side=side)
        t0 = time.time()
        self.theta, self.dp, self.frames, terms = s.solve(self.theta0(n), iters=iters, lr=0.03)
        self.left_frames = s.left_frames
        if self.verbose:
            print(f"body: {n} frames solved in {time.time() - t0:.0f} s; {({k: round(v, 1) for k, v in terms.items()})}",
                  flush=True)

    def theta0(self, n) -> np.ndarray:
        """The body solve's start, per frame (n, 21, deg): each arm as its first grip holds it while it has a task,
        hanging relaxed (HANGING) before and after. Started all from its grip, the hand at rest by the thigh kept the
        grip's turn, its shoulder rotated 32-40 deg (people's at most 31)."""
        r = next(g for g in self.grips.values() if g["side"] == "R")["theta"]
        lt = next(g for g in self.grips.values() if g["side"] == "L")["theta"]
        th = np.tile(np.r_[r[:12], lt[3:12]], (n, 1))
        for side, cols in (("R", slice(3, 12)), ("L", slice(12, 21))):
            first = min((x[0] for x in self.cons[side]), default=0.0)
            last = max((x[1] for x in self.cons[side]), default=0.0)
            for k in range(n):
                if not first <= k / FPS < last:
                    th[k, cols] = HANGING
        return th

    def body_at(self, k):
        """Frame k's right arm (world) and left arm (mirrored world) frames."""
        th, dp = self.theta[k], self.dp[k]
        right = BM.fk(th[:12], self.lumbar + dp)
        left = BM.fk(BM.mirror_trunk(np.r_[th[:3], th[12:21]]), self.lumbar + dp * np.array([-1.0, 1.0, 1.0]))
        return right, left

    def save(self, extra: dict) -> None:
        """reference.npz (both arms, the left in the mirrored world as L_*; each carried object's path) and take.json
        (events, clips, and extra: what the step's gate reads)."""
        n = self.n
        ts = np.arange(n) / FPS
        out = {"t": ts, "theta": self.theta, "dp": self.dp, "names": np.array(self.hand.names), "fps": FPS}
        for side in SIDES:
            pre = "" if side == "R" else "L_"
            touching = lambda t: any(e["t0"] - 0.1 <= t < e["t1"] for e in self.events     # noqa: E731
                                     if e["kind"] == "grip" and e["side"] == side)
            fr = [self.body_at(k)[SIDES.index(side)] for k in range(n)]
            out[pre + "H"] = np.stack([f["H"] for f in fr])
            out[pre + "W"] = np.stack([f["W"] + tremor(t + 3.1 * SIDES.index(side), 0.35 if touching(t) else 1.0)
                                       for f, t in zip(fr, ts)])
            for k_out, k_in in (("S", "S"), ("E", "E"), ("forearm", "F")):
                out[pre + k_out] = np.stack([f[k_in] for f in fr])
            out[pre + "q"] = np.stack([self.hand.vector(self.finger_at(side, t)) for t in ts])
            eg = [self.effort_at(side, t) for t in ts]
            out[pre + "effort"] = np.array([e for e, _ in eg])
            out[pre + "grip"] = np.array([g or "" for _, g in eg])
        for name in self.paths:
            poses = [self.obj_at(name, t) for t in ts]
            out[f"obj_{name}"] = np.stack([p for _, p in poses])
            out[f"obj_{name}_R"] = np.stack([R for R, _ in poses])
        self.theta12 = self.theta[:, :12]
        eyes, looks, ups = head_camera(self, self.theta12, self.dp, lumbar=self.lumbar)
        out |= {"eye": eyes, "look": looks, "up": ups}
        np.savez(self.out / "reference.npz", **out)
        jsonable = lambda v: v.tolist() if isinstance(v, np.ndarray) else v        # noqa: E731
        (self.out / "take.json").write_text(json.dumps({
            "events": [{k: jsonable(v) for k, v in e.items()} for e in self.events], "clips": self.clips,
            "T": self.T, "lumbar": np.asarray(self.lumbar).tolist(), "arms": list(SIDES)} | extra, indent=1), encoding="utf-8")
