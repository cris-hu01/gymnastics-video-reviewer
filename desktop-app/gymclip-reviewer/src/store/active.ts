/**
 * Active slice — currently focused video/clip ids.
 *
 * Migrated from App.tsx as part of A3 (cross-domain state consolidation):
 *   - activeVideoId: string | null previously held via useState in App
 *   - activeClipId:  string | null previously held via useState in App
 *
 * Rationale for grouping these in their own slice:
 *   1. Cross-domain reads — left video list, middle clip list, right
 *      platform-match panel, the player, and the export dialog all need
 *      to know which video/clip is in focus. Pre-A3 this required passing
 *      both ids through 3+ layers of components.
 *   2. Pure scalar state — no side effects, no DOM coupling. Safe to flip
 *      into the store ahead of the playback/trim triangle (A4) which
 *      *does* couple to refs.
 *   3. The derived `activeVideo` / `activeClip` objects deliberately stay
 *      as `useMemo` in App.tsx — they are projections of project state,
 *      not authoritative state themselves. Keeping them out of the store
 *      avoids stale-snapshot bugs when project mutates.
 *
 * Behavior preserved 1:1 from the old `useState<string | null>` sites:
 *   - setters accept the same string-or-null union,
 *   - no implicit clearing on project changes (callers handle that).
 */
import type { StateCreator } from 'zustand';

export interface ActiveState {
  activeVideoId: string | null;
  activeClipId: string | null;
}

export interface ActiveActions {
  setActiveVideoId: (id: string | null) => void;
  setActiveClipId: (id: string | null) => void;
}

export type ActiveSlice = ActiveState & ActiveActions;

export const createActiveSlice: StateCreator<ActiveSlice, [], [], ActiveSlice> = (set) => ({
  activeVideoId: null,
  activeClipId: null,
  setActiveVideoId: (id) => set({ activeVideoId: id }),
  setActiveClipId: (id) => set({ activeClipId: id }),
});
