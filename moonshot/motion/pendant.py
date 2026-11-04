"""Working the VF-2's pendant (plan §4; the vf2-controls card): the right index presses its keys and buttons, and the
right hand turns the jog handle in a precision disk grip, thumb under the rim and index and middle over it (Haas's
footage, moonshot/cards/footage/haas-edge-finder-indicator.timing.json). On a two-handed step
(moonshot/motion/step_take.py); the left hand rests at the side unless a step gives it work.

Keys are pressed with the index pad, one grip solved at a key in the keypad's middle and moved to each key, as the
keys are coplanar; the buttons stand 10 mm proud, so the same grip moves out by that much. The handle is turned in
strokes of at most a quarter turn: grip, turn the hand about the dial's axis, let go off the rim's front, turn back
and grip again, as a forearm can't keep turning. Each press and each stroke is an event the physics run reads
(moonshot/sim/pendant.py): "press" (key, force, t0, t1), and "turn" (clicks, t0, t1).

World millimetres; the machine stands as moonshot/world/cell.py places it (station x - 381).
"""
from __future__ import annotations

import math
import shutil

import mujoco
import numpy as np
import torch

from moonshot.body.skeleton import H0, build as build_body
from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion.primitives import PosePath, min_jerk, open_like
from moonshot.motion.step_take import StepTake
from moonshot.world import cell, vf2

OFFSET = np.array([-cell.LOAD_X_MM, 0.0, 0.0])           # station to world
REC = vf2.record()
A, C = REC["affordances"], REC["colliders"]
FACE_Y = A["keys"]["face_y_mm"]
DIAL = A["jog_handle"]
DIAL_C = np.array(DIAL["at_mm"], float) + OFFSET          # the dial's front face, centre
DIAL_U = np.array(DIAL["axis"], float)                    # into the pendant: a + turn is clockwise from the operator
DIAL_R = DIAL["radius_mm"]
DETENT_DEG = 360.0 / DIAL["detents_per_turn"]
STROKE_CLICKS = 20                                        # 72 deg a stroke: wider, and the turned hand's fingers swing
                                                          # down onto Cycle Start and Feed Hold below the handle
LUMBAR = np.array([200.0, -1430.0, 955.0])                # in front of the pendant's left half, the machine at the left
# a keypad grip per region of the keys, each solved at one key there: one hand pose can't reach every key without
# pitching the curled fingers into the face
KEY_GRIPS = {"keypad": "offset", "keypad_num": "0", "keypad_alpha": "m", "keypad_jog": "+x", "keypad_mode": "mdi",
             "keypad_inc": "inc_0.01"}           # the increment row's own: the mode grip's thumb fell on 4 and 5
KEY_EFFORT = 0.5                                          # the arm braced while it works the keys, as people
                                                          # co-contract for precise aiming (Gribble et al. 2003)
DIAL_EFFORT = 0.5                                         # a light grip on the jog handle, the least the run's pinch
                                                          # takes: at full effort the squeeze pressed the thumb into
                                                          # the handle's face, 8-16 N along its axis, and op30-z's
                                                          # muscles overloaded
OVERTURN = 1.15                                           # a stroke turns the hand this much farther than its clicks;
                                                          # the grip lets go when the dial reads right (sim/pendant.py)
OFF_RIM_MM = 25.0                                         # the pads sit within 12 mm of the rim's front: at 15 the
                                                          # opened hand's pose, turning back, came 5-7 mm into the
                                                          # handle (op30-z)
ON_RIM_S = 0.16                                           # onto the rim from there, and off it
TURN_BACK_S = 0.4                                         # off the rim, back over a stroke: in 0.22 s the wrist's arc
                                                          # peaked at 990 mm/s, the run's hand fell 30 mm behind and
                                                          # overshot 40, and was still 12-23 mm off as the grip closed
AXIAL_MM = 40.0                                           # onto and off the dial straight along its axis, this far
HOVER_MM = 40.0
HOVER_DWELL_S = 0.4                                       # the left index waits over Cycle Start before pressing it:
                                                          # pressed on arrival from the side, it was 45 mm short and
                                                          # 17 mm across at the press, and slid past (op20-z, op30-xy)
HOVER_RIGHT_MM = 40.0                                    # the right index ready over Feed Hold, not resting on it:
                                                          # held 15 mm off, its hand's sway of 10 mm pressed it
SETTLE_S = 0.3                                            # off the rim, before a jog's first stroke
CLEAR_MM = 60.0                                           # moves between the keys and the dial pass this far out
TOUCH_LIFT_MM = 1.0                                       # a press is planned to the pad touching the key, not in it:
                                                          # the push presses (moonshot/sim/pendant.py)
SHARED_GRIPS = data_root() / "takes" / "pendant" / "grips.json"   # every pendant take stands and grips alike


def key_at(name: str) -> np.ndarray:
    """A key's or button's surface centre (world mm)."""
    if name in ("cycle_start", "feed_hold"):
        return np.array(A[name]["at_mm"], float) + OFFSET
    x, z = A["keys"]["at_mm"][name]
    return np.array([x, FACE_Y, z], float) + OFFSET


def fingertip_in_hand(q: dict, press: np.ndarray) -> np.ndarray:
    """Where the body model's index meets a key, in the hand's frame (mm, from the wrist): its distal capsule's end
    farthest along the press direction (in the hand's frame), at the grip's finger angles. The physics run presses with
    that capsule, which sits inside the rendered skin, so the plan aims that point, not a skin vertex."""
    body = build_body()
    m = mujoco.MjModel.from_xml_string(body.xml)
    d = mujoco.MjData(m)
    for n, v in q.items():
        j = body.joints.get(f"R_{n}")
        if j is not None:
            d.qpos[m.jnt_qposadr[m.joint(j.name).id]] = math.radians(v - j.rest)
    mujoco.mj_kinematics(m, d)
    Hm, W = d.body("R_hand").xmat.reshape(3, 3) @ H0, d.body("R_hand").xpos
    g = m.geom("R_g_dis2").id
    axis = d.geom_xmat[g].reshape(3, 3)[:, 2] * m.geom_size[g][1]
    n = Hm @ np.asarray(press, float)
    tip = max((d.geom_xpos[g] + axis, d.geom_xpos[g] - axis), key=lambda e: e @ n) + n * m.geom_size[g][0]
    return Hm.T @ (tip - W) * 1000


def _rot(deg: float) -> np.ndarray:
    return G.rot_about(DIAL_U, deg)


def colliders() -> list:
    """The pendant's solids for the grip solver (world mm): its face, the dial, the E-stop and the buttons."""
    lo, hi = (np.array(C["pendant_face"][k], float) + OFFSET for k in ("box_min_mm", "box_max_mm"))
    out = [lambda p, c=(lo + hi) / 2, h=(hi - lo) / 2: G.sdf_box(p, c, np.eye(3), h),
           lambda p: G.sdf_cyl(p, DIAL_C, DIAL_C + DIAL_U * DIAL["depth_mm"], DIAL_R)]
    for g in ("estop", "cycle_start_button", "feed_hold_button"):
        cy = C[g]["cylinder"]
        c = np.array(cy["centre_mm"], float) + OFFSET
        out.append(lambda p, c=c, cy=cy: G.sdf_cyl(p, c - [0, cy["half_mm"], 0], c + [0, cy["half_mm"], 0], cy["radius_mm"]))
    return out


def keep_out(key: np.ndarray, depth: float = 12.0, window: float = 16.0) -> list:
    """Solids just in front of the pendant's face, but for a window round a key: the index goes in through the window,
    and the rest of the hand stays `depth` mm off the face, so the curled fingers can't lean on the keys around it."""
    lo, hi = (np.array(C["pendant_face"][k], float) + OFFSET for k in ("box_min_mm", "box_max_mm"))
    y0, y1 = FACE_Y - depth, FACE_Y
    x0, x1, z0, z1 = key[0] - window, key[0] + window, key[2] - window, key[2] + window
    boxes = [((lo[0], x0), (lo[2], hi[2])), ((x1, hi[0]), (lo[2], hi[2])), ((x0, x1), (lo[2], z0)), ((x0, x1), (z1, hi[2]))]
    out = []
    for (a, b), (c, e) in boxes:
        lo_b, hi_b = np.array([a, y0, c]), np.array([b, y1, e])
        out.append(lambda p, c_=(lo_b + hi_b) / 2, h_=(hi_b - lo_b) / 2: G.sdf_box(p, c_, np.eye(3), h_))
    return out


def rim(lo_deg: float, hi_deg: float, comp: float = 1.5, depth=(1.0, 12.0), w: float = 1.0):
    """A pad on the dial's rim between two clock angles (0 at the top, + clockwise from the operator), within depth
    (mm) of the dial's front, facing its axis."""
    Ct, U = torch.as_tensor(DIAL_C), torch.as_tensor(DIAL_U)

    def f(c, n):
        rel = c - Ct
        t = rel @ U
        r = rel - t * U
        radial = torch.linalg.norm(r)
        ang = torch.rad2deg(torch.atan2(r[0], r[2]))
        return w * ((radial - (DIAL_R - comp)) ** 2 + 20 * (1.0 + n @ (r / radial)) ** 2
                    + 0.5 * (torch.relu(depth[0] - t) ** 2 + torch.relu(t - depth[1]) ** 2)
                    + 0.05 * (torch.relu(lo_deg - ang) ** 2 + torch.relu(ang - hi_deg) ** 2))
    return f


def dial_open(hand, q: dict) -> dict:
    """The dial grip opened halfway, onto and off the rim: the thumb, index and middle, which hold it; the ring and
    little stay curled as they grip, in front of the dial's face. Opened too, they straightened into it: the ring 18-21
    mm inside the handle in the plan's own pose off the rim, and the run's hand, pushed back 14 mm, closed on the rim
    off its plan, the index and middle on it before the thumb (op30-z, the muscles past their maximum)."""
    return open_like(hand, q, 0.5) | {n: q[n] for n in q if n.startswith(("ring", "little", "cmc4", "cmc5"))}


class PendantTake(StepTake):
    """A step at the pendant. The machine's handle state is followed as the step presses keys, so a stroke knows the
    axis and increment it jogs: `axis_mm` is where the plan expects the machine (Haas's machine mm) after it."""

    def __init__(self, out, lumbar=LUMBAR, verbose=True, start_mm=(0.0, 0.0, 0.0)):
        super().__init__(out, lumbar, verbose)
        lo, hi = (np.array(C["pendant_face"][k], float) + OFFSET for k in ("box_min_mm", "box_max_mm"))
        self.boxes = [((lo + hi) / 2, (hi - lo) / 2)]
        own = self.out / "grips.json"
        if SHARED_GRIPS.exists() and not own.exists():
            shutil.copy(SHARED_GRIPS, own)
        self.solve_grips(self._grip_specs())
        SHARED_GRIPS.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(own, SHARED_GRIPS)
        # per keypad grip: where the index meets the face, in the hand's frame (fingertip_in_hand), and the press
        # direction
        self.pad_in_hand = {}
        for name in KEY_GRIPS:
            g = self.grips[name]
            ax = g["H"].T @ np.array([0.0, 1.0, 0.0])
            self.pad_in_hand[name] = (fingertip_in_hand(g["q"], ax), ax)
        self.key_H = self.grips["keypad"]["H"]    # the keypad grip's hand frame the hand last pressed with
        self.key_grip_last = ""                   # ... and its name
        self.where = "rest"                       # the right hand: "rest", "keys", "dial" or "hover"
        self.hold: dict[str, tuple] = {}          # a hand held where it is while the machine works: (H, W)
        self.cursor = 0                           # the work offsets page's cursor: x, y or z
        self.jog_axis, self.inc_mm = "x", 0.001 * vf2.INCH
        self.axis_mm = np.array(start_mm, float)
        self.dial_deg = 0.0                       # the planned dial angle, for the strokes' grip
        self.jogs = 0

    def _grip_specs(self) -> dict:
        S = lambda *a: list(a) + [0.0, 0.0]      # noqa: E731  trunk 3, arm 7, girdle 2
        h = self.hand
        q = h.neutral()
        q.update(index_mcp_flex=12, index_pip=12, middle_mcp_flex=70, middle_pip=90, ring_mcp_flex=80, ring_pip=95,
                 little_mcp_flex=80, little_pip=90, thumb_cmc_flex=15, thumb_cmc_abd=10, thumb_mcp_flex=40, thumb_ip=30)
        specs = {}
        for name, ref in KEY_GRIPS.items():
            k = key_at(ref)
            band = lambda p, k=k: 0.5 * ((p[0] - k[0]) ** 2 + (p[2] - k[2]) ** 2)    # noqa: E731
            specs[name] = dict(obj=k, q0=q, colliders=colliders() + keep_out(k), iters=900, side="R",
                               targets={"index": G.plane_target(k, [0, -1.0, 0], 1.0, band)},
                               starts=[S(8, 0, r, 75, 55, -10, 80, p, 0, 0) for p in (40, 75) for r in (0, 15)])
        q = h.neutral()
        for n in ("index", "middle"):
            q[f"{n}_mcp_flex"], q[f"{n}_pip"] = 45.0, 45.0
        q.update(ring_mcp_flex=60, ring_pip=70, little_mcp_flex=60, little_pip=70,
                 thumb_cmc_abd=30, thumb_cmc_flex=10, thumb_mcp_flex=20, thumb_ip=15)
        dial = dict(obj=DIAL_C.copy(), q0=q, colliders=colliders(), iters=1200, side="R",
                    # each pad 3 mm or more behind the rim's front: at 1 mm the thumb's tip rode onto the dial's face
                    # as the hand moved along the axis, the one digit on the dial, pressed into it (op30-z, op50-check:
                    # skin 6 mm deep, muscles over their maximum)
                    targets={"thumb": rim(150, 215, depth=(3.0, 12.0)), "index": rim(-40, 5, depth=(3.0, 12.0)),
                             "middle": rim(0, 45, depth=(3.0, 12.0))},
                    starts=[S(8, 0, r, 75, 50, -10, 85, p, 0, 0) for p in (0, 30, 60) for r in (0, 15)])
        c = key_at("cycle_start")
        button_l = dict(obj=c, q0=q, colliders=colliders(), iters=900, side="L",
                        targets={"index": G.plane_target(c, [0, -1.0, 0], 1.0,
                                                         lambda p: 0.5 * ((p[0] - c[0]) ** 2 + (p[2] - c[2]) ** 2))},
                        starts=[S(8, 0, r, 75, 50, -10, 80, p, 0, 0) for p in (40, 75) for r in (-15, 0)])
        return specs | {"dial": dial, "button_L": button_l}

    # --- the keys ----------------------------------------------------------------------------------------
    def key_grip(self, name: str) -> str:
        """The keypad grip solved nearest a key."""
        k = key_at(name)
        return min(KEY_GRIPS, key=lambda g: np.linalg.norm((key_at(KEY_GRIPS[g]) - k)[[0, 2]]))

    def key_pose(self, name: str, lift: float = 0.0):
        """The hand frame and wrist with the fingertip `lift` mm off a key, in its region's grip."""
        g = self.key_grip(name)
        H, (pt, _) = self.grips[g]["H"], self.pad_in_hand[g]
        return H, key_at(name) - [0, lift, 0] - H @ pt

    def press(self, name: str, force: float | None = None, move_s: float = 0.2, hold_s: float = 0.2) -> None:
        """Move the index over a key (from the keys, or reaching from elsewhere), press it, and lift off."""
        force = force or (A[name]["force_n"] if name in ("cycle_start", "feed_hold") else A["keys"]["force_n"])
        grip = self.key_grip(name)
        q = self.grips[grip]["q"]
        pt, ax = self.pad_in_hand[grip]
        H, W_on = self.key_pose(name, TOUCH_LIFT_MM)              # the wrist with the fingertip just off the key
        hover = W_on + [0, -HOVER_MM, 0]
        t0 = self.t
        reached = self.where != "keys"
        if reached:
            self.look(t0, key_at(name))
            via = self.clear_of_face(hover)
            dur = self.travel_s([self.side["R"]["wrist"], *via, hover])
            self.transit("R", t0, t0 + dur, hover, via=via, fade=(H, 1.0))
            self.effort("R", t0, 0.0, "keypad")
            self.effort("R", t0 + dur, KEY_EFFORT, "keypad")
            if self.where == "dial":              # open round the rim until the hand is off it: closed into the
                # key's grip 0.1 s into the move, the thumb and middle pinched the rim 20-29 N as the hand pulled
                # away, until the middle snapped off (op30-z, a finger flexor past its maximum)
                self.fingers("R", t0 + 0.35 * dur, dial_open(self.hand, self.grips["dial"]["q"]))
                self.fingers("R", t0 + 0.6 * dur, q)
            else:
                self.fingers("R", t0 + 0.1, q)
            t0 += dur
            move_s = 0.05
        else:                                     # Fitts: farther keys take longer, about 0.6 m/s on average
            move_s = max(move_s, 0.12 + np.linalg.norm(hover - self.side["R"]["wrist"]) / 600.0)
        start = self.side["R"]["wrist"]
        self.fingers("R", t0 + move_s * 0.5, q)
        # over the key, lined up by sight, before going in: longer after a longer move, as the hand takes longer to
        # settle on its target
        dwell = 0.6 if reached else 0.15 + min(0.45, np.linalg.norm(hover - start) / 400.0)
        if grip != self.key_grip_last:            # a new region's grip: the hand turns to it before it presses
            dwell += 0.4
        move_s += dwell
        # from the keys, the hand turns from the last key's grip to this one's on the way (a reach from elsewhere has
        # turned already), its pad blending from where it sat in the last grip: the new grip's frame and pad held from
        # the move's start jumped the fingertip's target, 16 mm in a frame from op30-z's Edit to Down
        H0 = H if reached else self.key_H
        pt0 = pt if reached or not self.key_grip_last else self.pad_in_hand[self.key_grip_last][0]
        path = PosePath(H0, start).to(t0, move_s - dwell, H, hover).to(t0 + move_s, 0.25, H, W_on).to(
            t0 + move_s + 0.25 + hold_s, 0.12, H, hover)
        t1 = t0 + move_s + 0.37 + hold_s

        def cons(t, path=path, pt0=pt0, pt=pt, ax=ax, t0=t0, turn_s=move_s - dwell):
            # the fingertip on its path and pressing along the face's normal, the hand free to roll about it; the
            # grip's own orientation only as a preference, as one hand pose can't reach every key
            Ht, Wt = path.at(t)
            p = pt0 + (pt - pt0) * min_jerk((t - t0) / turn_s)
            return [("pose", Ht, Wt, 1.0), ("tsr", p, Wt + Ht @ p, ax, [0.0, 1.0, 0.0], 6.0)]
        self.add("R", t0, t1, cons)
        self.event("press", round(t0 + move_s + 0.1, 3), round(t0 + move_s + 0.25 + hold_s, 3), side="R",
                   key=name, force=force, normal=[0.0, 1.0, 0.0])
        self.effort("R", t1, KEY_EFFORT, "keypad")
        self.fingers("R", t1, q)                  # the press's shape held to its end: what comes next changes it after
        self.key_H, self.key_grip_last = H, grip
        self.side["R"]["wrist"], self.t, self.where = hover, t1, "keys"
        self._follow(name)

    @staticmethod
    def travel_s(points) -> float:
        """How long a reach along these points takes: about 0.5 m/s on average, from 0.45 s (Fitts-like)."""
        length = sum(np.linalg.norm(np.asarray(b, float) - np.asarray(a, float)) for a, b in zip(points, points[1:]))
        return float(np.clip(0.3 + length / 500.0, 0.45, 1.6))

    def clear_of_face(self, to, to_dial: bool = False) -> list:
        """Points to pass through between the keys and the dial: one well out from the face, so the hand doesn't skim
        the keys on the way (none for a reach from the side); and off and onto the dial straight along its axis, so
        a hand that lags or overshoots pushes on the rim's face, which can't turn it, rather than brushing across
        the rim, which does."""
        here = np.asarray(self.side["R"]["wrist"], float)
        via = [here - DIAL_U * AXIAL_MM] if self.where == "dial" else []
        if self.where in ("keys", "dial"):
            via.append((here + np.asarray(to, float)) / 2 + [0, -CLEAR_MM, 0])
        if to_dial:
            via.append(np.asarray(to, float) - DIAL_U * AXIAL_MM)
        return via

    def leave_keys(self, t: float) -> None:
        """The arm eases off as the hand leaves the keys."""
        if self.where == "keys":
            self.effort("R", t + 0.25, 0.0, None)

    def keys(self, names) -> None:
        for n in names:
            self.press(n)

    def type(self, text: str) -> None:
        """Type on the keypad: letters, digits, '.', '-' and spaces."""
        self.keys(["space" if c == " " else c.lower() for c in text])

    def _follow(self, k: str) -> None:
        """The handle's state, as the machine will change it (moonshot/world/vf2.py Control)."""
        if k.startswith("inc_"):
            self.inc_mm = float(k[4:]) * vf2.INCH
        elif k in ("+x", "-x", "+y", "-y", "+z", "-z"):
            self.jog_axis = k[1]

    # --- the handle ----------------------------------------------------------------------------------------
    def dial_pose(self, deg: float, off: float = 0.0):
        """The dial grip turned `deg` clockwise about the dial's axis, `off` mm back off the rim toward the operator."""
        g = self.grips["dial"]
        R = _rot(deg)
        return R @ g["H"], DIAL_C + R @ (g["W"] - g["obj"]) - DIAL_U * off

    def turn(self, clicks: int, deg_s: float = 300.0) -> None:
        """Turn the handle `clicks` detents (+ clockwise) in strokes of at most STROKE_CLICKS, and a spare one: the run
        stops the hand once the machine reads where this jog takes it (`to_mm`, from where the take starts the axis:
        moonshot/sim/pendant.py), so a stroke whose grip slipped is made up by the spare, and an unneeded spare is a
        hand holding still."""
        if clicks == 0:
            return
        self.jogs += 1                            # the strokes of one jog: the run counts their clicks together
        i = "xyz".index(self.jog_axis)
        to = round(float(self.axis_mm[i] + clicks * self.inc_mm), 4)
        n = math.ceil(abs(clicks) / STROKE_CLICKS)
        per = [abs(clicks) // n + (1 if i < abs(clicks) % n else 0) for i in range(n)]
        sign = 1 if clicks > 0 else -1
        g = self.grips["dial"]
        for c in per + [0]:
            d = sign * (c or per[-1]) * DETENT_DEG * OVERTURN
            a0, a1 = -d / 2, d / 2
            t0 = self.t
            H0_, W_off = self.dial_pose(a0, OFF_RIM_MM)
            self.leave_keys(t0)
            if self.where != "dial":
                if self.where == "keys":              # the last key let go before the hand leaves for the dial
                    self.wait(0.25)
                    t0 = self.t
                via = self.clear_of_face(W_off, to_dial=True)
                dur = self.travel_s([self.side["R"]["wrist"], *via, W_off])
                self.transit("R", t0, t0 + dur, W_off, via=via, fade=(H0_, 1.0))
                # the hand opens for the dial late in the reach, widest about 75% of the way, as people's do: opened
                # at its start, over the keys, the middle finger reached 4.7 mm off them and pressed a digit
                shape = max(self.side["R"]["fkeys"], key=lambda k: k[0])[1]
                self.fingers("R", t0 + 0.4 * dur, shape)
                self.fingers("R", t0 + 0.75 * dur, dial_open(self.hand, g["q"]))
                t0 += dur
                # settled off the rim before the first stroke: a grip closing on a hand still arriving misses
                self.add("R", t0, t0 + SETTLE_S, lambda t, H=H0_, W=W_off: [("pose", H, W, 3.0)])
                t0 += SETTLE_S
            else:                                     # turn back, off the rim, from the last stroke's end
                back = self.dial_deg
                self.add("R", t0, t0 + TURN_BACK_S, lambda t, b=back, t0=t0, a0=a0: [
                    ("pose", *self.dial_pose(b + (a0 - b) * min_jerk((t - t0) / TURN_BACK_S), OFF_RIM_MM), 3.0)])
                t0 += TURN_BACK_S
            # onto the rim, close, turn, let go, back off
            tc, dur = t0 + ON_RIM_S, max(0.25, abs(d) / deg_s)
            self.add("R", t0, tc, lambda t, t0=t0, a0=a0: [
                ("pose", *self.dial_pose(a0, OFF_RIM_MM * (1 - min_jerk((t - t0) / ON_RIM_S))), 3.0)])
            self.fingers("R", t0, dial_open(self.hand, g["q"]))
            self.fingers("R", tc + 0.08, g["q"])
            self.effort("R", tc, 0.0, "dial")
            self.effort("R", tc + 0.1, DIAL_EFFORT, "dial")
            ts = tc + 0.12
            self.add("R", tc, ts + dur + 0.08, lambda t, ts=ts, dur=dur, a0=a0, a1=a1: [
                ("pose", *self.dial_pose(a0 + (a1 - a0) * min_jerk((t - ts) / dur)), 3.0)])
            self.event("turn", round(ts, 3), round(ts + dur, 3), side="R", clicks=sign * c, axis=self.jog_axis,
                       inc_mm=self.inc_mm, jog=self.jogs, to_mm=to)
            self.event("grip", round(tc, 3), round(ts + dur + 0.1, 3), side="R", grip="dial")
            te = ts + dur + 0.08
            self.effort("R", te, DIAL_EFFORT, "dial")
            self.effort("R", te + 0.06, 0.0, "dial")
            self.fingers("R", te, g["q"])
            self.fingers("R", te + 0.12, dial_open(self.hand, g["q"]))
            self.add("R", te, te + ON_RIM_S, lambda t, te=te, a1=a1: [
                ("pose", *self.dial_pose(a1, OFF_RIM_MM * min_jerk((t - te) / ON_RIM_S)), 3.0)])
            self.dial_deg, self.t, self.where = a1, te + ON_RIM_S, "dial"
            self.side["R"]["wrist"] = self.dial_pose(a1, OFF_RIM_MM)[1]
            self.axis_mm[i] += sign * c * self.inc_mm

    def press_left(self, name: str, hover_right: str | None = None) -> None:
        """The left index presses a button (Cycle Start) while the right index hovers over another (Feed Hold), as
        the card has one hand ready on Feed Hold whenever the other starts the machine."""
        t0 = self.t
        if hover_right:
            H, W = self.key_pose(hover_right, lift=HOVER_RIGHT_MM)
            start = self.side["R"]["wrist"]
            path = PosePath(H, start).to(t0, 0.5, H, W)
            self.add("R", t0, t0 + 0.5, lambda t, path=path: [("pose", *path.at(t), 3.0)])
            self.side["R"]["wrist"], self.hold["R"] = W, (H, W)
            self.where = "hover"
        g = self.grips["button_L"]
        H, W_on = g["H"], g["W"] + [0, -TOUCH_LIFT_MM, 0]   # solved at the button, in the mirrored world
        hover = W_on + [0, -HOVER_MM, 0]
        self.transit("L", t0, t0 + 0.7, self.at("L", hover), fade=(H, 1.0))   # transit takes world points
        self.fingers("L", t0 + 0.1, g["q"])
        tp = t0 + 0.7 + HOVER_DWELL_S
        path = PosePath(H, hover).to(tp, 0.08, H, W_on).to(tp + 0.2, 0.08, H, hover)
        self.add("L", t0 + 0.7, tp + 0.28, lambda t, path=path: [("pose", *path.at(t), 3.0)])
        self.event("press", round(tp + 0.04, 3), round(tp + 0.2, 3), side="L", key=name, force=A[name]["force_n"],
                   normal=[0.0, 1.0, 0.0])
        self.look(t0, key_at(name))
        self.side["L"]["wrist"], self.hold["L"] = hover, (H, hover)
        self.t = tp + 0.28

    def release_left(self, dur: float = 0.9) -> None:
        """The left hand back to the side; the right hand off its hover, onto the keys again."""
        self.hold.pop("L", None)
        self.fingers("L", self.t + 0.2, self.q_relax)
        self.transit("L", self.t, self.t + dur, self.at("L", self.rest))
        if self.hold.pop("R", None) is not None:
            self.where = "keys"

    def rest_hand(self, dur: float = 1.0) -> None:
        """The right hand back to the side."""
        self.leave_keys(self.t)
        self.fingers("R", self.t + 0.2, self.q_relax)
        self.transit("R", self.t, self.t + dur, self.rest, via=self.clear_of_face(self.rest))
        self.t += dur
        self.where = "rest"

    def wait(self, dur: float) -> None:
        """Hands still where they are."""
        if "L" in self.hold:
            H, W = self.hold["L"]
            self.add("L", self.t, self.t + dur, lambda t, H=H, W=W: [("pose", H, W, 1.0)])
        W = self.side["R"]["wrist"]
        if self.where == "hover":
            H, W = self.hold["R"]
            self.add("R", self.t, self.t + dur, lambda t, H=H, W=W: [("pose", H, W, 1.0)])
            self.t += dur
            return
        if self.where == "keys":
            H = self.key_H
        elif self.where == "dial":
            H = self.dial_pose(self.dial_deg, OFF_RIM_MM)[0]
        else:
            H = None
        self.add("R", self.t, self.t + dur, lambda t: [("pose", H, W, 1.0)] if H is not None else [("pos", W, 0.6)])
        self.t += dur
