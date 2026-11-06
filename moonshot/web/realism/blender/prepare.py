"""Prepare one asset in Blender: import its sources, give every face its library material from the asset's mapping,
run the mapping's hand fixes, join it into one object, lay out both UV sets, and save <work>/asset.blend plus
<work>/prepare.json (triangles, areas, what each material covers, anything unmapped). CPU only. Runs inside Blender:

    blender -b --factory-startup --python prepare.py -- <job.json>

Frame: the library's (metres, +Z up, the asset's front toward -Y), so the export lands in the light model's frame.
Per-link GLBs are stored Z-up inside a Y-up file (moonshot/library/stations/extract.py), so they are turned back,
as render_take.py does, and moved by the mapping's `translate_mm` where their station frame isn't the asset's.

UV0 is a box projection, 1 UV unit = 1 m (the shared tiles carry their own scale); UV1 one packed atlas for the AO.
Each face keeps three integer attributes for the review pictures: link, CAD material and part (connected solid).
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

UNDO_Y_UP = Matrix.Rotation(math.radians(-90), 4, "X")
UV1_FLOOR = 0.2              # an AO atlas using less of its square than this is mostly margin
T0 = time.perf_counter()


def log(*a):
    print("[prepare]", *a, flush=True)


def job() -> dict:
    return json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())


# --- import ----------------------------------------------------------------------------------------------------------
def import_source(src: dict) -> list:
    """The meshes of one source GLB, transformed into the asset frame, each tagged with its link name."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=src["path"], merge_vertices=False)
    new = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update()
    meshes = []
    move = Matrix.Translation(Vector(src.get("translate_mm", (0, 0, 0))) * 0.001)
    for o in new:
        if o.type != "MESH":
            continue
        M = move @ (UNDO_Y_UP if src.get("undo_y_up") else Matrix()) @ o.matrix_world
        if src.get("move_mm"):
            M = Matrix.Translation(Vector(src["move_mm"]) * 0.001) @ M
        o.data = o.data.copy()
        o.data.transform(M)
        if M.determinant() < 0:
            o.data.flip_normals()
        o.parent = None
        o.matrix_world = Matrix()
        o["link"] = src.get("link") or o.name.split(".")[0]
        o["simplified"] = bool(src.get("simplified"))
        if o.data.has_custom_normals:                     # kept for wind_outward's vote: cleared further on
            a = o.data.attributes.new("src_normal", "FLOAT_VECTOR", "FACE")
            a.data.foreach_set("vector", source_normals(o.data).ravel())
        meshes.append(o)
    for o in new:
        if o.type != "MESH":
            bpy.data.objects.remove(o)
    dropped = [o for o in meshes if o["link"] in src.get("drop_links", [])]
    for o in dropped:                                     # the mapping's drop_links: hidden or needless detail
        bpy.data.objects.remove(o)
    return [o for o in meshes if o not in dropped]


# --- per-face data -----------------------------------------------------------------------------------------------------
def face_arrays(me):
    n = len(me.polygons)
    ce = np.empty(n * 3)
    me.polygons.foreach_get("center", ce)
    no = np.empty(n * 3)
    me.polygons.foreach_get("normal", no)
    ar = np.empty(n)
    me.polygons.foreach_get("area", ar)
    return ce.reshape(-1, 3), no.reshape(-1, 3), ar


def parts(me) -> np.ndarray:
    """Connected solids: faces joined through vertices at the same position (to 0.01 mm), so a CAD solid tessellated
    face by face, its faces' vertices unwelded, is still one part."""
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    key = np.round(co.reshape(-1, 3) / 1e-5).astype(np.int64)
    _, vid = np.unique(key, axis=0, return_inverse=True)
    vid = vid.ravel()
    parent = np.arange(vid.max() + 1)

    def find(a):
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:
            parent[a], a = root, parent[a]
        return root
    tot = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get("loop_total", tot)
    vi = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get("vertex_index", vi)
    lv = vid[vi]
    start = np.concatenate([[0], np.cumsum(tot)[:-1]])
    for s, t in zip(start, tot):                          # union every face's vertices with its first
        a = find(lv[s])
        for b in lv[s + 1:s + t]:
            rb = find(b)
            if rb != a:
                parent[rb] = a
    roots = np.array([find(v) for v in range(len(parent))])
    _, part = np.unique(roots[lv[start]], return_inverse=True)
    return part.ravel()


def source_normals(me) -> np.ndarray:
    """Each face's normal as the source drew it: its corners' normals summed (the CAD's own). Taken at import, as
    the face attribute src_normal, before a simplified source's custom normals are cleared."""
    cn = np.empty(len(me.loops) * 3, np.float32)
    me.corner_normals.foreach_get("vector", cn)
    ls = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get("loop_start", ls)
    return np.add.reduceat(cn.reshape(-1, 3), ls)


def open_parts(me, part: np.ndarray):
    """Per part, whether it is an open shell (a sheet, a surface model) rather than a closed solid: some edge of it,
    its vertices welded by position, has only one face. Also the pairs of faces across every edge two faces share."""
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    _, vid = np.unique(np.round(co.reshape(-1, 3) / 1e-5).astype(np.int64), axis=0, return_inverse=True)
    vid = vid.ravel()
    vi = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get("vertex_index", vi)
    ls = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get("loop_start", ls)
    lt = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get("loop_total", lt)
    face = np.repeat(np.arange(len(lt)), lt)
    nxt = np.arange(len(vi)) + 1
    last = ls + lt - 1
    nxt[last] = ls                                   # each loop's next corner, wrapping round its face
    a, b = vid[vi], vid[vi[nxt]]
    e = np.stack([np.minimum(a, b), np.maximum(a, b)], 1)
    _, inv, cnt = np.unique(e, axis=0, return_inverse=True, return_counts=True)
    inv = inv.ravel()
    single = cnt[inv] == 1
    out = np.zeros(int(part.max()) + 1, bool)
    out[np.unique(part[face[single]])] = True
    # faces across each edge two faces share: sort the corners by edge, pair neighbours
    two = np.nonzero(cnt[inv] == 2)[0]
    o = two[np.argsort(inv[two], kind="stable")]
    pairs = np.stack([face[o[0::2]], face[o[1::2]]], 1)
    return out, pairs


def wind_outward(obj, part: np.ndarray, smooth_deg: float) -> dict:
    """Vendor CAD faces some surfaces inward, and a face wound inward bakes its AO from inside the machine (the
    laser's doors came out black). normals_make_consistent is no fix: on unwelded CAD every face is its own island and
    it turned 22-65% of batch A's assets inward. Instead:
    1. vote: a face whose winding disagrees with the source's own normals is turned to agree;
    2. a closed solid is left as the CAD wound it (outward to within 0.2%, batch B) unless rays show it inside out
       as a whole: then it is turned whole;
    3. on open shells (sheets, surface models, where the CAD's own normals can face into the machine, and even mix
       within one shell), each face is turned over when rays leave the model from its back and not from its front.
    Returns the shares of area flipped and the share left opposite the source, which check() gates."""
    me = obj.data
    a = me.attributes.get("src_normal")
    if a is None:
        # no source normals to vote with (a positions-only simplification, stripped of them): its winding is the
        # source's, which batch B measured outward to within 0.2%. Leave it as it came.
        log("winding: left as imported (no source normals)")
        return {"vote_flipped_share": 0.0, "outside_flipped_share": 0.0, "against_source_share": 0.0,
                "unintended_share": 0.0, "source_normals": False}
    src = np.empty(len(me.polygons) * 3, np.float32)
    a.data.foreach_get("vector", src)
    src = src.reshape(-1, 3)
    ce, fn, ar = face_arrays(me)
    total = float(ar.sum()) or 1.0
    vote = np.einsum("ij,ij->i", fn, src) < 0
    fv = np.where(vote[:, None], -fn, fn)
    is_open, pairs = open_parts(me, part)
    shell = is_open[part]
    tree = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())
    size = float(np.linalg.norm(ce.max(0) - ce.min(0)))
    reach, eps = size * 3 + 1.0, max(size * 1e-5, 1e-6)
    rng = np.random.default_rng(7)
    score = np.zeros(len(fv))                         # rays out of the back minus rays out of the front
    for f in np.nonzero(shell)[0]:
        d0, c = Vector(fv[f]), Vector(ce[f])
        for j in rng.normal(0, 0.15, (3, 3)):        # three rays a side, a little apart, so one graze can't decide
            d = (d0 + Vector(j)).normalized()
            score[f] += (tree.ray_cast(c - d0 * eps, -d, reach)[0] is None) -                 (tree.ray_cast(c + d0 * eps, d, reach)[0] is None)
    # decide by patch, not by face: a flat or smooth stretch of shell (neighbours within ~25 deg, either winding)
    # turns together, by its area's vote, so one triangle can't come out the other way round from its neighbour
    keep = pairs[(np.abs(np.einsum("ij,ij->i", fn[pairs[:, 0]], fn[pairs[:, 1]])) > 0.9)
                 & shell[pairs[:, 0]] & shell[pairs[:, 1]]]
    root = np.arange(len(fv))

    def find(x):
        while root[x] != x:
            root[x] = root[root[x]]
            x = root[x]
        return x
    for i, j in keep:
        ri, rj = find(i), find(j)
        if ri != rj:
            root[ri] = rj
    patch = np.array([find(x) for x in range(len(fv))])
    vote_area = np.bincount(patch, weights=score * ar, minlength=len(fv))
    outside = shell & (vote_area[patch] > 0)
    # a closed solid can be inside out as a whole (the laser's thin door slabs: every face wound into the slab, the
    # CAD's normals with them). Turned whole when its biggest faces' rays leave from the back far more than the front;
    # a right-way-out solid's back rays hit its own inside, so it never is.
    n_parts = int(part.max()) + 1
    order = np.lexsort((-ar, part))
    starts = np.searchsorted(part[order], np.arange(n_parts))
    ends = np.append(starts[1:], len(order))
    inverted = np.zeros(n_parts, bool)
    for p in np.nonzero(~is_open)[0]:
        front = back = 0
        faces = order[starts[p]:ends[p]][:24]
        for f in faces:
            d, c = Vector(fv[f]), Vector(ce[f])
            front += tree.ray_cast(c + d * eps, d, reach)[0] is None
            back += tree.ray_cast(c - d * eps, -d, reach)[0] is None
        inverted[p] = back >= 2 * front + 2 and back >= 0.25 * len(faces)
    outside |= inverted[part]
    flip = vote ^ outside
    if flip.any():
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.reverse_faces(bm, faces=[bm.faces[i] for i in np.nonzero(flip)[0]])
        bm.to_mesh(me)
        bm.free()
        if me.has_custom_normals:                      # the source's normals no longer match the flipped faces
            with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
                bpy.ops.mesh.customdata_custom_splitnormals_clear()
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(smooth_deg))
    _, fn2, _ = face_arrays(me)
    against = np.einsum("ij,ij->i", fn2, src) < 0
    out = {"vote_flipped_share": round(float(ar[vote].sum()) / total, 4),
           "outside_flipped_share": round(float(ar[outside].sum()) / total, 4),
           "open_shell_share": round(float(ar[shell].sum()) / total, 4),
           "solids_turned": int(inverted.sum()),
           "against_source_share": round(float(ar[against].sum()) / total, 4),
           "unintended_share": round(float(ar[against & ~outside].sum()) / total, 4)}
    log(f"winding: {out}")
    return out


def select(rule: dict, ctx: dict) -> np.ndarray:
    """The faces a mapping rule picks: every condition given must hold."""
    ce, no, names = ctx["centre"], ctx["normal"], ctx["names"]
    m = np.ones(len(ce), bool)
    if "links" in rule:
        m &= np.isin(ctx["link"], [ctx["links"].index(x) for x in rule["links"] if x in ctx["links"]])
    if "cads" in rule:
        m &= np.isin(ctx["cad"], [ctx["cads"].index(x) for x in rule["cads"] if x in ctx["cads"]])
    if "from" in rule:
        m &= np.isin(names, rule["from"])
    if "inside" in rule:
        lo, hi = np.array(rule["inside"]["lo"]), np.array(rule["inside"]["hi"])
        m &= np.all((ce > lo) & (ce < hi), 1)
    if "outside" in rule:
        lo, hi = np.array(rule["outside"]["lo"]), np.array(rule["outside"]["hi"])
        m &= ~np.all((ce > lo) & (ce < hi), 1)
    if "normal" in rule:
        d = np.array(rule["normal"]["dir"], float)
        dot = no @ (d / np.linalg.norm(d))
        m &= (dot >= rule["normal"].get("min", -1.0)) & (dot <= rule["normal"].get("max", 1.0))
    if "toward" in rule:
        c = np.array(rule["toward"]["point"])
        v = c - ce
        m &= np.einsum("ij,ij->i", no, v) / (np.linalg.norm(v, axis=1) + 1e-9) >= rule["toward"]["min"]
    if "part_inside" in rule or "part_size" in rule or "parts" in rule:
        plo, phi = ctx["part_lo"], ctx["part_hi"]
        ok = np.ones(len(plo), bool)
        if "part_inside" in rule:
            lo, hi = np.array(rule["part_inside"]["lo"]), np.array(rule["part_inside"]["hi"])
            ok &= np.all((plo >= lo) & (phi <= hi), 1)
        if "part_size" in rule:
            ext = np.sort(phi - plo, 1)[:, ::-1]                  # longest side first
            for k, v in rule["part_size"].items():
                ax = {"max_side": 0, "mid_side": 1, "min_side": 2}[k.split("_", 1)[1]]
                ok &= (ext[:, ax] <= v) if k.startswith("max") else (ext[:, ax] >= v)
        if "parts" in rule:
            sel = np.zeros(len(plo), bool)
            sel[[p for p in rule["parts"] if p < len(plo)]] = True
            ok &= sel
        m &= ok[ctx["part"]]
    return m


# --- hand fixes ----------------------------------------------------------------------------------------------------------
def fit_pane(obj, rule: dict):
    """A window opening with no glass in the CAD (the VF-2's doors): rays through the closed door along the rule's
    axis on an 8 mm grid; the largest enclosed region they pass through gets a pane just behind its front face.
    Ported from the spike's build_bay.py."""
    me = obj.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    tree = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())
    step = 0.008
    xs = np.arange(co[:, 0].min() + step, co[:, 0].max() - step / 2, step)
    zs = np.arange(co[:, 2].min() + step, co[:, 2].max() - step / 2, step)
    y0 = co[:, 1].min() - 0.5
    hit = np.zeros((len(zs), len(xs)), bool)
    hy = np.full((len(zs), len(xs)), np.nan)
    for i, z in enumerate(zs):
        for j, x in enumerate(xs):
            loc, *_ = tree.ray_cast(Vector((x, y0, z)), Vector((0, 1, 0)), 3.0)
            if loc is not None:
                hit[i, j], hy[i, j] = True, loc.y
    miss = ~hit
    lab = np.zeros(miss.shape, np.int32)
    k = 0
    for i0, j0 in zip(*np.nonzero(miss)):
        if lab[i0, j0]:
            continue
        k += 1
        stack = [(i0, j0)]
        lab[i0, j0] = k
        while stack:
            i, j = stack.pop()
            for a, b in ((i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1)):
                if 0 <= a < miss.shape[0] and 0 <= b < miss.shape[1] and miss[a, b] and not lab[a, b]:
                    lab[a, b] = k
                    stack.append((a, b))
    best, size = 0, 0
    for r in range(1, k + 1):
        m = lab == r
        ii, jj = np.nonzero(m)
        if ii.min() == 0 or jj.min() == 0 or ii.max() == miss.shape[0] - 1 or jj.max() == miss.shape[1] - 1:
            continue
        if m.sum() > size:
            best, size = r, m.sum()
    if not best:
        log(f"{obj['link']}: no window opening found")
        return None
    ii, jj = np.nonzero(lab == best)
    x0, x1, z0, z1 = xs[jj.min()], xs[jj.max()], zs[ii.min()], zs[ii.max()]
    ring = (lab != best) & hit
    near = np.zeros_like(ring)
    near[max(ii.min() - 3, 0):ii.max() + 4, max(jj.min() - 3, 0):jj.max() + 4] = True
    y_front = float(np.nanmedian(np.where(ring & near, hy, np.nan)))
    pad = 0.012
    bm = bmesh.new()
    lo, hi = Vector((x0 - pad, y_front + 0.004, z0 - pad)), Vector((x1 + pad, y_front + 0.008, z1 + pad))
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((lo + hi) / 2) @ Matrix.Diagonal((*(hi - lo), 1)))
    me2 = bpy.data.meshes.new(f"{obj['link']}_pane")
    bm.to_mesh(me2)
    bm.free()
    pane = bpy.data.objects.new(me2.name, me2)
    bpy.context.scene.collection.objects.link(pane)
    pane["link"] = obj["link"] + "_pane"
    pane["pane_material"] = rule["material"]
    log(f"{obj['link']}: pane {x1 - x0 + 2 * pad:.3f} x {z1 - z0 + 2 * pad:.3f} m at y {y_front:.3f}")
    return pane


# --- UVs -------------------------------------------------------------------------------------------------------------------
def uv0_box(me):
    """Each face projected along its dominant axis, 1 UV unit = 1 m, never mirrored."""
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    W = co.reshape(-1, 3)
    pn = np.empty(len(me.polygons) * 3)
    me.polygons.foreach_get("normal", pn)
    pn = pn.reshape(-1, 3)
    tot = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get("loop_total", tot)
    vi = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get("vertex_index", vi)
    nl = pn[np.repeat(np.arange(len(me.polygons)), tot)]
    p = W[vi]
    ax = np.argmax(np.abs(nl), 1)
    sgn = np.sign(nl[np.arange(len(nl)), ax])
    sgn[sgn == 0] = 1
    u = np.where(ax == 0, p[:, 1] * sgn, np.where(ax == 1, -p[:, 0] * sgn, p[:, 0]))
    v = np.where(ax == 2, p[:, 1] * sgn, p[:, 2])
    me.uv_layers["UV0"].data.foreach_set("uv", np.stack([u, v], 1).astype(np.float32).ravel())


def uv1_atlas(obj, margin: float):
    """Smart UV Project, then one pack: one AO atlas for the whole asset."""
    vl = bpy.context.view_layer
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    vl.objects.active = obj
    obj.data.uv_layers.active = obj.data.uv_layers["UV1"]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0, correct_aspect=True,
                             scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.uv_layers.active = obj.data.uv_layers["UV0"]
    obj.data.uv_layers["UV0"].active_render = True


def uv_area(me, layer: str) -> float:
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers[layer].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    me.calc_loop_triangles()
    t = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get("loops", t)
    a, b, c = (uv[t.reshape(-1, 3)[:, k]] for k in range(3))
    u, v = b - a, c - a
    return float(np.abs(u[:, 0] * v[:, 1] - u[:, 1] * v[:, 0]).sum() / 2)


# --- materials ---------------------------------------------------------------------------------------------------------
def lib_material(name: str, colours: dict) -> bpy.types.Material:
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat["lib"] = name
    c = colours.get(name, (0.5, 0.5, 0.5, 1.0))
    mat.diffuse_color = c                                  # Workbench draws this: the review pictures
    b = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = c
    return mat


def main():
    J = job()
    mp = J["mapping"]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objs = []
    for src in J["sources"]:
        objs += import_source(src)
    log(f"imported {len(objs)} meshes from {len(J['sources'])} files ({time.perf_counter() - T0:.0f} s)")
    # smooth shading where the source has no normals (the band saw's links are positions only)
    for o in objs:
        if o.get("simplified") and o.data.has_custom_normals:
            # the simplifier moved vertices but kept their old normals, which shades blotchy: recompute them
            with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
                bpy.ops.mesh.customdata_custom_splitnormals_clear()
        if not o.data.has_custom_normals:
            o.data.shade_smooth()
            o.data.set_sharp_from_angle(angle=math.radians(mp.get("smooth_deg", 30)))
    # hand fixes that make geometry: window panes
    for rule in mp.get("ops", []):
        if rule["op"] == "pane":
            for o in [o for o in objs if o["link"] in rule["links"]]:
                p = fit_pane(o, rule)
                if p is not None:
                    objs.append(p)
    # per-face link and CAD material, as attributes, then everything joined into one object
    links = sorted({o["link"] for o in objs})
    cads = sorted({(s.material.name.split(".")[0] if s.material else "none") for o in objs for s in o.material_slots}
                  | {"none", "pane"})
    for o in objs:
        me = o.data
        n = len(me.polygons)
        idx = np.zeros(n, np.int32)
        me.polygons.foreach_get("material_index", idx)
        slot = [cads.index(s.material.name.split(".")[0] if s.material else "none") for s in o.material_slots]
        cad = np.array(slot, np.int32)[idx] if slot else np.full(n, cads.index("pane" if "pane_material" in o else "none"))
        for name, vals in (("link_idx", np.full(n, links.index(o["link"]), np.int32)), ("cad_idx", cad)):
            a = me.attributes.get(name) or me.attributes.new(name, "INT", "FACE")
            a.data.foreach_set("value", vals)
        me.materials.clear()
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = obj.data.name = J["asset"]
    me = obj.data
    log(f"joined: {len(me.polygons)} faces ({time.perf_counter() - T0:.0f} s)")
    # parts and the context the rules select from
    part = parts(me)
    winding = None
    if J.get("recalc_normals"):
        winding = wind_outward(obj, part, mp.get("smooth_deg", 30))
    ce, no, ar = face_arrays(me)
    n_parts = int(part.max()) + 1
    plo = np.full((n_parts, 3), np.inf)
    phi = np.full((n_parts, 3), -np.inf)
    np.minimum.at(plo, part, ce)
    np.maximum.at(phi, part, ce)
    link = np.empty(len(me.polygons), np.int32)
    me.attributes["link_idx"].data.foreach_get("value", link)
    cad = np.empty(len(me.polygons), np.int32)
    me.attributes["cad_idx"].data.foreach_get("value", cad)
    a = me.attributes.new("part_idx", "INT", "FACE")
    a.data.foreach_set("value", part.astype(np.int32))
    # materials: by (link, CAD name), then the rules in order, later ones winning
    table = mp.get("cad", {})
    fallback = mp["fallback"]
    names = np.empty(len(me.polygons), dtype=object)
    unmapped = {}
    for i in range(len(me.polygons)):
        ln, cn = links[link[i]], cads[cad[i]]
        lib = table.get(ln, {}).get(cn) or table.get("*", {}).get(cn)
        if lib is None and ln.endswith("_pane"):
            lib = fallback                                  # replaced below by its pane rule's material
        elif lib is None:
            unmapped[f"{ln}/{cn}"] = unmapped.get(f"{ln}/{cn}", 0) + 1
            lib = fallback
        names[i] = lib
    pane_links = [ln for ln in links if ln.endswith("_pane")]
    ctx = dict(centre=ce, normal=no, names=names, link=link, links=links, cad=cad, cads=cads, part=part,
               part_lo=plo, part_hi=phi)
    rule_hits = []
    for rule in mp.get("rules", []):
        m = select(rule, ctx)
        names[m] = rule["material"]
        rule_hits.append({"why": rule.get("why", ""), "faces": int(m.sum()), "area_m2": round(float(ar[m].sum()), 4)})
        log(f"rule '{rule.get('why', '')}': {int(m.sum())} faces -> {rule['material']}")
    for ln in pane_links:                                   # a pane is its rule's material
        rule = next(r for r in mp["ops"] if r["op"] == "pane" and ln[:-5] in r["links"])
        names[link == links.index(ln)] = rule["material"]
    libs = sorted(set(names))
    colours = {k: tuple(v) for k, v in J.get("colours", {}).items()}
    for lname in libs:
        me.materials.append(lib_material(lname, colours))
    me.polygons.foreach_set("material_index", [libs.index(x) for x in names])
    # UVs: UV0 tiles, UV1 the AO atlas
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    me.uv_layers.new(name="UV0")
    me.uv_layers.new(name="UV1")
    uv0_box(me)
    # the islands' gap: a few texels at the atlas side this area will likely get (FRACTION margins are absolute, so
    # a fixed fraction collapses an atlas of 50,000 CAD islands to nothing)
    a = J["atlas"]
    side = 2 ** math.ceil(math.log2(math.sqrt(float(face_arrays(me)[2].sum()) / 0.45) / (a["texel_mm"] / 1000)))
    side = min(max(side, a["atlas_min"]), a["atlas_max"])
    # thousands of tiny islands (a spring, a thread) can still eat the square in margins: below UV1_FLOOR the pack
    # is redone with half the gap, down to half a texel, rather than baking an atlas of nothing (edgef baked black)
    t = time.perf_counter()
    margin_px = a["margin_px"]
    uv1_atlas(obj, margin_px / side)
    util = uv_area(me, "UV1")
    while util < UV1_FLOOR and margin_px > 0.5:
        margin_px /= 2
        log(f"UV1: {util:.3f} of the square used: packing again with a {margin_px} px gap")
        obj.data.uv_layers.active = obj.data.uv_layers["UV1"]
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=margin_px / side, shape_method="CONCAVE")
        bpy.ops.object.mode_set(mode="OBJECT")
        obj.data.uv_layers.active = obj.data.uv_layers["UV0"]
        util = uv_area(me, "UV1")
    log(f"UV1: {util:.3f} of the square used, margin {margin_px} px at {side} ({time.perf_counter() - t:.0f} s)")
    # the floor the asset stands on, for the AO only: never exported
    lo = np.min(ce, 0)
    hi = np.max(ce, 0)
    size = max(hi[0] - lo[0], hi[1] - lo[1]) * 3 + 0.2
    bpy.ops.mesh.primitive_plane_add(size=size, location=((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2,
                                                          float(J["bbox_min_z"]) - 0.0005))
    g = bpy.context.view_layer.objects.active
    g.name = "_ao_ground"
    g["occluder_only"] = True
    # report
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    me.calc_loop_triangles()
    by_mat = {}
    for lname in libs:
        sel = names == lname
        by_mat[lname] = {"faces": int(sel.sum()), "area_m2": round(float(ar[sel].sum()), 4)}
    stats = {"asset": J["asset"], "triangles": len(me.loop_triangles), "vertices": len(me.vertices),
             "area_m2": round(float(ar.sum()), 4), "uv1_utilisation": round(util, 4), "uv1_margin_px": margin_px,
             "bbox_m": [co.min(0).round(4).tolist(), co.max(0).round(4).tolist()], "links": links, "cads": cads,
             "parts": n_parts, "materials": by_mat, "unmapped": unmapped, "rules": rule_hits, "winding": winding,
             "seconds": round(time.perf_counter() - T0, 1)}
    Path(J["stats"]).write_text(json.dumps(stats, indent=1))
    if "parts_json" in J:                                  # every part's box, for writing rules
        order = np.argsort(-np.bincount(part, weights=ar, minlength=n_parts))
        rows = [{"part": int(p), "area_m2": round(float(ar[part == p].sum()), 5),
                 "lo": plo[p].round(4).tolist(), "hi": phi[p].round(4).tolist(),
                 "links": sorted({links[x] for x in set(link[part == p].tolist())}),
                 "materials": sorted(set(names[part == p].tolist()))} for p in order[:J.get("parts_listed", 400)]]
        Path(J["parts_json"]).write_text(json.dumps(rows, indent=1))
    bpy.ops.wm.save_as_mainfile(filepath=J["blend"])
    log(f"saved {J['blend']}: {stats['triangles']} triangles, {len(libs)} materials, "
        f"{len(unmapped)} unmapped (link, CAD) pairs ({stats['seconds']} s)")


main()
