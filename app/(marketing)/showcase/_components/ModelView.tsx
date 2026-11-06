'use client';

import { Bounds, Environment, Lightformer, OrbitControls, useGLTF } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Component, Suspense, useEffect, useMemo, type ReactNode } from 'react';
import { Mesh, MeshStandardMaterial, Vector3 } from 'three';
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
 * wheel still scrolls the panel.
 */
export default function ModelView({ url, part = false, onLoad, onError }: { url: string; part?: boolean; onLoad(): void; onError(error: unknown): void }) {
  const at = FROM.clone().multiplyScalar(part ? 400 : 4);
  return (
    <Canvas frameloop="demand" dpr={[1, 2]} camera={{ fov: 30, position: at.toArray(), near: 0.001, far: 10_000 }}>
      <color attach="background" args={['#1d2127']} />
      <hemisphereLight args={['#ffffff', '#40444c', 0.7]} />
      <directionalLight position={[3, 5, 4]} intensity={1.4} />
      <Environment resolution={64} frames={1}>
        <Lightformer form="rect" intensity={2.5} position={[0, 5, 0]} rotation-x={Math.PI / 2} scale={[10, 10, 1]} />
        <Lightformer form="rect" intensity={1} position={[-5, 2, 2]} rotation-y={Math.PI / 2} scale={[8, 4, 1]} />
      </Environment>
      <Catch onError={onError}>
        <Suspense fallback={null}>
          <Model url={url} part={part} onLoad={onLoad} />
        </Suspense>
      </Catch>
      <OrbitControls makeDefault enableDamping enableZoom={!part} enablePan={false} />
    </Canvas>
  );
}
