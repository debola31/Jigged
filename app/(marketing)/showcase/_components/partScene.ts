// The part as a machine cycle leaves it, for a mouse to turn: the take's last stock mesh (mm, +Y
// up), framed from where the step's still is taken. Nothing moves but the camera, so it draws on
// demand.
import { Box3, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Sphere, Vector3, type Object3D, type WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRenderer, gltfLoader, light } from './sceneBasics';

// The still's camera from the part (pipeline.py STILL_FROM_MM: in front, a little right, above),
// turned into the glTF frame.
const FROM = new Vector3(120, 230, 330).normalize();
// The meshes carry no normals. Facets of one curved face meet at a few degrees and are smoothed;
// a machined edge is near 90 degrees and stays sharp.
const CREASE = (30 * Math.PI) / 180;
const FOV = 30;

export class PartScene {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV, 1, 1, 10_000);
  private controls: OrbitControls;
  private resize: ResizeObserver;
  private part: Object3D | null = null;
  private url = '';
  private disposed = false;

  constructor(private container: HTMLElement) {
    this.renderer = createRenderer(container);
    light(this.scene, this.renderer);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // Turning only: a wheel over the page scrolls it, and the part stays centred.
    this.controls.enableZoom = false;
    this.controls.enablePan = false;
    this.controls.addEventListener('change', () => this.render());
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
  }

  /** Loads and draws the model at url. False if another was asked for (or the view closed) meanwhile. */
  async show(url: string): Promise<boolean> {
    this.url = url;
    const gltf = await gltfLoader().loadAsync(url);
    if (this.disposed || url !== this.url) return false;
    this.clear();
    gltf.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const smooth = toCreasedNormals(o.geometry, CREASE);
      o.geometry.dispose();
      o.geometry = smooth;
      // GLTFLoader shades a mesh without normals flat; it has them now.
      if (o.material instanceof MeshStandardMaterial) {
        o.material.flatShading = false;
        o.material.needsUpdate = true;
      }
    });
    this.part = gltf.scene;
    this.scene.add(gltf.scene);

    // Close enough that the part fills the wide frame: a flat part's bounding sphere is far taller
    // than the part looks from any side the camera turns to.
    const ball = new Box3().setFromObject(gltf.scene).getBoundingSphere(new Sphere());
    const distance = (ball.radius / Math.sin((FOV * Math.PI) / 360)) * 0.7;
    this.camera.position.copy(ball.center).addScaledVector(FROM, distance);
    this.camera.near = distance / 20;
    this.camera.far = distance * 20;
    this.controls.target.copy(ball.center);
    this.controls.update();
    this.fit();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.resize.disconnect();
    this.controls.dispose();
    this.clear();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clear(): void {
    this.part?.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    if (this.part) this.scene.remove(this.part);
    this.part = null;
  }

  private render(): void {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  private fit(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }
}
