/**
 * Selection slice — multi-select state for video list and clip list.
 *
 * Migrated from App.tsx as the A1 zustand pilot:
 *   - selectedVideoIds: Set<string> previously held via useState in App
 *   - selectedClipIds:  Set<string> previously held via useState in App
 *
 * Rationale for picking these as the pilot:
 *   1. Cross-domain (left list + middle list + bulk actions all touch them)
 *      → prop-drilling pain that benefits from a store immediately.
 *   2. Low blast radius — bugs only manifest as "selected the wrong items",
 *      not "lost the user's project" or "broke video playback".
 *   3. No timing coupling — unlike playback/trim, these don't interact with
 *      DOM refs or rAF callbacks.
 *
 * Behavior preserved 1:1 from the old `useState<Set<string>>` site:
 *   - new Sets returned on every mutation (referential equality flips so
 *     consumers re-render),
 *   - `toggle`/`set`/`clear` actions covering every former usage.
 */
import type { StateCreator } from 'zustand';

export interface SelectionState {
  selectedVideoIds: Set<string>;
  selectedClipIds: Set<string>;
}

export interface SelectionActions {
  setSelectedVideoIds: (next: Set<string>) => void;
  toggleSelectedVideoId: (id: string) => void;
  clearSelectedVideoIds: () => void;
  setSelectedClipIds: (next: Set<string>) => void;
  toggleSelectedClipId: (id: string) => void;
  clearSelectedClipIds: () => void;
}

export type SelectionSlice = SelectionState & SelectionActions;

export const createSelectionSlice: StateCreator<SelectionSlice, [], [], SelectionSlice> = (set) => ({
  selectedVideoIds: new Set<string>(),
  selectedClipIds: new Set<string>(),
  setSelectedVideoIds: (next) => set({ selectedVideoIds: new Set(next) }),
  toggleSelectedVideoId: (id) =>
    set((state) => {
      const next = new Set(state.selectedVideoIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedVideoIds: next };
    }),
  clearSelectedVideoIds: () => set({ selectedVideoIds: new Set<string>() }),
  setSelectedClipIds: (next) => set({ selectedClipIds: new Set(next) }),
  toggleSelectedClipId: (id) =>
    set((state) => {
      const next = new Set(state.selectedClipIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedClipIds: next };
    }),
  clearSelectedClipIds: () => set({ selectedClipIds: new Set<string>() }),
});
