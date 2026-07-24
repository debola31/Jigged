'use client';

import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html, OrbitControls, useGLTF } from '@react-three/drei';

const MODEL_URL = '/week1-scene.glb';

// This export IS Draco-compressed (KHR_draco_mesh_compression in
// extensionsRequired). drei's useGLTF auto-detects that and wires up a
// DRACOLoader, fetching the decoder from the gstatic CDN — no extra setup.
// (Because Draco is *required*, the model won't render if that CDN request is
// blocked, e.g. by a strict CSP; host the decoder locally if that ever bites.)
function Model() {
  const { scene } = useGLTF(MODEL_URL);
  return <primitive object={scene} />;
}

// Warm the cache so the model starts fetching before <Model /> mounts.
useGLTF.preload(MODEL_URL);

export default function Scene() {
  return (
    <Canvas
      // No camera was exported in the GLB, so this is a hand-framed 3/4 view of
      // the actual model cluster (CNC_Machine / Workbench / Worker sit around
      // x −3…0, y ~0.6–1.4). fov 50 ≈ Blender's default 50mm lens. OrbitControls
      // below re-targets the pivot to the cluster center.
      camera={{ position: [6, 4, 8], fov: 50, near: 0.1, far: 1000 }}
      dpr={[1, 2]}
    >
      {/* No lights were exported in the GLB (no KHR_lights_punctual), and the
          floor material is very dark, so these are a stand-in rig rather than a
          1:1 match. Ambient lifts the shadowed faces off pure black... */}
      <ambientLight intensity={0.8} />

      {/* ...and a directional key light from front-upper-right gives form.
          Bump intensity if the dark matte floor reads too flat. */}
      <directionalLight position={[5, 8, 5]} intensity={2.5} />

      <Suspense
        fallback={
          <Html center style={{ color: '#fff', font: '600 14px sans-serif' }}>
            Loading scene…
          </Html>
        }
      >
        <Model />
      </Suspense>

      {/* Inspect the scene from any angle. Pivot on the model cluster center
          (roughly x −1.5, y 0.9) rather than the world origin. */}
      <OrbitControls makeDefault enableDamping target={[-1.5, 0.9, 0]} />
    </Canvas>
  );
}
