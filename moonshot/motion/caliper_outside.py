"""A part's size checked with the 6 in calipers' outside jaws, planned as a two-handed take at the inspection bench
(plan §5.4): G1's inspect steps whose caption's first check is a size (ll-1007223's "the 75, 49 and 40 sizes with
the calipers": its 75). Each part's take is its Job.

The finished part lies on its mat as it was deburred, its length along the world's X, and the calipers face up at the
station's rest to its left (moonshot/motion/inspect.py: their jaws to the right). The left hand fetches them by the
beam's end as nist-ftc-10's inspect take does, and carries them, still face up, to the part's near side, the jaws
pointing away from the operator at the height they will close on, clear of its ends. The right hand takes the slider:
the thumb on the roller's near end, the index and middle under it. It opens the jaws past the part; both hands carry
them in, round its two ends; the left brings the fixed jaw onto the right end and the right closes the moving jaw onto
the left one, each pushing lightly (the card's 1-2 N). They are read, opened, brought off the end, drawn back and
closed; the right lets go and the left lays them where they lay. Face up the whole time, the display is read as they
hang there, and no hand turns them: the depth take's turn onto their end took the left forearm to people's limit.

    python -m moonshot.motion.caliper_outside <part>    # -> <data root>/takes/<part>-inspect: reference.npz, take.json
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.config import data_root
from moonshot.motion import grasp as G
from moonshot.motion import inspect as I
from moonshot.motion.bench import (CLOSE_S, REACH_S, RISE_S, STILL_S, BenchPlan, bands, bench_box, box,
                                   instrument_colliders, part_at, settle)
from moonshot.world import bench_cell as BC

SQUEEZE_N = 1.5              # each jaw's push on its end: the card's 1-2 N (proposed), the maker's "no excessive force"
OVERTRAVEL = 0.3             # the slider planned this far past the part's end; the part stops it
OPEN_MM = 8.0                # the jaws opened this far past the part before they go round it
CLEAR_MM = 3.0               # ... the fixed jaw this far right of the part's right end as they go round it and come off
FRONT_MM = 24.0              # the jaws carried in from this far in front of where they close
LIFT_N = I.LIFT_N            # the thumb's push closing the slider again, up its 2 N drag
SHUT_MM = I.SHUT_MM
SLIDER_EFFORT = I.SLIDER_EFFORT
SET_DOWN_MM = I.SET_DOWN_MM
JAW_MID = np.array([-108.2, -28.0, 4.25])    # the fixed jaw's measuring face, halfway along the moving jaw's reach and
                                             # through the jaws' thickness, in the calipers' frame (mm)
SLIDE_GRIP = np.array([-75.0, 10.0, 0.0])    # the right hand's grip on the slider, in its frame (mm)
CRADLE_GRIP = np.array([95.0, 9.75, 4.25])   # the left hand's under the beam's far end, in the calipers' frame (mm)
I.GRIP_AT.setdefault("slide", SLIDE_GRIP)    # let_go's and retake's way back along the forearm
I.GRIP_AT.setdefault("cradle", CRADLE_GRIP)
CARD = I.CARD                                # the caliper card, as the depth take plays it


@dataclass(frozen=True)
class Job:
    """One part's outside-jaw check: the part as it lies (its STEP origin at at_xy, its record's size read along the
    world's X, its right end the face at the size's +end), and where on its right end the jaws close (the part's frame):
    the jaws' height and how far in from its near face."""
    part: BC.BenchPart
    size: float
    right_end: tuple
    at_xy: tuple


JOBS = {"ll-1007223": Job(
    BC.LL_1007223, 75.0,
    # on the stem's two ends, 30 mm over the mat: over the near side's steps (to 20 mm), and there the jaws' 20 mm
    # reach takes the stem's 11 mm; held at its bar (under 10 mm), the slider sat on the mat and no finger fitted under
    right_end=(29.5, 10.0, 37.5),
    # right of where it is deburred: the hand on the slider in front of the body, the calipers clear of the micrometer
    at_xy=(60.0, -110.0))}


def out(part: str) -> Path:
    return data_root() / "takes" / f"{part}-inspect"


def loose(job: Job) -> str:
    at = part_at(job.part, job.at_xy)
    lo = np.min([b[0] for b in job.part.boxes.values()], axis=0)
    hi = np.max([b[1] for b in job.part.boxes.values()], axis=0)
    w, x, y, z = job.part.up
    mid = at + Rotation.from_quat([x, y, z, w]).as_matrix() @ ((lo + hi) / 2)
    return BC.mat_body(mid) + BC.part_body(at, job.part) + BC.caliper_body(BC.rest_mm("cal6"), I.CAL_YAW)


class OutsidePlan(I.InspectPlan):
    def __init__(self, job: Job, verbose=True):
        BenchPlan.__init__(self, out(job.part.name), verbose)
        self.job, self.bench_part = job, job.part
        rest = self.rests = settle(loose(job), skip=("cal6",))
        self.part, self.cal0 = rest["part"], rest["insp_cal6"]
        for body in ("insp_cal6_slider", "insp_cal6"):
            self.paths[body] = [(0.0, self.cal0[1], self.cal0[0])]
        self.solve_grips(self.grip_specs(), rest | {"insp_cal6_slider": self.cal0})

    # --- where the calipers are --------------------------------------------------------------------------------------
    def measuring(self):
        """The calipers' pose (closed) as they close on the part: face up, the beam along the world's X, the fixed
        jaw's measuring face on the part's right end where the job says. (origin, rotation)"""
        R = Rotation.from_euler("z", I.CAL_YAW, degrees=True).as_matrix()
        return self.to_world(self.job.right_end) - R @ JAW_MID, R

    def opened(self, p, s):
        """The slider's pose with the calipers' at p (measuring's rotation), opened s mm."""
        _, R = self.measuring()
        return p + R @ np.array([s, 0.0, 0.0])

    def place(self, t0, t1, p, s):
        """Plan the calipers to origin p, opened s, over [t0, t1]."""
        _, R = self.measuring()
        self.move("insp_cal6", t0, t1, R, p)
        self.move("insp_cal6_slider", t0, t1, R, self.opened(p, s))

    def front(self):
        p, R = self.measuring()
        return p + np.array([CLEAR_MM, -FRONT_MM, 0.0]), R

    # --- grips ------------------------------------------------------------------------------------------------------
    def grip_specs(self) -> dict:
        S = lambda *a: list(a) + [0.0, 0.0]               # noqa: E731  (trunk 3, arm 7, girdle 2)
        bc, bh = bench_box()
        C = BC.CAL
        ro = C["roller"]
        fp, Rf = self.front()
        cols = (self.cal_colliders((fp, Rf)) + self.part_colliders() + [box(bc, bh)]
                + instrument_colliders(self.rests, ("mic1", "thread"), 3.0))
        q0 = self.hand.neutral()
        q0.update(index_mcp_flex=45, index_pip=55, middle_mcp_flex=45, middle_pip=55, ring_mcp_flex=55, ring_pip=65,
                  little_mcp_flex=60, little_pip=70, thumb_cmc_abd=35, thumb_cmc_flex=15, thumb_mcp_flex=20, thumb_ip=15)
        # the thumb on the roller's near end, 1 mm in (the depth take's), the index and middle under the slider
        thumb_at = self.cal_point([ro["at"][0], ro["at"][1] + ro["half"], ro["at"][2]], (fp, Rf))
        under = lambda x: self.cal_point([x, 8.0, C["slider"][0][2]], (fp, Rf))     # noqa: E731
        slide = dict(of="insp_cal6_slider", at=(fp, Rf), obj=fp, q0=q0, iters=1000, colliders=cols,
                     targets={"thumb": G.plane_target(thumb_at, -Rf[:, 1], 1.0, bands(thumb_at, x=(-3, 3), z=(-3, 3))),
                              "index": G.plane_target(under(-88.0), -Rf[:, 2], 2.0,
                                                      bands(under(-88.0), x=(-5, 5), y=(-8, 8))),
                              "middle": G.plane_target(under(-70.0), -Rf[:, 2], 2.0,
                                                       bands(under(-70.0), x=(-5, 5), y=(-8, 8)))},
                     starts=[S(20, 0, r, 50, 40, sr, 90, pr, 0, 0) for pr in (30, 60) for sr in (-10, 15)
                             for r in (0,)])
        # the left hand under the beam's far end as they hang, palm up, thumb on top, as a ruler's end is held: the
        # beam grip it fetches them with, its palm down on the display's face, took the forearm past people's turn for
        # 316 frames held, and the arm let them sag 14 mm
        top = lambda x: self.cal_point([x, 9.75, C["beam"][1][2]], (fp, Rf))        # noqa: E731
        bottom = lambda x: self.cal_point([x, 9.75, C["beam"][0][2]], (fp, Rf))     # noqa: E731
        cradle = dict(side="L", of="insp_cal6", at=(fp, Rf), obj=fp, q0=q0, iters=1000, weights=(3.0, 3.0),
                      colliders=cols,
                      targets={"thumb": G.plane_target(top(98.0), Rf[:, 2], 1.0, bands(top(98.0), x=(-6, 6), y=(-5, 5))),
                               "index": G.plane_target(bottom(102.0), -Rf[:, 2], 1.0,
                                                       bands(bottom(102.0), x=(-5, 5), y=(-6, 6))),
                               "middle": G.plane_target(bottom(88.0), -Rf[:, 2], 1.0,
                                                        bands(bottom(88.0), x=(-5, 5), y=(-6, 6)))},
                      starts=[S(20, 0, r, 40, 30, sr, 90, pr, 0, 0) for pr in (-40, 0) for sr in (-20, 10)
                              for r in (0,)])
        return {"beam": I.InspectPlan.grip_specs(self)["beam"], "slide": slide, "cradle": cradle}

    # --- the verbs ------------------------------------------------------------------------------------------------
    def carry_over(self):
        """The left carries them, face up and closed, over to the part's near side, the jaws clear of its ends."""
        t0 = self.t
        fp, R = self.front()
        self.look(t0, self.to_world(self.job.right_end))
        self.place(t0, t0 + 1.5, fp + [0, 0, 40], 0.0)          # over, high: past the micrometer
        self.place(t0 + 1.5, t0 + 2.2, fp, 0.0)
        self.t_front = t0 + 2.2
        self.clip("carry", t0, self.t_front, "CARRY  the calipers to the part, jaws toward it")

    def take_slider(self):
        """The right hand up from the thigh, still, then onto the slider (BenchPlan.reach), once they are there."""
        fp, _ = self.front()
        _, Ws = self.grip_pose("slide", self.t_front)
        tS = self.reach("R", "slide", self.t_front + 0.3 - (RISE_S + STILL_S + REACH_S + CLOSE_S),
                        ready=Ws + [60, -150, 60], approach=Ws + [0, -40, 30], opened=0.6)
        self.effort("R", tS, 0.0, "slide")
        self.effort("R", tS + 0.2, SLIDER_EFFORT, "slide")
        self.t_slide = tS
        self.clip("slider", self.t_front, tS + 0.3, "SLIDER  the right thumb on the roller")
        # the right holding them by the slider, the left lets go of the beam's face and takes its end from under
        fp, R = self.front()
        t_rel = tS + 0.3
        self.let_go("beam", self.t_beam, t_rel, lifted=self.t_lift, relax=None, wait=0.15, away=(0.0, 0.0, 30.0))
        self.look(t_rel, self.cal_point(I.BEAM_GRIP, (fp, R)))
        self.t_cradle = self.retake("cradle", t_rel + 0.65)
        self.t = self.t_cradle + 0.3
        self.clip("hold", t_rel, self.t, "HOLD  the left hand takes the beam's end from under")

    def measure(self):
        """Open past the part, in round its ends, the fixed jaw onto the right end and the moving one closed onto the
        left, read; open, off, out, closed. The right hand lets go."""
        size = self.job.size
        fp, R = self.front()
        pm, _ = self.measuring()
        p_in = pm + [CLEAR_MM, 0.0, 0.0]
        wide = size + OPEN_MM
        t0 = self.t
        self.look(t0, self.cal_point([-80.0, 10.0, 12.5], (fp, R)))         # the display
        # opened at 30 mm/s, and all the way before they go in: at 60 mm/s the hand lagged it 24 mm short, and going
        # in, the moving jaw met the part's near face
        t_open = t0 + 0.3 + wide / 30.0
        self.move("insp_cal6_slider", t0 + 0.3, t_open, R, self.opened(fp, wide))
        self.look(t_open, self.to_world(self.job.right_end))
        t_open += 0.4
        t_in = t_open + 0.9
        self.place(t_open + 0.1, t_in, p_in, wide)                           # in round the ends
        t_on = t_in + 0.5
        self.place(t_in + 0.1, t_on, pm, wide)                               # the fixed jaw onto the right end
        t_shut = t_on + 0.2 + OPEN_MM / 12.0                                 # closed onto the left at 12 mm/s
        self.move("insp_cal6_slider", t_on + 0.2, t_shut, R, self.opened(pm, size - OVERTRAVEL))
        right_n = self.to_world([0.0, 0.0, 1.0], vec=True)                   # the right end's outward normal
        t_read = t_shut + 1.0                                                # settled, as the depth take's
        self.look(t_shut, self.cal_point([-80.0, 10.0, 12.5], (pm, R)))
        t_done = t_read + 1.2
        self.read = [t_read, t_done - 0.2]
        self.event("press", t_on - 0.1, t_done, side="L", normal=right_n.tolist(), force=SQUEEZE_N, contact="part",
                   at="cal6_jaw_out")
        self.event("press", t_shut - 0.3, t_done, side="R", normal=(-right_n).tolist(), force=SQUEEZE_N,
                   contact="part", at="cal6_mjaw_out")
        self.clip("measure", t0, t_done, "MEASURE  the jaws closed on the part's ends, light and square, and read")
        # off again: opened, the fixed jaw off its end, drawn back, closed by a push of the thumb
        t_free = t_done + 0.5
        self.move("insp_cal6_slider", t_done, t_free, R, self.opened(pm, size + CLEAR_MM))
        self.place(t_free + 0.1, t_free + 0.4, p_in, size + CLEAR_MM)
        t_back = t_free + 1.2
        self.place(t_free + 0.4, t_back, fp, size + CLEAR_MM)
        t_shut2 = t_back + 0.3 + (size + CLEAR_MM) / 30.0
        self.move("insp_cal6_slider", t_back + 0.3, t_shut2, R, self.opened(fp, -SHUT_MM))
        self.event("press", t_back + 0.3, t_shut2, side="R", normal=(-right_n).tolist(), force=LIFT_N,
                   contact="insp_cal6", at="cal6_slider")
        # closed, the left lets go of the end and takes the beam's face again, to lay them down; then the right lets go
        t_rel = t_shut2 + 0.2
        self.let_go("cradle", self.t_cradle, t_rel, relax=None, wait=0.15, away=(0.0, 0.0, -30.0))
        self.t_beam = self.retake("beam", t_rel + 0.65)
        t_off = self.t_beam + 0.3
        self.effort("R", t_shut2, SLIDER_EFFORT, "slide")
        self.effort("R", t_off, 0.0, "slide")
        W = self.let_go("slide", self.t_slide, t_off, relax=2.0, effort=0.0, wait=0.025, release=0.15)
        self.transit("R", t_off + 0.6, t_off + 1.2, W + [0, -230, 60])
        self.transit("R", t_off + 1.2, t_off + 1.4, W + [0, -230, 60])
        self.transit("R", t_off + 1.4, t_off + 2.0, self.rest)
        self.t = t_off
        self.clip("close", t_done, t_off, "CLOSE  opened off the part, drawn back and closed")

    def put_back(self):
        """The left carries them back, high over the micrometer, lays them where they lay, lets go and goes."""
        fp, R = self.front()
        p0, R0 = self.cal0
        t0 = self.t
        self.look(t0 + 0.4, p0)
        self.move_cal(t0 + 0.4, t0 + 1.2, R, fp + [0, 0, 40])
        self.move_cal(t0 + 1.2, t0 + 2.6, R0, p0 + [0, 0, 30])
        t_down = t0 + 3.0
        self.move_cal(t0 + 2.6, t_down, R0, p0 + [0, 0, SET_DOWN_MM])
        t_off = t_down + 0.1
        W = self.let_go("beam", self.t_beam, t_off)
        self.transit("L", t_off + 0.7, t_off + 1.85, self.rest, via=[W + [0, 0, 80], W + [0, -230, 60]])
        self.t = t_off + 1.85
        self.clip("put back", t0, self.t, "PUT BACK  the calipers, closed, where they lay")

    def compose(self):
        self.t = 0.5
        self.fetch()
        self.carry_over()
        self.take_slider()
        self.measure()
        self.put_back()


def build(part: str, solve=True, verbose=True) -> OutsidePlan:
    job = JOBS[part]
    plan = OutsidePlan(job, verbose=verbose)
    plan.compose()
    if solve:
        plan.solve()
        plan.save({"part": part, "read": plan.read, "size_mm": job.size,
                   "part_at": part_at(job.part, job.at_xy).tolist(), "cal_yaw": I.CAL_YAW, "loose": loose(job),
                   "card": CARD})
    return plan


if __name__ == "__main__":
    build(sys.argv[1])
