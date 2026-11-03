"""The approved look (the vise take's third draft, 2026-11-02): materials by name, the VF-2's CAD colours replaced by
what the parts are made of, NIMBLE's skin with subsurface scattering, a work shirt, a CC0 HDRI shop and the work
lights. Ported from trainual's blender/lib/look.py, blender/showcase_physics.py and blender/showcase_load.py. Runs
inside Blender, from render_take.py.

`cc0` is the folder of CC0 textures and the HDRI (<data root>/cc0); `textures` the bake's skin maps.
"""
from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector

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


def paint(mat, rgb, rough, coat=0.0, coat_rough=0.3, wear=0.06):
    n = Nodes(mat).set(**{"Base Color": (*rgb, 1), "Metallic": 0.0, "Coat Weight": coat, "Coat Roughness": coat_rough})
    n.link(n.noise_rough(rough, wear, 6.0), n.bsdf.inputs["Roughness"])
    return n


def metal(mat, rgb, rough, spread=0.05, aniso=0.0):
    n = Nodes(mat).set(**{"Base Color": (*rgb, 1), "Metallic": 1.0, "Anisotropic": aniso})
    n.link(n.noise_rough(rough, spread, 18.0), n.bsdf.inputs["Roughness"])
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
        role = VF2.get(name)
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
