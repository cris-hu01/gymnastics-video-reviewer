/**
 * Project slice — the authoritative `ProjectState` snapshot.
 *
 * Migrated from App.tsx as part of A3:
 *   - project: ProjectState | null previously held via useState in App
 *
 * Why this is the central piece of cross-domain state:
 *   - Every panel (video list, clip list, platform match, player) reads
 *     `project.videos / .candidate_clips / .platform_records / .platform_scopes`.
 *   - Two feature hooks (`useVideoImport`, `useLocalCard`) previously
 *     received `onProjectUpdate` callbacks; with the store they call the
 *     same action directly (still safe — zustand setters are stable
 *     references).
 *
 * No persist middleware on purpose:
 *   - All persistence already flows through the backend `state.json`
 *     endpoints. Layering zustand persist on top would double-write and
 *     fight the rollback policy described in `store/index.ts`.
 *
 * Two write paths exist by design:
 *   - `setProject(next)` for full replacements (the common path — every
 *     API response returns a fresh ProjectState).
 *   - `patchProject(updater)` for the rare in-place tweak that previously
 *     used the functional `setState((current) => ...)` form (e.g.
 *     `markVideosQueued` flipping a handful of video.status fields without
 *     waiting for a server round-trip). The updater returns either a
 *     fully new ProjectState or `null` to leave the prior value untouched
 *     (mirrors the old `if (!current) return current;` short-circuit).
 */
import type { StateCreator } from 'zustand';

import type { ProjectState } from '../types';

export interface ProjectStateSlice {
  project: ProjectState | null;
}

export interface ProjectActions {
  setProject: (next: ProjectState | null) => void;
  /**
   * Functional-update equivalent of the prior `setProject((cur) => ...)`
   * pattern. The updater receives the current project (possibly null),
   * and may return:
   *   - a new ProjectState (replaces current),
   *   - `null` (clears the project),
   *   - `undefined` (skips the update; matches the old "return current"
   *     short-circuit so consumers don't need a tri-state contract).
   */
  patchProject: (
    updater: (current: ProjectState | null) => ProjectState | null | undefined,
  ) => void;
}

export type ProjectSlice = ProjectStateSlice & ProjectActions;

export const createProjectSlice: StateCreator<ProjectSlice, [], [], ProjectSlice> = (set) => ({
  project: null,
  setProject: (next) => set({ project: next }),
  patchProject: (updater) =>
    set((state) => {
      const result = updater(state.project);
      if (result === undefined) return state;
      return { project: result };
    }),
});
