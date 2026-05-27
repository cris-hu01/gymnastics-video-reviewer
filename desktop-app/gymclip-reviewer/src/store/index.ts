/**
 * Central zustand store for gymclip-reviewer renderer.
 *
 * Why zustand instead of useReducer + Context? See plan
 * docs/superpowers/specs (or .claude/plans/...) "Subproject A — App.tsx
 * split". Short version: 7 cross-domain pieces of state currently live in
 * App.tsx as top-level useState, and a no-prop-drilling story makes the
 * downstream feature folder split (A2–A4) much cleaner.
 *
 * Migration policy:
 * - A1 (now): bootstrap store + migrate 2 low-risk slices (selectedVideoIds,
 *   selectedClipIds) to validate the pattern.
 * - A3: migrate activeVideoId, activeClip, project, jobs.
 * - A4: migrate playback + trim (the dangerous triangle).
 *
 * persist policy:
 * - We deliberately do NOT use `zustand/middleware`'s `persist` here for
 *   v1.3.0. All persistence still flows through the existing backend
 *   `state.json` + the electron-store / localStorage helpers in
 *   `lib/utils.ts`. Introducing persist with the wrong key namespace would
 *   undermine the rollback strategy documented in the plan ("zustand persist
 *   must use a fresh key, never reuse v1.2.x keys"). When/if we add persist
 *   later, use the key `gymclip-store-v1.3.0` and bump the version on every
 *   schema change.
 */
import { createActiveSlice, type ActiveSlice } from './active';
import { createProjectSlice, type ProjectSlice } from './project';
import { createSelectionSlice, type SelectionSlice } from './selection';
import { create } from 'zustand';

/**
 * The full store type is the intersection of every slice. Each slice
 * adds its own state + actions; this aggregator keeps the call sites
 * (`useStore(s => s.foo)`) flat.
 *
 * As we migrate more state in A3/A4, add new slice types here.
 */
export type AppStore = SelectionSlice & ActiveSlice & ProjectSlice;

export const useStore = create<AppStore>()((set, get, store) => ({
  ...createSelectionSlice(set, get, store),
  ...createActiveSlice(set, get, store),
  ...createProjectSlice(set, get, store),
}));

/**
 * Imperative accessor for non-React contexts (event handlers that close
 * over stale React state, async callbacks, electron IPC handlers, etc.).
 *
 * Prefer the hook form `useStore(selector)` inside components — only reach
 * for `getState()` when you genuinely cannot subscribe (e.g. inside a
 * `setTimeout` started by a `useEffect` whose dependencies have changed).
 */
export const getStoreState = useStore.getState;
export const setStoreState = useStore.setState;
