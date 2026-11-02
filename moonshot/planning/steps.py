"""A process plan's written instruction steps, one per video (plan §4, §6).

Deterministic: every VF-2 setup expands to the shop's setup pattern, each operation becomes a short cycle step, and
the finishing work follows. Each step's caption is built only from its `facts`, so it can't name a tool, size or
setting the plan doesn't contain (plan §2, O8; checked by `caption_names_only_facts`).

    python -m moonshot.planning.steps nist-ftc-10          # prints the steps as a numbered list
"""
from __future__ import annotations

import re
import sys

from moonshot.planning.validate import load_plan

VISE_NAMES = {"vise6": "the 6 in vise"}
FACE_UP = {"-Y": "pocket side up", "+Y": "scalloped side up", "+Z": "on its F65 side", "-Z": "on its F81 side",
           "+X": "standing on one end", "-X": "standing on the other end"}
TOOL_NAMES = {"facem": "the 2 in face mill", "em12": "the 1/2 in end mill", "em38": "the 3/8 in end mill",
              "em14": "the 1/4 in end mill", "bem14": "the 1/4 in ball end mill", "drill-2.5": "the 2.5 mm drill",
              "drill-6": "the 6 mm drill", "drill-7": "the 7 mm drill", "drill-5.5": "the 5.5 mm drill",
              "ream-3.5": "the 3.5 mm reamer", "tap-m3": "the M3 tap"}


def step(sid: str, title: str, caption: str, facts: dict, kind: str = "human", **extra) -> dict:
    return {"id": sid, "title": title, "caption": caption.format(**facts), "facts": facts, "kind": kind, **extra}


def expand(plan: dict) -> list[dict]:
    out = []
    loaded: set[str] = set()
    for s in plan["setups"]:
        w = s["workholding"]
        f = {"setup": s["title"], "vise": VISE_NAMES[w["vise"]], "up": FACE_UP[s["face_up"]],
             "parallels": f"{w['parallels_in']:g} in parallels" if w["parallels_in"] else "the vise floor and a stop"}
        p = s["id"]
        out += [
            step(f"{p}-clean", "Clean the vise and set the parallels",
                 "Blow out {vise} and wipe the jaws, then set {parallels}.", f, setup=p),
            step(f"{p}-load", "Load the part", "Set the part in {vise}, {up}, on {parallels}.", f, setup=p),
            step(f"{p}-seat", "Seat it and tighten the vise",
                 "Close the jaw until it touches, tap the part down, then tighten the handle.", f, setup=p),
            step(f"{p}-check", "Check the parallels are pinched",
                 "Try each parallel with a fingertip: neither should move.", f, setup=p),
            step(f"{p}-xy", "Find X and Y", "Set {wcs} X at {x} and Y at {y}.",
                 f | {"wcs": s["wcs"]["code"], "x": s["wcs"]["x"], "y": s["wcs"]["y"]}, setup=p),
            step(f"{p}-z", "Set Z", "Set {wcs} Z at {z}.", f | {"wcs": s["wcs"]["code"], "z": s["wcs"]["z"]}, setup=p),
        ]
        new = [op["tool"] for op in s["operations"] if op["tool"] not in loaded]
        if new:
            names = ", ".join(dict.fromkeys(TOOL_NAMES.get(t, t) for t in new))
            out.append(step(f"{p}-tools", "Load the tools", "Load {tools} into the carousel.",
                            f | {"tools": names, "tool_ids": list(dict.fromkeys(new))}, setup=p))
            loaded |= set(new)
        out.append(step(f"{p}-start", "Close the door and start the cycle",
                        "Close the door, check the program is {setup}, and press Cycle Start.", f, setup=p))
        for op in s["operations"]:
            out.append(step(f"{p}-{op['id']}", op["what"].split(":")[0], "{what}, with {tool}.",
                            {"what": op["what"], "tool": TOOL_NAMES.get(op["tool"], op["tool"])},
                            kind="cycle", setup=p, operation=op["id"]))
        out.append(step(f"{p}-unload", "Blow off the chips and unload",
                        "Open the door, blow the chips off, loosen the vise and lift the part out.", f, setup=p))
    for fin in plan.get("finish", []):
        out.append(step(fin["id"], fin["what"].split(",")[0], "{what}.", {"what": fin["what"]}, station=fin["station"]))
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
