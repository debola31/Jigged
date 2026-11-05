import { create } from 'zustand';
import type { Where } from './showcaseData';

/** Where the camera is asked to be. `token` changes on every request, so asking twice flies twice. */
export type View =
  | { kind: 'overview' }
  | { kind: 'item'; id: string }
  | { kind: 'step'; index: number }
  | { kind: 'zone'; where: Where };

interface ShowcaseState {
  /** The visitor's way in: pick a part, watch its instructions come together, then the plan. */
  phase: 'pick' | 'generating' | 'plan';
  /** What the step card shows: the plan's "what you'll need", the open step, or the part made. */
  sheet: 'need' | 'step' | 'done';
  /** The open step, by its index in the part; null before the visitor picks one. */
  step: number | null;
  /** The open shop item, shown in its own card until it is closed. */
  item: string | null;
  hovered: string | null;
  view: View;
  token: number;
  walking: boolean;
  /** The station the walk is stopped at, named on screen. */
  walkStop: string | null;
  /** Shop models that failed to load. */
  failedModels: number;
  setPhase(phase: 'pick' | 'generating' | 'plan'): void;
  /** Move the camera without opening anything. */
  look(view: View): void;
  openStep(index: number): void;
  openItem(id: string): void;
  closeItem(): void;
  showNeed(): void;
  /** Past the last step: the part is made, and the camera stands back to the whole shop. */
  showDone(): void;
  hover(id: string | null): void;
  overview(): void;
  setWalking(walking: boolean): void;
  setWalkStop(stop: string | null): void;
  modelFailed(): void;
}

export const useShowcase = create<ShowcaseState>((set) => ({
  phase: 'pick',
  sheet: 'need',
  step: null,
  item: null,
  hovered: null,
  view: { kind: 'overview' },
  token: 0,
  walking: false,
  walkStop: null,
  failedModels: 0,
  setPhase: (phase) => set({ phase }),
  look: (view) => set((s) => ({ view, token: s.token + 1 })),
  openStep: (index) => set((s) => ({ step: index, sheet: 'step', item: null, view: { kind: 'step', index }, token: s.token + 1 })),
  openItem: (id) => set((s) => ({ item: id, view: { kind: 'item', id }, token: s.token + 1 })),
  closeItem: () =>
    set((s) => ({
      item: null,
      view: s.sheet === 'step' && s.step !== null ? { kind: 'step', index: s.step } : { kind: 'overview' },
      token: s.token + 1,
    })),
  showNeed: () => set((s) => ({ sheet: 'need', item: null, view: { kind: 'overview' }, token: s.token + 1 })),
  showDone: () => set((s) => ({ sheet: 'done', item: null, view: { kind: 'overview' }, token: s.token + 1 })),
  hover: (id) => set({ hovered: id }),
  overview: () => set((s) => ({ view: { kind: 'overview' }, token: s.token + 1 })),
  setWalking: (walking) => set({ walking, walkStop: null }),
  setWalkStop: (walkStop) => set({ walkStop }),
  modelFailed: () => set((s) => ({ failedModels: s.failedModels + 1 })),
}));
