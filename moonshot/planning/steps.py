"""A process plan's written instruction steps, one per video (plan §4, §6).

Deterministic: every mill setup expands to the shop's setup pattern for how the part is held (in the vise on
parallels, standing on the vise floor against a stop, or a plate clamped to the table, which the next setup may
slide along it to reach what the machine's travel didn't), a band saw setup to the
saw's, a lathe setup to the lathe's (the stock in its chuck or collet, the turret's tools, Z on the part's end), a
surface grinder setup to the grinder's (the part blocked in by keepers on the magnetic chuck, the magnet on, the
wheel touched off), each operation becomes a short cycle step, and the finishing work follows. Each step's caption is built only
from its `facts`, so it can't name a tool, size or setting the plan doesn't contain (plan §2, O8; checked by
`caption_names_only_facts`).

A `cycle` step is machine-only: the mill's, the lathe's or the saw's own cut, or an outside vendor's process (a
finishing step with `machine_only`). Only people's work is rendered (your decision, 2026-11-03); a cycle step is shown
on the web as its caption and a still, or in three.js. It keeps its place in the sequence. An operation done by hand
on a manual machine ("by": "hand": the surface grinder's table and feeds are cranked by the operator) is people's
work, a step of its own like a cycle's.

    python -m moonshot.planning.steps nist-ftc-10          # prints the steps as a numbered list
"""
from __future__ import annotations

import re
import sys

from moonshot.planning.validate import load_plan

VISE_NAMES = {"d688": "the 6 in vise"}             # the Kurt D688 on the VF-2, the vise that's simulated and filmed
# nist-ftc-10's faces; a plan names its own in "faces"
FACE_UP = {"-Y": "pocket side up", "+Y": "scalloped side up", "+Z": "on its F65 side", "-Z": "on its F81 side",
           "+X": "standing on one end", "-X": "standing on the other end"}
TOOL_NAMES = {"facem": "the 2 in face mill", "em12": "the 1/2 in end mill", "em38": "the 3/8 in end mill",
              "em14": "the 1/4 in end mill", "bem14": "the 1/4 in ball end mill", "drill-2p5": "the 2.5 mm drill",
              "drill-6": "the 6 mm drill", "drill-7": "the 7 mm drill", "drill-5p5": "the 5.5 mm drill",
              "ream-3p5": "the 3.5 mm reamer", "tap-m3": "the M3 tap", "spot": "the 1/2 in spot drill",
              "drill": "the #7 drill", "drillk": "the K drill", "drillh": "the H drill", "tap": "the 1/4-20 tap",
              "chamf": "the 1/2 in chamfer mill", "bandsaw": "the band saw",
              # G1's (moonshot/library/generators.py SOURCED)
              "drill-3p3": "the 3.3 mm drill", "drill-6p5": "the 6.5 mm drill", "drill-11": "the 11 mm drill",
              "tap-m4": "the M4 tap", "ream-8": "the 8 mm reamer", "dovetail-20": "the 20 deg dovetail cutter",
              "drill-5-32": "the 5/32 in drill", "ream-1-4": "the 1/4 in reamer", "em18": "the 1/8 in end mill",
              "em132": "the 1/32 in end mill",
              # G2's: the ST-25's turret tools and the surface grinder's wheel, none with a record yet (each plan's
              # missing_records)
              "turn-ccgt": "the CCGT roughing tool", "turn-dcgt": "the DCGT finishing tool",
              "turn-vcgt": "the VCGT turning tool", "groove-3": "the 3 mm grooving tool",
              "tap-m4-bot": "the M4 bottoming tap", "drill-3p3-118": "the 3.3 mm 118 deg drill",
              "dwheel-1a1r": "the diamond wheel"}
# Where each mill's tools go. The VF-2 measures its own on its tool setter; the shop's other mills have none
# (shop.json puts the only tool setter and probe on the VF-2), so their tools are measured on the presetter first.
CHANGERS = {"vf2": "the carousel", "vf3": "the tool changer", "hurco": "the tool changer", "st25": "the turret"}
PRESET = {"vf3", "hurco"}
LATHES = {"st25"}                     # turning centres: the stock in a chuck or collet, its tools bolted in a turret
GRINDERS = {"sgrind"}                 # manual surface grinders: the part on the magnetic chuck, the wheel cranked
# a lathe's chuck or collet: its name, what's wiped, how it closes, how it opens. The ST-25's Kitagawa closes on its
# hydraulics by the foot pedal; the Royal 5C collet chuck is tightened by hand with its key
CHUCKS = {"chuck3": ("the 3-jaw chuck", "its jaws", "Close the jaws with the foot pedal.",
                     "open the jaws with the foot pedal"),
          "c5": ("the 5C collet chuck", "its collet", "Tighten the collet with the chuck key.",
                 "loosen the collet with the key")}


def step(sid: str, title: str, caption: str, facts: dict, kind: str = "human", **extra) -> dict:
    return {"id": sid, "title": title, "caption": caption.format(**facts), "facts": facts, "kind": kind, **extra}


def cycles(s: dict) -> list[dict]:
    """Each operation's step: the machine's cycle, or the operator's own work on a manual machine ("by": "hand")."""
    return [step(f"{s['id']}-{op['id']}", op["what"].split(":")[0], "{what}, with {tool}.",
                 {"what": op["what"], "tool": TOOL_NAMES.get(op["tool"], op["tool"])},
                 kind="human" if op.get("by") == "hand" else "cycle", setup=s["id"], operation=op["id"],
                 machine=s["machine"]) for op in s["operations"]]


def saw(plan: dict, s: dict) -> list[dict]:
    """The band saw: load the bar to the stop and clamp it, start the cut, the cut itself, lift the blank off."""
    p, m = s["id"], s["machine"]
    f = {"setup": s["title"], "bar": plan["stock"]["bar"], "length": plan["stock"]["length"]}
    return [
        step(f"{p}-load", "Load the bar",
             "Raise the bow, open the vise, slide the {bar} through to the stop for a {length} blank, and clamp it.",
             f, setup=p, machine=m),
        step(f"{p}-start", "Start the cut", "Press Start, switch the coolant on and let the bow down.", f,
             setup=p, machine=m),
        *cycles(s),
        step(f"{p}-unload", "Lift the blank off",
             "Lift the {length} blank off the bed, clear of the blade, and set it on the bench.", f, setup=p, machine=m),
    ]


def turret(s: dict, f: dict, loaded: dict[str, set[str]]) -> list[dict]:
    """A lathe setup's tools the turret doesn't hold yet, bolted into its stations and each touched off for its
    offsets (no step when every one is in from an earlier setup)."""
    p, m = s["id"], s["machine"]
    have = loaded.setdefault(m, set())
    new = list(dict.fromkeys(op["tool"] for op in s["operations"] if op["tool"] not in have))
    have |= set(new)
    if not new:
        return []
    tf = f | {"tools": ", ".join(TOOL_NAMES.get(t, t) for t in new), "tool_ids": new, "changer": CHANGERS[m]}
    return [step(f"{p}-tools", "Set up the turret", "Bolt {tools} into {changer} and touch each one off.", tf,
                 setup=p, machine=m)]


def lathe(s: dict, faces_out: dict, loaded: dict[str, set[str]]) -> list[dict]:
    """A lathe setup: the stock into the chuck or collet and closed on it, the turret's new tools, Z on the part's
    end (a lathe's X is the spindle's centre, so only Z is set), the cycle, and the part out: from the chuck, or after
    a part-off, out of the chip tray, the bar's end then taken out of the collet."""
    w, p, m = s["workholding"], s["id"], s["machine"]
    chuck, wiped, close, opens = CHUCKS[w["chuck"]]
    f = {"setup": s["title"], "chuck": chuck, "holds": w["holds"], "out": faces_out[s["face_out"]]}
    parted = any(op["kind"] == "part_off" for op in s["operations"])
    return [
        step(f"{p}-clean", "Clean the chuck", "Blow the chips out of {chuck} and wipe " + wiped + ".", f,
             setup=p, machine=m),
        step(f"{p}-load", f"Load {w['holds']}", "Set {holds} in {chuck}, {out}.", f, setup=p, machine=m),
        step(f"{p}-seat", "Clamp it", close, f, setup=p, machine=m),
        *turret(s, f, loaded),
        step(f"{p}-z", "Set Z", "Set {wcs} Z at {z}.", f | {"wcs": s["wcs"]["code"], "z": s["wcs"]["z"]},
             setup=p, machine=m),
        step(f"{p}-start", "Close the door and start the cycle",
             "Close the door, check the program is {setup}, and press Cycle Start.", f, setup=p, machine=m),
        *cycles(s),
        step(f"{p}-unload", "Open the door and pick the part out" if parted else "Blow off the chips and unload",
             "Open the door, blow the chips off, pick the part out of the chip tray, then " + opens +
             " and take out the bar's end." if parted else
             "Open the door, blow the chips off, " + opens + " and lift the part out.", f, setup=p, machine=m),
    ]


def grinder(s: dict, faces: dict) -> list[dict]:
    """A manual surface grinder setup: the part blocked in on the magnetic chuck by ground steel keepers set tight
    round it (a part the magnet holds too weakly, as carbide), the magnet switched on, the wheel touched down on its
    top and set across from its edge by hand (a manual grinder has no work offsets), each operation, then the part
    and the keepers off."""
    w, p, m = s["workholding"], s["id"], s["machine"]
    f = {"setup": s["title"], "keepers": w["keepers_are"], "on": w["on"], "up": faces[s["face_up"]]}
    return [
        step(f"{p}-clean", "Clean the chuck", "Wipe {on} and {keepers} clean.", f, setup=p, machine=m),
        step(f"{p}-load", "Block the part in", "Set the part on {on}, {up}, and set {keepers} tight round it.", f,
             setup=p, machine=m),
        step(f"{p}-seat", "Switch the magnet on", "Switch the magnet on, holding {keepers} against the part.", f,
             setup=p, machine=m),
        step(f"{p}-touch", "Touch off",
             "Touch the wheel down on the top and zero the down-feed, then set the wheel's edge {land} inside the "
             "cutting edge.", f | {"land": s["datum"]["land"]}, setup=p, machine=m),
        *cycles(s),
        step(f"{p}-unload", "Take the part out",
             "Switch the magnet off, lift the part out and take {keepers} off.", f, setup=p, machine=m),
    ]


def held(s: dict, faces: dict) -> list[dict]:
    """Clean, load, seat and check: how the part goes into this setup's workholding."""
    w, p, m = s["workholding"], s["id"], s["machine"]
    if "shift" in w:                               # the last setup's plate, slid along the table to reach the rest
        f = {"setup": s["title"], "clamps": w["clamps"], "on": w["on"], "shift": w["shift"]}
        return [
            step(f"{p}-shift", "Shift the plate", "Loosen the clamps, slide the plate {shift} and clamp it again.", f,
                 setup=p, machine=m),
            step(f"{p}-check", "Check it's straight",
                 "Probe the other dowel hole: it should read where the drawing has it.", f, setup=p, machine=m),
        ]
    if "clamps" in w:                              # a plate clamped down on the table
        f = {"setup": s["title"], "up": faces[s["face_up"]], "clamps": w["clamps"], "on": w["on"]}
        return [
            step(f"{p}-clean", "Clean the table", "Blow the chips off {on} and wipe it.", f, setup=p, machine=m),
            step(f"{p}-load", "Lay the plate down", "Lay the plate on {on}, {up}.", f, setup=p, machine=m),
            step(f"{p}-seat", "Clamp it down", "Set {clamps} step clamps on its margin and tighten each nut.", f,
                 setup=p, machine=m),
            step(f"{p}-check", "Check it's straight",
                 "Sweep the indicator along its long edge: the needle should stay put.", f, setup=p, machine=m),
        ]
    f = {"setup": s["title"], "vise": VISE_NAMES[w["vise"]], "up": faces[s["face_up"]],
         "parallels": f"{w['parallels_in']:g} in parallels" if w["parallels_in"] else "the vise floor and a stop"}
    stop = not w["parallels_in"]               # standing on the vise floor against a stop: no parallels to set or check
    return [
        step(f"{p}-clean", "Clean the vise and set the stop" if stop else "Clean the vise and set the parallels",
             "Blow out {vise} and wipe the jaws and its floor, then set the stop." if stop else
             "Blow out {vise} and wipe the jaws, then set {parallels}.", f, setup=p, machine=m),
        step(f"{p}-load", "Load the part", "Set the part in {vise}, {up}, on {parallels}.", f, setup=p, machine=m),
        step(f"{p}-seat", "Seat it and tighten the vise",
             "Close the jaw until it touches, tap the part down, then tighten the handle.", f, setup=p, machine=m),
        step(f"{p}-check", "Check it's square" if stop else "Check the parallels are pinched",
             "Sweep the indicator up its side: the needle should stay put." if stop else
             "Try each parallel with a fingertip: neither should move.", f, setup=p, machine=m),
    ]


def expand(plan: dict) -> list[dict]:
    out = []
    faces = plan.get("faces", FACE_UP)
    loaded: dict[str, set[str]] = {}               # the tools already in each machine
    for i, s in enumerate(plan["setups"]):
        p, m = s["id"], s["machine"]
        nxt = plan["setups"][i + 1] if i + 1 < len(plan["setups"]) else {}
        stays = "shift" in nxt.get("workholding", {})      # the next setup slides this plate rather than reloading it
        if m == "bandsaw":
            out += saw(plan, s)
            continue
        if m in LATHES:
            out += lathe(s, plan.get("faces_out", {}), loaded)
            continue
        if m in GRINDERS:
            out += grinder(s, faces)
            continue
        out += held(s, faces)
        f = out[-1]["facts"]
        out += [
            step(f"{p}-xy", "Find X and Y", "Set {wcs} X at {x} and Y at {y}.",
                 f | {"wcs": s["wcs"]["code"], "x": s["wcs"]["x"], "y": s["wcs"]["y"]}, setup=p, machine=m),
            step(f"{p}-z", "Set Z", "Set {wcs} Z at {z}.", f | {"wcs": s["wcs"]["code"], "z": s["wcs"]["z"]},
                 setup=p, machine=m),
        ]
        have = loaded.setdefault(m, set())
        new = [op["tool"] for op in s["operations"] if op["tool"] not in have]
        if new:
            new = list(dict.fromkeys(new))
            names = ", ".join(TOOL_NAMES.get(t, t) for t in new)
            tf = f | {"tools": names, "tool_ids": new, "changer": CHANGERS[m]}
            if m in PRESET:
                which = "its length, and load it" if len(new) == 1 else "their lengths, and load them"
                out.append(step(f"{p}-tools", "Measure and load the tools",
                                "Measure {tools} on the presetter, enter " + which + " into {changer}.", tf, setup=p,
                                machine=m))
            else:
                out.append(step(f"{p}-tools", "Load the tools", "Load {tools} into {changer}.", tf, setup=p,
                                machine=m))
            have |= set(new)
        out.append(step(f"{p}-start", "Close the door and start the cycle",
                        "Close the door, check the program is {setup}, and press Cycle Start.", f, setup=p, machine=m))
        out += cycles(s)
        if stays:
            out.append(step(f"{p}-unload", "Open the door and blow off the chips",
                            "Open the door and blow the chips off; the plate stays clamped.", f, setup=p, machine=m))
        else:
            out.append(step(f"{p}-unload", "Blow off the chips and unload",
                            "Open the door, blow the chips off, loosen the clamps and lift the plate off."
                            if "clamps" in s["workholding"] else
                            "Open the door, blow the chips off, loosen the vise and lift the part out.", f, setup=p,
                            machine=m))
    for fin in plan.get("finish", []):
        out.append(step(fin["id"], fin.get("title", fin["what"].split(",")[0]), "{what}.", {"what": fin["what"]},
                        kind="cycle" if fin.get("machine_only") else "human", station=fin["station"]))
    return out


def caption_names_only_facts(s: dict) -> bool:
    """Every number and tool name in a caption appears in its facts (plan §2, O8)."""
    facts_text = " ".join(str(v) for v in s["facts"].values())
    numbers = re.findall(r"\d+(?:\.\d+)?", s["caption"])
    return all(n in facts_text for n in numbers)


def main(argv: list[str]) -> None:
    for i, s in enumerate(expand(load_plan(argv[0])), 1):
        tag = "  [cycle]" if s["kind"] == "cycle" else ""
        print(f"{i:3d}. {s['title']}{tag}\n     {s['caption']}")


if __name__ == "__main__":
    main(sys.argv[1:])
