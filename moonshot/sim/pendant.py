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
  is there the right arm stops where it is, still gripping, so the dial stops with it, until the jog's last stroke
  ends; then the hand slides off the rim and comes round onto the plan. Each jog is counted from where the machine
  is when it starts, so one that fell short or ran on is made up by the next on its axis.
- A key or button registers from the force the hand puts on it (`Control.touch`): contact with the pendant's face
  inside a key's square, or with a button.
- The handle turns only by the hand's grip on it; the machine counts its detents.

Declared shortcuts: `clamped`, the part welded to the table, standing in for the vise's clamp (the Seat step's take
proves the clamp: moonshot/tests/gates/test_vise_take.py; nothing in these steps pushes on the part); and
`dial_pinch`, the jog handle held to the hand while a stroke grips it and a finger touches its rim, standing in for
fingertips on the knurled rim, which capsules on a smooth cylinder can't hold (a grip assist, as the vise take's
`enclose`).

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

from moonshot.motion.primitives import min_jerk
from moonshot.sim.record import glbs_in_bodies
from moonshot.sim.runner import ARM, SETTLE_STEPS, TakeRunner
from moonshot.world import cell, vf2
from moonshot.world.vise import Load

PRESS_KI = 20.0             # the pushed force grows 20 N/s per newton it falls short (as the vise take's)
TOUCH_N = 0.2               # less than this on a key isn't touching it
ALIGNED_MM = 6.0            # a press pushes only once the fingertip is this close to the key's centre (keys are 14 mm)
AIM_GAIN = 0.6              # of the fingertip's error, steered out at once: under 1, so the arm's lag can't make it ring
AIM_TAU = 0.5               # s: what stays off is taken up this slowly
AIM_MAX = 0.03              # m
STANDOFF_MM = 8.0           # until then the fingertip is held this far off the face, so a hand that lands off its key
                            # lifts and re-aims rather than sliding across the keys between
DAMPING = 0.02              # m: damped least squares for the corrections
BACK_OFF_S = 0.5            # a held hand, its jog done, slides straight off the dial this long at least,
BACK_OFF_MM = 40.0          # this far, past the rim's depth (as the plan leaves the dial),
CLEAR_WAIT_S = 0.5          # and up to this much longer while anything of it still touches the dial;
FREEZE_EASE_S = 0.6         # then its arm comes round onto the plan over this
DIAL_AXIS = np.array(vf2.record()["affordances"]["jog_handle"]["axis"], float)     # into the pendant
DEBOUNCE_S = 0.05           # a key reads as held until its force has stayed low this long, as a keypad debounces a
                            # finger bouncing on it (as moonshot/sim/door_cycle.py's Cycle Start)
NEVER_HELD = ["vf2_estop"]  # pressing it would stop the machine


def tool_xml(tool: dict) -> str:
    """A tool in its holder, hanging from the spindle's gauge line; it turns with the spindle. It doesn't collide:
    an edge finder's or probe's touch is the machine's sensing, read from the geometry."""
    hl, st, tip = tool["holder_mm"], tool["stickout_mm"], tool["tip_mm"]
    f = lambda v: f"{v / 1000:.5f}"                      # noqa: E731
    return (f'\n        <body name="tool">'
            f'<geom name="tool_holder" type="cylinder" size="{f(tool["holder_r"])} {f(hl / 2)}" pos="0 0 {f(-hl / 2)}" '
            f'contype="0" conaffinity="0" mass="1.1" rgba="0.6 0.6 0.62 1"/>'
            f'<geom name="tool_shank" type="cylinder" size="{f(tool["shank_r"])} {f((st - tip) / 2)}" '
            f'pos="0 0 {f(-hl - (st - tip) / 2)}" contype="0" conaffinity="0" mass="0.05" rgba="0.7 0.7 0.72 1"/>'
            f'<geom name="tool_tip" type="cylinder" size="{f(tool["tip_r"])} {f(tip / 2)}" '
            f'pos="0 0 {f(-tool["length_mm"] + tip / 2)}" contype="0" conaffinity="0" mass="0.005" rgba="0.75 0.75 0.78 1"/>'
            f'</body>')


class PendantRunner(TakeRunner):
    station = "vf2"
    grip_geoms = {"dial": "vf2_jog_handle"}

    def __init__(self, folder: Path):
        super().__init__(folder)
        m, d, s = self.model, self.data, self.tk["setup"]
        self.machine = cell.start(m, d)
        self.machine0 = self.machine.machine_mm()  # the plan counts the axes from where the take starts them
        self.machine.setup_mode = bool(s.get("setup_mode"))
        self.machine.tool = int(s["tool"].get("number", 0))
        self.machine.tool_length = {int(k): v for k, v in s.get("tool_length", {}).items()}
        self.machine.vps_queue = [dict(v) for v in s.get("vps", [])]
        c0 = np.array(s["centre_mm"], float)
        self.bores = [{"rel": (np.array(b["centre_mm"], float) - c0[:2]) / 1000, "r": b["r_mm"] / 1000,
                       "top": (b["top_z_mm"] - c0[2]) / 1000} for b in s.get("bores", [])]
        if s["tool"].get("ball"):
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
        keys = vf2.record()["affordances"]["keys"]
        self.key_half = keys["half_mm"] / 1000
        self.key_names = list(keys["at_mm"])
        self.key_xz = np.array([d.site(f"vf2_key_{k}").xpos[[0, 2]] for k in self.key_names])
        self.key_at = {k: d.site(f"vf2_key_{k}").xpos.copy() for k in self.key_names}
        self.key_at |= {b: d.site(f"vf2_{b}").xpos.copy() for b in ("cycle_start", "feed_hold")}
        self.index_pad = {s: m.geom(f"{s}_g_dis2").id for s in ("R", "L")}
        self.rec = {"touching": [], "handle_deg": [], "hand_wrench": [], "machine_mm": [], "key_n": [],
                    "active_constraints": [], "applied_forces": [], "machine_axes": {f"vf2_{a}": [] for a in
                                                                                       ("x", "y", "z", "spindle")}}
        self._key_n: dict[str, float] = {}
        self.arm_dofs = {s: np.array([m.jnt_dofadr[m.joint(f"{s}_{j}").id] for j in ARM]) for s in ("R", "L")}
        act_of_dof = {int(dof): a for a, dof in enumerate(self.act_dof)}
        self.arm_act = {s: np.array([act_of_dof[int(v)] for v in self.arm_dofs[s]]) for s in ("R", "L")}
        self._last_on: dict[str, float] = {}
        self.aim_i = {s: np.zeros(3) for s in ("R", "L")}
        self.turns = sorted((e for e in self.tk["events"] if e["kind"] == "turn"), key=lambda e: e["t0"])
        self.jog_ev = {e["jog"]: e for e in self.turns}                  # its last stroke: the target, axis and step
        self.jog_dir = {j: np.sign(sum(e["clicks"] for e in self.turns if e["jog"] == j)) for j in self.jog_ev}
        self.jog_t0 = {e["jog"]: e["t0"] - 0.25 for e in reversed(self.turns)}  # counted from its first stroke
        self.jog_end = {j: e["t1"] + 0.2 for j, e in self.jog_ev.items()}       # to its last stroke's end
        self.jog_from: dict[int, int] = {}          # jog -> the dial's clicks at its start
        self.jog_need: dict[int, int] = {}          # jog -> the clicks it needs, from where the machine is then
        self.jog_done: dict[int, float] = {}        # jog -> when the machine read right
        self.jog_hold: dict[int, np.ndarray] = {}   # jog -> the joints its hand is held at
        self.jog_back: dict[int, np.ndarray] = {}   # jog -> the joints' change sliding its held hand off the dial
        self.jog_clear: dict[int, float] = {}       # jog -> when its backed-off hand was clear of the dial
        self._corr = np.zeros(m.nv)                 # the sight correction the last step added
        right = [n for n in self.body.joints if n.startswith("R_")]
        arm = [n for n in right if n[2:] in ARM]
        self.r_q = np.array([m.jnt_qposadr[m.joint(n).id] for n in right])
        self.r_dof = np.array([m.jnt_dofadr[m.joint(n).id] for n in right])
        self.r_arm = np.isin(self.r_q, [m.jnt_qposadr[m.joint(n).id] for n in arm])     # arm, not fingers
        self.pinch = m.equality("dial_pinch").id
        self.dial_geom = m.geom("vf2_jog_handle").id

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
                          'active="false" solref="0.02 1" solimp="0.9 0.95 0.002"/>\n', 1)
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
            if e["key"] in self.machine._down:                 # it clicked: ease off, as people do
                self.press_done.add(i)
                continue
            F = self._key_n.get(e["key"], 0.0)
            n = np.asarray(e["normal"], float)
            off = self.key_at[e["key"]] - self.fingertip(e["side"], n)
            if F < TOUCH_N and np.linalg.norm(off - n * (off @ n)) > ALIGNED_MM / 1000:
                continue                                       # not over the key yet: sight first, then press
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
            near = [e for e in self.presses if e["side"] == s and e["t0"] - 0.9 <= t <= e["t1"]][:1]
            i = self.aim_i[s]
            if not near:
                i *= 1 - dt / 0.2
                continue
            n = np.asarray(near[0]["normal"], float)
            err = self.key_at[near[0]["key"]] - self.fingertip(s, n)
            across = err - n * (err @ n)
            i += across * dt / AIM_TAU
            if np.linalg.norm(i) > AIM_MAX:
                i *= AIM_MAX / np.linalg.norm(i)
            c = AIM_GAIN * across + i
            if np.linalg.norm(across) > ALIGNED_MM / 1000 and self._key_n.get(near[0]["key"], 0.0) < TOUCH_N:
                c = c + n * min(0.0, err @ n - STANDOFF_MM / 1000)      # off the face until over the key
            g = self.index_pad[s]
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, d, jacp, None, self.fingertip(s, [0, 1.0, 0]), m.geom_bodyid[g])
            J = jacp[:, self.arm_dofs[s]]
            d.ctrl[self.acts[self.arm_act[s]]] += J.T @ np.linalg.solve(J @ J.T + DAMPING ** 2 * np.eye(3), c)

    def correction(self, t: float) -> np.ndarray:
        self._corr = super().correction(t)
        return self._corr

    def count_clicks(self, t: float) -> None:
        """While a jog's strokes turn the dial: the moment the machine reads where the plan has it after the jog, and
        the joints the hand stops at then: the arm where it is (what the servo aims at, less the sight correction it
        adds), not where the plan had it, which the lagging hand would catch up to, turning the dial on; the fingers
        as the plan has them, gripping."""
        for j, t0 in self.jog_t0.items():
            if t0 <= t <= self.jog_end[j] and j not in self.jog_done:
                c, e = self.machine.clicks(), self.jog_ev[j]
                if j not in self.jog_from:
                    self.jog_from[j] = c
                    i = "xyz".index(e["axis"])
                    at = self.machine.machine_mm()[i] - self.machine0[i]
                    self.jog_need[j] = round((e["to_mm"] - at) / e["inc_mm"])
                if (c - self.jog_from[j]) * self.jog_dir[j] >= self.jog_need[j] * self.jog_dir[j]:
                    q, _, _ = super().at(t)
                    arm_q, arm_dof = self.r_q[self.r_arm], self.r_dof[self.r_arm]
                    q[arm_q] = self.data.qpos[arm_q] - self._corr[arm_dof]
                    self.jog_done[j], self.jog_hold[j], self.jog_back[j] = t, q, self.back_off_dq(q)
                return

    def frozen(self, t: float) -> tuple[int, float, float, float] | None:
        """While a done jog's hand is held: (the jog, how far its arm and its fingers have eased back onto the plan,
        how far it has backed off the dial). Held from the moment the machine reads right to its last
        stroke's end; then the hand, its grip eased but its fingers still shaped round the rim, slides straight off
        the rim's front along the dial's axis (BACK_OFF_S), which can't turn it; only once nothing of it touches the
        dial (or CLEAR_WAIT_S on) do the fingers open and the arm come round onto the plan (FREEZE_EASE_S), which by
        then is off the rim too. Fingers opening on the rim, or a hand turning with them on it, drag the dial on."""
        for j, td in self.jog_done.items():
            end = self.jog_end[j]
            if td <= t < end:
                return j, 0.0, 0.0, 0.0
            clear = self.jog_clear.get(j)                     # when the backed-off hand was first clear of the dial
            if t >= end and clear is None:
                if t >= end + BACK_OFF_S + CLEAR_WAIT_S or t >= end + BACK_OFF_S and not self.on_dial():
                    self.jog_clear[j] = clear = t
                else:
                    return j, 0.0, 0.0, min_jerk((t - end) / BACK_OFF_S)
            if clear <= t < clear + FREEZE_EASE_S:
                x = (t - clear) / FREEZE_EASE_S
                w = min_jerk(x)
                return j, w, w, 1.0 - min_jerk((x - 0.7) / 0.3)      # kept off the rim till the arm is nearly round
        return None

    def at(self, t: float):
        """The plan, but a done jog's right arm and hand stopped where the machine read right, gripping the dial, so
        it stops with them, as people stop turning a handle: no coasting on past the jog's clicks."""
        q, v, a = super().at(t)
        self.count_clicks(t)
        f = self.frozen(t)
        if f is not None:
            j, w_arm, w_fingers, back = f
            qf = self.jog_hold[j]
            wq = np.where(self.r_arm, w_arm, w_fingers)
            q[self.r_q] = qf[self.r_q] + (q[self.r_q] - qf[self.r_q]) * wq
            q += self.jog_back[j] * back
            v[self.r_dof] *= wq
            a[self.r_dof] *= wq
        return q, v, a

    def hold_dial(self, t: float) -> None:
        """The dial_pinch shortcut: on while the stroke grips (or the hand holds it still) and a finger touches the
        rim, its anchor set where the hand is then, so switching it on moves nothing."""
        m, d = self.model, self.data
        e, grip = self.effort("R", t)
        want = grip == "dial" and e >= 0.5
        if want and not d.eq_active[self.pinch]:
            touching = any(self.dial_geom in (c.geom1, c.geom2) and ({c.geom1, c.geom2} & self.hand_geoms)
                           for c in d.contact[:d.ncon])
            if touching:
                hb, gb = m.body("R_hand").id, m.body("vf2_jog_handle").id
                p = d.xpos[gb] + d.xmat[gb].reshape(3, 3) @ m.eq_data[self.pinch, 0:3]
                m.eq_data[self.pinch, 3:6] = d.xmat[hb].reshape(3, 3).T @ (p - d.xpos[hb])
                d.eq_active[self.pinch] = 1
        elif not want and d.eq_active[self.pinch]:
            d.eq_active[self.pinch] = 0

    def effort(self, side: str, t: float) -> tuple[float, str]:
        """The plan's effort, but a held hand keeps the grip it had when the dial read right."""
        f = self.frozen(t) if side == "R" else None
        return super().effort(side, self.jog_done[f[0]] if f is not None and f[3] == 0.0 else t)

    def on_dial(self) -> bool:
        """Is any part of the hand touching the jog handle?"""
        return any(self.dial_geom in (c.geom1, c.geom2) and ({c.geom1, c.geom2} & self.hand_geoms)
                   for c in self.data.contact[:self.data.ncon])

    def back_off_dq(self, q: np.ndarray) -> np.ndarray:
        """The arm's joint change (qpos) that slides the hand held at joints q straight off the dial, along its axis
        toward the operator, by BACK_OFF_MM: part of the plan the runner tracks, so its correction agrees."""
        m = self.model
        scratch = mujoco.MjData(m)
        scratch.qpos[:] = self.data.qpos
        scratch.qpos[self.body_q] = q[self.body_q]
        mujoco.mj_kinematics(m, scratch)
        mujoco.mj_comPos(m, scratch)
        jacp = np.zeros((3, m.nv))
        mujoco.mj_jacBody(m, scratch, jacp, None, m.body("R_hand").id)
        dofs = self.arm_dofs["R"]
        J = jacp[:, dofs]
        dq = np.zeros(m.nq)
        qadr = [m.jnt_qposadr[m.joint(f"R_{j}").id] for j in ARM]
        dq[qadr] = J.T @ np.linalg.solve(J @ J.T + DAMPING ** 2 * np.eye(3), -DIAL_AXIS * BACK_OFF_MM / 1000)
        return dq

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
        self.machine.apply()

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
                "pressed": [[round(t - self.settle_s, 3), key] for t, key in c.pressed], "events": c.events,
                "machine_mm": c.machine_mm().round(4).tolist(),
                "press_n_max": {e["key"] + f"@{e['t0']}": round(max((f.get(e["key"], 0.0) for f in
                                self.rec["key_n"][int(e["t0"] * self.fps):int(e["t1"] * self.fps) + 2]), default=0.0), 2)
                                for e in self.presses}}

    @property
    def settle_s(self) -> float:
        return SETTLE_STEPS * self.model.opt.timestep

    def export(self, folder: Path | None = None) -> None:
        folder = Path(folder or self.folder)
        super().export(folder)
        checks = {k: self.rec[k] for k in ("touching", "handle_deg", "hand_wrench", "active_constraints",
                                           "applied_forces", "machine_axes")} | {"never_held": NEVER_HELD}
        (folder / "checks.json").write_text(json.dumps(checks), encoding="utf-8")
        (folder / "outcome.json").write_text(json.dumps(self.outcome(), indent=1), encoding="utf-8")
