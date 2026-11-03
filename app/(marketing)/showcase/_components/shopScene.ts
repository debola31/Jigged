// The shop in three.js: every item in layout.json drawn with its light GLB, the zones and aisles
// on the floor, and the station of the current step outlined. Nothing in it moves except the
// camera, so it draws on demand rather than every frame.
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  CanvasTexture,
  Color,
  EdgesGeometry,
  Group,
  HemisphereLight,
  DirectionalLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BRAND } from '@/components/marketing/marketingStyles';
import { mediaUrl, type Rect, type Shop, type Where } from './showcaseData';

// Scene colours. three.js takes literal colours, so they are named here once; the accents are
// the marketing palette's.
const COLOURS = {
  background: BRAND.indigo,
  floor: '#3a3f55',
  wall: '#565c74',
  furniture: '#6b7186',
  aisle: '#e8c22e',
  label: 'rgba(255, 255, 255, 0.78)',
  highlight: BRAND.amber,
};
const ZONE_TINT: Record<string, string> = {
  milling: BRAND.steel,
  turning: BRAND.steel,
  grinding: BRAND.teal,
  'wire-edm': BRAND.teal,
  saw: BRAND.amber,
  finishing: BRAND.amber,
  inspection: '#8a7fd6',
  benches: '#a07a52',
};
const LOADS_AT_ONCE = 6;
const FLY_MS = 1100;

type Vec3 = [number, number, number];

/** Plan (mm, +Z up) to scene (m, +Y up, the glTF frame): a turn about plan +Z is one about scene +Y. */
function toScene(x: number, y: number, z: number): Vec3 {
  return [x / 1000, z / 1000, -y / 1000];
}

const deg = (d: number) => (d * Math.PI) / 180;

/** The way an item faces, in plan: its front is its local -Y. */
function front(rot: number): [number, number] {
  return [Math.sin(deg(rot)), -Math.cos(deg(rot))];
}

interface View {
  position: Vector3;
  target: Vector3;
}

export interface LoadState {
  loaded: number;
  failed: number;
  total: number;
}

export class ShopScene {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private outline = new Group();
  private resize: ResizeObserver;
  private frame = 0;
  private flight: { from: View; to: View; start: number } | null = null;
  /** The point the camera looks at. */
  private target = new Vector3();
  private disposed = false;
  readonly overview: View;

  constructor(
    private container: HTMLElement,
    private shop: Shop,
    options: { orbit: boolean; onLoad(state: LoadState, error?: unknown): void },
  ) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(40, 1, 0.1, 400);
    const [w, d] = shop.building.size;
    // The building is long and narrow, so the whole shop is seen corner-on from the south-west,
    // receding into the frame, rather than square-on as a thin strip.
    const centre = new Vector3(...toScene(w / 2, d / 2, 0));
    this.overview = {
      position: centre.clone().add(new Vector3(-w / 1000 * 0.68, w / 1000 * 0.55, w / 1000 * 0.55)),
      target: centre.clone().add(new Vector3(w / 1000 * 0.04, 0, 0)),
    };
    this.camera.position.copy(this.overview.position);
    this.target.copy(this.overview.target);
    this.camera.lookAt(this.target);

    this.scene.background = new Color(COLOURS.background);
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.6;
    this.scene.add(new HemisphereLight('#ffffff', '#30344a', 1.4));
    const sun = new DirectionalLight('#ffffff', 1.6);
    sun.position.set(-20, 40, 25);
    this.scene.add(sun);

    this.addBuilding();
    this.scene.add(this.outline);

    if (options.orbit) {
      // Mouse only: on a phone the page has to keep scrolling under a finger, so touch gets the
      // camera that follows the steps and nothing else.
      // The controls share this.target, so a flight and an orbit move the same point.
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.target = this.target;
      this.controls.enableDamping = false;
      // No wheel zoom: the wheel over the view has to keep scrolling the page. The steps' flights
      // give the close-ups.
      this.controls.enableZoom = false;
      this.controls.maxPolarAngle = deg(85);
      this.controls.addEventListener('change', () => this.render());
      this.controls.addEventListener('start', () => (this.flight = null));
      this.controls.update();
    }

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    void this.loadModels(options.onLoad);
  }

  /** Outline where a step happens: its machine's box, or its zone on the floor. */
  highlight(where: Where): void {
    this.outline.traverse((o) => {
      if (o instanceof LineSegments) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    this.outline.clear();
    const station = this.station(where);
    if (station.item) {
      const { item, size, box } = station.item;
      const lines = new LineSegments(
        new EdgesGeometry(new BoxGeometry(size[0] * 1.05, size[1] * 1.03, size[2] * 1.05)),
        new LineBasicMaterial({ color: COLOURS.highlight }),
      );
      lines.position.set((box.min[0] + box.max[0]) / 2000, size[1] / 2, -(box.min[1] + box.max[1]) / 2000);
      const group = new Group();
      group.position.set(...toScene(item.x, item.y, item.z));
      group.rotation.y = deg(item.rot);
      group.add(lines);
      this.outline.add(group);
    } else if (station.zone) {
      this.outline.add(this.zoneOutline(station.zone));
    }
    this.render();
  }

  /** Fly to where a step happens: a machine seen from its operator side, or a zone from the south. */
  flyToStation(where: Where): void {
    const station = this.station(where);
    if (station.item) {
      const { item, size } = station.item;
      const radius = Math.max(...size) / 2;
      const [fx, fy] = front(item.rot);
      const target = new Vector3(...toScene(item.x, item.y, item.z));
      target.y += size[1] * 0.45;
      const away = radius * 2.6 + 1.5;
      this.flyTo({
        target,
        position: target.clone().add(new Vector3(fx * away + away * 0.35, radius * 1.3 + 1.2, -fy * away)),
      });
      return;
    }
    // A zone is seen from the south, the way its floor label reads.
    const target = new Vector3(...toScene(where.x, where.y, 0));
    this.flyTo({ target, position: target.clone().add(new Vector3(0, 10, 13)) });
  }

  showWholeShop(): void {
    this.flyTo(this.overview);
  }

  private station(where: Where) {
    const item = where.item ? this.shop.items.find((i) => i.item === where.item) : undefined;
    if (item) {
      const box = this.shop.assets[item.asset].bbox;
      const size: Vec3 = [(box.max[0] - box.min[0]) / 1000, (box.max[2] - box.min[2]) / 1000, (box.max[1] - box.min[1]) / 1000];
      return { item: { item, size, box } };
    }
    return { zone: this.shop.zones.find((z) => z.name === where.name)?.rect };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls?.dispose();
    this.scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof LineSegments) {
        o.geometry.dispose();
        for (const m of [o.material].flat()) {
          if (m instanceof MeshBasicMaterial) m.map?.dispose();
          m.dispose();
        }
      }
    });
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private render = () => {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  };

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private flyTo(to: View): void {
    const from = { position: this.camera.position.clone(), target: this.target.clone() };
    this.flight = { from, to, start: performance.now() };
    cancelAnimationFrame(this.frame);
    const step = (now: number) => {
      if (!this.flight) return;
      const t = Math.min(1, (now - this.flight.start) / FLY_MS);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.flight.from.position, this.flight.to.position, e);
      this.target.lerpVectors(this.flight.from.target, this.flight.to.target, e);
      this.camera.lookAt(this.target);
      this.render();
      if (t < 1) this.frame = requestAnimationFrame(step);
      else this.flight = null;
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) step(this.flight.start + FLY_MS);
    else this.frame = requestAnimationFrame(step);
  }

  private async loadModels(onLoad: (state: LoadState, error?: unknown) => void): Promise<void> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const assets = Object.keys(this.shop.assets);
    const state: LoadState = { loaded: 0, failed: 0, total: assets.length };
    let firstError: unknown;
    const queue = [...assets];
    const worker = async () => {
      for (let asset = queue.shift(); asset; asset = queue.shift()) {
        try {
          const gltf = await loader.loadAsync(mediaUrl(this.shop.assets[asset].model));
          if (this.disposed) return;
          for (const item of this.shop.items.filter((i) => i.asset === asset)) {
            const group = new Group();
            group.position.set(...toScene(item.x, item.y, item.z));
            group.rotation.y = deg(item.rot);
            group.add(gltf.scene.clone(true));
            this.scene.add(group);
          }
          state.loaded++;
        } catch (err) {
          state.failed++;
          firstError ??= err;
        }
        if (this.disposed) return;
        this.render();
        onLoad({ ...state });
      }
    };
    await Promise.all(Array.from({ length: LOADS_AT_ONCE }, worker));
    if (!this.disposed && state.failed) onLoad({ ...state }, firstError);
  }

  private addBuilding(): void {
    const [w, d] = this.shop.building.size;
    const floor = this.flat([0, 0, w, d], 0, new MeshStandardMaterial({ color: COLOURS.floor, roughness: 0.95 }));
    this.scene.add(floor);
    for (const z of this.shop.zones) {
      this.scene.add(
        this.flat(z.rect, 0.004, new MeshBasicMaterial({ color: ZONE_TINT[z.id] ?? COLOURS.wall, transparent: true, opacity: 0.16, depthWrite: false })),
      );
      const [x0, y0, x1, y1] = z.rect;
      // Labels sit along the edge nearest the main aisle, read from the south.
      this.addLabel(z.name, (x0 + x1) / 2, y0 < d / 2 ? y1 - 450 : y0 + 450);
    }
    const stripe = new MeshStandardMaterial({ color: COLOURS.aisle, roughness: 0.7 });
    for (const a of this.shop.aisles) {
      const [x0, y0, x1, y1] = a.rect;
      const edges: Rect[] = x1 - x0 > y1 - y0
        ? [[x0, y0, x1, y0 + 80], [x0, y1 - 80, x1, y1]]
        : [[x0, y0, x0 + 80, y1], [x1 - 80, y0, x1, y1]];
      for (const e of edges) this.scene.add(this.flat(e, 0.006, stripe));
    }
    const wall = new MeshStandardMaterial({ color: COLOURS.wall, roughness: 0.85 });
    const h = 1.2;
    const t = 0.2;
    for (const [cx, cz, sx, sz] of [
      [w / 2000, t / 2, w / 1000, t],
      [w / 2000, -d / 1000 - t / 2, w / 1000, t],
      [-t / 2, -d / 2000, t, d / 1000 + 2 * t],
      [w / 1000 + t / 2, -d / 2000, t, d / 1000 + 2 * t],
    ]) {
      const m = new Mesh(new BoxGeometry(sx, h, sz), wall);
      m.position.set(cx, h / 2, cz);
      this.scene.add(m);
    }
    const furniture = new MeshStandardMaterial({ color: COLOURS.furniture, roughness: 0.8 });
    for (const f of this.shop.furniture) {
      const [sw, sd, top] = f.size;
      const m = new Mesh(new BoxGeometry(sw / 1000, top / 1000, sd / 1000), furniture);
      m.position.set(...toScene(f.x, f.y, top / 2));
      m.rotation.y = deg(f.rot);
      this.scene.add(m);
    }
  }

  /** A plan rect lying on the floor, lifted a little to sit above what's under it. */
  private flat(r: Rect, lift: number, material: MeshStandardMaterial | MeshBasicMaterial): Mesh {
    const m = new Mesh(new PlaneGeometry((r[2] - r[0]) / 1000, (r[3] - r[1]) / 1000), material);
    m.rotation.x = -Math.PI / 2;
    m.position.set(...toScene((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, lift * 1000));
    return m;
  }

  private zoneOutline(r: Rect): Object3D {
    const lines = new LineSegments(
      new EdgesGeometry(new BoxGeometry((r[2] - r[0]) / 1000, 0.02, (r[3] - r[1]) / 1000)),
      new LineBasicMaterial({ color: COLOURS.highlight }),
    );
    lines.position.set(...toScene((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, 10));
    return lines;
  }

  private addLabel(text: string, x: number, y: number): void {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const font = `600 72px ${getComputedStyle(document.body).fontFamily}`;
    ctx.font = font;
    canvas.width = Math.ceil(ctx.measureText(text).width) + 24;
    canvas.height = 96;
    ctx.font = font;
    ctx.fillStyle = COLOURS.label;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 12, 48);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const height = 0.7;
    const m = new Mesh(
      new PlaneGeometry((canvas.width / canvas.height) * height, height),
      new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(...toScene(x, y, 8));
    this.scene.add(m);
  }
}
