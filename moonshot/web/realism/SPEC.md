# Realistic shop models: what the page needs

The contract between `moonshot/web/realism` (which writes the models) and the showcase page (which shows them).
Verified 2026-11-05 on the pilot (vf2, bandsaw, d688, cat40) with `preview/index.html`: three.js r186, headless
Chromium on a GTX 1070 (ANGLE/D3D11). The numbers come from `manifest.json` beside this file.

## Files

All paths are relative to the media root (`NEXT_PUBLIC_SHOWCASE_MEDIA_URL`), as the light models' paths are.

| Path | What |
|---|---|
| `models/<asset>.glb` | today's light model: unchanged, still loaded first |
| `models-full/<asset>.glb` | the realistic model: same frame as the light one, so the same group, position and rotation |
| `models-full/manifest.json` | per asset: `light`, `full`, `bytes`, `triangles`, `draw_calls`, GPU bytes, `tiles`, `priority`, `load_order`, `validation`; and the shop `totals` |
| `tiles/<family>_{base,mr,nrm}.ktx2` | the shared tiles: about 8 MB, used by every model, downloaded once |

Assets missing from `manifest.assets` have no realistic model yet: keep their light model.

## Loaders and extensions

- `GLTFLoader` with `MeshoptDecoder` (as today) and **`KTX2Loader`** (`setTranscoderPath` to three's
  `examples/jsm/libs/basis/`, then `detectSupport(renderer)`). In drei: the 4th argument of `useGLTF`,
  `(loader) => loader.setKTX2Loader(ktx2).register(sharedTiles)`.
- Required by every model: `KHR_texture_basisu`, `EXT_meshopt_compression`, `KHR_mesh_quantization`. Also used:
  `KHR_texture_transform` (every tile), `KHR_materials_clearcoat` (the Kurt vise), `KHR_materials_emissive_strength`.
- **No `KHR_materials_transmission`, anywhere.** three.js draws a transmissive material by rendering the whole
  opaque scene again, so one window pane would double the shop's draw calls. Glass is `alphaMode: BLEND`.

## The shared tiles: one cache for the page, or the GPU budget is blown

Every model names the same `../tiles/*.ktx2` files by URI (they are not embedded). GLTFLoader caches images per
file it parses, so without help each model uploads its own copy of every tile it uses: 22 tiles are about 23 MB of
GPU memory once, but a copy per asset is about a gigabyte across the shop. Register this plugin on the loader; it keeps one load per tile URL
for the page and hands each model a clone, which shares the GPU texture (three.js keys uploads by `Source`).

```ts
const tileCache = new Map<string, Promise<Texture>>();
export function sharedTiles(parser: GLTFParser) {
  const load = parser.loadImageSource.bind(parser);
  parser.loadImageSource = (index: number, loader: Loader) => {
    const uri: string | undefined = parser.json.images[index].uri;
    if (!uri?.includes('tiles/')) return load(index, loader);
    const url = LoaderUtils.resolveURL(uri, parser.options.path);
    if (!tileCache.has(url)) tileCache.set(url, load(index, loader));
    return tileCache.get(url)!.then((t) => t.clone());
  };
  return { name: 'jigged_shared_tiles' };
}
```

A `register()`ed plugin's own `loadTexture` won't do: the built-in `KHR_texture_basisu` plugin answers first.

## Textures, UVs and colour spaces

| Slot | Image | UV | Colour space | Note |
|---|---|---|---|---|
| baseColor | `tiles/<family>_base.ktx2` (ETC1S) | 0 + `KHR_texture_transform` | sRGB | grey; `baseColorFactor` is the colour |
| metallicRoughness | `tiles/<family>_mr.ktx2` (UASTC) | 0 + transform | linear | G roughness, B metalness; the factors scale both |
| normal | `tiles/<family>_nrm.ktx2` (UASTC) | 0 + transform | linear | OpenGL convention; no tangents: three derives them |
| occlusion | embedded `ao` (ETC1S, one per asset) | **TEXCOORD_1** | linear | GLTFLoader sets `aoMap.channel = 1` itself |

The texture transform carries both the tile's physical scale and a normalisation of UV0 (box-projected in metres),
so UV0 quantises to 16 bits. GLTFLoader applies it: nothing to do. Desktop transcodes every KTX2 to BC7 (1 byte a
texel), phones to ASTC; the manifest's GPU bytes assume 1 byte a texel plus mipmaps.

## Lighting

- **AO per asset plus one realtime key light**, not lightmaps: the AO is baked with the asset alone on a floor, so it
  survives any layout change. three.js applies `aoMap` to indirect light only, so the key light (a shadowed
  `DirectionalLight`) supplies the direct light and its shadows.
- **Metals need an environment map** (`scene.environment`), or they render black. The pilot was checked with the
  step videos' HDRI (`machine_shop_02`, intensity 0.6, rotated by π); RoomEnvironment works too, flatter.
- Checked under **AgX**, which the page is moving to.

## Swap-in: level of detail by screen size

A realistic model shows only while its item is big enough on screen to matter; everywhere else, the overview
included, the light model stays. Measured below: the whole-shop view costs about what it does today.

1. **Load** the light models as today. Then, when every light model is in and the page is idle
   (`requestIdleCallback`), stream the realistic ones in `load_order` (heroes first), two at a time, paused while the
   camera flies. Before an item may show its realistic model it must be loaded and `await renderer.compileAsync(...)`ed.
2. **Rule, per item, each frame the camera moves:** `share = r / (max(d, r) * tan(fov / 2))`, where `r` is the
   radius of the item's bounding sphere (from the record's `bbox`, as picking uses) and `d` the camera's distance to
   its centre: roughly the fraction of the view's height the item spans.
   - **Swap forward** to realistic when `share >= 0.20`; **swap back** to light when `share < 0.14`. The gap is
     the hysteresis, so an item at the edge doesn't flicker as the camera glides.
   - Items outside the frustum keep their state; they cost nothing drawn.
   - **Cap:** among the items that qualify, biggest share first, at most **1.5 M realistic triangles** at once
     (`manifest.assets[a].triangles`); the rest stay light.
3. **Both stay resident.** Swapping is `visible` on two children of the item's group, so it's instant both ways;
   with every realistic model loaded the GPU holds about 0.33 GB (textures 0.25 GB, geometry 0.08 GB; light models
   negligible), inside the 1 GB budget, so nothing is disposed. Only evict (dispose the realistic model, keep the
   light) if a device reports memory pressure; the rule then reloads it when it next qualifies.
4. **Shadows:** a swap changes geometry, so redraw the static shadow map once after swaps settle (debounced
   ~300 ms after the camera stops), never every frame.
5. **A failed realistic model** keeps its light one: report it once, as model failures are reported today.
6. **Phones get no realistic models**: light models only, no swap (decided 2026-11-05). The page already tells a
   phone from a desktop for its controls (touch gets no orbit); the same test gates the stream.

The rule and the views are in `preview/index.html` (`lodUpdate`), measured with
`python -m moonshot.web.realism.loadcheck --lod`.

## Picking, highlighting and shadows

- Same frame and box as the light model, checked per asset against the record's bbox (`validation.checks.frame`). One
  stands proud of it on purpose: the vise's handle, by 90 mm (x) and 55 mm (z). Picking by the record's box and the
  outlines need no change. The VF-2's doors are shut, as in the light model, so the swap changes no silhouette.
- One mesh per material, nothing named per part: highlighting stays the box outline. Keep `raycast = () => {}`.
- `castShadow` on every mesh except transparent ones (the VF-2's door panes); `receiveShadow` on all.

## Measured (1080p, GTX 1070, three.js r186 in headless Chromium, shadows drawn once)

With 73 realistic models built (2026-11-05, 21:10); frame time with the triangles drawn and the realistic items shown.

| View (the page's) | all light | all realistic | with the swap rule |
|---|---|---|---|
| Whole shop (overview) | 5.4 ms, 0.87 M | 12.6 ms, 2.27 M | **7.3 ms**, 1.15 M, 3 realistic |
| Milling zone, from the south | 3.5 ms, 0.34 M | 6.8 ms, 0.87 M | **6.3 ms**, 0.77 M, 6 realistic |
| VF-2 from its operator side | 2.5 ms, 0.07 M | 3.9 ms, 0.36 M | **3.7 ms**, 0.36 M, 3 realistic |
| Main aisle at eye height | 6.0 ms, 0.94 M | 12.3 ms, 2.42 M | **7.5 ms**, 1.30 M, 7 realistic |

Shadows redrawn every frame add 2-3 ms; the page's room adds about 0.5 ms (the scene agent's measurement). About
3.2 ms per million triangles drawn. The projection for all 95 and the download and GPU totals are in
`<data>/realism/projection.json` (`python -m moonshot.web.realism project`).
