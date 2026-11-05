// What the shop view and the part view share: a renderer in a container, one light, and a loader
// for the meshopt-compressed GLBs the media pipeline writes.
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BRAND } from '@/components/marketing/marketingStyles';

export function createRenderer(container: HTMLElement): WebGLRenderer {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);
  return renderer;
}

/** The page's indigo behind, a soft room reflected in the metal, and a sun from the upper left. */
export function light(scene: Scene, renderer: WebGLRenderer): void {
  scene.background = new Color(BRAND.indigo);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.6;
  scene.add(new HemisphereLight('#ffffff', '#30344a', 1.4));
  const sun = new DirectionalLight('#ffffff', 1.6);
  sun.position.set(-20, 40, 25);
  scene.add(sun);
}

export function gltfLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}
