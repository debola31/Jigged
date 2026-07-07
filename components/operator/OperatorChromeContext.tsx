'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { DependencyList, ReactNode } from 'react';

/**
 * Header chrome for the operator shell.
 *
 * Each operator page declares, from its own render, what the fixed AppBar should
 * show for it: a contextual back target (or none, on the back-less "home" roots
 * where the JIG logo shows instead) and an optional right-side cluster of
 * job-context action icons (Files, Previous notes). `OperatorShell` is
 * presentational — it renders whatever the current page registered.
 *
 * Why a context and not "compute back from the pathname": pages already know
 * their exact parent (the operation page literally computes `travelerHref`), and
 * a QR deep-link into a page has no in-app history for `router.back()` to use.
 * The action icons also need page-owned handlers — they open sheets whose
 * open-state the page owns — which only the page can supply.
 */
export interface OperatorChromeAction {
  key: 'files' | 'history';
  icon: ReactNode;
  /** aria-label / tooltip for the icon button. */
  label: string;
  onClick: () => void;
}

export interface OperatorChromeConfig {
  /** Back target for the header. Omit/null on back-less roots (logo shows). */
  back?: { href: string; label?: string } | null;
  /** Right-cluster action icons for the current page. */
  actions?: OperatorChromeAction[];
}

interface OperatorChromeContextValue {
  config: OperatorChromeConfig;
  setConfig: (config: OperatorChromeConfig) => void;
}

const OperatorChromeContext = createContext<OperatorChromeContextValue>({
  config: {},
  setConfig: () => {},
});

export function OperatorChromeProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<OperatorChromeConfig>({});
  return (
    <OperatorChromeContext.Provider value={{ config, setConfig }}>
      {children}
    </OperatorChromeContext.Provider>
  );
}

/** Read the current header chrome (used by the shell). */
export function useOperatorChrome(): OperatorChromeConfig {
  return useContext(OperatorChromeContext).config;
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
