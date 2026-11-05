"""Cutting bar stock to length on the band saw, run on the full body model (plan §5.4): the takes planned in
moonshot/motion/bandsaw.py, their physics on the two-handed bench runner (moonshot/sim/bench.py) in the saw's cell
(moonshot/world/saw_cell.py), and between them the machine's own cut, run without the person. Each take starts from
the saw as the one before left it (state.json, in the station's frame); the cut starts from the part's clamp take
with the saw as the controls' take (saw-start, the same for every bar) left it. Its gate is
moonshot/tests/gates/test_bandsaw_take.py.

- The saw's switchgear and feed (bandsaw.Control) run every step, the feed set by the valve's knob where it is turned.
  Start has no collider in the station's record, so it is worked at its site: it registers when the index's pad comes
  down within BUTTON_MM of its top during the plan's press. Everything else is contact: the bar slides on the bed and
  stops on the stop block, the handwheel turns the screw that closes the jaw on the bar, the fingers turn the valve.
- Carried, the bar, the piece, the handwheel's knob and the valve's are held to the hand by the declared
  `carry_<body>` weld (the knob turning in the fist, `loose`); they keep meeting the saw and the bench, not the skin.
- While the hand turns the handwheel it pushes the knob round with the card's force, fed forward through the arm
  as a press is (`hand_forces`).

    python -m moonshot.sim.bandsaw <part> load|clamp|start|cut|unload|all [--replan]   # -> <data root>/takes/<take>
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import mujoco
import numpy as np

from moonshot.motion import bandsaw as plan
from moonshot.sim.bench import BenchRun
from moonshot.sim.record import glbs_in_bodies
from moonshot.world import bandsaw as BS
from moonshot.world import saw_cell as SC

BUTTON_MM = 6.0             # a press registers with the pad's skin this near the button's top (its travel, proposed)
AIM_TAU, AIM_MAX = 0.15, 0.04   # a fingertip is steered onto a control by sight this fast (s), by at most this (m), as
                                # the pendant takes' (moonshot/sim/pendant.py)
AIM_LEAD_S = 0.5            # ... from this long before its press
TURN_N_PER_RAD = 300.0      # the push on the handwheel's knob grows this much per radian the wheel is behind its plan
TURN_N_MAX = 80.0           # ... to at most this (proposed: a firm one-handed push)
NEVER_HELD = ["saw_blade", "saw_head"]   # the band's collider, and the head that carries it (the checks read what a
                                         # hand touches by body, validate/objects.py touched)
DRIVEN = ["saw", "saw_base", "saw_head", "saw_cover_idler", "saw_cover_drive", "saw_blade", "saw_jaw",
          "saw_handwheel", "saw_feed_valve", "saw_bench", "saw_stop_block"]
CUT_EXTRA_S = 3.0           # the cut's run past the end of cut, while the blade runs down


def machine_axes(model, data, ctl) -> dict[str, float]:
    m, d = model, data
    blade = d.qvel[m.jnt_dofadr[m.joint("saw_blade").id]] * ctl.radius / BS.SFPM
    return {"saw_head_deg": math.degrees(d.qpos[ctl.q["head"]]), "saw_blade_sfpm": float(blade)}


def jaw_force(model, data, body: str) -> float:
    """The movable jaw's normal force on a body (N)."""
    m, d = model, data
    b, jaw, f, c6 = m.body(body).id, m.body("saw_jaw").id, 0.0, np.zeros(6)
    for i in range(d.ncon):
        c = d.contact[i]
        if {m.geom_bodyid[c.geom1], m.geom_bodyid[c.geom2]} == {b, jaw}:
            mujoco.mj_contactForce(m, d, i, c6)
            f += abs(c6[0])
    return f


class SawRun(BenchRun):
    CARRIED_BITS = (2, 1)        # the saw's colliders are contype 0: a carried body keeps meeting them as the skin does

    def __init__(self, folder: Path, place: SC.Place, loose: str, state: dict | None, carried=(), grip_objects=None,
                 lifted=None):
        self.place, self.state = place, state
        super().__init__(folder, loose, carried, grip_objects=grip_objects, lifted=lifted)
        m = self.model
        self.buttons = [e for e in self.tk["events"] if e["kind"] == "button"]
        self.turns = [e for e in self.tk["events"] if e["kind"] == "turn"]
        self.drags = [e for e in self.tk["events"] if e["kind"] == "drag"]
        self.pad = {dg: m.geom(f"R_g_dis{i}").id for dg, i in (("thumb", 1), ("index", 2))}
        # the saw's links are the machine's, driven, not objects riding on one another: touching its bed isn't touching
        # its blade (BenchRun groups every tree that isn't the person)
        self.moves_with = {k: v for k, v in self.moves_with.items() if k not in DRIVEN}
        self.log = {"axes": {"saw_head_deg": [], "saw_blade_sfpm": []}, "jaw_N": [], "controls": []}
        self.qpos: list[np.ndarray] = []
        self.aim = np.zeros(3)

    def scene(self, loose, carried, skip):
        return SC.with_body(self.body.xml, self.place, loose, carried)

    def start(self) -> None:
        self.ctl = BS.Control(self.model, self.data)
        if self.state is not None:
            SC.set_saw(self.model, self.data, self.ctl, self.state)
        else:
            self.ctl.state, self.ctl.feed_mm_s = "idle", 0.0
            self.data.qpos[self.ctl.q["head"]] = math.radians(plan.RAISED_DEG)
            self.data.qpos[self.ctl.q["handwheel"]] = math.radians(plan.KNOB_START_DEG)
            jaw = SC.bar_x()[0] - plan.JAW_GAP_MM - SC.site_mm("jaw_face")[0]       # the jaw's face that far off the bar
            self.data.qpos[self.ctl.q["jaw"]] = jaw / 1000
            self.ctl.engage_vise()
            self.ctl.events.clear()

    def pad_mm(self, digit: str, point) -> float:
        """How far a point is from a fingertip's skin (its distal capsule's surface), mm."""
        m, d = self.model, self.data
        g = self.pad[digit]
        r, half = m.geom_size[g][:2] * 1000
        c, axis = d.geom_xpos[g] * 1000, d.geom_xmat[g].reshape(3, 3)[:, 2]
        rel = np.asarray(point, float) - c
        return float(np.linalg.norm(rel - axis * np.clip(rel @ axis, -half, half)) - r)

    def before_step(self, tt: float) -> None:
        for e in self.buttons:
            if e["t0"] <= tt < e["t1"] and self.ctl.state == "idle" and self.pad_mm(e["digit"], e["at"]) < BUTTON_MM:
                self.ctl.press(e["button"])
                self.log["controls"].append({"t": round(tt, 3), "button": e["button"], "state": self.ctl.state})
        feed = self.ctl.feed_mm_s
        self.ctl.apply()
        if self.ctl.feed_mm_s != feed and (not self.log["controls"] or "feed_mm_s" not in self.log["controls"][-1]
                                           or abs(self.ctl.feed_mm_s - self.log["controls"][-1]["feed_mm_s"]) > 0.25):
            self.log["controls"].append({"t": round(tt, 3), "feed_mm_s": round(self.ctl.feed_mm_s, 3)})

    def aim_error(self, tt: float) -> np.ndarray | None:
        """Where a control's press wants the fingertip less where it is (m, world): the index's pad onto Start's top
        through its travel; None outside it."""
        m, d = self.model, self.data
        for e in self.buttons:
            if e["t0"] - AIM_LEAD_S <= tt < e["t1"]:
                g = self.pad[e["digit"]]
                pad = d.geom_xpos[g] * 1000 - np.array([0.0, 0.0, m.geom_size[g][0] * 1000])   # its underside
                want = np.asarray(e["at"], float) - [0.0, 0.0, e.get("travel_mm", 0.0) if tt >= e["t0"] else 0.0]
                return (want - pad) / 1000
        return None

    def carry_offset(self, tt: float) -> np.ndarray:
        """BenchRun's corrections, and a fingertip steered onto a control by sight, integrated slowly and capped: the
        arm at full reach to the control box lands its fingertip 20-30 mm short."""
        dq = super().carry_offset(tt)
        m, p, dt = self.model, self.plan, self.model.opt.timestep
        err = self.aim_error(tt)
        if err is None:
            self.aim *= 1 - dt / 0.2
        else:
            self.aim += err * dt / AIM_TAU
            n = np.linalg.norm(self.aim)
            if n > AIM_MAX:
                self.aim *= AIM_MAX / n
        if self.aim.any():
            hb = m.body("R_hand").id
            dofs = self.side_arm_dofs["R"]
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jacBody(m, p, jacp, None, hb)
            J = jacp[:, dofs]
            dq[dofs] += J.T @ np.linalg.solve(J @ J.T + 0.02 ** 2 * np.eye(3), self.aim)
        return dq

    def hand_forces(self, tt: float) -> np.ndarray:
        """The presses', the push that turns the handwheel (the card's force on the knob along its way round), and a
        drag: a carried bar's friction on the bed, which the hand anticipates as it slides it, and the push holding it
        to the stop, each fed forward through the arm."""
        tau = super().hand_forces(tt)
        m, d = self.model, self.data
        for e in self.drags:
            if e["t0"] <= tt < e["t1"]:
                ease = min(1.0, (tt - e["t0"]) / 0.25, (e["t1"] - tt) / 0.25)
                hand = m.body(f"{e['side']}_hand").id
                jacp = np.zeros((3, m.nv))
                mujoco.mj_jac(m, d, jacp, None, d.xpos[hand], hand)
                tau += jacp[:, self.act_dof].T @ (np.asarray(e["direction"], float) * e["force"] * ease)
        for e in self.turns:
            if not e["t0"] <= tt < e["t1"]:
                continue
            j = m.joint("saw_handwheel").id
            axis, anchor = d.xaxis[j], d.xanchor[j]
            hand = m.body(f"{e['side']}_hand").id
            p = d.xpos[hand]
            # along the knob's way round, at the knob: at the wrist, 80 mm over it, the tangent pointed in at the axis
            tangent = np.cross(axis, d.geom_xpos[m.geom("saw_handwheel_knob").id] - anchor)
            tangent /= np.linalg.norm(tangent) + 1e-12
            # harder the further the wheel is behind its plan, as people turn a wheel until it's where they want it:
            # with the card's force alone it trailed, 126 deg of its 180 when the turn's time was up. Snug, it stalls,
            # and the hand bears down on it up to TURN_N_MAX
            x = min(1.0, max(0.0, (tt - e["t0"]) / (e["t1"] - e["t0"])))
            planned = e["q0"] + e["turn_rad"] * x * x * x * (10 - 15 * x + 6 * x * x)
            behind = planned - d.qpos[m.jnt_qposadr[j]]
            ease = min(1.0, (tt - e["t0"]) / 0.25, (e["t1"] - tt) / 0.15)
            push = min(TURN_N_MAX, max(0.0, e["force"] + TURN_N_PER_RAD * behind)) * ease
            jacp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, d, jacp, None, p, hand)
            tau += jacp[:, self.act_dof].T @ (tangent * push)
        return tau

    def measure(self, _run, k: int) -> None:
        self.qpos.append(self.data.qpos.copy())
        for a, v in machine_axes(self.model, self.data, self.ctl).items():
            self.log["axes"][a].append(round(v, 4))
        held = [b for b in ("bar", "rest") if b in self.stock]
        self.log["jaw_N"].append(round(jaw_force(self.model, self.data, held[0]) if held else 0.0, 2))

    @property
    def stock(self) -> list[str]:
        names = {self.model.body(b).name for b in range(self.model.nbody)}
        return [b for b in SC.STOCK_BODIES if b in names]

    def finish(self, report: dict) -> dict:
        m, d = self.model, self.data
        state = SC.saw_state(m, d, self.ctl, self.place)
        (self.folder / "state.json").write_text(json.dumps(state, indent=1), encoding="utf-8")
        # the physics itself, frame by frame, for a look at the run as MuJoCo has it (moonshot/sim/bandsaw.py still)
        (self.folder / "physics.xml").write_text(self.xml, encoding="utf-8")
        np.savez_compressed(self.folder / "physics.npz", qpos=np.array(self.qpos), fps=self.fps)
        report = report | {"events": list(self.ctl.events), "controls": self.log["controls"],
                           "jaw_N_end": self.log["jaw_N"][-1] if self.log["jaw_N"] else 0.0,
                           "saw_end": {"head_deg": round(math.degrees(state["q"]["head"]), 3),
                                       "control": state["control"]}}
        self.export("bandsaw", NEVER_HELD, self.stock, glbs_in_bodies(m, "saw", SC.render_links()), report,
                    checks={"machine_axes": self.log["axes"], "driven": DRIVEN, "jaw_N": self.log["jaw_N"]})
        return json.loads((self.folder / "report.json").read_text(encoding="utf-8"))

    def go(self, seconds=None) -> dict:
        self.run(seconds, measure=self.measure)
        return {}


def run_load(replan=False, seconds=None) -> dict:
    out = plan.OUT["load"]
    if replan or not (out / "reference.npz").exists():
        plan.build("load")
    r = SawRun(out, SC.FRONT, SC.bar_body(SC.FRONT), None, carried=("bar",), grip_objects={"bar": ("bar",)},
               lifted=())
    r.go(seconds)
    s = SC.saw_state(r.model, r.data, r.ctl, r.place)["stock"]["bar"]
    end = s["centre"][1] - SC.bar_mm() / 2
    return r.finish({"bar_end_mm": round(end, 3), "to_stop_mm": round(end - SC.stop_face_y(), 3)})


def run_clamp(replan=False, seconds=None) -> dict:
    out = plan.OUT["clamp"]
    state = plan.state_of("load")
    if replan or not (out / "reference.npz").exists():
        plan.build("clamp")
    s = state["stock"]["bar"]
    r = SawRun(out, SC.END, SC.bar_body(SC.END, s["centre"], s["R"]), state, carried=("saw_handwheel",),
               grip_objects={"knob": ("saw_handwheel",)}, lifted=())
    r.go(seconds)
    return r.finish({"handwheel_turns": round((r.data.qpos[r.ctl.q["handwheel"]] - state["q"]["handwheel"])
                                              / (2 * math.pi), 3),
                     "jaw_closed_mm": round((r.data.qpos[r.ctl.q["jaw"]] - state["q"]["jaw"]) * 1000, 3)})


def run_start(replan=False, seconds=None) -> dict:
    """The controls' take, the same for every bar: from the part's clamp take (the first part's, as it is planned)."""
    out = plan.OUT["start"]
    state = plan.state_of("clamp")
    if replan or not (out / "reference.npz").exists():
        plan.build("start")
    s = state["stock"]["bar"]
    r = SawRun(out, SC.START, SC.bar_body(SC.START, s["centre"], s["R"]), state, carried=("saw_feed_valve",),
               grip_objects={"valve": ("saw_feed_valve",)}, lifted=())
    r.go(seconds)
    J = BS.record()["joints"]["feed_valve"]
    return r.finish({"valve_turned_deg": round(math.degrees(r.data.qpos[r.ctl.q["feed_valve"]]
                                                            - state["q"]["feed_valve"]), 2),
                     "feed_mm_s": round(r.ctl.feed_mm_s, 3), "mm_s_per_deg": J["mm_s_per_deg"]})


def cut_state() -> dict:
    """Where the cut starts: the part's bar and vise as its clamp take left them, the saw's head, valve, switchgear and
    blade as the controls' take left them (its own bar the first part's: the bow is still 170 mm over either)."""
    clamp, start = plan.state_of("clamp"), plan.state_of("start")
    return clamp | {"q": clamp["q"] | {k: start["q"][k] for k in ("head", "feed_valve", "cover_idler", "cover_drive")},
                    "control": start["control"], "blade_rad_s": start["blade_rad_s"]}


def cut(seconds: float | None = None) -> dict:
    """The machine's own work, without the person: the bar as the clamp left it, cut (the piece and the rest a kerf
    apart, saw_cell.cut_bodies); the head comes down on the feed the valve was opened to, and the blade stops at the
    end of the cut. Writes the saw's state for the unload and cut.npz, the cut as it ran (head, blade, the stock and
    the jaw's force on the rest, every 0.1 s), for the gate."""
    out = plan.OUT["cut"]
    out.mkdir(parents=True, exist_ok=True)
    state = cut_state()
    s = state["stock"]["bar"]
    m = mujoco.MjModel.from_xml_string(SC.standalone_xml(SC.FRONT, SC.cut_bodies(SC.FRONT, s["centre"], s["R"])))
    d = mujoco.MjData(m)
    ctl = BS.Control(m, d)
    SC.set_saw(m, d, ctl, state)
    mujoco.mj_forward(m, d)
    rec = {k: [] for k in ("t", "head_deg", "blade_sfpm", "jaw_N", "piece", "rest", "piece_R", "rest_R")}
    t, end_at, limit = 0.0, None, seconds or 600.0
    every = int(round(0.1 / m.opt.timestep))
    k = 0
    while t < limit and (end_at is None or t < end_at + CUT_EXTRA_S):
        ctl.step()
        t = d.time
        if end_at is None and "end_of_cut" in ctl.events:
            end_at = t
        if k % every == 0:
            ax = machine_axes(m, d, ctl)
            rec["t"].append(t)
            rec["head_deg"].append(ax["saw_head_deg"])
            rec["blade_sfpm"].append(ax["saw_blade_sfpm"])
            rec["jaw_N"].append(jaw_force(m, d, "rest"))
            for b in ("piece", "rest"):
                i = m.body(b).id
                rec[b].append(SC.FRONT.station(d.xpos[i] * 1000))
                rec[f"{b}_R"].append(d.xmat[i].reshape(3, 3).copy())
        k += 1
    np.savez(out / "cut.npz", **{k: np.array(v) for k, v in rec.items()})
    nxt = SC.saw_state(m, d, ctl, SC.FRONT)
    (out / "state.json").write_text(json.dumps(nxt, indent=1), encoding="utf-8")
    report = {"part": SC.STOCK["part"], "seconds": round(t, 1),
              "end_of_cut_s": None if end_at is None else round(end_at, 1),
              "events": list(ctl.events), "head_deg_end": round(rec["head_deg"][-1], 3),
              "blade_sfpm_end": round(rec["blade_sfpm"][-1], 2),
              "rest_moved_mm": round(float(np.linalg.norm(np.array(rec["rest"]) - rec["rest"][0], axis=1).max()), 4),
              "piece_moved_mm": round(float(np.linalg.norm(np.array(rec["piece"]) - rec["piece"][0], axis=1).max()), 4),
              "jaw_N_min": round(float(min(rec["jaw_N"])), 1)}
    (out / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    return report


def run_unload(replan=False, seconds=None) -> dict:
    out = plan.OUT["unload"]
    state = plan.state_of("cut")
    if replan or not (out / "reference.npz").exists():
        plan.build("unload")
    st = state["stock"]
    loose = "".join(SC.stock_body(b, SC.FRONT, st[b]["centre"], st[b]["R"], st[b]["length"]) for b in ("piece", "rest"))
    r = SawRun(out, SC.FRONT, loose, state, carried=("piece",), grip_objects={"top": ("piece",), "pinch": ("piece",)},
               lifted=("piece",))
    r.go(seconds)
    p = SC.saw_state(r.model, r.data, r.ctl, r.place)["stock"]
    return r.finish({"piece_end": p["piece"], "rest_end": p["rest"]})


def still(take: str, frame: int | None = None, out: Path | None = None, view_from=(-0.55, -0.55, 0.75)) -> Path:
    """A picture of the physics run at a frame (the middle by default), as MuJoCo draws it: its colliders, the body's
    capsules, the saw and the stock (the bow's boxes see-through), at the right hand from view_from (m, world). For
    review; the take's render is Blender's (moonshot/render/)."""
    folder = plan.OUT[take]
    xml = (folder / "physics.xml").read_text(encoding="utf-8")
    xml = xml.replace("<worldbody>", '<visual><global offwidth="1280" offheight="720"/></visual>\n  <worldbody>', 1)
    m = mujoco.MjModel.from_xml_string(xml)
    for g in range(m.ngeom):            # the bow's coarse boxes, which span its window, drawn see-through
        if m.body(m.geom_bodyid[g]).name in ("saw_head", "saw_cover_idler", "saw_cover_drive"):
            m.geom_rgba[g, 3] = 0.1
        elif m.body(m.geom_bodyid[g]).name in SC.STOCK_BODIES:
            m.geom_rgba[g] = (0.75, 0.75, 0.8, 1.0)
    m.vis.headlight.ambient[:], m.vis.headlight.diffuse[:] = 0.45, 0.6
    d = mujoco.MjData(m)
    qpos = np.load(folder / "physics.npz")["qpos"]
    k = len(qpos) // 2 if frame is None else frame
    d.qpos[:] = qpos[k]
    mujoco.mj_forward(m, d)
    r = mujoco.Renderer(m, 720, 1280)
    cam = mujoco.MjvCamera()
    hand = d.body("R_hand").xpos
    # from behind the person's left shoulder and above, looking at the right hand (the body faces +Y), by default
    view_from = np.asarray(view_from, float)
    cam.lookat[:] = hand
    cam.distance = float(np.linalg.norm(view_from))
    cam.azimuth = math.degrees(math.atan2(-view_from[1], -view_from[0]))
    cam.elevation = math.degrees(math.atan2(-view_from[2], math.hypot(*view_from[:2])))
    opt = mujoco.MjvOption()
    r.update_scene(d, cam, opt)
    from PIL import Image
    path = out or folder / f"physics-still-{k}.png"
    Image.fromarray(r.render()).save(path)
    return path


RUNS = {"load": run_load, "clamp": run_clamp, "start": run_start,
        "cut": lambda replan=False, seconds=None: cut(seconds), "unload": run_unload}


def main(argv: list[str]) -> int:
    """<part> <take>|all [--replan] [--seconds s]: a part's takes (all: its own, the controls' when it has none yet)."""
    plan.use_part(argv[0])
    which = argv[1] if len(argv) > 1 else "all"
    replan = "--replan" in argv
    seconds = float(argv[argv.index("--seconds") + 1]) if "--seconds" in argv else None
    order = [k for k in RUNS if k != "start" or not (plan.OUT["start"] / "state.json").exists()]
    for k in (order if which == "all" else [which]):
        print(k, json.dumps(RUNS[k](replan=replan, seconds=seconds), indent=1), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
