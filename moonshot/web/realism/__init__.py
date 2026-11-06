"""The shop's realistic models: each placed asset rebuilt at full detail with real materials and baked AO, streamed in
after the light models (`media.py models`) and swapped in per asset. The VF-2 bay spike proved the look
(<data>/realism-spike/REPORT.md); this is that spike as a budgeted pipeline for every asset.

    python -m moonshot.web.realism tiles                    # the shared tile library -> <data>/web/tiles/
    python -m moonshot.web.realism build vf2 d688 ...       # per asset: prepare, bake, export, pack, validate
    python -m moonshot.web.realism look vf2                 # review pictures: mapping colours and the packed result
    python -m moonshot.web.realism manifest                 # <data>/web/models-full/manifest.json

What each piece holds:
- matlib.py: surface families (the shared, tileable texture sets) and materials (a family plus factors), as data;
- mappings/<asset>.json: which material each face of an asset gets, by (link, CAD material) and geometric rules;
  reviewed by eye from `look` pictures, never guessed from a CAD name alone (the spike's mat_10 lesson);
- budgets.py: the UX budgets (download, GPU memory, triangles) per priority tier, and how they are estimated;
- blender/: the Blender steps (prepare, bake, export, renders); pack/: gltf-transform (KTX2, meshopt) and the
  glTF validator, run with node from <data>/realism/node so no node_modules lands in the checkout.

The web side's contract (loaders, the shared tiles, colour spaces, the swap-in) is SPEC.md beside this file.
"""
