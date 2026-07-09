'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DependencyList, ReactNode } from 'react';

/**
 * Header chrome + in-app navigation for the operator shell.
 *
 * BACK BUTTON — holistic, not per-hop. The browser history stack already IS
 * "where you came from", so the header back button just pops it (router.back()).
 * We don't thread a `?back=` return URL through every navigation; instead every
 * in-app forward navigation goes through `useOperatorNav().push`, which bumps a
 * depth counter, and the header back calls `goBack()`:
 *   - depth > 0  → there's an in-app page behind us → router.back() (retraces
 *     the exact path the operator took, through the parts hub and everything).
 *   - depth === 0 → a QR deep-link landed straight on this page with no in-app
 *     history to pop → navigate to the page's declared parent `back.href`
 *     (the fallback) so we climb the hierarchy instead of leaving the app.
 *
 * The depth ref lives in the provider, which sits in the operator layout and
 * stays mounted across client navigations, so it survives jobs → traveler →
 * hub → … and resets to 0 only on a fresh load (i.e. a real deep-link entry).
 */
export interface OperatorChromeConfig {
  /**
   * Header back target. Omit/null on back-less roots (the JIG logo shows).
   * `href` is the FALLBACK parent, used only on a deep-link entry (no in-app
   * history) — normal back pops real history via goBack(). `label` is the
   * button's aria-label.
   */
  back?: { href: string; label?: string } | null;
}

interface OperatorChromeContextValue {
  config: OperatorChromeConfig;
  setConfig: (config: OperatorChromeConfig) => void;
  push: (href: string) => void;
  goBack: () => void;
}

const OperatorChromeContext = createContext<OperatorChromeContextValue>({
  config: {},
  setConfig: () => {},
  push: () => {},
  goBack: () => {},
});

export function OperatorChromeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [config, setConfig] = useState<OperatorChromeConfig>({});

  // In-app navigation depth from the operator-view entry page (see the file
  // header). A ref, not state — it must survive client navigations without
  // re-rendering, and only the goBack handler reads it.
  const depthRef = useRef(0);
  // Latest config, so goBack can read the current page's fallback href without
  // being re-created (and re-subscribing the shell) on every chrome change.
  // Synced in an effect (not during render); the config always settles before a
  // back tap, and the fallback only matters on a depth-0 deep-link anyway.
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const push = useCallback(
    (href: string) => {
      depthRef.current += 1;
      router.push(href);
    },
    [router],
  );

  const goBack = useCallback(() => {
    if (depthRef.current > 0) {
      depthRef.current -= 1;
      router.back();
      return;
    }
    // Deep-link entry: nothing in-app to pop — climb to the declared parent.
    const fallback = configRef.current.back?.href;
    if (fallback) router.push(fallback);
  }, [router]);

  return (
    <OperatorChromeContext.Provider value={{ config, setConfig, push, goBack }}>
      {children}
    </OperatorChromeContext.Provider>
  );
}

/** Read the current header chrome (used by the shell). */
export function useOperatorChrome(): OperatorChromeConfig {
  return useContext(OperatorChromeContext).config;
}

/**
 * In-app navigation for operator pages. Use `push(href)` for EVERY forward
 * navigation inside the operator shell (it records one level of depth so the
 * header back can safely router.back()); `goBack()` powers the header back
 * button. Same-page URL updates (e.g. `?scope=`/`?completed=` on the jobs list)
 * and single-part hub redirects should keep using `router.replace` directly —
 * a replace doesn't add a history entry, so it must not bump depth.
 */
export function useOperatorNav(): { push: (href: string) => void; goBack: () => void } {
  const { push, goBack } = useContext(OperatorChromeContext);
  return { push, goBack };
}

/**
 * Declare the header chrome for the current page. Re-syncs only when `deps`
 * change (the same caller-owned-deps contract as `useLoad`) and clears on
 * unmount, so navigating between pages swaps the header cleanly (both updates
 * batch within one commit, so there's no empty-header flicker). `setConfig` is a
 * stable useState setter; the config object is rebuilt each render, so it is
 * intentionally NOT in the dependency list — pass primitive deps (hrefs / ids).
 */
export function useSetOperatorChrome(config: OperatorChromeConfig, deps: DependencyList): void {
  const { setConfig } = useContext(OperatorChromeContext);
  useEffect(() => {
    setConfig(config);
    return () => setConfig({});
    // Caller-owned deps, like useLoad: the config object is rebuilt every render,
    // so it's intentionally not a dependency — re-sync only when `deps` change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
