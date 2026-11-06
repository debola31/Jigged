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

## Swap-in

1. Load the light models as today. Start the realistic ones only after every light model is in and the page is idle
   (`requestIdleCallback`), so the first view is exactly as fast as today.
2. Stream in `load_order` (heroes first, then `near`, then `other`), re-sorted by distance to the current station,
   two at a time. Pause while the camera is flying; resume when it stops.
3. Before swapping, `await renderer.compileAsync(full, camera, scene)` so shaders and texture uploads don't hitch
   the next frame. Then, in one frame, replace the light model under every item of that asset, dispose the light
   geometry and materials, and redraw the shadow map once (`shadowMap.needsUpdate = true`).
4. A failed full model keeps its light one: report it once, as model failures are reported today.
5. **Phones get no realistic models**: light models only, no swap (decided 2026-11-05). The page already tells a
   phone from a desktop for its controls (touch gets no orbit); the same test gates the stream. A phone on
   cellular can't spend ~66 MB and a phone GPU ~0.3 GB on what is a few hundred pixels across.

## Picking, highlighting and shadows

- Same frame and box as the light model, checked per asset against the record's bbox (`validation.checks.frame`). One
  stands proud of it on purpose: the vise's handle, by 90 mm (x) and 55 mm (z). Picking by the record's box and the
  outlines need no change. The VF-2's doors are shut, as in the light model, so the swap changes no silhouette.
- One mesh per material, nothing named per part: highlighting stays the box outline. Keep `raycast = () => {}`.
- `castShadow` on every mesh except transparent ones (the VF-2's door panes); `receiveShadow` on all.

## Measured (1080p, GTX 1070, three.js r186 in headless Chromium)

| Whole shop | triangles drawn | draws | frame, shadows drawn once (as the page does) | frame, shadows every frame |
|---|---|---|---|---|
| today, all light | 0.99 M | 432 | 6.2 ms | 5.8-7.6 ms |
| pilot: 4 realistic | 1.50 M | 443 | 8.3 ms | 10.4 ms |
| 73 realistic (2026-11-05, 20:50) | 2.48 M | 546 | **12.1 ms** | 15.0 ms |

About 3.2 ms per million triangles drawn. The projection for all 95 and the download and GPU totals are in
`<data>/realism/projection.json` (`python -m moonshot.web.realism project`); the page's own room and
post-processing come on top, so keep shadows static.
