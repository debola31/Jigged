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
- Checked under **AgX**; ACESFilmic (the page today) renders the same materials more saturated and contrasty.

## Swap-in

1. Load the light models as today. Start the realistic ones only after every light model is in and the page is idle
   (`requestIdleCallback`), so the first view is exactly as fast as today.
2. Stream in `load_order` (heroes first, then `near`, then `other`), re-sorted by distance to the current station,
   two at a time. Pause while the camera is flying; resume when it stops.
3. Before swapping, `await renderer.compileAsync(full, camera, scene)` so shaders and texture uploads don't hitch
   the next frame. Then, in one frame, replace the light model under every item of that asset, dispose the light
   geometry and materials, and redraw the shadow map once (`shadowMap.needsUpdate = true`).
4. A failed full model keeps its light one: report it once, as model failures are reported today.
5. **Phones:** the shop on cellular is a different budget. Suggested: no realistic models when
   `navigator.connection?.saveData`, a 2G/3G `effectiveType` or `deviceMemory < 4`; heroes only on other phones
   (about 21 MB with the tiles, 70 MB of GPU); everything on desktop. The page's call.

## Picking, highlighting and shadows

- Same frame and box as the light model, checked per asset against the record's bbox (`validation.checks.frame`). Two
  stand proud of it on purpose: the VF-2's left door, slid open 0.55 m, by 33 mm; the vise's handle by 90 mm (x) and
  55 mm (z). Picking by the record's box and the outlines need no change.
- One mesh per material, nothing named per part: highlighting stays the box outline. Keep `raycast = () => {}`.
- `castShadow` on every mesh except transparent ones (the VF-2's door panes); `receiveShadow` on all.

## Measured (pilot, 1080p, GTX 1070, shadows drawn once as the page does)

| | today, all light | 4 realistic | 4 realistic + 2 more copies each | projection, all 95 built |
|---|---|---|---|---|
| triangles drawn | 0.99 M | 1.50 M | 2.75 M | 2.26 M |
| frame | 6.1 ms | 8.3 ms | 11.5 ms | ~10.4 ms (3.2 ms per million triangles) |

Download, all 95 projected: about 66 MB (tiles 7.8 MB); GPU textures about 0.27 GB; see `projection.json` in
`<data>/realism/`. Regenerate with `python -m moonshot.web.realism project`.
