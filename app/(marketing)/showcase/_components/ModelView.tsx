'use client';

import { Bounds, Environment, Lightformer, OrbitControls, useGLTF } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { Component, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AgXToneMapping, Mesh, MeshStandardMaterial, Vector3, type Object3D } from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

// A cut's mesh carries no normals. Facets of one curved face meet at a few degrees and are
// smoothed; a machined edge is near 90 degrees and stays sharp.
const CREASE = (30 * Math.PI) / 180;
// The still's camera from the part (pipeline.py STILL_FROM_MM: in front, a little right, above).
const FROM = new Vector3(120, 230, 330).normalize();

function Model({ url, part, onLoad }: { url: string; part: boolean; onLoad(): void }) {
  const gltf = useGLTF(url, false, true);
  const object = useMemo(() => {
    const o = gltf.scene.clone(true);
    if (part) {
      o.traverse((m) => {
        if (!(m instanceof Mesh)) return;
        m.geometry = toCreasedNormals(m.geometry, CREASE);
        // GLTFLoader shades a mesh without normals flat; it has them now.
        if (m.material instanceof MeshStandardMaterial) {
          m.material = m.material.clone();
          m.material.flatShading = false;
        }
      });
    }
    return o;
  }, [gltf.scene, part]);
  useEffect(onLoad, [onLoad]);
  return (
    <Bounds fit clip observe margin={part ? 0.9 : 1.2}>
      <primitive object={object} />
    </Bounds>
  );
}

/**
 * A thing's realistic model (moonshot/web/realism/SPEC.md), loaded for this canvas's renderer and
 * its shaders compiled before it shows. It has the light model's frame, so it fits as that would.
 */
function Full({ url, onLoad, onError }: { url: string; onLoad(): void; onError(error: unknown): void }) {
  const { gl, camera, scene, invalidate } = useThree();
  const [model, setModel] = useState<Object3D | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { realisticLoader } = await import('./realisticLoader');
        const loaded = await realisticLoader(gl).load(url);
        await gl.compileAsync(loaded, camera, scene);
        if (live) setModel(loaded);
      } catch (error) {
        if (live) onError(error);
      }
    })();
    return () => {
      live = false;
    };
  }, [url, gl, camera, scene, onError]);
  useEffect(() => {
    if (!model) return;
    invalidate();
    onLoad();
  }, [model, invalidate, onLoad]);
  if (!model) return null;
  return (
    <Bounds fit clip observe margin={1.2}>
      <primitive object={model} />
    </Bounds>
  );
}

class Catch extends Component<{ children: ReactNode; onError(error: unknown): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * One model on its own, for a mouse to turn: a thing from the shop at its full size, or the part
 * as a cut leaves it (`part`), framed from where the step's still is taken and turn-only, so the
 * wheel still scrolls the panel. A thing with a realistic model (`full`) shows that one, and its
 * light model (`url`) only if the realistic one fails, reported by `onFullError`.
 */
export default function ModelView({
  url,
  full,
  part = false,
  onLoad,
  onError,
  onFullError,
}: {
  url: string;
  full?: string | null;
  part?: boolean;
  onLoad(): void;
  onError(error: unknown): void;
  onFullError?(error: unknown): void;
}) {
  const [fullFailed, setFullFailed] = useState(false);
  const onFull = useCallback(
    (error: unknown) => {
      setFullFailed(true);
      onFullError?.(error);
    },
    [onFullError],
  );
  const at = FROM.clone().multiplyScalar(part ? 400 : 4);
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      // A thing as the shop draws it (ShopCanvas), so its white paint keeps its shading; the part as it always has.
      gl={part ? undefined : { toneMapping: AgXToneMapping }}
      camera={{ fov: 30, position: at.toArray(), near: 0.001, far: 10_000 }}
    >
      <color attach="background" args={['#1d2127']} />
      <hemisphereLight args={['#ffffff', '#40444c', 0.7]} />
      <directionalLight position={[3, 5, 4]} intensity={1.4} />
      <Environment resolution={64} frames={1}>
        <Lightformer form="rect" intensity={2.5} position={[0, 5, 0]} rotation-x={Math.PI / 2} scale={[10, 10, 1]} />
        <Lightformer form="rect" intensity={1} position={[-5, 2, 2]} rotation-y={Math.PI / 2} scale={[8, 4, 1]} />
      </Environment>
      <Catch onError={onError}>
        <Suspense fallback={null}>
          {full && !fullFailed ? <Full url={full} onLoad={onLoad} onError={onFull} /> : <Model url={url} part={part} onLoad={onLoad} />}
        </Suspense>
      </Catch>
      <OrbitControls makeDefault enableDamping enableZoom={!part} enablePan={false} />
    </Canvas>
  );
}
