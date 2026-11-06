// The realistic shop models' loader, as moonshot/web/realism/SPEC.md has it: meshopt geometry, KTX2
// textures, and one shared copy of the tiles every model names. Imported only once the light shop
// has settled on a desktop, so none of it weighs on the first view.
import { LoaderUtils, LoadingManager, type Loader, type Object3D, type Texture, type WebGLRenderer } from 'three';
import { GLTFLoader, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** Where scripts/copy-basis-transcoder.mjs puts three's transcoder, so it loads from our origin. */
const TRANSCODER = '/wasm/basis/';

export interface RealisticLoader {
  load(url: string): Promise<Object3D>;
  dispose(): void;
}

export function realisticLoader(gl: WebGLRenderer): RealisticLoader {
  // Its own manager, so these don't count as the shop's models in the load status.
  const manager = new LoadingManager();
  const ktx2 = new KTX2Loader(manager).setTranscoderPath(TRANSCODER).detectSupport(gl);
  // Every model names the same ../tiles/*.ktx2 by URI. GLTFLoader caches images per file it parses,
  // so without this each model would upload its own copy of every tile (about 1 GB across the shop
  // against 23 MB once). One load per tile URL for the page; each model gets a clone, which shares
  // the GPU texture, since three.js keys uploads by Source. A plugin's own loadTexture won't do:
  // the built-in KHR_texture_basisu plugin answers first.
  const tiles = new Map<string, Promise<Texture>>();
  const sharedTiles = (parser: GLTFParser) => {
    const load = parser.loadImageSource.bind(parser);
    parser.loadImageSource = (index: number, loader: Loader) => {
      const uri: string | undefined = parser.json.images[index].uri;
      if (!uri?.includes('tiles/')) return load(index, loader);
      const url = LoaderUtils.resolveURL(uri, parser.options.path);
      if (!tiles.has(url)) tiles.set(url, load(index, loader));
      return tiles.get(url)!.then((t) => t.clone());
    };
    return { name: 'jigged_shared_tiles' };
  };
  const gltf = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2).register(sharedTiles);
  return {
    load: async (url) => (await gltf.loadAsync(url)).scene,
    dispose: () => ktx2.dispose(),
  };
}
