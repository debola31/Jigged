"""The approved look (the vise take's third draft, 2026-11-02): materials by name, the VF-2's CAD colours replaced by
what the parts are made of, the library's placeholder props drawn as what they stand for, NIMBLE's skin with
subsurface scattering, a work shirt, a CC0 HDRI shop and the work lights. Ported from trainual's blender/lib/look.py,
blender/showcase_physics.py and blender/showcase_load.py. Runs inside Blender, from render_take.py.

`cc0` is the folder of CC0 textures and the HDRI (<data root>/cc0); `textures` the bake's skin maps.
"""
from __future__ import annotations

import math
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

MM = 0.001
# VF-2 CAD materials, by what an ID render showed them to be (vf2.glb's names carry no meaning)
VF2 = {
    "mat_10": "table",          # table top
    "mat_2": "tslot",           # T-slot walls
    "mat_6": "cast_edge",       # table sides
    "mat_1": "waycover",        # telescopic covers either side of the table
    "mat_4": "waycover_dark",   # column covers
    "mat_3": "spindle_head",
    "mat_0": "enclosure",       # inside of the enclosure
}
# The library's placeholder props (each asset record says "self-made placeholder"): boxes in flat CAD colours, their
# materials mat_N, which render_take.import_glb renames <GLB stem>_mat_N. Each drawn as what its record says it is,
# keyed by the node it colours. Only their look: their colliders are the station's own boxes (moonshot/world/).
PROPS = {
    # library/inspection/rough: a Mitutoyo SJ-210 class surface roughness tester
    "rough_mat_0": "sj210_case",    # display_unit: the display unit
    "rough_drive": "sj210_drive",   # ... the drive unit beside it (dress)
    "rough_key": "sj210_key",       # ... and the display unit's keys (dress)
    "rough_start": "sj210_start",
    "rough_mat_1": "lcd",           # screen
    "rough_mat_2": "sj210_steel",   # stylus_arm: the detector, its tip on the roughness specimen
    # library/support/bench: the workbench, its drawer cabinet and the rolling tool cart beside it
    "bench_mat_4": "cart_red",      # cart_shelf_4: the cart's two shelves
    "bench_mat_1": "frame_black",   # leg_1: the bench's legs and the cart's corner posts
    "bench_mat_5": "caster",        # caster_1: the cart's casters
}


def _box(bm, lo_mm, hi_mm, index: int) -> None:
    lo, hi = Vector(lo_mm) * MM, Vector(hi_mm) * MM
    M = Matrix.Translation((lo + hi) / 2) @ Matrix.Diagonal((*(hi - lo), 1.0))
    for f in {f for v in bmesh.ops.create_cube(bm, size=1.0, matrix=M)["verts"] for f in v.link_faces}:
        f.material_index = index


def _material(me, name: str) -> int:
    me.materials.append(bpy.data.materials.get(name) or bpy.data.materials.new(name))
    return len(me.materials) - 1


def _cart_shelves(bm, me) -> None:
    """Each shelf's lip: a 3 mm rim round its top raised 38 mm (1.5 in), as a sheet-steel cart shelf is formed."""
    bm.normal_update()
    rim = bmesh.ops.inset_region(bm, faces=[f for f in bm.faces if f.normal.z > 0.99], thickness=3.0 * MM,
                                 use_even_offset=True)["faces"]
    up = bmesh.ops.extrude_face_region(bm, geom=rim)["geom"]
    bmesh.ops.translate(bm, vec=(0.0, 0.0, 38.0 * MM), verts=[v for v in up if isinstance(v, bmesh.types.BMVert)])
    bmesh.ops.delete(bm, geom=rim, context="FACES_ONLY")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)


def _sj210(bm, me) -> None:
    """The drive unit in its own dark finish, and the display unit's keys on its top (z = 50.8 mm) right of the
    screen, which ends at x = 12.1: a cursor pad, three function keys and the blue start key."""
    drive = _material(me, "rough_drive")
    for f in bm.faces:
        if f.calc_center_median().y < 0:                  # the drive unit lies in front of the display unit
            f.material_index = drive
    key, start, top = _material(me, "rough_key"), _material(me, "rough_start"), 50.8
    for dx, dy in ((0, 0), (-10, 0), (10, 0), (0, -10), (0, 10)):
        _box(bm, (34 + dx, 30.3 + dy, top), (42 + dx, 38.3 + dy, top + 1.5), key)
    for y in (21.0, 34.3, 47.6):
        _box(bm, (56, y - 3.5, top), (68, y + 3.5, top + 1.5), key)
    _box(bm, (76, 25.3, top), (90, 43.3, top + 2.0), start)


DRESS = {("bench", "cart_shelf_4"): _cart_shelves, ("rough", "display_unit"): _sj210}


def dress(stem: str, ob) -> None:
    """A placeholder prop's render mesh given what its boxes lack (DRESS, by its GLB's stem and node), in the GLB's
    frame. Only what is drawn: every collider is the station's own (moonshot/world/), and nothing rests on these."""
    fn = DRESS.get((stem, ob.name.split(".")[0]))
    if fn is None or ob.type != "MESH":
        return
    ob.data.transform(ob.matrix_basis)                   # the node's (quantised) scale into the mesh: metres
    ob.matrix_basis = Matrix()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    fn(bm, ob.data)
    for f in bm.faces:                                   # flat boxes: the Bevel in their material rounds the edges
        f.smooth = False
    bm.to_mesh(ob.data)
    bm.free()


class Nodes:
    """A fresh node tree with a Principled BSDF, and helpers to wire textures into it."""

    def __init__(self, mat: bpy.types.Material):
        mat.use_nodes = True
        self.nt = mat.node_tree
        self.nt.nodes.clear()
        self.out = self.nt.nodes.new("ShaderNodeOutputMaterial")
        self.bsdf = self.nt.nodes.new("ShaderNodeBsdfPrincipled")
        self.link(self.bsdf.outputs[0], self.out.inputs["Surface"])
        self._coords = None

    def link(self, a, b):
        self.nt.links.new(a, b)

    def set(self, **inputs):
        for k, v in inputs.items():
            self.bsdf.inputs[k].default_value = v
        return self

    def node(self, kind: str, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def coords(self, scale: float):
        """Object-space coordinates scaled so one texture tile spans 1/scale metres (CAD meshes have no usable UVs,
        so textures are box-projected)."""
        if self._coords is None:
            tc = self.node("ShaderNodeTexCoord")
            mp = self.node("ShaderNodeMapping")
            mp.inputs["Scale"].default_value = (scale, scale, scale)
            self.link(tc.outputs["Object"], mp.inputs["Vector"])
            self._coords = mp.outputs[0]
        return self._coords

    def image(self, path: Path, colour: bool, scale: float | None = None, uv: bool = False):
        im = self.node("ShaderNodeTexImage")
        im.image = bpy.data.images.load(str(path), check_existing=True)
        im.image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
        if not uv:
            im.projection = "BOX"
            im.projection_blend = 0.2
            self.link(self.coords(scale or 2.0), im.inputs["Vector"])
        return im

    def normal(self, colour_out, strength: float):
        nm = self.node("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = strength
        self.link(colour_out, nm.inputs["Color"])
        return nm.outputs[0]

    def ramp(self, a, lo: float, hi: float):
        """Map a 0..1 value onto lo..hi."""
        m = self.node("ShaderNodeMapRange")
        self.link(a, m.inputs["Value"])
        m.inputs["To Min"].default_value = lo
        m.inputs["To Max"].default_value = hi
        return m.outputs[0]

    def tint(self, colour_out, rgb, factor=1.0):
        mx = self.node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY")
        mx.inputs["Factor"].default_value = factor
        self.link(colour_out, mx.inputs["A"])
        mx.inputs["B"].default_value = (*rgb, 1)
        return mx.outputs["Result"]

    def noise_rough(self, base: float, spread: float, scale: float):
        """Roughness that wanders a little over the surface (handling, coolant, wear)."""
        n = self.node("ShaderNodeTexNoise")
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = 6
        self.link(self.coords(1.0), n.inputs["Vector"])
        return self.ramp(n.outputs["Fac"], base - spread, base + spread)

    def mottled(self, rgb, amount: float, scale: float = 3.0):
        """A colour that darkens by up to `amount` in broad patches (fading, handling, shop dust): no real finish is
        one flat colour."""
        n = self.node("ShaderNodeTexNoise")
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = 4
        self.link(self.coords(1.0), n.inputs["Vector"])
        return self.tint(self.ramp(n.outputs["Fac"], 1.0 - amount, 1.0), rgb)

    def rounded(self, edge_mm: float, coat: bool = False):
        """Edges rounded to edge_mm in the shading (Cycles' Bevel), the mesh untouched: a placeholder's sharp boxes
        catch the light along their edges as a moulding or a folded sheet does."""
        bv = self.node("ShaderNodeBevel", samples=8)
        bv.inputs["Radius"].default_value = edge_mm * MM
        self.link(bv.outputs["Normal"], self.bsdf.inputs["Normal"])
        if coat:
            self.link(bv.outputs["Normal"], self.bsdf.inputs["Coat Normal"])
        return self

    def pbr(self, cc0: Path, asset: str, scale: float, tint=None, rough=(0.0, 1.0), normal=1.0, metal=None):
        """An ambientCG material, box-projected."""
        d = cc0 / asset
        c = self.image(d / f"{asset}_2K-JPG_Color.jpg", True, scale).outputs["Color"]
        if tint:
            c = self.tint(c, tint)
        self.link(c, self.bsdf.inputs["Base Color"])
        r = self.image(d / f"{asset}_2K-JPG_Roughness.jpg", False, scale)
        self.link(self.ramp(r.outputs["Color"], *rough), self.bsdf.inputs["Roughness"])
        n = self.image(d / f"{asset}_2K-JPG_NormalGL.jpg", False, scale)
        self.link(self.normal(n.outputs["Color"], normal), self.bsdf.inputs["Normal"])
        if metal is None:
            m = self.image(d / f"{asset}_2K-JPG_Metalness.jpg", False, scale)
            self.link(m.outputs["Color"], self.bsdf.inputs["Metallic"])
        else:
            self.set(Metallic=metal)
        return self


def sock(sockets, ident):
    return next(x for x in sockets if x.identifier == ident)


def paint(mat, rgb, rough, coat=0.0, coat_rough=0.3, wear=0.06, edge_mm=0.0, mottle=0.0):
    """Paint, powder coat or moulded plastic; edge_mm rounds a modelled box's edges, mottle varies its colour."""
    n = Nodes(mat).set(**{"Base Color": (*rgb, 1), "Metallic": 0.0, "Coat Weight": coat, "Coat Roughness": coat_rough})
    n.link(n.noise_rough(rough, wear, 6.0), n.bsdf.inputs["Roughness"])
    if mottle:
        n.link(n.mottled(rgb, mottle), n.bsdf.inputs["Base Color"])
    if edge_mm:
        n.rounded(edge_mm, coat=coat > 0)
    return n


def metal(mat, rgb, rough, spread=0.05, aniso=0.0, edge_mm=0.0):
    n = Nodes(mat).set(**{"Base Color": (*rgb, 1), "Metallic": 1.0, "Anisotropic": aniso})
    n.link(n.noise_rough(rough, spread, 18.0), n.bsdf.inputs["Roughness"])
    if edge_mm:
        n.rounded(edge_mm)
    return n


def cotton(mat, rgb=(0.03, 0.05, 0.10)):
    n = Nodes(mat).set(**{"Base Color": (*rgb, 1), "Roughness": 0.92, "Sheen Weight": 0.6, "Sheen Roughness": 0.6,
                          "Sheen Tint": (0.35, 0.42, 0.6, 1), "Specular IOR Level": 0.2})
    weave = n.node("ShaderNodeTexWave", wave_type="BANDS")
    weave.inputs["Scale"].default_value = 1200.0
    weave.inputs["Distortion"].default_value = 2.0
    n.link(n.node("ShaderNodeTexCoord").outputs["UV"], weave.inputs["Vector"])
    bump = n.node("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.15
    n.link(weave.outputs["Fac"], bump.inputs["Height"])
    n.link(bump.outputs["Normal"], n.bsdf.inputs["Normal"])
    return n


def bare_steel() -> bpy.types.Material:
    """What a GLB with no materials is drawn in: most of what a shop holds is steel."""
    mat = bpy.data.materials.get("bare_steel")
    if mat is None:
        mat = bpy.data.materials.new("bare_steel")
        metal(mat, (0.62, 0.63, 0.65), 0.3)
    return mat


# The ST-25's links (moonshot/library/stations/extract.py) come out of Haas's STEP unpainted: each drawn in what that
# part of the machine is, by its link (the GLB's path under library/machines/st25/links/): the door and the castings
# dark grey, as Haas's CAD colours them (the asset's st25.glb: its door and front casting cover), the enclosure light
# grey [proposed: the CAD's colour there is its default], the way covers stainless, the chucks and the turret ground
# steel.
ST25_FINISH = {"base": "st25_enclosure", "pendant": "st25_pendant", "door": "st25_door",
               "zslide": "st25_casting", "xslide": "st25_casting", "turret": "st25_turret",
               "zcover_left": "st25_waycover", "zcover_right": "st25_waycover", "spindle": "st25_nose",
               "drawtube": "st25_nose", "probe_arm": "st25_probe", "br10/body": "st25_chuck",
               "br10/jaw_0": "st25_softjaw", "br10/jaw_1": "st25_softjaw", "br10/jaw_2": "st25_softjaw",
               "c5/body": "st25_chuck", "c5/collet": "st25_chuck"}


def link_finish(path: Path):
    """The material an unpainted station link is drawn in, or None: the ST-25's by its link (ST25_FINISH)."""
    p = path.as_posix()
    if "machines/st25/links/" not in p:
        return None
    role = ST25_FINISH.get(p.split("machines/st25/links/", 1)[1].removesuffix(".glb"))
    if role is None:
        return None
    mat = bpy.data.materials.get(role)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(role)
    if role == "st25_enclosure":
        paint(mat, (0.58, 0.59, 0.6), 0.5, wear=0.12)              # light grey sheet, satin, worn at the edges
    elif role in ("st25_door", "st25_casting"):
        paint(mat, (0.05, 0.052, 0.056), 0.45, coat=0.2, wear=0.1)  # the dark grey door and castings
    elif role == "st25_pendant":
        paint(mat, (0.07, 0.072, 0.078), 0.4, coat=0.2)
    elif role == "st25_waycover":
        metal(mat, (0.7, 0.71, 0.73), 0.25, aniso=0.2)               # stainless way covers
    elif role in ("st25_turret", "st25_nose", "st25_chuck"):
        metal(mat, (0.6, 0.61, 0.63), 0.24, aniso=0.3)               # ground steel
    elif role == "st25_softjaw":
        metal(mat, (0.66, 0.67, 0.68), 0.3, spread=0.08)             # machined soft steel
    elif role == "st25_probe":
        paint(mat, (0.06, 0.06, 0.065), 0.4, coat=0.2)
    return mat


def geom(rgba) -> bpy.types.Material:
    """A collider drawn as itself: painted in its MuJoCo colour."""
    name = "geom_" + "_".join(f"{c:.2f}" for c in rgba[:3])
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
        paint(mat, tuple(rgba[:3]), 0.45)
    return mat


def apply_look(cc0: Path) -> None:
    """Every imported material, by its name."""
    done = set()
    for m in list(bpy.data.materials):
        name = m.name.split(".")[0]
        role = VF2.get(name) or PROPS.get(name)
        if role == "table":
            # ground cast iron: grey, with grinding marks, a little oil
            Nodes(m).pbr(cc0, "Metal054A", 3.0, tint=(0.95, 0.96, 1.0), rough=(0.32, 0.58), normal=0.6, metal=1.0)
        elif role == "tslot":
            Nodes(m).pbr(cc0, "Metal054A", 3.0, tint=(0.35, 0.35, 0.36), rough=(0.5, 0.75), normal=0.8, metal=0.85)
        elif role == "cast_edge":
            paint(m, (0.035, 0.037, 0.04), 0.5)
        elif role == "waycover":
            Nodes(m).pbr(cc0, "Metal012", 2.0, tint=(0.75, 0.76, 0.78), rough=(0.2, 0.45), normal=0.5, metal=1.0)
        elif role == "waycover_dark":
            Nodes(m).pbr(cc0, "Metal012", 2.0, tint=(0.4, 0.4, 0.42), rough=(0.3, 0.55), normal=0.5, metal=1.0)
        elif role == "spindle_head":
            paint(m, (0.05, 0.05, 0.055), 0.45, coat=0.3)
        elif role == "enclosure":
            paint(m, (0.55, 0.56, 0.57), 0.55, wear=0.12)
        elif role == "sj210_case":
            # moulded light grey ABS, satin, its edges radiused as a moulding's are
            paint(m, (0.36, 0.37, 0.37), 0.4, wear=0.08, edge_mm=3.0, mottle=0.06)
        elif role == "sj210_drive":
            paint(m, (0.035, 0.036, 0.04), 0.42, wear=0.08, edge_mm=2.5)
        elif role == "sj210_key":
            paint(m, (0.06, 0.062, 0.068), 0.55, edge_mm=1.0)
        elif role == "sj210_start":
            paint(m, (0.012, 0.06, 0.28), 0.4, coat=0.3, edge_mm=1.5)
        elif role == "lcd":
            # the display's glass over a dark (sleeping) panel: glossy, it shows the shop's lights
            paint(m, (0.004, 0.005, 0.007), 0.3, coat=1.0, coat_rough=0.03, wear=0.03, edge_mm=0.6)
        elif role == "sj210_steel":
            # the detector's stainless barrel and the lapped steel specimen
            metal(m, (0.62, 0.63, 0.65), 0.22, aniso=0.3, edge_mm=0.6)
        elif role == "cart_red":
            # red powder-coated sheet steel: semi-gloss, folded edges, faded and scuffed in patches
            paint(m, (0.15, 0.013, 0.01), 0.42, coat=0.3, coat_rough=0.25, wear=0.1, edge_mm=1.5, mottle=0.25)
        elif role == "frame_black":
            paint(m, (0.02, 0.02, 0.022), 0.45, coat=0.2, coat_rough=0.3, wear=0.1, edge_mm=2.0)
        elif role == "caster":
            paint(m, (0.012, 0.012, 0.013), 0.65, edge_mm=1.5)
        elif name.startswith("mat_"):
            # the rest of the machine's CAD colours: painted sheet metal, light or dark as drawn
            b = next((x for x in m.node_tree.nodes if x.type == "BSDF_PRINCIPLED"), None) if m.node_tree else None
            c = b.inputs["Base Color"].default_value if b else (0.5, 0.5, 0.5, 1)
            lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
            paint(m, (0.04, 0.04, 0.045) if lum < 0.15 else (0.5, 0.51, 0.52), 0.5, wear=0.1)
        elif name.startswith("kurt_blue"):
            paint(m, (0.02, 0.10, 0.36), 0.42, coat=0.7, coat_rough=0.2)
        elif name.startswith(("ground_steel", "hardened_steel")):
            metal(m, (0.62, 0.63, 0.65), 0.22, aniso=0.3)
        elif name.startswith("handle_steel"):
            metal(m, (0.7, 0.71, 0.72), 0.16)
        elif name.startswith("grip_black"):
            paint(m, (0.012, 0.012, 0.014), 0.6, coat=0.15)
        elif name.startswith("mallet_body"):
            metal(m, (0.12, 0.12, 0.13), 0.4)
        elif name.startswith("urethane_yellow"):
            paint(m, (0.68, 0.38, 0.03), 0.55, wear=0.08)
        elif name.startswith("urethane_black"):
            paint(m, (0.008, 0.008, 0.01), 0.6)
        elif name.startswith("handle_grip"):
            paint(m, (0.30, 0.17, 0.08), 0.6, coat=0.25, coat_rough=0.5)
        elif name.startswith("acetal_black"):
            # machined black acetal (Delrin): satin, a faint sheen where the cutter left it smooth
            paint(m, (0.012, 0.012, 0.013), 0.38, coat=0.15, coat_rough=0.35, wear=0.04)
        elif name.startswith("aluminium_6061"):
            # saw-cut 6061 bar: mill finish, light scratches
            Nodes(m).pbr(cc0, "Metal050C", 6.0, tint=(1.0, 1.0, 1.0), rough=(0.3, 0.5), normal=0.5, metal=1.0)
        else:
            continue
        done.add(name)
    print("[look]", ", ".join(sorted(done)), flush=True)


def skin(textures: Path, name="nimble_skin") -> bpy.types.Material:
    """NIMBLE's scanned maps, plus what close-ups need on top of a 1024 px texture:
    - Random Walk (Skin) subsurface, anisotropy 0.8 (measured skin; Blender 5.2's own comment);
    - pores and fine wrinkles from the rest-pose position, so they stay on the skin;
    - knuckle creases on the dorsal masks, deeper as a joint straightens;
    - nails: harder, glossier, less scattering;
    - pressure blanching: paler, less red, where the skin touches a surface;
    - a machinist's skin: a little grime in the creases, a sheen of oil."""
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    n = Nodes(mat)
    col = n.image(textures / "skin_diffuse.png", True, uv=True)
    nrm = n.image(textures / "skin_normal.png", False, uv=True)
    spec = n.image(textures / "skin_spec.png", False, uv=True)
    attr = lambda k: n.node("ShaderNodeAttribute", attribute_name=k)   # noqa: E731
    rest = n.node("ShaderNodeAttribute", attribute_name="rest", attribute_type="GEOMETRY")
    crease, nail, contact = attr("crease"), attr("nail"), attr("contact")
    # albedo: the scan, slightly desaturated (the PCA mean reads orange under AgX), with blanching
    hsv = n.node("ShaderNodeHueSaturation")
    hsv.inputs["Saturation"].default_value = 0.9
    hsv.inputs["Value"].default_value = 0.95
    n.link(col.outputs["Color"], hsv.inputs["Color"])
    blanch = n.node("ShaderNodeMix", data_type="RGBA", blend_type="MIX")
    sock(blanch.inputs, "B_Color").default_value = (0.74, 0.60, 0.52, 1)
    m = n.node("ShaderNodeMath", operation="MULTIPLY")
    n.link(contact.outputs["Fac"], m.inputs[0])
    m.inputs[1].default_value = 0.55
    n.link(m.outputs[0], sock(blanch.inputs, "Factor_Float"))
    n.link(hsv.outputs["Color"], sock(blanch.inputs, "A_Color"))
    # grime in creases (cavity from the crease mask and a noise), very slight
    grime_noise = n.node("ShaderNodeTexNoise")
    grime_noise.inputs["Scale"].default_value = 140.0
    n.link(rest.outputs["Vector"], grime_noise.inputs["Vector"])
    gm = n.node("ShaderNodeMath", operation="MULTIPLY")
    n.link(crease.outputs["Fac"], gm.inputs[0])
    n.link(grime_noise.outputs["Fac"], gm.inputs[1])
    gm2 = n.node("ShaderNodeMath", operation="MULTIPLY")
    n.link(gm.outputs[0], gm2.inputs[0])
    gm2.inputs[1].default_value = 0.35
    grime = n.node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY")
    sock(grime.inputs, "B_Color").default_value = (0.45, 0.38, 0.33, 1)
    n.link(gm2.outputs[0], sock(grime.inputs, "Factor_Float"))
    n.link(sock(blanch.outputs, "Result_Color"), sock(grime.inputs, "A_Color"))
    n.link(sock(grime.outputs, "Result_Color"), n.bsdf.inputs["Base Color"])
    # roughness: the scan's spec map, oilier on the back, nails glossy
    rough = n.ramp(spec.outputs["Color"], 0.62, 0.42)
    nail_r = n.node("ShaderNodeMix", data_type="FLOAT")
    n.link(nail.outputs["Fac"], sock(nail_r.inputs, "Factor_Float"))
    n.link(rough, sock(nail_r.inputs, "A_Float"))
    sock(nail_r.inputs, "B_Float").default_value = 0.18
    n.link(sock(nail_r.outputs, "Result_Float"), n.bsdf.inputs["Roughness"])
    # detail normals: scan normal map -> pores -> fine wrinkles -> knuckle creases
    pores = n.node("ShaderNodeTexVoronoi", feature="SMOOTH_F1")
    pores.inputs["Scale"].default_value = 2600.0
    n.link(rest.outputs["Vector"], pores.inputs["Vector"])
    fine = n.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="X")
    fine.inputs["Scale"].default_value = 420.0
    fine.inputs["Distortion"].default_value = 6.0
    fine.inputs["Detail"].default_value = 3.0
    n.link(rest.outputs["Vector"], fine.inputs["Vector"])
    creases = n.node("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Z")
    creases.inputs["Scale"].default_value = 260.0
    creases.inputs["Distortion"].default_value = 4.0
    creases.inputs["Detail"].default_value = 2.0
    n.link(rest.outputs["Vector"], creases.inputs["Vector"])
    cm = n.node("ShaderNodeMath", operation="MULTIPLY")
    n.link(creases.outputs["Fac"], cm.inputs[0])
    n.link(crease.outputs["Fac"], cm.inputs[1])
    b1 = n.node("ShaderNodeBump")
    b1.inputs["Strength"].default_value = 0.10
    b1.inputs["Distance"].default_value = 0.00008
    n.link(pores.outputs["Distance"], b1.inputs["Height"])
    n.link(n.normal(nrm.outputs["Color"], 0.9), b1.inputs["Normal"])
    b2 = n.node("ShaderNodeBump")
    b2.inputs["Strength"].default_value = 0.08
    b2.inputs["Distance"].default_value = 0.00006
    n.link(fine.outputs["Fac"], b2.inputs["Height"])
    n.link(b1.outputs["Normal"], b2.inputs["Normal"])
    b3 = n.node("ShaderNodeBump")
    b3.inputs["Strength"].default_value = 0.45
    b3.inputs["Distance"].default_value = 0.00025
    n.link(cm.outputs[0], b3.inputs["Height"])
    n.link(b2.outputs["Normal"], b3.inputs["Normal"])
    n.link(b3.outputs["Normal"], n.bsdf.inputs["Normal"])
    # subsurface: less where it presses (blood pushed out) and at the nails
    ss = n.node("ShaderNodeMath", operation="SUBTRACT")
    ss.inputs[0].default_value = 1.0
    n.link(nail.outputs["Fac"], ss.inputs[1])
    n.link(ss.outputs[0], n.bsdf.inputs["Subsurface Weight"])
    n.set(**{"Subsurface Radius": (1.0, 0.36, 0.2), "Subsurface Scale": 0.0035, "Subsurface Anisotropy": 0.8,
             "Specular IOR Level": 0.4, "Coat Weight": 0.0, "Sheen Weight": 0.08})
    try:
        n.bsdf.subsurface_method = "RANDOM_WALK_SKIN"
    except TypeError:
        pass
    return mat


def world(cc0: Path, strength: float = 0.6, rotation_deg: float = 0.0) -> None:
    """Shop lighting from Poly Haven's machine_shop_02 (CC0)."""
    sc = bpy.context.scene
    w = sc.world or bpy.data.worlds.new("shop")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(str(cc0 / "machine_shop_02_4k.hdr"), check_existing=True)
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Rotation"].default_value = (0, 0, math.radians(rotation_deg))
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
    nt.links.new(mp.outputs[0], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs[0], out.inputs["Surface"])


def _area(name, loc, size, energy, rgb, target, size_y=None):
    sc = bpy.context.scene
    L = bpy.data.lights.new(name, "AREA")
    L.shape = "RECTANGLE"
    L.size = size
    if size_y:
        L.size_y = size_y
    L.energy = energy
    L.color = rgb
    o = bpy.data.objects.new(name, L)
    sc.collection.objects.link(o)
    o.location = Vector(loc) * MM
    o.rotation_euler = (Vector(target) * MM - o.location).to_track_quat("-Z", "Y").to_euler()
    return o


def lights(station: str, work: Vector, strength: float = 1.0) -> None:
    """The work lights. The VF-2's: one inside the enclosure, back left, below the spindle head (above it the covers
    block it), so the shadow of whatever is lifted falls toward the operator, which shows how high it is; and soft
    shop light through the open doors. Elsewhere, soft light from above and behind the operator onto `work` (mm)."""
    if station == "vf2":
        _area("work_light", (-700, -180, 1300), 0.5, 7 * strength, (1.0, 0.97, 0.92), (-381, -350, 900), size_y=0.05)
        _area("door_light", (-400, -1600, 1700), 2.0, 140, (1.0, 0.98, 0.95), (-381, -350, 900))
    else:
        _area("shop_light", work + Vector((-300, -900, 900)), 2.0, 140 * strength, (1.0, 0.98, 0.95), work)
