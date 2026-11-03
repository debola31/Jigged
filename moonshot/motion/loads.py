"""What a process plan's vise setup loads (plan §7): the part as it sits in the vise, the parallels under it and the
jaw opening to start from, placed as in the reference take (moonshot/world/vise.py REFERENCE).

A later setup loads a machined part. Until the stock-removal model (plan track E) hands each setup its part, a
machined part is loaded as its bounding box, from the part's finished size and what the earlier setups cut
(MACHINED_MM): a declared shortcut, sound where the vise touches it, since every face it rests or clamps on is
machined flat by then; the render draws its real shape.
"""
from __future__ import annotations

from moonshot.world.vise import REFERENCE, VISE, Load

AXIS = {"X": 0, "Y": 1, "Z": 2}
INCH = 25.4
# from the reference take: parallel a stands this far in from the fixed jaw, parallel b this far in from the part's
# near edge (so the part sits on both whether set down short or slid home), and the jaws start this much wider
# than the part
FIXED_TO_A = VISE["fixed_face_y"] - REFERENCE.parallels_y["para_a"]
NEAR_TO_B = REFERENCE.parallels_y["para_b"] - (VISE["fixed_face_y"] - REFERENCE.size_mm[1])
OPENING_MARGIN = REFERENCE.opening0 - REFERENCE.size_mm[1]
# each later setup's part as its bounding box, in the stock's axes (mm): nist-ftc-10 is 158 x 31 x 75 finished; Op 10
# profiles the outline and faces datum A 2 mm down, Op 20 faces it to its 31 mm
MACHINED_MM = {("nist-ftc-10", "op20"): (158.0, 36.1, 75.0), ("nist-ftc-10", "op30"): (158.0, 31.0, 75.0),
               ("nist-ftc-10", "op40"): (158.0, 31.0, 75.0)}


def vise_load(plan: dict, setup_id: str) -> Load:
    setups = plan["setups"]
    s = next(x for x in setups if x["id"] == setup_id)
    w = s["workholding"]
    if not w["parallels_in"]:
        raise NotImplementedError(f"{setup_id} stands on the vise floor against a stop; the take has no such load yet")
    size = plan["stock"]["size_mm"] if s is setups[0] else MACHINED_MM[(plan["part"], setup_id)]
    up, across = AXIS[s["face_up"][-1]], AXIS[w["jaw_on"][0]]
    along = ({0, 1, 2} - {up, across}).pop()
    width = float(size[across])
    fy = VISE["fixed_face_y"]
    return Load(size_mm=(float(size[along]), width, float(size[up])), parallel_h=w["parallels_in"] * INCH,
                parallels_y={"para_a": fy - FIXED_TO_A, "para_b": fy - width + NEAR_TO_B},
                opening0=width + OPENING_MARGIN)
