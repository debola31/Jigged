"""A step at the VF-2's pendant (moonshot/motion/pendant.py) run in MuJoCo, on the two-handed runner
(moonshot/sim/runner.py): the part clamped in the vise, a tool in the spindle, and the machine's control
(moonshot/world/vf2.py) reading the hands.

- A press is force control at the index pad: the planned force pushed into the key along the plan's normal,
  trimmed by how hard the pad really presses (integral control), as the vise take presses (moonshot/sim/vise_take.py),
  until the key clicks.
  The plan aims the fingertip at the key, and the runner's sight-guided correction (moonshot/sim/runner.py) takes
  up how far the hand trails it. The fingertip is a hand's length from the wrist, so a few degrees of the hand's turn
  put it a key away: sight steers the fingertip itself onto the key, across the key's face (in proportion to how far
  off it is, and slowly for what stays off). Until it is over its key it is held off the face, so a hand that arrives
  off its key re-aims rather than sliding across the keys between; the press's own direction is the force's.
- A jog of the handle ends when the machine reads where the plan has it after the jog, as people stop turning when
  the display reads right: the plan's strokes turn the hand a third farther than the jog needs, and once the machine
  is there the dial is locked at that click and the right arm stops where it is, still gripping it, until the
  jog's last stroke ends; then it comes round onto the plan, which leaves the dial along its axis. Each jog is counted from where the
  machine is when it starts, so one that fell short or ran on is made up by the next on its axis.
- A key or button registers from the force the hand puts on it (`Control.touch`): contact with the pendant's face
  inside a key's square, or with a button.
- The handle turns only by the hand's grip on it; the machine counts its detents.

Declared shortcuts: `clamped`, the part welded to the table, standing in for the vise's clamp (the Seat step's take
proves the clamp: moonshot/tests/gates/test_vise_take.py; nothing in these steps pushes on the part); and
`dial_pinch`, the jog handle held to the hand while a stroke grips it and a finger touches its rim, standing in for
fingertips on the knurled rim, which capsules on a smooth cylinder can't hold (a grip assist, as the vise take's
`enclose`); and `dial_lock`, the handle held at its detent outside that grip, so only the grip turns it.

The run writes, beside the take record: checks.json (per frame, what the hands touch, the handle's angle, the
right hand's wrench, the machine's axes, the active constraints and the bodies pushed from outside the physics; and
the never-held E-stop) and outcome.json (the machine at the end: its offsets, tool lengths
and every key it registered). moonshot/tests/gates/test_setting_takes.py reads them.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

import mujoco
import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.motion.primitives import min_jerk
from moonshot.sim.record import glbs_in_bodies
from moonshot.body.skeleton import set_finger_contact
from moonshot.sim.runner import ARM, PAD, SETTLE_STEPS, TakeRunner
from moonshot.world import cell, vf2
from moonshot.world.vise import Load

PRESS_KI = 20.0             # the pushed force grows 20 N/s per newton it falls short (as the vise take's)
TOUCH_N = 0.2               # less than this on a key isn't touching it
ALIGNED_MM = 6.0            # a press pushes only once the fingertip is this close to the key's centre (keys are 14 mm)
GOING_IN_S = 0.15           # before a press's start, the index going in: sight leaves the depth to the press
APPROACH_PAST_MM = 2.0     # a lined-up finger is steered in, until its key clicks, to this far past the key's face,
APPROACH_TAU = 0.1          # what stays short taken up at this rate (s), up to APPROACH_MAX_MM: steered by the error
APPROACH_MAX_MM = 15.0     # alone, the sagging arm stopped 2.3-6.5 mm short of a target 2 mm past it
PUSH_NEAR_MM = 1.0          # within this of the face, or touching, it's pushed too: steered in, the index came to
                            # rest on keys at under 0.2 N
AIM_GAIN = 0.6              # of the fingertip's error, steered out at once: under 1, so the arm's lag can't make it ring
AIM_TAU = 0.5               # s: what stays off is taken up this slowly
AIM_MAX = 0.03              # m
STANDOFF_MM = 8.0           # until then the fingertip is held this far off the face, so a hand that lands off its key
                            # lifts and re-aims rather than sliding across the keys between
DAMPING = 0.02              # m: damped least squares for the corrections
FREEZE_EASE_S = 0.4         # a held hand, its jog's last stroke over, comes round onto the plan over this
DEBOUNCE_S = 0.05           # a key reads as held until its force has stayed low this long, as a keypad debounces a
                            # finger bouncing on it (as moonshot/sim/door_cycle.py's Cycle Start)
NEVER_HELD = ["vf2_estop"]  # pressing it would stop the machine
DIAL_FINGERS = ("index", "middle")    # the dial grip's fingers with targets (motion/pendant.py), the thumb aside
NEAR_M = 0.02               # one this close to the handle bends the contact way (as moonshot/sim/vise_take.py's)


def tool_xml(tool: dict) -> str:
    """A tool in its holder, hanging from the spindle's gauge line; it turns with the spindle. It doesn't collide:
    an edge finder's, probe's or indicator's touch is the machine's sensing, or the needle's, read from the geometry.
    A tool with "offset_mm" (a lever test indicator) carries its ball that far off the axis on a level stylus.
    Its weight is carried by the head's counterbalance, as the spindle's is: uncompensated, its 1.2 kg sagged the Z
    servo 5.7 um below its setpoint, past the 5 um a probing cycle waits for, and op30-z's cycle never ended."""
    hl, st, tip = tool["holder_mm"], tool["stickout_mm"], tool["tip_mm"]
    f = lambda v: f"{v / 1000:.5f}"                      # noqa: E731
    body = (f'\n        <body name="tool" gravcomp="1">'
            f'<geom name="tool_holder" type="cylinder" size="{f(tool["holder_r"])} {f(hl / 2)}" pos="0 0 {f(-hl / 2)}" '
            f'contype="0" conaffinity="0" mass="1.1" rgba="0.6 0.6 0.62 1"/>'
            f'<geom name="tool_shank" type="cylinder" size="{f(tool["shank_r"])} {f((st - tip) / 2)}" '
            f'pos="0 0 {f(-hl - (st - tip) / 2)}" contype="0" conaffinity="0" mass="0.05" rgba="0.7 0.7 0.72 1"/>')
    if "offset_mm" not in tool:
        return (body + f'<geom name="tool_tip" type="cylinder" size="{f(tool["tip_r"])} {f(tip / 2)}" '
                f'pos="0 0 {f(-tool["length_mm"] + tip / 2)}" contype="0" conaffinity="0" mass="0.005" '
                f'rgba="0.75 0.75 0.78 1"/></body>')
    (ox, oy), z = tool["offset_mm"], -tool["length_mm"] + tool["tip_r"]
    return (body + f'<geom name="tool_stylus" type="capsule" fromto="0 0 {f(z)} {f(ox)} {f(oy)} {f(z)}" '
            f'size="{f(tool["stylus_r"])}" contype="0" conaffinity="0" mass="0.002" rgba="0.75 0.75 0.78 1"/>'
            f'<geom name="tool_tip" type="sphere" size="{f(tool["tip_r"])}" pos="{f(ox)} {f(oy)} {f(z)}" '
            f'contype="0" conaffinity="0" mass="0.001" rgba="0.85 0.3 0.3 1"/></body>')


class PendantRunner(TakeRunner):
    station = "vf2"
    grip_geoms = {"dial": "vf2_jog_handle"}

    def __init__(self, folder: Path):
        super().__init__(folder)
        m, d, s = self.model, self.data, self.tk["setup"]
        self.machine = cell.start(m, d)
        self.machine0 = self.machine.machine_mm()  # the plan counts the axes from where the take starts them
        self.machine.setup_mode = bool(s.get("setup_mode"))
        self.machine.tool = int((s.get("tool") or {}).get("number", 0))
        self.machine.tool_length = {int(k): v for k, v in s.get("tool_length", {}).items()}
        self.machine.vps_queue = [dict(v) for v in s.get("vps", [])]
        c0 = np.array(s["centre_mm"], float)
        self.bores = [{"rel": (np.array(b["centre_mm"], float) - c0[:2]) / 1000, "r": b["r_mm"] / 1000,
                       "top": (b["top_z_mm"] - c0[2]) / 1000} for b in s.get("bores", [])]
        if (s.get("tool") or {}).get("ball"):
            self.machine.sensor = self.probe_touch
        # the vise clamped on the part: the jaw at its width, the screw locked
        load = Load.from_json(s["load"])
        jaw = (load.opening0 - 2 * s["half_mm"][1]) / 1000
        d.qpos[m.jnt_qposadr[m.joint("jaw_slide").id]] = jaw
        crank = jaw / m.eq_data[m.equality("lead_screw").id, 1]
        d.qpos[m.jnt_qposadr[m.joint("crank").id]] = crank
        lock = m.equality("screw_lock").id
        m.eq_data[lock, 0], d.eq_active[lock] = crank, 1
        mujoco.mj_forward(m, d)
        self.presses = [e for e in self.tk["events"] if e["kind"] == "press"]
        self.press_i = [0.0] * len(self.presses)
        self.press_done: set[int] = set()
        self.hand_geoms = {g for g in range(m.ngeom) if m.geom(g).name[:2] in ("R_", "L_")}
        self.face = m.geom("vf2_pendant_face").id
        self.buttons = {m.geom(f"vf2_{b}_button").id: b for b in ("cycle_start", "feed_hold")}
        self.buttons[m.geom("vf2_tool_release_button").id] = "tool_release_head"     # on the head
        keys = vf2.record()["affordances"]["keys"]
        self.key_half = keys["half_mm"] / 1000
        self.key_names = list(keys["at_mm"])
        self.key_xz = np.array([d.site(f"vf2_key_{k}").xpos[[0, 2]] for k in self.key_names])
        self.key_at = {k: d.site(f"vf2_key_{k}").xpos.copy() for k in self.key_names}
        self.key_at |= {b: d.site(f"vf2_{b}").xpos.copy() for b in ("cycle_start", "feed_hold")}
        self.key_at["tool_release_head"] = d.site("vf2_tool_release").xpos.copy()
        self.index_pad = {s: m.geom(f"{s}_g_dis2").id for s in ("R", "L")}
        self.rec = {"touching": [], "handle_deg": [], "hand_wrench": [], "machine_mm": [], "key_n": [],
                    "active_constraints": [], "applied_forces": [], "machine_axes": {f"vf2_{a}": [] for a in
                                                                                       ("x", "y", "z", "spindle")}}
        self._key_n: dict[str, float] = {}
        # the corrections by sight and the press's aim steer through the shoulder, elbow and wrist, not the girdle: its
        # few centimetres of slide took most of a least-squares correction and stopped at their ends, the hand 10 mm off
        steer = [j for j in ARM if not j.startswith("sc_")]
        self.arm_dofs = {s: np.array([m.jnt_dofadr[m.joint(f"{s}_{j}").id] for j in steer]) for s in ("R", "L")}
        act_of_dof = {int(dof): a for a, dof in enumerate(self.act_dof)}
        self.arm_act = {s: np.array([act_of_dof[int(v)] for v in self.arm_dofs[s]]) for s in ("R", "L")}
        self._last_on: dict[str, float] = {}
        self.aim_i = {s: np.zeros(3) for s in ("R", "L")}
        self.approach_i = {s: 0.0 for s in ("R", "L")}       # the steering in onto a key taken up so far (aim), m
        self.press_t0: dict[str, float | None] = {"R": None, "L": None}   # the press the aim is on, its start
        self.lifting = {s: False for s in ("R", "L")}
        self.press_n: dict[str, np.ndarray | None] = {s: None for s in ("R", "L")}
        self.turns =sorted((e for e in self.tk["events"] if e["kind"] == "turn"), key=lambda e: e["t0"])
        self.jog_ev = {e["jog"]: e for e in self.turns}                  # its last stroke: the target, axis and step
        self.jog_dir = {j: np.sign(sum(e["clicks"] for e in self.turns if e["jog"] == j)) for j in self.jog_ev}
        self.jog_t0 = {e["jog"]: e["t0"] - 0.25 for e in reversed(self.turns)}  # counted from its first stroke
        self.jog_end = {j: e["t1"] + 0.2 for j, e in self.jog_ev.items()}       # to its last stroke's end
        self.jog_done: dict[int, float] = {}        # jog -> when the machine read right
        self.jog_hold: dict[int, np.ndarray] = {}   # jog -> the joints its hand is held at
        self._corr = np.zeros(m.nv)                 # the sight correction the last step added
        right = [n for n in self.body.joints if n.startswith("R_")]
        arm = [n for n in right if n[2:] in ARM]
        self.r_q = np.array([m.jnt_qposadr[m.joint(n).id] for n in right])
        self.r_dof = np.array([m.jnt_dofadr[m.joint(n).id] for n in right])
        self.r_arm = np.isin(self.r_q, [m.jnt_qposadr[m.joint(n).id] for n in arm])     # arm, not fingers
        self.pinch = m.equality("dial_pinch").id
        self.lock = m.equality("dial_lock").id
        self.dial_geom = m.geom("vf2_jog_handle").id
        self._dial_contact: set[str] = set()        # the fingers bending their fingertips the contact way (dial_coupling)
        # the dial's axis and a basis across it (its own frame), and the angle about it the pinch holds the hand at
        a = m.jnt_axis[m.joint("vf2_jog").id] / np.linalg.norm(m.jnt_axis[m.joint("vf2_jog").id])
        e1 = np.cross(a, [1.0, 0, 0] if abs(a[0]) < 0.9 else [0, 1.0, 0])
        e1 /= np.linalg.norm(e1)
        self.dial_basis = (a, e1, np.cross(a, e1))
        rim = m.eq_data[self.pinch, 0:3]
        self.pinch_angle = math.atan2(rim @ self.dial_basis[2], rim @ e1)

    def scene(self, body_xml: str) -> str:
        s = self.tk["setup"]
        paras = {k: np.array(v, float) for k, v in s["parallels"].items()}
        xml = cell.with_body(body_xml, np.array(s["centre_mm"], float), paras, "R_hand", Load.from_json(s["load"]))
        c = " ".join(f"{v / 1000:.5f}" for v in s["centre_mm"])
        h = vf2.record()["affordances"]["jog_handle"]
        rim = f"0 {-h['depth_mm'] / 2000:.5f} {h['radius_mm'] / 1000:.5f}"
        xml = xml.replace("<equality>\n", '<equality>\n    <weld name="clamped" body1="blank" body2="vf2_table" '
                          f'anchor="{c}" relpose="0 0 0 1 0 0 0" solref="0.005 1"/>\n'
                          f'    <connect name="dial_pinch" body1="vf2_jog_handle" body2="R_hand" anchor="{rim}" '
                          'active="false" solref="0.02 1" solimp="0.9 0.95 0.002"/>\n'
                          '    <joint name="dial_lock" joint1="vf2_jog" polycoef="0 0 0 0 0" active="true" '
                          'solref="0.005 1"/>\n', 1)
        if not s.get("tool"):
            return xml                                     # the spindle empty
        gauge = re.search(r'<geom name="vf2_spindle_gauge"[^>]*/>', xml).group(0)
        return xml.replace(gauge, gauge + tool_xml(s["tool"]), 1)

    def glbs(self) -> dict[str, list[dict]]:
        return glbs_in_bodies(self.model, "vf2", vf2.render_links())

    def probe_touch(self) -> bool:
        """Is the probe's ball touching the part? Its centre against the part's box, or inside a bore its wall: the
        machine's sensing, read from the geometry (the probe doesn't collide)."""
        m, d = self.model, self.data
        tip, part = m.geom("tool_tip").id, m.geom("blank").id
        r = self.tk["setup"]["tool"]["tip_r"] / 1000
        p = d.geom_xpos[tip] - d.geom_xpos[part]                 # the part doesn't turn: world axes
        for b in self.bores:
            q = np.hypot(*(p[:2] - b["rel"]))
            if q < b["r"] and p[2] < b["top"]:
                return q + r >= b["r"]
        out = np.abs(p) - m.geom_size[part]
        return float(np.linalg.norm(np.maximum(out, 0)) + min(out.max(), 0)) <= r

    # --- each step ---------------------------------------------------------------------------------------
    def key_forces(self) -> dict[str, float]:
        """The normal force each key and button takes from the hands now (N)."""
        m, d, out, c6 = self.model, self.data, {}, np.zeros(6)
        for i in range(d.ncon):
            c = d.contact[i]
            pair = {c.geom1, c.geom2}
            if not pair & self.hand_geoms:
                continue
            other = (pair - self.hand_geoms).pop() if len(pair - self.hand_geoms) == 1 else None
            if other == self.face:
                near = np.abs(self.key_xz - c.pos[[0, 2]]).max(1)
                k = int(np.argmin(near))
                if near[k] > self.key_half:
                    continue
                name = self.key_names[k]
            elif other in self.buttons:
                name = self.buttons[other]
            else:
                continue
            mujoco.mj_contactForce(m, d, i, c6)
            out[name] = out.get(name, 0.0) + abs(c6[0])
        return out

    def push(self, t: float) -> None:
        """Each press under way: its force at the index pad, through the arm's and the index's joints."""
        m, d = self.model, self.data
        dt = m.opt.timestep
        for i, e in enumerate(self.presses):
            if not e["t0"] - 0.05 <= t < e["t1"] + 0.08 or i in self.press_done:
                continue
            if e["key"] in self.machine._down and not e.get("hold"):   # it clicked: ease off, as people do
                self.press_done.add(i)
                continue
            F = self._key_n.get(e["key"], 0.0)
            n = np.asarray(e["normal"], float)
            off = self.key_at[e["key"]] - self.fingertip(e["side"], n)
            if F < TOUCH_N and off @ n > PUSH_NEAR_MM / 1000:
                continue                                       # not at the key yet: the aim brings it (aim)
            ramp = min(1.0, (t - (e["t0"] - 0.05)) / 0.05)
            fade = 1.0 - min(1.0, max(0.0, (t - e["t1"]) / 0.08))
            if e["t0"] <= t < e["t1"]:                         # pushing until the key is felt, then holding its force
                self.press_i[i] = float(np.clip(self.press_i[i] + PRESS_KI * (e["force"] - F) * dt, -e["force"], e["force"]))
            mag = max(0.0, e["force"] * ramp + self.press_i[i]) * fade
            g = self.index_pad[e["side"]]
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, d, jacp, None, self.fingertip(e["side"], e["normal"]), m.geom_bodyid[g])
            tau = jacp[:, self.act_dof].T @ (np.asarray(e["normal"], float) * mag)
            d.ctrl[self.acts] += tau / m.actuator_gainprm[self.acts, 0]

    def fingertip(self, side: str, n, data=None) -> np.ndarray:
        """Where the index's pad meets a face with inward normal n (world, m): the point of its distal capsule that
        stands farthest along n, not the capsule's centre, which lies a centimetre back along the finger. data: the
        run (default) or the plan."""
        m, d = self.model, data if data is not None else self.data
        g = self.index_pad[side]
        axis = d.geom_xmat[g].reshape(3, 3)[:, 2] * m.geom_size[g][1]
        ends = (d.geom_xpos[g] + axis, d.geom_xpos[g] - axis)
        n = np.asarray(n, float)
        return max(ends, key=lambda e: e @ n) + n * m.geom_size[g][0]

    def aim(self, t: float) -> None:
        """Steer each index pad onto the key it is about to press, by sight, across the key's face."""
        m, d, dt = self.model, self.data, self.model.opt.timestep
        for s in ("R", "L"):
            # the next press within reach in time: the hand works toward it from the last one's end
            near = [(j, e) for j, e in enumerate(self.presses) if e["side"] == s and e["t0"] - 0.9 <= t <= e["t1"]][:1]
            i = self.aim_i[s]
            self.press_n[s] = np.asarray(near[0][1]["normal"], float) if near else None
            self.press_t0[s] = near[0][1]["t0"] if near else None
            self.lifting[s] = bool(near) and near[0][0] in self.press_done
            if not near:
                i *= 1 - dt / 0.2
                self.approach_i[s] = 0.0
                continue
            j, e = near[0]
            n = np.asarray(e["normal"], float)
            err = self.key_at[e["key"]] - self.fingertip(s, n)
            across = err - n * (err @ n)
            i += across * dt / AIM_TAU
            if np.linalg.norm(i) > AIM_MAX:
                i *= AIM_MAX / np.linalg.norm(i)
            c = AIM_GAIN * across + i
            g = self.index_pad[s]
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, d, jacp, None, self.fingertip(s, [0, 1.0, 0]), m.geom_bodyid[g])
            J = jacp[:, self.arm_dofs[s]]
            dq = J.T @ np.linalg.solve(J @ J.T + DAMPING ** 2 * np.eye(3), c)
            # off the face until over the key; and once it has clicked, lifted off it: a finger left resting on the
            # key, as the plan has it until the press ends, bounces about its release force and clicks it again. The
            # whole hand moves straight back, its turn held: moved back by the index's tip alone, the arm pitched the
            # hand about it, and as the index lifted off Offset the thumb pressed J (op10-xy)
            touching = self._key_n.get(e["key"], 0.0) >= TOUCH_N
            if self.lifting[s] or (np.linalg.norm(across) > ALIGNED_MM / 1000 and not touching):
                move = n * min(0.0, err @ n - STANDOFF_MM / 1000)
            elif t >= e["t0"] - 0.05:
                # lined up, the plan's index on its key: in straight the same way to just past the key's face. Pushed
                # there by force through the body, the run's index swung 4-7 mm across +Y, out of line, and never
                # pressed it (op10-xy, op30-xy, op40-xy, op50-xy); steered through the plan's quick go-in as well, after
                # a hand lagging it by up to 20 mm, the arm kicked it 7-11 mm across +Y and Reset
                planned = (self.key_at[e["key"]] - self.fingertip(s, n, data=self.plan)) @ n
                if planned < 0.003:
                    short = max(0.0, err @ n - planned + APPROACH_PAST_MM / 1000)
                    self.approach_i[s] = min(APPROACH_MAX_MM / 1000, self.approach_i[s] + short * dt / APPROACH_TAU)
                    move = n * (short + self.approach_i[s])
                else:
                    move = None
            else:
                move = None
            if move is None or self.lifting[s]:
                self.approach_i[s] = 0.0
            if move is not None:
                jp, jr = np.zeros((3, m.nv)), np.zeros((3, m.nv))
                mujoco.mj_jacBody(m, d, jp, jr, m.body(f"{s}_hand").id)
                J6 = np.vstack([jp, jr])[:, self.arm_dofs[s]]
                dq += J6.T @ np.linalg.solve(J6 @ J6.T + DAMPING ** 2 * np.eye(6), np.r_[move, 0.0, 0.0, 0.0])
            d.ctrl[self.acts[self.arm_act[s]]] += dq

    def held_error(self, side: str, t: float) -> np.ndarray | None:
        """While a press is under way, sight corrects the hand across the key's face only: how deep the index stands
        is the press's, which holds it off the face until it's over the key, pushes, and lifts it once it has
        clicked, all meant to leave the plan. Sight, correcting the depth too, wound up 10 mm into the keypad by
        op20-xy's 11th second, and the middle finger pressed 2 as the hand left for the dial; held still through
        the press altogether, it let the hand drift onto other keys. Until the index goes in (GOING_IN_S before the
        press), sight corrects the depth as well: left to the press from the hover on, the arm's sag held the index
        14 mm farther off than the plan over +Y after a jog, and it reached the key only as the press ended (op30-xy)."""
        n = self.press_n[side]
        if n is None or t < self.press_t0[side] - GOING_IN_S:
            return None
        m, d, p = self.model, self.data, self.plan
        hb = m.body(f"{side}_hand").id
        Rp, Ra = p.xmat[hb].reshape(3, 3), d.xmat[hb].reshape(3, 3)
        err = np.r_[p.xpos[hb] - d.xpos[hb], Rotation.from_matrix(Rp @ Ra.T).as_rotvec()]
        err[:3] -= n * (err[:3] @ n)
        return err

    def correction(self, t: float) -> np.ndarray:
        """The runner's correction by sight, for the right hand only: the left only presses Cycle Start, aimed by its
        press, and resting at the side between it wound up a steady offset that put it 55 mm below the button."""
        self.visual["L"][:] = 0.0
        self._corr = super().correction(t)
        return self._corr

    def count_clicks(self, t: float) -> None:
        """While a jog's strokes turn the dial: the moment the position display reads where the plan has the axis
        after the jog (counting clicks would count those lost at a travel limit), and
        the joints the hand stops at then: the arm where it is (what the servo aims at, less the sight correction it
        adds), not where the plan had it, which the lagging hand would catch up to, turning the dial on; the fingers
        as the plan has them, gripping."""
        for j, t0 in self.jog_t0.items():
            if t0 <= t <= self.jog_end[j] and j not in self.jog_done:
                e = self.jog_ev[j]
                i = "xyz".index(e["axis"])
                at = self.machine.jog_goal_mm()[i] - self.machine0[i]
                if (e["to_mm"] - at) * self.jog_dir[j] < e["inc_mm"] / 2:
                    q, _, _ = super().at(t)
                    arm_q, arm_dof = self.r_q[self.r_arm], self.r_dof[self.r_arm]
                    q[arm_q] = self.data.qpos[arm_q] - self._corr[arm_dof]
                    self.jog_done[j], self.jog_hold[j] = t, q
                return

    def frozen(self, t: float) -> tuple[int, float] | None:
        """While a done jog's hand is held: (the jog, how far it has eased back onto the plan). Held, gripping, from the
        moment the machine reads right to its last stroke's end; then it comes round onto the plan over FREEZE_EASE_S,
        the plan leaving the dial along its axis. The dial is locked at its click meanwhile (dial_lock), so nothing of
        the hand on its way off turns it."""
        for j, td in self.jog_done.items():
            end = self.jog_end[j]
            if td <= t < end + FREEZE_EASE_S:
                return j, min_jerk(max(0.0, t - end) / FREEZE_EASE_S)
        return None

    def at(self, t: float):
        """The plan, but a done jog's right arm and hand stopped where the machine read right, gripping the dial, so
        it stops with them, as people stop turning a handle: no coasting on past the jog's clicks."""
        q, v, a = super().at(t)
        self.count_clicks(t)
        f = self.frozen(t)
        if f is not None:
            j, w = f
            qf = self.jog_hold[j]
            q[self.r_q] = qf[self.r_q] + (q[self.r_q] - qf[self.r_q]) * w
            v[self.r_dof] *= w
            a[self.r_dof] *= w
        return q, v, a

    def hold_dial(self, t: float) -> None:
        """The dial_pinch shortcut: on while a stroke of a jog not yet done turns the dial (not while the grip closes
        on it, while the hand still settles) and a finger touches its rim, its anchor set where the hand is then, so
        switching it on moves nothing; off the moment no finger touches it (left on, it turned the dial under a hand
        gone off the rim, and back 7 clicks as the hand went back: op10-z); and dial_lock whenever it is
        off, at the dial's nearest detent, so only the grip turns it and the jog's last click stops it there.
        The pinch turns the dial and does nothing else: each step its dial-side point is moved to the hand's own depth
        along the axis and distance from it, keeping only its angle about the axis, so it pulls only round the rim.
        Held as a point, it held the hand where it first touched the rim while the plan carried it on along the axis,
        12 N median into the dial and 23 N at the 95th percentile, and op30-z's muscles overloaded."""
        m, d = self.model, self.data
        hb, gb = m.body("R_hand").id, m.body("vf2_jog_handle").id
        e, grip = self.effort("R", t)
        stroke = any(ev["t0"] - 0.02 <= t <= ev["t1"] + 0.1 for ev in self.turns)
        # the grip closed: half the plan's light grip on the handle (motion/pendant.py DIAL_EFFORT)
        want = grip == "dial" and e >= 0.25 and stroke and self.frozen(t) is None
        touching = want and any(self.dial_geom in (c.geom1, c.geom2) and ({c.geom1, c.geom2} & self.hand_geoms)
                                for c in d.contact[:d.ncon])
        if touching and not d.eq_active[self.pinch]:
            p = d.xpos[gb] + d.xmat[gb].reshape(3, 3) @ m.eq_data[self.pinch, 0:3]
            m.eq_data[self.pinch, 3:6] = d.xmat[hb].reshape(3, 3).T @ (p - d.xpos[hb])
            d.eq_active[self.pinch], d.eq_active[self.lock] = 1, 0
        elif not touching and d.eq_active[self.pinch]:
            d.eq_active[self.pinch] = 0
        if d.eq_active[self.pinch]:
            a, e1, e2 = self.dial_basis
            hand = d.xpos[hb] + d.xmat[hb].reshape(3, 3) @ m.eq_data[self.pinch, 3:6]
            b = d.xmat[gb].reshape(3, 3).T @ (hand - d.xpos[gb])            # the hand's point, in the dial's frame
            h = b @ a
            r = np.linalg.norm(b - h * a)
            m.eq_data[self.pinch, 0:3] = h * a + r * (math.cos(self.pinch_angle) * e1 + math.sin(self.pinch_angle) * e2)
        if not d.eq_active[self.pinch] and not d.eq_active[self.lock]:
            n = self.machine.detents
            m.eq_data[self.lock, 0] = round(d.qpos[self.machine.q["jog"]] * n / (2 * math.pi)) * 2 * math.pi / n
            d.eq_active[self.lock] = 1

    def effort(self, side: str, t: float) -> tuple[float, str]:
        """The plan's effort, but a held hand keeps the grip it had when the dial read right."""
        f = self.frozen(t) if side == "R" else None
        return super().effort(side, self.jog_done[f[0]] if f is not None and f[1] == 0.0 else t)

    def debounced(self, forces: dict[str, float]) -> dict[str, float]:
        now, on = float(self.data.time), self.machine.actuation
        for k, f in forces.items():
            if f >= 0.3 * on:
                self._last_on[k] = now
        held = {k: on for k, t in self._last_on.items() if k in self.machine._down and now - t < DEBOUNCE_S}
        return held | {k: f for k, f in forces.items() if f >= held.get(k, 0.0)}

    def before_step(self, t: float) -> None:
        self._key_n = self.key_forces()
        self.machine.touch(self.debounced(self._key_n))
        self.push(t)
        self.aim(t)
        self.hold_dial(t)
        self.dial_coupling(t)
        self.machine.apply()

    def dial_coupling(self, t: float) -> None:
        """In the dial's grip, its fingers near the handle bend their fingertip joints the contact way (dip = k pip + c),
        as the grip solver solved them (motion/grasp.py's coupling for a finger with a target); the rest, and every
        finger elsewhere, freely, as the vise take switches its own. Free throughout, the index's DIP ran 11 deg more
        bent than its grip was solved with, and its tip sank 3.1-3.8 mm into the handle at every grip (op50-check)."""
        m, d = self.model, self.data
        near, ft = set(), np.zeros(6)
        if self.effort("R", t)[1] == "dial":
            near = {f for f in DIAL_FINGERS if mujoco.mj_geomDistance(
                m, d, m.geom(f"R_g_{PAD[f]}").id, self.dial_geom, NEAR_M, ft) < NEAR_M}
        if near != self._dial_contact:
            for f in ("index", "middle", "ring", "little"):
                set_finger_contact(m, self.body, "R", f, f in near)
            self._dial_contact = near

    # --- each frame --------------------------------------------------------------------------------------
    def hand_wrench(self) -> list[float]:
        """The net force and torque the world puts on the right hand (N, N m, world; torque about the wrist)."""
        m, d = self.model, self.data
        mujoco.mj_rnePostConstraint(m, d)
        hand = m.body("R_hand").id
        W = d.xpos[hand]
        f, tq = np.zeros(3), np.zeros(3)
        for b in range(m.nbody):
            p = b
            while p and p != hand:
                p = m.body_parentid[p]
            if p != hand:
                continue
            fb, tb = d.cfrc_ext[b][3:], d.cfrc_ext[b][:3]
            P = d.subtree_com[m.body_rootid[b]]
            f += fb
            tq += tb + np.cross(P - W, fb)
        return [*f.round(4).tolist(), *tq.round(5).tolist()]

    def on_frame(self, k: int) -> None:
        m, d = self.model, self.data
        touching = set()
        for i in range(d.ncon):
            pair = {d.contact[i].geom1, d.contact[i].geom2}
            if pair & self.hand_geoms and len(pair - self.hand_geoms) == 1:
                touching.add(m.geom((pair - self.hand_geoms).pop()).name)
        self.rec["touching"].append(sorted(touching))
        self.rec["handle_deg"].append(round(math.degrees(d.qpos[self.machine.q["jog"]]), 3))
        self.rec["hand_wrench"].append(self.hand_wrench())
        self.rec["machine_mm"].append(self.machine.machine_mm().round(4).tolist())
        self.rec["key_n"].append({k: round(v, 2) for k, v in self._key_n.items()})
        self.rec["active_constraints"].append([m.equality(i).name for i in range(m.neq) if d.eq_active[i]])
        self.rec["applied_forces"].append([m.body(b).name for b in range(m.nbody) if d.xfrc_applied[b].any()])
        for a in ("x", "y", "z"):
            self.rec["machine_axes"][f"vf2_{a}"].append(round(float(d.qpos[self.machine.q[a]]) * 1000, 4))
        sp = m.jnt_dofadr[m.joint("vf2_spindle").id]
        self.rec["machine_axes"]["vf2_spindle"].append(round(float(d.qvel[sp]) * 60 / (2 * math.pi), 1))

    def outcome(self) -> dict:
        c = self.machine
        return {"work": {k: v.round(4).tolist() for k, v in c.work.items()}, "tool": c.tool,
                "tool_length": {str(k): round(v, 4) for k, v in c.tool_length.items()},
                "pressed": [[round(self.plan_time(t), 3), key] for t, key in c.pressed], "events": c.events,
                "machine_mm": c.machine_mm().round(4).tolist(),
                "press_n_max": {e["key"] + f"@{e['t0']}": round(max((f.get(e["key"], 0.0) for f in
                                self.rec["key_n"][int(e["t0"] * self.fps):int(e["t1"] * self.fps) + 2]), default=0.0), 2)
                                for e in self.presses}}

    @property
    def settle_s(self) -> float:
        return SETTLE_STEPS * self.model.opt.timestep

    def plan_time(self, sim_t: float) -> float:
        """The plan's time at a simulation time: after the settle, each frame steps a whole number of timesteps (33 of
        1 ms at 30 fps), so the simulation runs at 0.99 of the plan's clock, 0.85 s behind by the end of an 85 s take."""
        spf = round(1.0 / (self.fps * self.model.opt.timestep))
        return (sim_t - self.settle_s) / (spf * self.model.opt.timestep * self.fps)

    def export(self, folder: Path | None = None) -> None:
        folder = Path(folder or self.folder)
        super().export(folder)
        # for nothing_moves_without_a_cause: the machine's own bodies move by its servos, not a hand; the rest, the
        # stock, the parallels and the vise's jaw, crank and knob, sit on its table and are judged by how they move on it
        scene = json.loads((folder / "scene.json").read_text(encoding="utf-8"))["bodies"]
        objects = [n for n, b in scene.items() if b["role"] == "object"]
        driven = [n for n in objects if n.startswith("vf2") or n == "tool"]
        checks = {k: self.rec[k] for k in ("touching", "handle_deg", "hand_wrench", "active_constraints",
                                           "applied_forces", "machine_axes")} | {"never_held": NEVER_HELD}
        checks |= {"driven": driven, "rides_on": {n: "vf2_table" for n in objects if n not in driven},
                   "touch_lead": self.checks["touch_lead"]}
        (folder / "checks.json").write_text(json.dumps(checks), encoding="utf-8")
        (folder / "outcome.json").write_text(json.dumps(self.outcome(), indent=1), encoding="utf-8")
