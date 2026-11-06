"""The shop's materials as data: plain Python, read by the tile baker (tiles.py), Blender (blender/*.py) and the
packer (through `resolved()`, which pack.mjs reads as JSON).

Two layers, so the download and the GPU carry each texture once for the whole shop:
- FAMILIES are surfaces: a tileable, colour-neutral texture set (base, mr, nrm) at physical scale, baked from CC0
  sources plus procedural layers into <data>/web/tiles/. Every paint in the shop shares one orange-peel set, every
  ground metal one Metal054A set. A family's base averages BASE_MEAN and its roughness `rough_mean`, so a material
  scales them by its factors without changing the texture.
- MATERIALS are a family plus glTF factors: colour, roughness, metalness, tile size, normal strength and extensions.
  A new paint colour costs no texture at all.

The spike gave each material its own texture set; at shop scale that is ~30 sets, which the budgets can't carry
(spike REPORT.md: "every GLB embedded its own copy"; the bay alone was 0.43 GB of GPU textures).

Colours are linear RGB (glTF factors are). Ported looks keep the spike's and moonshot/render/look.py's values, so the
shop and the step videos agree. UV0 is a box projection at 1 UV unit = 1 m; a material's textures repeat every
`tile_m` metres.
"""
from __future__ import annotations

BASE_MEAN = 0.9          # a family's base texture averages this (linear), so colour factors stay <= 1

# CC0 sources (ambientCG ids) the families draw on, all under <data>/cc0/<id>/.
SOURCES = {
    "Metal012": "https://ambientcg.com/view?id=Metal012",
    "Metal050C": "https://ambientcg.com/view?id=Metal050C",
    "Metal054A": "https://ambientcg.com/view?id=Metal054A",
    "Plastic012B": "https://ambientcg.com/view?id=Plastic012B",
    "Rubber004": "https://ambientcg.com/view?id=Rubber004",
    "SurfaceImperfections003": "https://ambientcg.com/view?id=SurfaceImperfections003",
    "SurfaceImperfections013": "https://ambientcg.com/view?id=SurfaceImperfections013",
    "Fingerprints002": "https://ambientcg.com/view?id=Fingerprints002",
}
LICENCE = "CC0 1.0 (ambientCG)"

# --- families: what tiles.py bakes ---------------------------------------------------------------------------------
# base:   mottle = low-frequency colour variation; src = an ambientCG colour map's luminance at `contrast`
# rough:  src = its roughness map at `contrast`; smudge / prints = imperfection maps, relative (+ rougher, - glossier)
# normal: peel = orange peel (1-3 mm); cast = sand-cast pits under paint; src = its NormalGL at `strength`
# size:   texels per tile; tile_m: the scale the procedural layers are designed at (a material may differ a little)
FAMILIES: dict[str, dict] = {
    "paint": dict(
        about="painted or powder-coated sheet metal and moulded covers: orange peel, handling smudges, fingerprints",
        size=1024, tile_m=1.0, rough_mean=0.6,
        base=dict(mottle=0.05), rough=dict(smudge=("SurfaceImperfections003", 0.15), prints=("Fingerprints002", -0.12)),
        normal=dict(peel=0.12)),
    "paint_cast": dict(
        about="paint over a sand casting: columns, bases, vise bodies; pits and lumps under the coat",
        size=1024, tile_m=0.6, rough_mean=0.6,
        base=dict(mottle=0.08, pits=0.25), rough=dict(smudge=("SurfaceImperfections003", 0.22)),
        normal=dict(cast=0.7, peel=0.2)),
    "ground": dict(
        about="ground or machined steel and cast iron: grinding marks (Metal054A)",
        size=1024, tile_m=1 / 3, rough_mean=0.6, src="Metal054A",
        base=dict(contrast=0.6), rough=dict(contrast=0.55), normal=dict(strength=0.6)),
    "brushed": dict(
        about="brushed stainless sheet: way covers, trays, guards (Metal012)",
        size=1024, tile_m=0.5, rough_mean=0.6, src="Metal012",
        base=dict(contrast=0.3), rough=dict(contrast=0.35, prints=("Fingerprints002", -0.12)), normal=dict(strength=0.5)),
    "mill": dict(
        about="mill-finish or bead-blasted aluminium (Metal050C)",
        size=1024, tile_m=1 / 6, rough_mean=0.6, src="Metal050C",
        base=dict(contrast=0.5), rough=dict(contrast=0.4), normal=dict(strength=0.5)),
    "plastic": dict(
        about="moulded plastic: knobs, bezels, tool pockets, hoses (Plastic012B)",
        size=512, tile_m=0.2, rough_mean=0.6, src="Plastic012B",
        base=dict(contrast=0.5), rough=dict(contrast=0.5), normal=dict(strength=0.3)),
    "rubber": dict(
        about="black rubber: wipers, seals, feet, grips (Rubber004)",
        size=512, tile_m=0.4, rough_mean=0.95, src="Rubber004",
        base=dict(contrast=0.5), rough=dict(contrast=0.15), normal=dict(strength=0.4)),
    "glass": dict(
        about="glass, polycarbonate and gloss screens: smudges and prints, no normal map",
        size=512, tile_m=0.4, rough_mean=0.25,
        base=dict(), rough=dict(prints=("Fingerprints002", 0.9), smudge=("SurfaceImperfections003", 0.3))),
    "flat": dict(about="factors only, no textures: tiny parts, lamps, keys", size=0, tile_m=1.0, rough_mean=1.0),
}

# --- materials --------------------------------------------------------------------------------------------------------
# color: linear RGB; or ("src", tint) = the family's source colour (its mean, measured by tiles.py) times a tint.
# Optional: tile_m (default the family's), normal (normal-map strength, default 1), clearcoat (weight, roughness),
# emissive (rgb, strength), alpha (alphaMode BLEND below 1), double_sided.
# No KHR_materials_transmission anywhere: three.js draws a transmissive material by rendering the opaque scene a
# second time, so one pane would double the whole shop's draw calls. Glass is alpha-blended instead.
MATERIALS: dict[str, dict] = {
    # --- Haas: the VF-2 (spike mapping.py) ---------------------------------------------------------------------------
    "paint_haas_white": dict(family="paint", color=(0.55, 0.555, 0.545), rough=0.36,
                             about="Haas enclosure sheet metal: off-white semi-gloss powder coat"),
    "paint_haas_interior": dict(family="paint", color=(0.47, 0.475, 0.465), rough=0.24, tile_m=0.8,
                                about="the enclosure's inside: the same paint under a coolant film, glossier"),
    "paint_haas_dark": dict(family="paint", color=(0.032, 0.034, 0.037), rough=0.42,
                            about="Haas dark grey: skirt under the doors, roof strip, head and column covers"),
    "paint_haas_red": dict(family="paint", color=(0.42, 0.018, 0.02), rough=0.34,
                           about="Haas red: the VF logo panel, the column-top logo"),
    "paint_label_yellow": dict(family="paint", color=(0.75, 0.55, 0.02), rough=0.4, tile_m=0.5,
                               about="warning labels"),
    # --- cast iron ---------------------------------------------------------------------------------------------------
    "cast_iron_ground": dict(family="ground", color=("src", (0.95, 0.96, 1.0)), rough=0.45, metal=1.0,
                             about="ground cast-iron table tops and ways (look.py 'table')"),
    "cast_iron_raw": dict(family="ground", color=("src", (0.35, 0.35, 0.36)), rough=0.6, metal=0.85, normal=1.3,
                          about="machined, unground cast iron: T-slot walls, table sides (look.py 'tslot')"),
    "cast_iron_painted": dict(family="paint_cast", color=(0.045, 0.047, 0.05), rough=0.5,
                              about="painted castings: column, saddle, base; dark grey over sand-cast texture"),
    # --- steel and aluminium -----------------------------------------------------------------------------------------
    "steel_ground": dict(family="ground", color=(0.62, 0.63, 0.65), rough=0.24, metal=1.0, tile_m=0.12, normal=0.5,
                         about="ground steel: linear rails, spindle nose, vise jaws, holder tapers"),
    "steel_bright": dict(family="ground", color=(0.70, 0.71, 0.72), rough=0.16, metal=1.0, tile_m=0.2, normal=0.3,
                         about="polished steel: handles, knobs, clips"),
    "steel_machined": dict(family="ground", color=(0.50, 0.505, 0.515), rough=0.34, metal=1.0, tile_m=0.15,
                           normal=0.7, about="turned or milled steel, not ground: flanges, collars, nuts"),
    "steel_black_oxide": dict(family="ground", color=(0.06, 0.062, 0.066), rough=0.38, metal=1.0, tile_m=0.15,
                              normal=0.6, about="black-oxide steel: bolts, blades' backs, hardware"),
    "steel_brushed": dict(family="brushed", color=("src", (0.75, 0.76, 0.78)), rough=0.32, metal=1.0,
                          about="brushed stainless: telescopic way covers, tool tray (look.py 'waycover')"),
    "aluminium_brushed": dict(family="mill", color=("src", (1.0, 1.0, 1.0)), rough=0.4, metal=1.0,
                              about="mill-finish aluminium: fixture housings, coolant fittings (look.py 'aluminium_6061')"),
    "chrome": dict(family="ground", color=(0.75, 0.76, 0.77), rough=0.08, metal=1.0, tile_m=0.3, normal=0.15,
                   about="chrome plate: handwheel rims, levers"),
    # --- plastic, rubber, glass --------------------------------------------------------------------------------------
    "plastic_black": dict(family="plastic", color=("src", (0.6, 0.6, 0.62)), rough=0.45,
                          about="black moulded plastic: pockets, bezels, knobs, hoses"),
    "plastic_green": dict(family="flat", color=(0.02, 0.25, 0.04), rough=0.3, about="pendant keys and lamps"),
    "plastic_black_gloss": dict(family="glass", color=(0.006, 0.007, 0.009), rough=0.06,
                                about="a control's screen glass over a dark panel"),
    "rubber_black": dict(family="rubber", color=("src", (0.35, 0.35, 0.35)), rough=0.85,
                         about="black rubber: wipers, seals, levelling pads"),
    "glass_polycarbonate": dict(family="glass", color=(0.80, 0.84, 0.85), rough=0.04, alpha=0.18,
                                about="door windows: polycarbonate with handling smudges, alpha-blended"),
    # --- workholding -------------------------------------------------------------------------------------------------
    "paint_kurt_blue": dict(family="paint_cast", color=(0.02, 0.10, 0.36), rough=0.42, normal=0.25,
                            clearcoat=(0.7, 0.2), about="Kurt blue: glossy enamel, filled smooth over the casting "
                                                       "(look.py 'kurt_blue')"),
    # --- the band saw ------------------------------------------------------------------------------------------------
    "paint_saw_grey": dict(family="paint", color=(0.16, 0.175, 0.17), rough=0.4,
                           about="the band saw's machine-grey enamel: bow, covers, cabinet base (colour unconfirmed)"),
    "paint_saw_cast": dict(family="paint_cast", color=(0.16, 0.175, 0.17), rough=0.45,
                           about="the band saw's cast parts in the same grey: bed, vise jaws' bodies, arm"),
    "steel_blade": dict(family="ground", color=(0.55, 0.56, 0.58), rough=0.28, metal=1.0, tile_m=0.1, normal=0.4,
                        about="bi-metal band-saw blade"),
}


def library(local: dict | None = None) -> dict[str, dict]:
    """The shared materials plus an asset's own (its mapping's `materials`, each named <asset>_...): a colour only
    one machine wears belongs to its mapping, so parallel workers don't all edit this file."""
    return {**MATERIALS, **(local or {})}


def family(name: str, local: dict | None = None) -> dict:
    return FAMILIES[library(local)[name]["family"]]


def tile_m(name: str, local: dict | None = None) -> float:
    m = library(local)[name]
    return m.get("tile_m", FAMILIES[m["family"]]["tile_m"])


def resolved(name: str, src_means: dict[str, list[float]], local: dict | None = None) -> dict:
    """A material as glTF needs it: factors against its family's textures. `src_means` is the mean linear colour of
    each source map, which tiles.py measures (a ("src", tint) colour is that mean times the tint)."""
    m, fam = library(local)[name], family(name, local)
    colour = m["color"]
    if colour[0] == "src":
        colour = [c * t for c, t in zip(src_means[fam["src"]], colour[1])]
    textured = fam["size"] > 0
    base = [min(1.0, c / BASE_MEAN) if textured and fam.get("base") else c for c in colour]
    rough = m["rough"] / fam["rough_mean"] if textured else m["rough"]
    out = {"name": name, "family": m["family"], "about": m["about"], "tile_m": tile_m(name, local),
           "baseColorFactor": [round(c, 5) for c in base] + [m.get("alpha", 1.0)],
           "roughnessFactor": round(min(rough, 1.0), 4), "metallicFactor": m.get("metal", 0.0),
           "normalScale": m.get("normal", 1.0), "doubleSided": m.get("double_sided", m.get("alpha", 1.0) < 1.0)}
    for k in ("clearcoat", "emissive"):
        if k in m:
            out[k] = m[k]
    return out


def resolve_all(src_means: dict[str, list[float]], local: dict | None = None) -> dict[str, dict]:
    return {n: resolved(n, src_means, local) for n in library(local)}


def check(local: dict | None = None, asset: str | None = None) -> list[str]:
    """What's wrong with the library (and an asset's own materials): unknown families or sources, factors a texture
    can't reach, an asset's material shadowing a shared one or not named after the asset."""
    errors = []
    for name, f in FAMILIES.items():
        if f.get("src") and f["src"] not in SOURCES:
            errors.append(f"{name}: unknown source {f['src']}")
        for layer in ("rough", "base"):
            for k in ("smudge", "prints"):
                if k in f.get(layer, {}) and f[layer][k][0] not in SOURCES:
                    errors.append(f"{name}: unknown source {f[layer][k][0]}")
    for name in local or {}:
        if name in MATERIALS:
            errors.append(f"{name}: an asset's material may not shadow the library's")
        if asset and not name.startswith(f"{asset}_"):
            errors.append(f"{name}: an asset's material is named <asset>_...")
    for name, m in library(local).items():
        if m.get("family") not in FAMILIES:
            errors.append(f"{name}: unknown family {m.get('family')}")
            continue
        fam = FAMILIES[m["family"]]
        if m["color"][0] == "src" and not fam.get("src"):
            errors.append(f"{name}: a source colour on family {m['family']}, which has none")
        if fam["size"] and m["rough"] > fam["rough_mean"] * 1.0001:
            errors.append(f"{name}: roughness {m['rough']} above its family's texture mean {fam['rough_mean']}")
        if m["color"][0] != "src" and fam["size"] and max(m["color"]) > BASE_MEAN:
            errors.append(f"{name}: colour above BASE_MEAN")
        if not m.get("about"):
            errors.append(f"{name}: no `about`")
    return errors
