"""A step's plan for both hands on one trunk (plan §4): what every take has in common, so a step only adds its verbs.

Each hand gets constraints over time (wrist positions and poses), finger shapes, effort and grips; the step adds the
gaze, its events and its clips. `solve` plans the trunk and both arms at once (moonshot/motion/solver.py) and `save`
writes reference.npz and take.json, which the physics run tracks (moonshot/sim/runner.py).

Positions are given in the world for either hand. A left hand's are moved into the mirrored world here, where the
planner and the grips treat it as a right hand (moonshot/motion/kinematics.py); a left hand's frame H is given in the
mirrored world, as its grips come out of the grip solver.

reference.npz: t, theta (n, 21), dp (n, 3) mm, fps, names (NIMBLE's joints), eye, look, up (n, 3), lumbar, and per
hand s in R, L: {s}_q (n, J) degrees, {s}_H and {s}_forearm (n, 3, 3), {s}_W, {s}_S, {s}_E (n, 3) mm, {s}_effort
(n,), {s}_grip (n,); the left hand's in the mirrored world.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import math
import time
from pathlib import Path

import numpy as np

from moonshot.body.hand import AnatomicalHand
from moonshot.body.nimble import Nimble
from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion import kinematics as BM
from moonshot.motion import solver as BS
from moonshot.motion.primitives import FPS, PosePath, blend_q, min_jerk, relaxed, tremor

MOONSHOT = Path(__file__).resolve().parents[1]
SIDES = ("R", "L")
REST_OFFSET = np.array([210.0, 55.0, -105.0])      # a hand hanging relaxed by the thigh, from the lumbar pivot
THETA0 = [8.0, 0, 0, 40, 40, 0, 60, 20, 0, 0, 0, 0]
KEY = "__source_hash__"


class StepTake:
    def __init__(self, out, lumbar, verbose=True):
        self.out, self.lumbar, self.verbose = Path(out), np.asarray(lumbar, float), verbose
        self.out.mkdir(parents=True, exist_ok=True)
        self.hand = AnatomicalHand(Nimble(data_root() / "hand-model" / "nimble"))
        self.th = G.TorchHand(self.hand)
        self.prior = BS.ArmPrior()
        self.q_relax = relaxed(self.hand)
        self.rest = self.lumbar + REST_OFFSET               # the same in the mirrored world for the left hand
        self.side = {s: {"cons": [], "fkeys": [(0.0, self.q_relax)], "ekeys": [(0.0, 0.0, None)],
                         "wrist": self.rest.copy(), "loads": []} for s in SIDES}
        self.gaze, self.events, self.clips, self.boxes = [], [], [], []
        self.grips: dict[str, dict] = {}
        self.t = 0.0

    # --- where -------------------------------------------------------------------------------------------
    def at(self, side: str, p) -> np.ndarray:
        """A world point where the side's planning sees it: itself for the right hand, mirrored for the left."""
        p = np.asarray(p, float)
        return p if side == "R" else BM.mirror_points(p, self.lumbar)

    def rest_of(self, side: str) -> np.ndarray:
        """Where the side's hand hangs relaxed, in the world."""
        return self.at(side, self.rest)

    def solve_grips(self, specs: dict[str, dict], source=None, depends=()) -> None:
        """Grips by name from grasp.solve_spec specs (each with its "side"), cached in the take's grips.json and
        solved again only when the code or the specs' source change: source is what builds the specs (a method, or
        the step's whole class by default), depends the modules whose constants place what is gripped (a holster's
        position isn't in the method that builds the spec). obj is given in the world."""
        src = "".join((MOONSHOT / f).read_text(encoding="utf-8") for f in (
            "motion/grasp.py", "body/hand.py", "motion/kinematics.py", "motion/solver.py", "body/data/anatomy.json"))
        src += inspect.getsource(source or type(self)) + "".join(inspect.getsource(m) for m in depends)
        key = hashlib.sha1((src + json.dumps(self.lumbar.tolist())).encode()).hexdigest()
        cache = self.out / "grips.json"
        data = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else {}
        if data.get(KEY) != key:                         # a field no grip can be named, so no grip overwrites it
            data = {KEY: key}
        for name, spec in specs.items():
            if name not in data:
                t0 = time.time()
                best = G.solve_spec(self.th, spec, self.lumbar, self.prior)
                data[name] = {k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in best.items()}
                if self.verbose:
                    print(f"grip {name} ({spec.get('side', 'R')}): loss {best['loss']:.1f} ({time.time() - t0:.0f} s)")
                cache.write_text(json.dumps(data, indent=1), encoding="utf-8")
        for name in specs:
            g = data[name]
            H, W, obj = np.array(g["H"]), np.array(g["W"]), np.array(g["obj"])
            self.grips[name] = {"q": self.hand.clamp(g["q"]), "H": H, "W": W, "obj": obj, "side": g["side"],
                                "theta": np.array(g["theta"]), "W_rel": W - obj, "loss": g["loss"]}

    def grip_pose(self, name: str, obj=None, R=None) -> tuple[np.ndarray, np.ndarray]:
        """The grip's hand frame and wrist (the side's world) with its object at obj (world; default where it was
        solved), turned by R (world, from how it stood when the grip was solved)."""
        g = self.grips[name]
        p = g["obj"] if obj is None else self.at(g["side"], obj)
        if R is None:
            return g["H"], p + g["W_rel"]
        Rs = R if g["side"] == "R" else BM.mirror_frames(R)
        return Rs @ g["H"], p + Rs @ g["W_rel"]

    # --- the plan's pieces -------------------------------------------------------------------------------
    def add(self, side, t0, t1, fn):
        """fn(t) -> constraints in the side's world: ("pos", W, w) | ("pose", H, W, w) | ("tsr", point in the hand,
        world point, axis in the hand, world axis, w): a point of the hand on a point, an axis along an axis, turning
        about it free (moonshot/motion/solver.py)."""
        self.side[side]["cons"].append((t0, t1, fn))

    def transit(self, side, t0, t1, W_to, via=(), fade=None):
        """Free motion of the wrist to W_to (world) through via points, min-jerk submovements that overlap; the body
        chooses the orientation; fade=(H, w_end) fades in a grip's orientation over the last 0.5 s."""
        s = self.side[side]
        pts = [s["wrist"]] + [self.at(side, v) for v in via] + [self.at(side, W_to)]
        n = len(pts) - 1
        span = (t1 - t0) / n
        path = PosePath(np.eye(3), pts[0])
        for i in range(n):
            path.to(t0 + i * span * 0.85, span * 1.15 if i < n - 1 else span, np.eye(3), pts[i + 1])

        def fn(t, path=path):
            out = [("pos", path.at(t)[1], 1.0)]
            if fade is not None and (w := min_jerk((t - (t1 - 0.5)) / 0.5)) > 0:
                out.append(("pose", fade[0], path.at(t)[1], w * fade[1]))
            return out
        self.add(side, t0, t1, fn)
        s["wrist"] = pts[-1]

    def follow(self, side, t0, t1, grip, obj_at, R_at=None):
        """Hold a grip on an object while it moves: obj_at(t) is the object's world position, R_at(t) how it has
        turned (world, from how it stood when the grip was solved)."""
        R_at = R_at or (lambda t: None)

        def fn(t):
            H, W = self.grip_pose(grip, obj_at(t), R_at(t))
            return [("pose", H, W, 1.0)]
        self.add(side, t0, t1, fn)
        self.side[side]["wrist"] = self.grip_pose(grip, obj_at(t1), R_at(t1))[1]

    def fingers(self, side, t, q):
        self.side[side]["fkeys"].append((t, q))

    def effort(self, side, t, value, grip=None):
        self.side[side]["ekeys"].append((t, value, grip))

    def load(self, side, t0, t1, kg):
        self.side[side]["loads"].append((t0, t1, kg))

    def look(self, t, point):
        self.gaze.append((t, np.asarray(point, float)))

    def event(self, kind, t0, t1, **kw):
        self.events.append(dict(kind=kind, t0=t0, t1=t1, **kw))

    def clip(self, verb, t0, t1, caption):
        self.clips.append(dict(verb=verb, t0=t0, t1=t1, caption=caption))

    def finger_at(self, side, t):
        keys = sorted(self.side[side]["fkeys"], key=lambda k: k[0])
        for (t0, a), (t1, b) in zip(keys, keys[1:]):
            if t0 <= t < t1:
                return blend_q(a, b, min_jerk((t - t0) / max(t1 - t0, 1e-9)))
        return keys[0][1] if t < keys[0][0] else keys[-1][1]

    def effort_at(self, side, t):
        keys = self.side[side]["ekeys"]
        for (t0, a, ga), (t1, b, gb) in zip(keys, keys[1:]):
            if t0 <= t < t1:
                return a + (b - a) * (t - t0) / max(t1 - t0, 1e-9), ga or gb
        return (keys[0][1], keys[0][2]) if t < keys[0][0] else (keys[-1][1], keys[-1][2])

    # --- solving and saving ------------------------------------------------------------------------------
    def solve(self, theta0=None, iters=3000):
        self.T = self.t + 0.3
        self.n = n = int(self.T * FPS) + 1
        s = BS.BodySolver(n, FPS, self.lumbar, self.prior, boxes=self.boxes, arms=SIDES)
        for side in SIDES:
            for k in range(n):
                t = k / FPS
                active = [fn for t0, t1, fn in self.side[side]["cons"] if t0 <= t < t1]
                if not active:                       # hold where the last move ended, or hang at rest before any
                    done = [(t1, fn) for t0, t1, fn in self.side[side]["cons"] if t1 <= t]
                    last = max(done, key=lambda c: c[0], default=None)
                    s.pos(k, self.rest if last is None else self.target_of(last[1], last[0] - 1e-6), 0.6, side=side)
                for fn in active:
                    for c in fn(t):
                        if c[0] == "pos":
                            s.pos(k, c[1], c[2], side=side)
                        elif c[0] == "tsr":
                            s.tsr(k, *c[1:5], w=c[5], side=side)
                        else:
                            s.pose(k, c[1], c[2], c[3], side=side)
                s.side[side]["load"][k] = sum(kg for t0, t1, kg in self.side[side]["loads"] if t0 <= t < t1)
        t0 = time.time()
        self.theta, self.dp, self.frames, terms = s.solve(np.array(theta0 if theta0 is not None else THETA0, float),
                                                         iters=iters, lr=0.03)
        self.left_frames = s.left_frames
        self.misses = self.plan_misses()
        if self.verbose:
            print(f"body: {n} frames solved in {time.time() - t0:.0f} s; {({k: round(v, 1) for k, v in terms.items()})}")
            print("wrist off its targets (mm, median / max): " + ", ".join(
                f"{s} {np.median(m):.1f} / {np.max(m):.1f}" for s, m in self.misses.items() if len(m)))

    def plan_misses(self) -> dict[str, np.ndarray]:
        """How far each hand's planned wrist is from its targets, at every frame that has one (mm)."""
        out = {}
        for side in SIDES:
            miss = []
            for k in range(self.n):
                t = k / FPS
                W = self.frames_at(k)[side]["W"]
                for t0, t1, fn in self.side[side]["cons"]:
                    if t0 <= t < t1:
                        miss.append(float(np.linalg.norm(W - self.target_of(fn, t))))
            out[side] = np.array(miss)
        return out

    @staticmethod
    def target_of(fn, t) -> np.ndarray:
        """The wrist position a constraint function asks for at t (its first constraint's)."""
        c = fn(t)[0]
        return np.asarray(c[1] if c[0] == "pos" else c[2], float)

    def frames_at(self, k: int) -> dict[str, dict]:
        """Each hand's frames at frame k, the left's in the mirrored world, as the solver planned them."""
        th, dp = self.theta[k], self.dp[k]
        out = {"R": BM.fk(th[:12], self.lumbar + dp)}
        out["L"] = BM.fk(np.r_[BM.mirror_trunk(th[:3]), th[12:21]], BM.mirror_points(self.lumbar + dp, self.lumbar))
        return out

    def save(self):
        n, t = self.n, np.arange(self.n) / FPS
        arrays = {"t": t, "theta": self.theta, "dp": self.dp, "fps": FPS, "names": np.array(self.hand.names),
                  "lumbar": self.lumbar}
        fr = [self.frames_at(k) for k in range(n)]
        for side in SIDES:
            touching = [(e["t0"] - 0.1, e["t1"]) for e in self.events if e["kind"] == "grip" and e.get("side") == side]
            amp = np.array([0.35 if any(a <= tk < b for a, b in touching) else 1.0 for tk in t])
            arrays |= {f"{side}_H": np.stack([f[side]["H"] for f in fr]), f"{side}_forearm": np.stack([f[side]["F"] for f in fr]),
                       f"{side}_W": np.stack([f[side]["W"] + tremor(tk + (0 if side == "R" else 7.3), a)
                                              for f, tk, a in zip(fr, t, amp)]),
                       f"{side}_S": np.stack([f[side]["S"] for f in fr]), f"{side}_E": np.stack([f[side]["E"] for f in fr]),
                       f"{side}_q": np.stack([self.hand.vector(self.finger_at(side, tk)) for tk in t])}
            eg = [self.effort_at(side, tk) for tk in t]
            arrays[f"{side}_effort"] = np.array([e for e, _ in eg])
            arrays[f"{side}_grip"] = np.array([g or "" for _, g in eg])
        arrays["eye"], arrays["look"], arrays["up"] = head_camera(self.gaze, self.theta, self.dp, self.lumbar)
        np.savez(self.out / "reference.npz", **arrays)
        (self.out / "take.json").write_text(json.dumps({
            "events": [{k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in e.items()} for e in self.events],
            "clips": self.clips, "T": self.T, "lumbar": self.lumbar.tolist(), "two_handed": True}, indent=1),
            encoding="utf-8")


def head_camera(gaze, theta, dp, lumbar):
    """Head-mounted camera from the gaze schedule: the head turns ~62% of the way to the eyes' target, ~30 ms behind
    them, smoothed like a neck (0.12 s); up from the head (as moonshot/motion/setup_take.py's)."""
    sched = sorted(gaze, key=lambda g: g[0])
    eyes, looks, ups = [], [], []
    head_dir = None
    a = (1 / FPS) / (0.12 + 1 / FPS)
    for k in range(len(theta)):
        t = k / FPS - 0.03
        tgt = sched[0][1]
        for t0, p in sched:
            if t >= t0:
                tgt = p
        f = BM.fk(theta[k][:12], lumbar + dp[k])
        eye0 = f["neck"] + f["thorax"] @ np.array([0, 60.0, 175.0])
        fwd = f["thorax"] @ np.array([0, math.cos(math.radians(30)), -math.sin(math.radians(30))])
        g = (tgt - eye0) / np.linalg.norm(tgt - eye0)
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
    sm = lambda A: np.stack([np.convolve(np.pad(A[:, i], 6, mode="edge"), np.hanning(13) / np.hanning(13).sum(), "valid")  # noqa: E731
                             for i in range(3)], 1)
    return sm(np.array(eyes)), sm(np.array(looks)), np.array(ups)
