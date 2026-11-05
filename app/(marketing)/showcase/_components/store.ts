import { create } from 'zustand';

/** Where the camera is asked to be. `token` changes on every request, so asking twice flies twice. */
export type View = { kind: 'overview' } | { kind: 'item'; id: string } | { kind: 'step'; index: number };

interface ShowcaseState {
  /** The open step, by its index in the part; null before the visitor picks one. */
  step: number | null;
  /** The open shop item; its panel covers the step's until it is closed. */
  item: string | null;
  hovered: string | null;
  tab: 'plan' | 'shop';
  category: string;
  query: string;
  view: View;
  token: number;
  walking: boolean;
  /** The station the walk is stopped at, named on screen. */
  walkStop: string | null;
  /** Shop models that failed to load. */
  failedModels: number;
  openStep(index: number): void;
  openItem(id: string): void;
  closeItem(): void;
  /** Back to the part's plan: no step, no thing, the whole shop. */
  showPlan(): void;
  hover(id: string | null): void;
  setTab(tab: 'plan' | 'shop'): void;
  setCategory(category: string): void;
  setQuery(query: string): void;
  overview(): void;
  setWalking(walking: boolean): void;
  setWalkStop(stop: string | null): void;
  modelFailed(): void;
}

export const useShowcase = create<ShowcaseState>((set) => ({
  step: null,
  item: null,
  hovered: null,
  tab: 'plan',
  category: 'all',
  query: '',
  view: { kind: 'overview' },
  token: 0,
  walking: false,
  walkStop: null,
  failedModels: 0,
  openStep: (index) => set((s) => ({ step: index, item: null, view: { kind: 'step', index }, token: s.token + 1 })),
  openItem: (id) => set((s) => ({ item: id, view: { kind: 'item', id }, token: s.token + 1 })),
  closeItem: () =>
    set((s) => ({
      item: null,
      view: s.step === null ? { kind: 'overview' } : { kind: 'step', index: s.step },
      token: s.token + 1,
    })),
  showPlan: () => set((s) => ({ step: null, item: null, view: { kind: 'overview' }, token: s.token + 1 })),
  hover: (id) => set({ hovered: id }),
  setTab: (tab) => set({ tab }),
  setCategory: (category) => set({ category }),
  setQuery: (query) => set({ query }),
  overview: () => set((s) => ({ view: { kind: 'overview' }, token: s.token + 1 })),
  setWalking: (walking) => set({ walking, walkStop: null }),
  setWalkStop: (walkStop) => set({ walkStop }),
  modelFailed: () => set((s) => ({ failedModels: s.failedModels + 1 })),
}));
