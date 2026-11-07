'use client';

// The realistic models' manifest (moonshot/web/realism/SPEC.md), fetched once for the page: the
// shop's stream (Realistic.tsx) and a thing's card (ModelView) both read it. No three.js here, so
// the card's bundle can ask for it.

import { useEffect, useState } from 'react';
import { mediaUrl } from './showcaseData';

export interface Manifest {
  assets: Record<string, { full: string; triangles: number; priority: string; load_order: number }>;
}

let pending: Promise<Manifest | null> | null = null;

/**
 * The manifest, or null when none is published (Supabase Storage answers a missing object with
 * 400, a plain server 404): the light models, quietly. Any other failure rejects, and the next
 * caller asks again.
 */
export function realisticManifest(): Promise<Manifest | null> {
  pending ??= (async () => {
    const res = await fetch(mediaUrl('models-full/manifest.json'));
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`The realistic models' manifest answered ${res.status}`);
    return (await res.json()) as Manifest;
  })().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/**
 * The realistic model's URL for an asset: undefined while the manifest is asked for, null when the
 * asset has none or the manifest can't be had, and nothing asked at all unless `enabled`. A failed
 * manifest isn't reported here: the shop's stream reports it, on the same desktops (FINE_POINTER).
 */
export function useRealisticModel(asset: string | undefined, enabled: boolean): string | null | undefined {
  const [found, setFound] = useState<{ asset: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!enabled || !asset) return;
    let live = true;
    realisticManifest().then(
      (manifest) => {
        const full = manifest?.assets[asset]?.full;
        if (live) setFound({ asset, url: full ? mediaUrl(full) : null });
      },
      () => {
        if (live) setFound({ asset, url: null });
      },
    );
    return () => {
      live = false;
    };
  }, [asset, enabled]);
  if (!enabled || !asset) return null;
  return found?.asset === asset ? found.url : undefined;
}
