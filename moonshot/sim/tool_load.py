"""Load the tools (moonshot/motion/tool_load.py) run in MuJoCo, on the pendant's runner (moonshot/sim/pendant.py): the
part clamped in the vise as the setting takes have it, the tool stand on the table, the carousel's holders in
their pockets, and the VF-2's drawbar (moonshot/world/vf2.py SPINDLE_BORE) reading its Tool Release button.

- A seat take: the holder a free body in its fork on the stand. The right hand closes on its body under the flange,
  and from then until the drawbar holds it the hand carries it by the declared grip assist `carry_holder`, a stiff weld
  where the holder sits in the hand as the fingers close (as the inspection bench's tools, moonshot/world/bench_cell.py;
  capsule fingers can't keep a 1.25 in body steady in a wrap), its skin and the holder not colliding meanwhile (the
  weld stands for their contact); it takes the holder's weight over people's loading time (fed forward through the
  arm), lifts it off the tines, slides it out and carries it in under the spindle, watching it (the hand's correction
  by sight is on the holder: on its planned path and upright, as the blow-off take's is on the gun's); then pushes it
  up into the bore, the weld now a pivot on the holder's axis so the bore stands it upright, while the left index holds
  the head's button (a held press: it keeps pushing once the button clicks, sim/pendant.py), and the drawbar's
  fingers, open while it is held, close under the knob when it is let go. Then the weld lets go, and only the drawbar
  holds the holder.
- A pick take and an insert take (a far fork's seat in two, planning/takes.py split): the pick as a seat take up to
  the holder held up clear of the stand, the carry on to its end; the insert the rest, the holder in the hand from its
  first frame where the pick left it from the body, its weight taken, the carry on from the start.
- A tool change take (00-change, NN-atc): keys at the pendant, the holder in the spindle part of it (it is clamped
  there), nothing loose. The changer's own motion isn't simulated: the machine counts the change (world/vf2.py
  Control.tool_change) and the next take starts from the carousel it leaves, across the cut.

    python -m moonshot.sim.tool_load nist-ftc-10 op50-tools [take]    # runs each take (or one) and writes its record

Writes beside each take record: checks.json (as the pendant's, and touching_R, and the runner's load_N and weight_N for
the holder, which the grasp checks read) and outcome.json (the machine's pocket table and key presses; for a seat,
where the holder ended in the spindle and what holds it). moonshot/tests/gates/test_setting_takes.py reads them.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import mujoco
import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion.primitives import min_jerk
from moonshot.sim.pendant import PendantRunner
from moonshot.sim.runner import APPROACH_S, H0, RELEASE_S, TakeRunner
from moonshot.world import tooling as TL
from moonshot.world import vise as V
from moonshot.world.vise import Load

G = 9.81
GRIP_Z_MM = -30.0           # where the fingers wrap the holder's body, on its axis (its frame: the gauge line's centre)
BORE_IN_MM = 45.0           # the holder's gauge line this close under the spindle's: its taper's top 11 mm up the rings
BORE_AXIS_MM = 4.0          # ... and its axis this close to the spindle's
L_SIGHT_EASE_S = 0.3        # the left hand's sight correction, its press over, eases off this fast
FAST_MM_S = 250.0           # while the plan moves the right hand faster than this, sight doesn't correct it: it acts
                            # in a movement's slow end (corrected through the fast reach to the holder, the eye wound
                            # up 22 mm of lag and threw the hand 30 mm past its grip as the reach slowed)
CARRY_SOLREF_S = 0.004      # the carry weld's time constant, holding the holder stiffly in the hand ...
CARRY_SOLIMP = (0.9, 0.95)  # ... and its impedance
PRELOAD_SOLREF_S = 0.3      # before the hand takes the holder's weight, soft, and giving: at the carry's impedance the
PRELOAD_SOLIMP = (0.02, 0.05)  # weld passes 90% of the hand's own tremor and drift to the resting holder whatever its
                            # stiffness, 0.4-0.54 N of it, near the 0.55 N that starts the loading
R_OUT_S = 0.8              # the right hand off the holder this long after its grip ends (motion/tool_load.py)
R_SIGHT_EASE_S = 0.8        # ... and its carry's correction eases out this fast as it goes back, as the bench's
CARRIED = ("seat", "pick", "insert")    # the takes a hand carries a holder in: a whole seat, or its pick and its insert
SEATED_SOLREF_S = 0.03      # the weld's time constant once the holder is seated and the drawbar takes it ...
SEATED_LEAD_S = 0.05        # ... from this long before Tool Release is let go
HOLD_DAMP_S = 0.3           # the eye on a carried holder weighs how fast it moves off its path (s) beside how far: on
                            # its place alone, the holder swayed 20 mm each side of the spindle's axis (30 mm the face
                            # mill's) as it was lined up under it, every 1.2 s, and the face mill's knob landed on the
                            # spindle's face beside the bore


class ToolLoadRun(PendantRunner):
    # the holder's grip doesn't squeeze (moonshot/sim/runner.py): the carry weld holds it and the hand and the holder
    # don't collide meanwhile, so the squeeze only drove the fingers deeper into it, the skin to 3.5 mm
    grip_geoms = {"dial": "vf2_jog_handle"}

    def __init__(self, folder: Path):
        super().__init__(folder)
        m, ld = self.model, self.tk["load"]
        self.kind = ld["kind"]
        c = self.machine
        c.pockets = {int(p): t for p, t in ld["pockets"].items()}
        c.current, c.spindle_tool = int(ld["current"]), ld["spindle"]
        c.mode = self.tk["setup"].get("mode", "")
        self.loose = m.body("holder").id if self.kind in CARRIED else None
        self.holder_geoms = {g for g in range(m.ngeom) if self.loose is not None and m.geom_bodyid[g] == self.loose}
        self.right = {g for g in self.hand_geoms if m.geom(g).name.startswith("R_")}
        self.knob = m.geom("holder_knob_head").id if self.loose is not None else None
        self.finger_geoms = {m.geom(f"vf2_finger_{k}").id for k in range(3)}
        self.finger_q = [m.jnt_qposadr[m.joint(f"vf2_finger_{k}").id] for k in range(3)]
        self.spindle_body = m.body("vf2_spindle").id      # (the runner's spindle is its joint's dof)
        ev = {e["kind"]: e for e in self.tk["events"]}
        self.grip, self.carry, self.seat_ev = ev.get("grip"), ev.get("carry"), ev.get("seat")
        self.seat_t0 = self.seat_ev["t0"] if self.seat_ev else float("inf")      # a pick never seats it
        reach = [e for e in self.presses if e["side"] == "L" and "reach_t0" in e]
        self.release_t = reach[0]["t1"] if reach else float("inf")             # Tool Release let go
        self.l_sight = (reach[0]["reach_t0"], reach[0]["t1"] + 0.2) if reach else None
        self._r_out = None
        self.wrist_speed = {s: np.linalg.norm(np.gradient(self.rd[f"{s}_W"], 1.0 / self.fps, axis=0), axis=1)
                            for s in ("R", "L")}
        self.path = [(k[0], np.array(k[1:], float)) for k in ld.get("path", [])]
        self.kg = TL.holder_kg(ld["tool"]) if self.kind in CARRIED else 0.0
        self.rec |= {"holder": [], "holder_quat": [], "touching_R": [], "fingers": [], "clamp_N": [],
                     "released": []}
        self.weld = m.equality("carry_holder").id if self.loose is not None else None
        if self.loose is not None:              # the planned grip's hand (its body's frame) in the holder's, upright
            from moonshot.motion.tool_load import holder_grip
            self.grip_in_holder = np.array(holder_grip(ld["tool"])["H"], float) @ H0.T
            self.grip_W_m = np.array(holder_grip(ld["tool"])["W_rel"], float) * 0.001     # the wrist, holder's frame
        # a tool wider than the holder's body (the face mill) leaves the fingers no slack round it: as the hand takes the
        # weight, the weld sets it wholly on its planned grip, not just turned to it about the holder's axis (held
        # where it closed, a few millimetres and degrees off, the fingers sat 6 mm into the cutter as it was carried)
        self.wide = self.loose is not None and TL.cutter(ld["tool"])["body_r"] > TL.BODY[0]
        self._pivoting = False
        self._pivot_R = np.eye(3)
        self._hold, self._hold_q = None, None
        self._stiff = False
        self._apart_on = False

    # --- the scene --------------------------------------------------------------------------------------------------
    def scene(self, body_xml: str) -> str:
        xml = super().scene(body_xml)
        ld = self.tk["load"]
        n = len(self.tk["step"]["facts"]["tool_ids"])
        stand = {int(k): t for k, t in ld["stand"].items()}
        layout = TL.Layout.from_json(ld.get("stand_layout"))     # a plate's on the bracket; else the vise setups'
        add = ""
        if ld["kind"] in ("seat", "pick"):          # on the stand
            add += TL.holder_body("holder", ld["tool"], TL.on_stand(ld["fork"], layout))
            stand.pop(ld["fork"])
        elif ld["kind"] == "insert":               # in the hand from the start, where the pick left it held
            add += TL.holder_body("holder", ld["tool"], np.array(ld["path"][0][1:], float))
        add += TL.stand_xml(n, stand, layout)
        add += TL.carousel_xml({int(p): t for p, t in ld["pockets"].items() if t != "probe"}, int(ld["current"]))
        xml = xml.replace("<worldbody>\n", "<worldbody>\n" + add, 1)
        if ld["kind"] in CARRIED:                  # the carry's grip assist, switched by before_step
            xml = xml.replace("<equality>\n", '<equality>\n    <weld name="carry_holder" body1="holder" body2="R_hand" '
                              f'active="false" solref="{CARRY_SOLREF_S} 1" solimp="0.9 0.95 0.002"/>\n', 1)
        if ld["kind"] == "atc":                    # the holder clamped in the spindle, part of it until the change
            gauge = '<geom name="vf2_spindle_gauge" type="cylinder" size="0.022 0.005" contype="0" conaffinity="0" mass="5"/>'
            assert gauge in xml
            xml = xml.replace(gauge, gauge + f'<body name="holder">{TL.holder_geoms("holder", ld["tool"], collide=False)}'
                              f'</body>', 1)
        return xml

    def glbs(self) -> dict[str, list[dict]]:
        out = super().glbs()
        if "plate" not in self.tk["setup"]:        # the vise (a plate's spoilboard and clamps are drawn from their geoms)
            for body, drawn in V.render_glbs().items():
                out.setdefault(body, []).extend(drawn)
        ld = self.tk["load"]
        if ld["kind"] in CARRIED + ("atc",):
            out["holder"] = TL.render_glbs(ld["tool"])
        for k, t in ld["stand"].items():
            if not (ld["kind"] in ("seat", "pick") and int(k) == ld["fork"]):
                out[f"stand_holder_{k}"] = TL.render_glbs(t)
        for p, t in ld["pockets"].items():
            if t != "probe":
                out[f"pocket_{p}"] = TL.render_glbs(t)
        return out

    def meshes(self, folder: Path) -> dict[str, dict]:
        if "plate" in self.tk["setup"]:            # the plate, the spoilboard and the clamps: drawn from their geoms
            return {}
        return V.render_meshes(Load.from_json(self.tk["setup"]["load"]), folder)

    def start(self) -> None:
        """An insert's holder in the hand where its pick (the take before it, planning/takes.py tool_takes) left it
        there, the hand standing where the plan has it at the first frame: placed on its planned path, or in the hand
        as its planned grip has it, it sat a few millimetres deeper than the pick's hand had closed on it, and the
        weld, holding it so for the whole carry, held the skin 4.1-6 mm into it, where the pick's was 1.3-2.7."""
        super().start()
        if self.kind != "insert":
            return
        from moonshot.planning.takes import tool_takes
        names = tool_takes(self.tk["step"])
        pick = self.folder.parent / names[names.index(self.folder.name) - 1]
        rec = np.load(pick / "take.npz")                   # the pick must have run first: its record is the start
        bodies = [str(b) for b in rec["bodies"]]

        def pose(body):
            R = np.zeros(9)
            mujoco.mju_quat2Mat(R, np.asarray(rec["quat"][-1, bodies.index(body)], float))
            return R.reshape(3, 3), rec["pos"][-1, bodies.index(body)] * 0.001

        (Rh, ph), (Ro, po) = pose("R_hand"), pose("holder")
        m, d = self.model, self.data
        mujoco.mj_kinematics(m, d)
        hb = m.body("R_hand").id
        Rn = d.xmat[hb].reshape(3, 3)
        R = Rn @ Rh.T @ Ro                                  # the holder's frame now, as it was in the hand
        adr = m.jnt_qposadr[m.body_jntadr[self.loose]]
        d.qpos[adr:adr + 3] = d.xpos[hb] + Rn @ Rh.T @ (po - ph)
        mujoco.mju_mat2Quat(d.qpos[adr + 3:adr + 7], np.ascontiguousarray(R).reshape(-1))

    # --- the hand and the holder ------------------------------------------------------------------------------------
    def planned_holder(self, t: float) -> np.ndarray:
        """The holder's gauge line where the plan has it at t (mm, world)."""
        p = self.path[0][1]
        for (t0, a), (t1, b) in zip(self.path, self.path[1:]):
            if t >= t0:
                p = a + (b - a) * min_jerk((t - t0) / max(t1 - t0, 1e-9))
        return p

    def at(self, t: float):
        """The plan; and from when the carry ends, the right arm held where the weld left it, the plan's own motion
        from then on added to that (`let_go`), eased back onto the plan as the hand goes back to rest."""
        self._t = t                                # the plan's time this step, for what reads it without being given it
        q, v, a = super().at(t)
        if self._hold is not None:
            q[self._hold_q] += self._hold * (1.0 - min_jerk((t - self.grip["t1"] - R_OUT_S) / R_SIGHT_EASE_S))
        return q, v, a

    def let_go(self, t: float) -> None:
        """As the weld lets go of the holder, the drawbar holding it: the right arm's targets set where the arm is,
        and its sight's correction, which stood for where the holder sat in the hand, folded into them, so letting
        go moves nothing. Held at the plan and its correction, the arm, pressed up against the seated holder through
        the weld and freed of it, sprang 12 mm across into it, the palm 6 mm into its body."""
        q, _, _ = super().at(t)
        self._hold_q = self.r_q[self.r_arm]
        self._hold = self.data.qpos[self._hold_q] - q[self._hold_q]
        self.visual["R"][:] = 0.0

    def carrying(self, t: float) -> bool:
        return self.carry is not None and self.carry["t0"] <= t < self.carry["t1"]

    def holding(self, t: float) -> bool:
        """Is the hand carrying the holder's weight (from the carry's loading to its end)?"""
        return self.carrying(t) and t >= self.carry.get("loading", (self.carry["t0"],))[0]

    def planned_speed(self, side: str, t: float) -> float:
        """How fast the plan moves the side's wrist at t (mm/s)."""
        k = min(len(self.t) - 1, int(round(t * self.fps)))
        return float(self.wrist_speed[side][k])

    def correction(self, t: float) -> np.ndarray:
        """As a pendant take's, but for the left hand's reach up to the head's Tool Release, which sight corrects too,
        from its start to its press's end, and lets go of slowly after: the pendant's left hand only presses Cycle
        Start, beside it, but uncorrected on its long reach up to the head the left arm sagged 20 mm and drifted 28 mm
        forward, its index onto the button half a second early."""
        dt = self.model.opt.timestep
        if self.loose is not None and t >= self.grip["t1"] + R_OUT_S:   # the carry's correction eases out (below)
            if self._r_out is None:
                self._r_out = self.visual["R"].copy()
            self.visual["R"][:] = self._r_out * (1.0 - min_jerk((t - self.grip["t1"] - R_OUT_S) / R_SIGHT_EASE_S))
        w = self.l_sight
        if w is None or t < w[0]:
            return super().correction(t)
        if t >= w[1]:
            self.visual["L"] *= 1.0 - dt / L_SIGHT_EASE_S
        self._corr = TakeRunner.correction(self, t)
        return self._corr

    def held_error(self, side: str, t: float) -> np.ndarray | None:
        """Until the hand takes the holder's weight, the eye on the hand, settling it on its grip as the fingers close
        and firm (the weld is soft and passes nothing): steered by the holder from the grip's contact, the hand kept
        the 14 deg its turn lagged its reach, the holder went into the spindle that far turned in it, and as the bore
        stood it upright the wrist came 25 mm off the grip and the skin 5 mm into the holder.
        While the right hand carries the holder, up to when the drawbar has it: the eye on the holder, on its
        planned path and standing upright, its taper over the bore, as people watch what they carry, not their hand.
        Upright only: how it has turned about its own axis doesn't matter to the taper or the drawbar. Otherwise as a
        pendant take's (a press's). Once the carry is over, the right hand's correction, which stood for where the
        holder sat in it, is kept while the hand opens and comes off the holder, then eases out as it goes back
        (`correction`): taken up afresh at once, the 70 mm it had built up threw the hand into the spindle's nose, and
        the hand brought back onto its planned grip on the clamped holder moved across it, the palm 6 mm into it. The
        left hand's sight, past its press, only eases off."""
        if side == "L" and self.l_sight is not None and t >= self.l_sight[1]:
            return np.zeros(6)
        if side == "R" and self.loose is not None and (t >= self.carry["t1"] or self.planned_speed("R", t) > FAST_MM_S):
            return np.zeros(6)
        if side != "R" or self.loose is None or not self.holding(t):
            return super().held_error(side, t)
        m, d, p = self.model, self.data, self.plan
        if self._pivoting:
            # the holder turns free in the hand, its taper in the bore: the eye puts the hand's grip on it under the
            # spindle's axis, which stands it upright, and the hand keeps the turn it had as the holder went in, so
            # the holder stays in it as it was carried: turned to its planned turn, the 5-10 deg the hand had held
            # the holder off its planned grip came out of the grip instead, the wrist 20 mm off it, and as the hand
            # let go the palm sank 7 mm into the holder
            hb = m.body("R_hand").id
            Rh = d.xmat[hb].reshape(3, 3)
            grip = d.xpos[hb] + Rh @ m.eq_data[self.weld, 0:3]
            want = self.planned_holder(t) * 0.001 + [0.0, 0.0, GRIP_Z_MM * 0.001]
            turn = Rotation.from_matrix(self._pivot_R @ Rh.T).as_rotvec()
            return np.r_[want - grip, turn]
        else:
            z = d.xmat[self.loose].reshape(3, 3)[:, 2]
            axis = np.cross(z, [0.0, 0.0, 1.0])
            s = np.linalg.norm(axis)
            turn = axis / s * np.arctan2(s, z[2]) if s > 1e-9 else np.zeros(3)
        dof = m.jnt_dofadr[m.body_jntadr[self.loose]]
        v_plan = (self.planned_holder(t + 0.01) - self.planned_holder(t - 0.01)) / 0.02 * 0.001
        lag = HOLD_DAMP_S * (d.qvel[dof:dof + 3] - v_plan)
        return np.r_[self.planned_holder(t) * 0.001 - d.xpos[self.loose] - lag, turn]

    def touching(self, side: str) -> bool:
        """As the runner's, but the holder the right hand reaches for and carries in isn't a contact to stop
        correcting at: the hand closes on it where the plan has it (else the carry weld locks in a hand 30 mm off its
        grip, which then wedges the holder in its fork), and it is what the hand is steered by, until the push starts
        and the bore takes it."""
        t = getattr(self, "_t", 0.0)
        if side == "R" and self.loose is not None and self.grip and self.grip["t0"] - 0.6 <= t < self.seat_t0:
            m, d = self.model, self.data
            mine = self.side_bodies[side]
            for i in range(d.ncon):
                b1, b2 = m.geom_bodyid[d.contact[i].geom1], m.geom_bodyid[d.contact[i].geom2]
                if (b1 in mine) != (b2 in mine) and (b2 if b1 in mine else b1) != self.loose:
                    return True
            return False
        return super().touching(side)

    def hand_force(self, side: str, t: float) -> np.ndarray | None:
        """The holder's weight while it is carried, as people anticipate a load they know: taken over the plan's
        loading time once the grip has closed (the carry event's `loading`), until then none."""
        if side == "R" and self.carrying(t):
            a, b = self.carry.get("loading", (self.carry["t0"], self.carry["t0"]))
            return np.array([0.0, 0.0, self.kg * G * float(np.clip((t - a) / max(b - a, 1e-9), 0.0, 1.0))])
        return None

    def forces_on(self, geoms: set, by: set) -> np.ndarray:
        """The world force (N) the `by` geoms put on the `geoms` geoms, summed over their contacts."""
        m, d, f6, F = self.model, self.data, np.zeros(6), np.zeros(3)
        for i in range(d.ncon):
            c = d.contact[i]
            if c.geom2 in geoms and c.geom1 in by:
                sign = 1.0
            elif c.geom1 in geoms and c.geom2 in by:
                sign = -1.0
            else:
                continue
            mujoco.mj_contactForce(m, d, i, f6)
            F += sign * (c.frame.reshape(3, 3).T @ f6[:3])
        return F

    def anchor_weld(self, at_holder, turn_to_grip: bool = False) -> None:
        """Set carry_holder to hold the holder where it is in the hand now, at a point given in the holder's frame (mm):
        no jump as it switches on or changes. turn_to_grip: and turned about its own axis to where the planned grip
        has it in the hand, which only turns the holder in its fork (`carry_weld`)."""
        m, d = self.model, self.data
        hb = m.body("R_hand").id
        Ro, Rh = d.xmat[self.loose].reshape(3, 3), d.xmat[hb].reshape(3, 3)
        P = d.xpos[self.loose] + Ro @ (np.asarray(at_holder, float) * 0.001)
        rel = Ro.T @ Rh                                                # the hand in the holder's frame
        if turn_to_grip:
            dR = self.grip_in_holder @ rel.T
            a = np.arctan2(dR[1, 0] - dR[0, 1], dR[0, 0] + dR[1, 1])
            rel = np.array([[np.cos(a), -np.sin(a), 0.0], [np.sin(a), np.cos(a), 0.0], [0.0, 0.0, 1.0]]) @ rel
        m.eq_data[self.weld, 0:3] = Rh.T @ (P - d.xpos[hb])          # the point in the hand (body2)
        m.eq_data[self.weld, 3:6] = Ro.T @ (P - d.xpos[self.loose])  # ... and in the holder (body1)
        if turn_to_grip and self.wide:             # the hand where its planned grip has it on the holder, wholly
            rel = self.grip_in_holder
            a = np.asarray(at_holder, float) * 0.001
            m.eq_data[self.weld, 0:3] = rel.T @ (a - self.grip_W_m)
            m.eq_data[self.weld, 3:6] = a
        qr = np.zeros(4)
        mujoco.mju_mat2Quat(qr, np.ascontiguousarray(rel).reshape(-1))
        m.eq_data[self.weld, 6:10] = qr

    def carry_weld(self, t: float) -> None:
        """carry_holder on from just after the fingers close to when the drawbar has the holder, holding the holder
        where it then sits in the hand (no jump: welded to where the plan had the hand, a hand that closed off it
        snapped onto it, and the holder's load spiked as the grip closed); the eye keeps it on its path and upright
        (held_error). From when the push into the bore starts it holds only the holder's place in the hand, not its
        turn (torquescale 0), at a point on the holder's own axis among the fingers, so the bore's rings stand it
        upright as it goes up, as a taper aligns a holder a hand guides: carried rigidly, a hand 7 deg off its grip
        jammed it in the bore, and held at the wrist, beside the holder, the push up through it tipped the holder until
        its taper wedged across the rings. The hand's skin and the holder are apart while it's on and until the hand
        is well off it (the runner's RELEASE_S)."""
        m, d = self.model, self.data
        want = self.carry["t0"] <= t < self.carry["t1"]
        if want and not self._pivoting and d.eq_active[self.weld] and t >= self.seat_t0 and self.in_bore():
            self.anchor_weld([0.0, 0.0, GRIP_Z_MM])
            m.eq_data[self.weld, 10] = 0.0
            self._pivoting = True
            self._pivot_R = d.xmat[m.body("R_hand").id].reshape(3, 3).copy()
        lo = self.carry.get("loading", (self.carry["t0"], self.carry["t0"]))
        loading = t >= lo[0]
        if want and not d.eq_active[self.weld]:
            self.anchor_weld([0.0, 0.0, 0.0])
            m.eq_data[self.weld, 10] = 1.0
            d.eq_active[self.weld] = 1
            self._stiff = False
        elif not want and d.eq_active[self.weld]:
            d.eq_active[self.weld] = 0
            self.let_go(t)
        # soft while the grip firms and before the hand takes any weight, as the skin and the fingers give; set again
        # where the holder then sits in the hand as the hand starts to take its weight, so stiffening moves nothing;
        # and stiffened over the loading, as the grip firms with the load (Guillery 2013): stiff from the start, the
        # hand's tremor shook the resting holder against its tines at 1-2 N, past the 0.55 N that starts the loading,
        # and stiffened at once, the hand, held a few millimetres high by its sight, lifted it off in 0.13 s
        if want and loading and not self._stiff and not self._pivoting:
            # turned about the holder's own axis onto the planned grip: the hand's turn lagged its reach, and the
            # 13-18 deg it held the holder turned in it stayed to the end, where the fingers, wrapped round its
            # front, dragged through it as the hand came away
            self.anchor_weld([0.0, 0.0, 0.0], turn_to_grip=True)
            self._stiff = True
        f = float(np.clip((t - lo[0]) / max(lo[1] - lo[0], 1e-9), 0.0, 1.0)) if self._stiff else 0.0
        m.eq_solref[self.weld, 0] = PRELOAD_SOLREF_S * (CARRY_SOLREF_S / PRELOAD_SOLREF_S) ** f
        m.eq_solimp[self.weld, 0:2] = np.add(PRELOAD_SOLIMP, f * np.subtract(CARRY_SOLIMP, PRELOAD_SOLIMP))
        if self._pivoting and t >= self.release_t - SEATED_LEAD_S:
            # seated, as Tool Release is let go and the drawbar pulls the holder in: the hand's hold gives, as a hand
            # does to a pull it feels coming; held as stiffly as it was carried, the drawbar's snap went through the
            # weld into the hand in one 65 N step, and the wrist's extensor past its maximum
            m.eq_solref[self.weld, 0] = SEATED_SOLREF_S
        # apart from the final approach on, as the runner holds a welded tool's grip (APPROACH_S): a hand trailing its
        # plan by 15 mm, its open fingers just under the flange, knocked the holder out of its fork; and on until the
        # hand is well off it (the runner's RELEASE_S): touching again as the weld let go, the fingers round a face
        # mill pulled its holder, 15 N of it, out of the drawbar's 18 N
        apart = self.grip["t0"] - APPROACH_S <= t < self.carry["t1"] + RELEASE_S
        if apart != self._apart_on:
            self.hold_apart(self.loose, 1 if apart else 0)
            self._apart_on = apart

    def in_bore(self) -> bool:
        """Is the holder's taper up in the spindle's bore, past the lead-in and among the rings, on its axis? Only then
        may the weld let it turn: lower, nothing stands it up, and freed under the nose it toppled over in the hand."""
        s = self.seated()
        return s["s_mm"] >= -BORE_IN_MM and s["offset_mm"] <= BORE_AXIS_MM

    def weight_moment(self, t: float) -> None:
        """The rest of the holder's weight fed forward: the runner feeds hand_force forward at the wrist, this adds its
        moment there, the weight hanging off the hand at the holder's own centre of mass, 100 mm and more away: without
        it the wrist gave under the load as it was taken, and the holder tipped 6 deg and dropped 9 mm in the fork."""
        F = self.hand_force("R", t)
        if F is None:
            return
        m, d = self.model, self.data
        hb = m.body("R_hand").id
        at, wrist = np.zeros((3, m.nv)), np.zeros((3, m.nv))
        mujoco.mj_jac(m, d, at, None, d.xipos[self.loose], hb)
        mujoco.mj_jacBody(m, d, wrist, None, hb)
        tau = (at - wrist)[:, self.act_dof].T @ F
        d.ctrl[self.acts] += tau / m.actuator_gainprm[self.acts, 0]

    def before_step(self, t: float) -> None:
        if self.loose is not None:
            self.carry_weld(t)
            self.weight_moment(t)
        super().before_step(t)
        if (self.loose is not None and self.machine.spindle_tool is None and t >= self.seat_t0
                and self._steps % 10 == 0 and self.seated()["clamped"]):
            self.machine.spindle_tool = self.tk["load"]["tool"]      # the machine now holds what the hand put in

    def seated(self) -> dict:
        """Where the loose holder is against the spindle's gauge point, and what holds it."""
        d = self.data
        rel = (d.xpos[self.loose] - d.xpos[self.spindle_body]) * 1000
        R = d.xmat[self.loose].reshape(3, 3)
        clamp = float(np.linalg.norm(self.forces_on({self.knob}, self.finger_geoms))) if self.knob is not None else 0.0
        return {"offset_mm": float(np.hypot(*rel[:2])), "s_mm": float(rel[2]),
                "tilt_deg": float(np.degrees(np.arccos(np.clip(R[2, 2], -1, 1)))), "clamp_N": clamp,
                "clamped": clamp > 1.0 and not self.machine.tool_release_held()}

    # --- each frame --------------------------------------------------------------------------------------------------
    def on_frame(self, k: int) -> None:
        super().on_frame(k)
        m, d = self.model, self.data
        touching = set()
        for i in range(d.ncon):
            pair = {d.contact[i].geom1, d.contact[i].geom2}
            if pair & self.right and len(pair - self.hand_geoms) == 1:
                touching.add(m.geom((pair - self.hand_geoms).pop()).name)
        self.rec["touching_R"].append(sorted(touching))
        self.rec["fingers"].append([round(float(d.qpos[a]), 4) for a in self.finger_q])
        self.rec["released"].append(self.machine.tool_release_held())
        if self.loose is not None:
            self.rec["holder"].append((d.xpos[self.loose] * 1000).round(3).tolist())
            self.rec["holder_quat"].append(d.xquat[self.loose].round(6).tolist())
            self.rec["clamp_N"].append(round(self.seated()["clamp_N"], 3))

    def outcome(self) -> dict:
        c = self.machine
        out = super().outcome() | {"kind": self.kind, "pockets": {str(p): t for p, t in sorted(c.pockets.items())},
                                   "current": c.current, "spindle_tool": c.spindle_tool, "changes": c.changes}
        rel = [i for i, r in enumerate(self.rec["released"]) if r]
        out["tool_release_held_s"] = [round(rel[0] / self.fps, 3), round(rel[-1] / self.fps, 3)] if rel else None
        if self.loose is not None:
            s = self.seated()
            tail = self.rec["touching_R"][-int(0.5 * self.fps):]
            out["seated"] = {k: round(v, 3) if isinstance(v, float) else v for k, v in s.items()} | {
                "hand_off_s": not any(any(n.startswith("holder") for n in t) for t in tail),
                "lifted_mm": round(float(max(h[2] for h in self.rec["holder"]) - self.rec["holder"][0][2]), 2)}
        return out

    def export(self, folder: Path | None = None) -> None:
        super().export(folder)
        folder = Path(folder or self.folder)
        ck = json.loads((folder / "checks.json").read_text(encoding="utf-8"))
        ck["touching_R"] = self.rec["touching_R"]
        if self.loose is not None:              # the holder's lift and weight as the runner records a carried object's
            ck |= {"load_N": self.checks["load_N"], "weight_N": self.checks["weight_N"], "clamp_N": self.rec["clamp_N"]}
        (folder / "checks.json").write_text(json.dumps(ck), encoding="utf-8")


def takes(part: str, step_id: str) -> list[Path]:
    root = data_root() / "takes" / part / step_id
    return sorted(p for p in root.iterdir() if (p / "take.json").exists() and (p / "reference.npz").exists())


def main(argv: list[str]) -> int:
    part, step_id = argv[0], argv[1]
    only = argv[2] if len(argv) > 2 else None
    for folder in takes(part, step_id):
        if only and folder.name != only:
            continue
        run = ToolLoadRun(folder)
        run.run(log=None)
        run.export(folder)
        out = run.outcome()
        print(folder.name, json.dumps({k: out[k] for k in ("pressed", "pockets", "current", "spindle_tool")
                                       if k in out} | ({"seated": out["seated"]} if "seated" in out else {})), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
