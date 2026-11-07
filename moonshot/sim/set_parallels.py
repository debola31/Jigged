"""The physics of setting the parallels (moonshot/motion/set_parallels.py): the VF-2 cell with its doors open, the
vise open at the load's opening, the part waiting on the table, and the parallels free bodies standing in their rack.
The pinch holds each parallel by a declared soft constraint while it is carried, as a tool is held (the capsule
fingers on a 3.1 mm plate can't hold it by friction alone); it is let go standing on the seat, and the physics decides
whether it stays standing where the load take expects it.

    python -m moonshot.sim.set_parallels           # runs the take in the data root and writes its take record
    python -m moonshot.sim.set_parallels ll-1007223-op10-set-parallels     # a setup's own run (sim/setup_scene.py)
"""
from __future__ import annotations

import json
import math
import sys

import mujoco
import numpy as np

from moonshot.body.skeleton import DATA, hand_couplings
from moonshot.motion import set_parallels as SP
from moonshot.motion.primitives import min_jerk
from moonshot.sim.door_cycle import _Cell
from moonshot.sim.setup_scene import Table
from moonshot.world import cell
from moonshot.world import parallel_rack as RACK
from moonshot.world import vise as V

# the carry weld, as the runner makes it (moonshot/sim/runner.py), and soft while the grip firms before the hand takes
# the block's weight, as the tool takes' (moonshot/sim/tool_load.py PRELOAD_SOLREF_S): at once stiff, it closed on a
# block a few tenths of a degree off the planned turn and pushed it into the table, and the load read as on (the
# parallel's 5% of its weight is 0.05 N) the frame the carry closed. Stiffened over STIFFEN_S as the carry starts, so
# the hand's rising pull (hand_force) comes through it as the load; stiffened over the loading itself, the parallel's
# load came through only once the hand rose, and it was up 67 ms later
CARRY_SOLREF_S, CARRY_SOLIMP = 0.004, (0.9, 0.95)
SOFT_SOLREF_S, SOFT_SOLIMP = 0.3, (0.02, 0.05)
STIFFEN_S = 0.05
COUPLE_EASE_S = 0.15       # the fingers' couplings ease onto the grip's as the fingers close, and off once the hand is
COUPLE_HOLD_S = 0.8        # up off the block after letting go (motion/set_parallels.py lifts it 0.35-0.8 s after): eased
COUPLE_OFF_S = 0.5         # off as it let go, the thumb rolled back into the stop it had just set down
FAST_MM_S = 250.0          # while the plan moves the right hand faster than this, sight doesn't correct it, as the tool
                           # takes' (moonshot/sim/tool_load.py): corrected through the reach, the lag it wound up left
                           # the hand 2 mm past its grip when it closed, the thumb 6 mm into the stop


class FirmGrip:
    """What a pinch carried by its weld needs of the physics (set-parallels, set-stop). The weld is soft from when it
    closes until the carry starts (the preload), set again there where the block then sits in the hand, and stiffened.
    And the gripping hand keeps the grip's own shape: the body couples each DIP to its PIP, the thumb's CMC roll to
    its flexion and the palm's cupping to the ring finger (moonshot/body/skeleton.py hand_couplings, soft so contact
    can bend them), but while the weld holds the block the hand and the block don't collide (runner.py APPROACH_S), so
    nothing pressed the pads back: the middle fingertip curled 26 deg past its grip, into the stop, and the thumb rolled
    3 deg into it. The pinch doesn't squeeze either (no grip_geoms): the squeeze only drove the pads deeper."""
    grip_geoms: dict[str, str] = {}
    TORQUESCALE = 1.0          # the weld's turn weighed against its place (MuJoCo's weld torquescale) once it's set

    def firm_setup(self) -> None:
        grips = json.loads((self.folder / "grips.json").read_text(encoding="utf-8"))
        self._couplings = hand_couplings(json.loads((DATA / "anatomy.json").read_text(encoding="utf-8")))
        self._grip_c = {}
        for e in self.grip_events:                 # follower = k * leader + c, as the grip has the pair
            q = grips[e["grip"]]["q"]
            self._grip_c[e["grip"]] = [q[c.follower] - c.k * q[c.leader] - c.c for c in self._couplings]
        self._anchored: set[int] = set()
        W = self.rd["R_W"]
        self._plan_speed = np.linalg.norm(np.gradient(W, 1.0 / self.fps, axis=0), axis=1)

    def fast(self, t: float) -> bool:
        """Is the plan moving the right hand faster than sight corrects it?"""
        return bool(self._plan_speed[min(len(self._plan_speed) - 1, int(round(t * self.fps)))] > FAST_MM_S)

    def carry_of(self, grip_event: dict) -> dict:
        raise NotImplementedError

    def enclose(self, t: float) -> None:
        super().enclose(t)
        m, d = self.model, self.data
        for e in self.grip_events:
            eq = m.equality(self.eq_name(e["grip"])).id
            if not d.eq_active[eq]:
                self._anchored.discard(eq)
                continue
            if self._eq_by.get(eq) is not e:         # held now by another of its grip's events (a wrench taken twice)
                continue
            c = self.carry_of(e)
            if t >= c["t0"] and eq not in self._anchored:
                # set again where the block sits in the hand now: the hand drifts a little on the soft weld while the
                # grip firms, and stiffened back to where it closed, the weld threw parallel b 2.7 mm up off its seat
                hb, ob = m.body(f"{e['side']}_hand").id, m.body(self.encloses[e["grip"]]).id
                Ro = d.xmat[ob].reshape(3, 3)
                m.eq_data[eq, 3:6] = Ro.T @ (d.xpos[hb] - d.xpos[ob])
                qr = np.zeros(4)
                mujoco.mju_mat2Quat(qr, np.ascontiguousarray(Ro.T @ d.xmat[hb].reshape(3, 3)).reshape(-1))
                m.eq_data[eq, 6:10] = qr
                m.eq_data[eq, 10] = self.TORQUESCALE
                self._anchored.add(eq)
            f = float(np.clip((t - c["t0"]) / STIFFEN_S, 0.0, 1.0)) if eq in self._anchored else 0.0
            m.eq_solref[eq, 0] = SOFT_SOLREF_S * (CARRY_SOLREF_S / SOFT_SOLREF_S) ** f
            m.eq_solimp[eq, 0:2] = np.add(SOFT_SOLIMP, f * np.subtract(CARRY_SOLIMP, SOFT_SOLIMP))

    def before_step(self, t: float) -> None:
        super().before_step(t)
        m = self.model
        w, grip = 0.0, None
        for e in self.grip_events:                   # the grip's shape from as the carry closes until off the block
            t_c, t_off = e["t0"] + 0.1, e["t1"] + COUPLE_HOLD_S
            on = min_jerk((t - (t_c - COUPLE_EASE_S)) / COUPLE_EASE_S) * (1 - min_jerk((t - t_off) / COUPLE_OFF_S))
            if on > w:
                w, grip = on, e["grip"]
        for i, cp in enumerate(self._couplings):
            c = cp.c + (w * self._grip_c[grip][i] if grip else 0.0)
            jf, jl = self.body.joints[f"R_{cp.follower}"], self.body.joints[f"R_{cp.leader}"]
            eq = m.equality(f"couple_R_{cp.follower}").id
            m.eq_data[eq, 0] = math.radians(cp.k * jl.rest + c - jf.rest)
            m.eq_data[eq, 1] = cp.k


class SetParallels(FirmGrip, _Cell):
    doors_open_mm = 600.0          # fully open, as the vise take loads with them
    # a 0.09 kg plate pinched 100 mm from the wrist turns in the weld under its own weight as it comes off its seat (its
    # turn is held only as stiffly as its small inertia makes it), 3 mm at its middle: the pinch holds its turn
    # as firmly as its place
    TORQUESCALE = 5.0
    encloses = {SP.GRIP[n]: n for n in SP.ORDER}
    welded = set(SP.GRIP.values())

    def __init__(self, folder=SP.TAKES / "set-parallels"):
        super().__init__(folder)
        self.firm_setup()
        self.load = V.REFERENCE if self.table is None else self.table.load
        self.base_at = {n: [] for n in SP.ORDER}
        self.tilt = {n: [] for n in SP.ORDER}
        self.in_hand = {n: [] for n in SP.ORDER}
        self.carry = {e["obj"]: e for e in self.tk["events"] if e["kind"] == "carry"}
        keys = np.load(self.folder / "parallel_keys.npz")
        self.keys = {n: (keys[f"{n}_t"], keys[f"{n}_p"]) for n in SP.ORDER}
        grips = {e["grip"]: e for e in self.grip_events}
        # the eye leaves the hand be while the parallel is in its slot, where pulling the hand onto its plan drags it
        # into the slot's walls, and from letting go until the hand is up off it, where pulling the hand back onto its
        # plan (15 mm off it, as the eye steered the parallel) would sweep the open fingers into it. Out of the slot it
        # steers the parallel (held_error), down onto the seat and on it until it is let go: left be once it touched,
        # it was dragged 3 mm across the seat by the planned hand's last slight turning
        self.steer = {n: (self.keys[n][0][1], grips[SP.GRIP[n]]["t1"]) for n in SP.ORDER}
        self.still = [(grips[SP.GRIP[n]]["t0"], self.keys[n][0][1]) for n in SP.ORDER]
        self.still += [(grips[SP.GRIP[n]]["t1"], grips[SP.GRIP[n]]["t1"] + 0.8) for n in SP.ORDER]
        self._now = 0.0

    def carry_of(self, grip_event: dict) -> dict:
        return self.carry[grip_event["on"]]

    def planned_centre(self, name: str, t: float) -> np.ndarray:
        """Where the plan has the parallel's middle (mm) at t (motion/set_parallels.py, its keys)."""
        ts, ps = self.keys[name]
        if t <= ts[0]:
            return ps[0]
        for a, b, pa, pb in zip(ts, ts[1:], ps, ps[1:]):
            if a <= t < b:
                return pa + (pb - pa) * min_jerk((t - a) / (b - a))
        return ps[-1]

    def held_error(self, side: str, t: float) -> np.ndarray | None:
        """In free air the eye is on the parallel: where its middle is, and whether it stands upright, against the plan,
        so a grip closed a few mm off doesn't set it down that far off, and the planned hand's own slight turning on the
        way (7 deg) doesn't set it down leaning. Its turn about the vertical is left to the hand: the arm can't turn the
        hand that way much here, and asking it to wound the correction up to its limit, the fingers into the jaw."""
        self._now = t
        m, d = self.model, self.data
        held = next((n for n in SP.ORDER if self.steer[n][0] <= t < self.steer[n][1]), None)
        if side != "R" or held is None:
            return None
        b = m.body(held).id
        z = d.xmat[b].reshape(3, 3)[:, 2]
        axis = np.cross(z, [0.0, 0.0, 1.0])
        s = np.linalg.norm(axis)
        upright = axis / s * np.arctan2(s, z[2]) if s > 1e-9 else np.zeros(3)
        return np.r_[self.planned_centre(held, t) * 0.001 - d.xpos[b], upright]

    def touching(self, side: str) -> bool:
        if side == "R" and (any(a <= self._now < b for a, b in self.still) or self.fast(self._now)):
            return True
        return super().touching(side)

    def scene(self, body_xml: str) -> str:
        """The reference load's; or a setup's own run's, its table open (moonshot/sim/setup_scene.py): the same, its
        load's parallels in the rack and its part waiting on the table."""
        if "scene" in self.tk:
            self.table = Table(self.tk)
            return self.table.xml(body_xml)
        load = V.REFERENCE
        xml = cell.with_body(body_xml, load.stage, RACK.slots(load), "R_hand", load)
        return xml.replace("<worldbody>\n", "<worldbody>\n" + RACK.xml(), 1)

    def start(self) -> None:
        """The table at the loading spot, the doors open, the vise open at the load's opening and locked."""
        m, d = self.model, self.data
        self.ctl = cell.start(m, d)
        for k in ("door_left", "door_right"):
            d.qpos[self.ctl.q[k]] = self.doors_open_mm * 0.001
        lock = m.equality("screw_lock").id
        m.eq_data[lock, 0] = d.qpos[m.jnt_qposadr[m.joint("crank").id]]
        d.eq_active[lock] = 1
        for n in SP.ORDER:                  # free in their rack: the vise scene's keeper clips hold them for the load take
            d.eq_active[m.equality(f"keep_{n}").id] = 0
            a = m.jnt_qposadr[m.joint(n).id]
            d.qpos[a + 3:a + 7] = [np.cos(RACK.YAW / 2), 0.0, 0.0, np.sin(RACK.YAW / 2)]   # turned with the rack

    def planned_relpose(self, grip):
        """The pinch holds the parallel as it stands in its slot when the carry closes (runner.py: as it is). Squared to
        the grip's planned turn (as before the hand's colliders fit its skin, when the closed hand stood 10-18 deg off
        its plan), the hand's own 0.4-0.8 deg off it now turned the 152 mm parallel's ends past the slot's 1 mm play
        either side, and it came out jammed, 2-3.5 mm off in the hand. Its uprightness the eye sees to in the air
        (held_error)."""
        return None

    def hand_force(self, side, t):
        """The parallel's weight, carried: taken up over people's loading time (motion/set_parallels.py LOADING_S),
        as the grip's load comes on before lift-off (Guillery 2013). All at once, the parallel came up 67 ms after the
        load came on."""
        e = next((e for e in self.carry.values() if e["t0"] <= t < e["t1"]), None)
        if side == "R" and e is not None:
            kg = SP.STEEL * V.PARALLEL_L * V.PARALLEL_T * self.load.parallel_h * 1e-9
            return np.array([0.0, 0.0, kg * 9.81 * min(1.0, (t - e["t0"]) / SP.LOADING_S)])
        return None

    def on_frame(self, k: int) -> None:
        m, d = self.model, self.data
        hb = m.body("R_hand").id
        Rh, ph = d.xmat[hb].reshape(3, 3), d.xpos[hb]
        for n in SP.ORDER:
            b = m.body(n).id
            R = d.xmat[b].reshape(3, 3)
            self.base_at[n].append((d.xpos[b] - R[:, 2] * self.load.parallel_h / 2 * 0.001) * 1000)
            self.tilt[n].append(float(np.degrees(np.arccos(np.clip(R[2, 2], -1, 1)))))
            self.in_hand[n].append(Rh.T @ (d.xpos[b] - ph) * 1000)

    def outcome(self) -> dict:
        t = np.arange(len(self.base_at[SP.ORDER[0]])) / self.fps
        dest, out = self.load.parallels(), {}
        for n in SP.ORDER:
            B, Hh, e = np.array(self.base_at[n]), np.array(self.in_hand[n]), self.carry[n]
            carried = (t >= e["t0"] + 0.2) & (t < e["t1"] - 0.2)
            ref = Hh[np.argmax(carried)]
            out[n] = {"off_mm": [round(float(v), 2) for v in B[-1] - dest[n]],
                      "tilt_deg": round(self.tilt[n][-1], 2),
                      "lifted_mm": round(float(B[:, 2].max() - B[0, 2]), 1),
                      "max_slip_mm": round(float(np.linalg.norm(Hh[carried] - ref, axis=1).max()), 2)}
        return out


def main(argv: list[str]) -> int:
    for name in argv or ["set-parallels"]:
        r = SetParallels(SP.TAKES / name)
        r.run(log=print)
        r.export()
        out = r.outcome()
        (r.folder / "sim-report.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(name, out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
