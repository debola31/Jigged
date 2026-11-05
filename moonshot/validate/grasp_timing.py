"""Grasp timing (plan §5.2): each reach to grasp lasts as long as people's do, and each lift's preload (grip rising,
no load yet) and loading (load rising to the object's weight) last as long as Guillery 2013 measured.

A reach is the hand's movement onset (its speed rising past person.movement_onset_frac of the reach's peak) to its
first contact with the object a grasp closes on. A lift's phases start at that contact: loading starts when the
hand's lifting force passes person.force_onset_frac of the object's weight, and ends at lift-off, the object
person.lift_off_mm above where it sat. The lifting force comes from the physics run (checks.json load_N).

A take that isn't the vise's is read from its record (moonshot/validate/objects.py): either hand's grips, each on
the object its grip event names, and only those that take it up (the hand carries it) from rest: a steadying hand's
press on the part, as the vise take's presses, and taking a tool from the other hand, aren't reaches to grasp as
people's were measured, nor lifts. A left hand's reach is held to people's left hands
(person.reach_to_grasp_left_s): both arms are checked (your decision, 2026-11-03). Its contact is the first frame a hand touches the object or carries
it (a carried tool leaves the skin, so the carry can close before a finger meets it), as the cause check reads
touching: validate/take.py gives every check the one `touching`, and with right-hand touches alone the cause check
found the left hand's work uncaused.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from moonshot.contracts.thresholds import threshold
from moonshot.validate import objects
from moonshot.validate.registry import Result, check

# the grips that close the hand round an object, and that object; presses and fingertip touches aren't grasps. A door
# take's hand wraps its door's handle bar (moonshot/motion/door_cycle.py), closing it or opening it
BARS = {"door_left": "vf2_door_left_pull", "door_right": "vf2_door_right_pull",
        "open_left": "vf2_door_left_pull", "open_right": "vf2_door_right_pull"}
GRASPS = {"blank_faces": "blank", "knob": "knob"} | BARS
LIFTED = {"blank"}
LEAD_S = 0.5                    # a grasp's contact may come this long before its planned grip starts


def hand_speed(W_mm: np.ndarray, fps: float) -> np.ndarray:
    return np.linalg.norm(np.gradient(W_mm, 1 / fps, axis=0), axis=1)


def reaches(speed: np.ndarray, touching: list[list[str]], obj: str, grasping, fps: float) -> list[tuple[int, int]]:
    """(onset, contact) frames of each reach to grasp obj: contact is the first frame the hand touches obj after
    LEAD_S off it (a contact flickering for a frame isn't a new reach), while a grasp of it is planned; onset the last
    frame before the reach's peak speed (in the 2 s before contact) slower than person.movement_onset_frac of it."""
    frac, off = threshold("person.movement_onset_frac").value, int(LEAD_S * fps)
    out = []
    for k in range(1, len(touching)):
        if obj in touching[k] and grasping[k] and not any(obj in t for t in touching[max(0, k - off):k]):
            start = max(0, k - int(2 * fps))
            peak = start + int(np.argmax(speed[start:k]))
            slow = np.flatnonzero(speed[start:peak + 1] <= frac * speed[peak])
            out.append((start + int(slow[-1]) if slow.size else start, k))
    return out


def intervals(events: list[dict], kind: str) -> list[dict]:
    """A take's intervals of one kind. take.json stores each as one event, or as an opening (t1 None) and a later
    closing (t0 None) event, paired in order as the physics run pairs them; one never closed lasts to the end."""
    out, opened = [], []
    for e in events:
        if e["kind"] != kind:
            continue
        if e["t0"] is not None and e["t1"] is not None:
            out.append(dict(e))
        elif e["t0"] is not None:
            opened.append(dict(e))
        else:
            start = opened.pop(0)
            start["t1"] = e["t1"]
            out.append(start)
    return out + opened


def _from_record(take: Path, tk: dict, ck: dict) -> dict:
    rec = np.load(take / "take.npz")
    fps, t, at = float(rec["fps"]), rec["t"], objects.positions(take)
    lift = threshold("person.lift_off_mm").value
    grasping: dict[str, np.ndarray] = {}
    hand: dict[str, str] = {}
    carried = {(e["obj"], e.get("side", "R")) for e in tk["events"] if e["kind"] == "carry"}
    for e in intervals(tk["events"], "grip"):
        obj, side = e.get("on"), e.get("side")
        if side not in ("R", "L") or obj not in at or (obj, side) not in carried:   # a press holding the part down
            continue
        k0 = min(len(t) - 1, int(round(e["t0"] * fps)))
        if at[obj][k0, 2] > at[obj][0, 2] + lift:                   # already up: taken from the other hand
            continue
        t1 = e["t1"] if e["t1"] is not None else t[-1]
        grasping[obj] = grasping.get(obj, np.zeros(len(t), bool)) | ((t >= e["t0"] - LEAD_S) & (t <= t1))
        hand[obj] = side
    lifted = [o for o in grasping if o in ck.get("load_N", {})]
    out = {"fps": fps, "hand_speed_mm_s": hand_speed(rec["R_W"], fps).tolist(),
           "touching": objects.touched(take, ck["touching"], objects.carried(ck["active_constraints"])),
           "grasping": {k: v.tolist() for k, v in grasping.items()},
           "height_mm": {o: at[o][:, 2].tolist() for o in lifted}, "weight_N": {o: ck["weight_N"][o] for o in lifted},
           "load_N": ck.get("load_N", {}), "touch_lead": objects.touch_leads(take, ck["touch_lead"])}
    if "L" in hand.values():
        out |= {"hand": {o: s for o, s in hand.items() if s == "L"},
                "hand_speed_L_mm_s": hand_speed(rec["L_W"], fps).tolist()}
    return out


def measure(take: Path) -> dict:
    """What the check reads, from a physics run: a vise take's own keys, or any other take's record. A run with the
    vise's keys and two hands (the door takes') times the left hand's reaches (its grip events' side) on its own
    speed (sim.npz W_L)."""
    from moonshot.world import vise as V
    sim = np.load(take / "sim.npz")
    tk = json.loads((take / "take.json").read_text(encoding="utf-8"))
    ck = json.loads((take / "checks.json").read_text(encoding="utf-8"))
    if not objects.is_vise(sim):
        return _from_record(take, tk, ck)
    fps, t = float(sim["fps"]), sim["t"]
    grasping: dict[str, np.ndarray] = {}
    left = {}
    for e in intervals(tk["events"], "grip"):
        if e.get("grip") in GRASPS:
            obj, t1 = GRASPS[e["grip"]], e["t1"] if e["t1"] is not None else t[-1]
            grasping[obj] = grasping.get(obj, np.zeros(len(t), bool)) | ((t >= e["t0"] - LEAD_S) & (t <= t1))
            if e.get("side") == "L":
                left[obj] = "L"
    load = V.Load.from_json(tk["load"]) if "load" in tk else V.REFERENCE
    out = {"fps": fps, "hand_speed_mm_s": hand_speed(sim["W"], fps).tolist(), "touching": ck["touching"],
           "grasping": {k: v.tolist() for k, v in grasping.items()}, "height_mm": {"blank": sim["blank"][:, 2].tolist()},
           "weight_N": {"blank": load.mass_kg * 9.81}, "touch_lead": ck["touch_lead"]}
    if left:
        out |= {"hand": left, "hand_speed_L_mm_s": hand_speed(sim["W_L"], fps).tolist()}
    if "load_N" in ck:
        out["load_N"] = ck["load_N"]
    return out


def hand_of(take: dict, obj: str) -> tuple[str, np.ndarray]:
    """The hand a grasp is the work of (take's `hand`: {object: "L"}; the right when absent), and its speed."""
    side = take.get("hand", {}).get(obj, "R")
    return side, np.asarray(take["hand_speed_mm_s" if side == "R" else "hand_speed_L_mm_s"], float)


@check("grasp_timing",
       good=["good/grasp_timing_people.json", "good/grasp_timing_left_hand.json"],
       bad=["bad/grasp_timing_slow_reach.json", "bad/grasp_timing_long_preload.json",
            "bad/grasp_timing_left_slow_reach.json"])
def grasp_timing(take: dict) -> Result:
    """take: {"fps", "hand_speed_mm_s", "touching": per frame, "grasping": {object: per frame, a grasp planned},
    "height_mm": {lifted object: per frame}, "load_N": {lifted object: per-frame lifting force}, "weight_N"}, and
    for the left hand's grasps "hand" ({object: "L"}) and "hand_speed_L_mm_s": each reach is held to its own hand's
    people (person.reach_to_grasp_left_s, _right_s), the lift's phases to everyone's."""
    fps = float(take["fps"])
    if not len(take["hand_speed_mm_s"]):
        raise ValueError("a take with no frames can't pass a per-frame check")
    reach = {"R": threshold("person.reach_to_grasp_right_s").band, "L": threshold("person.reach_to_grasp_left_s").band}
    phases = {"preload_ms": threshold("person.grasp_preload_ms").band,
              "loading_ms": threshold("person.grasp_loading_ms").band}
    onset, lift = threshold("person.force_onset_frac").value, threshold("person.lift_off_mm").value
    found, outside = [], []
    for obj, grasping in take["grasping"].items():
        side, speed = hand_of(take, obj)
        bands = {"reach_s": reach[side]} | phases
        for start, contact in reaches(speed, take["touching"], obj, grasping, fps):
            g = {"object": obj, "hand": side, "contact_frame": contact, "reach_s": round((contact - start) / fps, 3)}
            if obj in take["height_mm"]:
                z = np.asarray(take["height_mm"][obj], float)[contact:]
                lifted = np.flatnonzero(z > z[0] + lift)
                loading = np.flatnonzero(np.asarray(take["load_N"][obj], float)[contact:] >= onset * take["weight_N"][obj])
                if not (lifted.size and loading.size):
                    outside.append(f"{obj}@{contact} never lifted")
                else:
                    g["preload_ms"] = round(1000 * loading[0] / fps)
                    g["loading_ms"] = round(1000 * (lifted[0] - loading[0]) / fps)
            found.append(g)
            outside += [f"{obj}@{contact} {k} {g[k]}" for k, (lo, hi) in bands.items() if k in g and not lo <= g[k] <= hi]
    if not found:
        raise ValueError("no grasp to time: the hand never closed on what the take grasps")
    return Result(passed=not outside, worst=float(len(outside)), detail={"grasps": found, "outside": outside})
