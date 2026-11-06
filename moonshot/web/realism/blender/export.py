"""Export a prepared asset's geometry as glTF, in the library's frame (metres, +Y up, its front toward glTF +Z), with
both UV sets (TEXCOORD_0 tiles, TEXCOORD_1 the AO atlas) and its normals. Materials go out as named stubs, one per
library material: pack.mjs builds them from the library, so a glTF material is defined in one place.

    blender -b --factory-startup --python export.py -- <job.json>     (job: blend, asset, raw)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import bpy

J = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
bpy.ops.wm.open_mainfile(filepath=J["blend"])
for o in list(bpy.data.objects):
    if o.get("occluder_only") or o.type != "MESH":
        bpy.data.objects.remove(o)
obj = bpy.data.objects[J["asset"]]
for name in ("link_idx", "cad_idx", "part_idx", "src_normal"):          # review data, not for the page
    if name in obj.data.attributes:
        obj.data.attributes.remove(obj.data.attributes[name])
for s in obj.material_slots:
    nt = s.material.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], out.inputs["Surface"])
for o in bpy.context.selected_objects:
    o.select_set(False)
obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=J["raw"], export_format="GLB", use_selection=True, export_yup=True,
                          export_apply=False, export_extras=False, export_texcoords=True, export_normals=True,
                          export_tangents=False, export_materials="EXPORT", export_cameras=False, export_lights=False,
                          export_animations=False, export_image_format="NONE", export_attributes=False)
print("[export] wrote", J["raw"], flush=True)
