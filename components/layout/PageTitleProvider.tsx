'use client';

import { createContext, useContext, useState } from 'react';

/**
 * Lets a page override the title shown in the global Header (the sticky app
 * bar). Detail pages set it to the record's identity — e.g. the part page sets
 * the part number — so the identity is always visible while scrolling (the app
 * bar already sticks reliably) without a second in-page header bar.
 *
 * When null, the Header falls back to its pathname-derived title. Pages set it
 * in an effect and clear it on unmount.
 */
interface PageTitleContextValue {
  title: string | null;
  setTitle: (title: string | null) => void;
}

const PageTitleContext = createContext<PageTitleContextValue>({
  title: null,
  setTitle: () => {},
});

export function PageTitleProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  return (
    <PageTitleContext.Provider value={{ title, setTitle }}>
      {children}
    </PageTitleContext.Provider>
  );
}

export function usePageTitle(): PageTitleContextValue {
  return useContext(PageTitleContext);
}
