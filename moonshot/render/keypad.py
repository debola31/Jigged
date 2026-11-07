"""The VF-2 pendant's keypad and screen, drawn at render time (render only).

The pendant's CAD (trainual's vf2.glb, library/machines/vf2/links/pendant.glb) is a bare face: no keys, no screen, so a
hand working the control presses a blank white box. This lays a thin panel on that face, a texture of the keypad with
every key where the station's record has it (moonshot/library/stations/vf2.json affordances.keys, the same sites the
hand presses: moonshot/world/vf2.py pendant()), its label in a small block font, and the screen above them. Nothing
here collides or moves; the E-stop, jog handle, Cycle Start and Feed Hold stand out of the face as the record's own
cylinders and are drawn by their GLB, in front of this panel.

Drawn by us from the record, not a photograph of Haas's control. Runs inside Blender (numpy only; no PIL there).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix

MM = 0.001
PX_MM = 3.0                       # texture resolution: 3 px a mm, a 16 mm key is 48 px
KEY_MM = 15.0                     # a key's face; the record's pitch is 18 mm
PROUD_MM = 0.4                    # the panel stands this far in front of the CAD face, so it draws over it
SCREEN_MM = (770.0, 1072.0, 1505.0, 1770.0)   # x0, x1, z0, z1: the screen above the keys [proposed: not in the CAD]

PANEL = (0.075, 0.078, 0.085)
KEY = {"alpha": (0.70, 0.71, 0.72), "func": (0.38, 0.39, 0.41), "red": (0.55, 0.08, 0.07)}
INK = {"alpha": (0.05, 0.05, 0.06), "func": (0.92, 0.92, 0.93), "red": (0.95, 0.95, 0.95)}

# A 5 x 7 block font: each glyph seven rows of five bits, top row first.
_FONT = {
    "A": "01110 10001 10001 11111 10001 10001 10001", "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01111 10000 10000 10000 10000 10000 01111", "D": "11110 10001 10001 10001 10001 10001 11110",
    "E": "11111 10000 10000 11110 10000 10000 11111", "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01111 10000 10000 10011 10001 10001 01111", "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "01110 00100 00100 00100 00100 00100 01110", "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001", "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001", "N": "10001 11001 10101 10011 10001 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110", "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101", "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110", "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110", "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 10101 01010", "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 01010 00100 00100 00100 00100", "Z": "11111 00001 00010 00100 01000 10000 11111",
    "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11110 00001 00001 01110 00001 00001 11110",
    "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
    "+": "00000 00100 00100 11111 00100 00100 00000", "-": "00000 00000 00000 11111 00000 00000 00000",
    ".": "00000 00000 00000 00000 00000 01100 01100", "/": "00001 00010 00010 00100 01000 01000 10000",
    " ": "00000 00000 00000 00000 00000 00000 00000",
}
_GLYPH = {c: np.array([[b == "1" for b in row] for row in rows.split()], bool) for c, rows in _FONT.items()}

# Labels where the record's key name isn't what the key says.
LABEL = {"inc_0.0001": ".0001", "inc_0.001": ".001", "inc_0.01": ".01", "inc_0.1": ".1", "eob": "EOB",
         "tool_offset_measure": "TOOL OFS", "part_zero_set": "PART ZERO", "current_commands": "CURNT COMDS",
         "single_block": "SINGL BLOCK", "option_stop": "OPT STOP", "block_delete": "BLOCK DEL",
         "spindle_jog": "SPNDL JOG", "rotate_index": "ROT INDX", "handle_jog": "HAND JOG", "zero_return": "ZERO RET",
         "home_g28": "HOME G28", "next_tool": "NEXT TOOL", "tool_release": "TOOL REL", "page_up": "PAGE UP",
         "page_down": "PAGE DOWN", "atc_fwd": "ATC FWD", "diagnostic": "DIAG", "position": "POSIT"}


def _record() -> dict:
    return json.loads((Path(__file__).resolve().parents[1] / "library" / "stations" / "vf2.json")
                      .read_text(encoding="utf-8"))


def _kind(name: str) -> str:
    if name == "reset":
        return "red"
    return "alpha" if len(name) == 1 or name.isdigit() or name in ("+y", "+z", "eob") else "func"


def _text(img: np.ndarray, words: list[str], cx: float, cy: float, rgb, scale: int, left: bool = False) -> None:
    """Lines of text centred on (cx, cy) px, or starting at cx when `left`; row 0 of img is the bottom (Blender's
    pixel order)."""
    gw, gh = 6 * scale, 8 * scale                       # a glyph's cell: 5 x 7 and a pixel's gap
    top = cy + len(words) * gh / 2
    for i, w in enumerate(words):
        x0 = int(round(cx if left else cx - len(w) * gw / 2))
        y_top = int(round(top - i * gh))                # this line's top row (rows count up from the bottom)
        for j, ch in enumerate(w):
            g = _GLYPH.get(ch, _GLYPH[" "])
            for r in range(7):
                for c in range(5):
                    if g[r, c]:
                        x, y = x0 + j * gw + c * scale, y_top - (r + 1) * scale
                        img[y:y + scale, x:x + scale, :3] = rgb


def _words(name: str) -> list[str]:
    label = LABEL.get(name, name.replace("_", " ")).upper()
    words = label.split()
    if len(words) > 2:
        words = [" ".join(words[:-1]), words[-1]]
    return words


def images(rec: dict | None = None) -> tuple[bpy.types.Image, bpy.types.Image, tuple]:
    """The panel's texture and the screen's, and the face's extent (x0, x1, z0, z1, y) in mm."""
    rec = rec or _record()
    face = rec["colliders"]["pendant_face"]
    (x0, yf, z0), (x1, _, z1) = face["box_min_mm"], face["box_max_mm"]
    keys = rec["affordances"]["keys"]
    w, h = int((x1 - x0) * PX_MM), int((z1 - z0) * PX_MM)
    img = np.ones((h, w, 4), np.float32)
    img[..., :3] = PANEL
    half = KEY_MM / 2 * PX_MM
    for name, (x, z) in keys["at_mm"].items():
        cx, cy = (x - x0) * PX_MM, (z - z0) * PX_MM
        kind = _kind(name)
        a, b = int(cx - half), int(cx + half)
        c, d = int(cy - half), int(cy + half)
        img[c:d, a:b, :3] = KEY[kind]
        img[d - 2:d, a:b, :3] = np.minimum(np.array(KEY[kind]) * 1.25, 1.0)    # the key's lit top edge
        img[c:c + 2, a:b, :3] = np.array(KEY[kind]) * 0.6                     # and its shadowed bottom one
        words = _words(name)
        scale = 2 if max(len(s) for s in words) <= 3 and len(words) == 1 else 1
        _text(img, words, cx, cy, INK[kind], scale)
    # the screen's bezel on the panel; the lit screen is its own quad (emissive), drawn over it
    sx0, sx1, sz0, sz1 = SCREEN_MM
    img[int((sz0 - 6 - z0) * PX_MM):int((sz1 + 6 - z0) * PX_MM), int((sx0 - 6 - x0) * PX_MM):int((sx1 + 6 - x0) * PX_MM), :3] = 0.02
    panel = bpy.data.images.new("vf2_keypad", w, h, alpha=False)
    panel.pixels.foreach_set(img.ravel())
    panel.pack()

    sw, sh = int((sx1 - sx0) * PX_MM), int((sz1 - sz0) * PX_MM)
    scr = np.ones((sh, sw, 4), np.float32)
    scr[..., :3] = (0.01, 0.015, 0.03)
    # the screen: a title bar, the machine's position large, and the work offsets page below, as an NGC control
    # shows them while a part is set up (figures made up, the same in every take)
    white, green, grey, amber = (0.92, 0.93, 0.95), (0.35, 0.95, 0.45), (0.55, 0.58, 0.62), (0.98, 0.72, 0.18)
    scr[sh - 34:, :, :3] = (0.05, 0.12, 0.30)
    _text(scr, ["MDI    G54    T1    MEM"], 14, sh - 17, white, 2, left=True)
    scr[sh - 40:sh - 34, :, :3] = (0.02, 0.04, 0.09)
    row = sh - 70
    _text(scr, ["POSITION  WORK G54"], 14, row, amber, 2, left=True)
    for axis, v in (("X", -3.4251), ("Y", 1.2870), ("Z", 0.5000)):
        row -= 40
        _text(scr, [f"{axis}  {v:9.4f}".replace(" ", " ")], 30, row, green, 4, left=True)
    row -= 44
    scr[row:row + 3, 10:sw - 10, :3] = (0.15, 0.2, 0.3)
    row -= 26
    _text(scr, ["WORK ZERO OFFSET     X          Y          Z"], 14, row, amber, 2, left=True)
    for g, xyz in (("G52", (0.0, 0.0, 0.0)), ("G54", (-14.2183, -9.6402, -12.0315)), ("G55", (0.0, 0.0, 0.0)),
                   ("G56", (0.0, 0.0, 0.0))):
        row -= 24
        _text(scr, [f"{g}    " + "  ".join(f"{v:9.4f}" for v in xyz)], 14, row, white if g == "G54" else grey, 2,
              left=True)
    row -= 34
    scr[row:row + 3, 10:sw - 10, :3] = (0.15, 0.2, 0.3)
    row -= 26
    _text(scr, ["PROGRAM  O01000"], 14, row, amber, 2, left=True)
    program = ["N10 T1 M06", "N20 G00 G90 G54 X0. Y0.", "N30 S5000 M03", "N40 G43 H01 Z1. M08",
               "N50 G01 Z-.05 F20.", "N60 X2.5 F40.", "N70 Y1.25", "N80 X0.", "N90 Y0.", "N100 G00 Z1. M09",
               "N110 G28 G91 Z0.", "N120 M30"]
    for i, line in enumerate(program):
        row -= 24
        if row < 16:
            break
        if i == 3:                                       # the line the control is on, highlighted
            scr[row - 10:row + 10, 10:sw // 2, :3] = (0.10, 0.22, 0.45)
        _text(scr, [line], 14, row, white if i == 3 else green, 2, left=True)
    # the bottom: the spindle and feed status, and the soft keys' labels along the screen's foot
    scr[0:64, :, :3] = (0.03, 0.05, 0.10)
    _text(scr, ["SPINDLE    0 RPM    FEED 100%    RAPID 25%    COOLANT OFF"], 14, 46, white, 2, left=True)
    for j, label in enumerate(("F1 SET", "F2 CLEAR", "F3 MEASURE", "F4 OFFSET")):
        x = 10 + j * (sw - 20) // 4
        scr[6:26, x + 2:x + (sw - 20) // 4 - 4, :3] = (0.10, 0.18, 0.35)
        _text(scr, [label], x + (sw - 20) // 8, 16, white, 1)
    screen = bpy.data.images.new("vf2_screen", sw, sh, alpha=False)
    screen.pixels.foreach_set(scr.ravel())
    screen.pack()
    return panel, screen, (x0, x1, z0, z1, yf)


def _material(name: str, image, emission: float) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.interpolation = "Smart"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.45 if emission == 0 else 0.15
    if emission:
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emission
    return m


def _quad(name: str, x0, x1, z0, z1, y, material) -> bpy.types.Object:
    """A quad on the face, raw coordinates in metres, facing the operator (-Y), UVs across it."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    vs = [bm.verts.new((x * MM, y * MM, z * MM)) for x, z in ((x0, z0), (x1, z0), (x1, z1), (x0, z1))]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.new("UVMap")
    for loop, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = (u, v)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    return bpy.data.objects.new(name, me)


def pendant(holder, link, body: str) -> list:
    """The keypad panel and the screen on the pendant's face, under the GLB's holder (render_take.import_glb). The
    importer turns a GLB's raw Z-up coordinates +90 deg about X and the holder undoes it; these quads are given that
    same turn so they land in the GLB's raw frame."""
    panel, screen, (x0, x1, z0, z1, yf) = images()
    y = yf - PROUD_MM
    turn = Matrix.Rotation(math.radians(90), 4, "X")
    obs = [_quad("vf2_keypad", x0, x1, z0, z1, y, _material("vf2_keypad", panel, 0.0))]
    sx0, sx1, sz0, sz1 = SCREEN_MM
    obs.append(_quad("vf2_screen", sx0, sx1, sz0, sz1, y - 0.2, _material("vf2_screen", screen, 1.2)))
    for o in obs:
        link(o, holder, turn)
        o["body"], o["kind"] = body, "glb"
    return obs
