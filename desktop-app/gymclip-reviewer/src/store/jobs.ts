/**
 * Jobs slice — backend AppJob list (detect / export / upload pipelines).
 *
 * Migrated from App.tsx as part of A3:
 *   - jobs: AppJob[] previously held via useState in App
 *
 * Why this needs its own slice (instead of folding into project):
 *   - Jobs live in a separate `/api/jobs` resource and have their own
 *     polling cadence (refreshJobs in App). Treating them as a sibling of
 *     ProjectState keeps the polling effect's dependency surface tight.
 *   - The export feature (`useExportJobs`) was already prop-receiving the
 *     array; once panels read directly from the store the prop drops.
 *
 * Mutations follow the same immutable-update rule as every other slice:
 * each action returns a fresh array — never mutates the existing one —
 * so React's `Object.is` shallow check fires re-renders for subscribers.
 *
 * `upsertJob` matches the prior `setJobs(current => [next, ...filtered])`
 * pattern: the new job is prepended, any old entry with the same id is
 * filtered out. This preserves the visual "newest first" ordering the
 * UI assumes (queue panel sorts by insertion order).
 */
import type { StateCreator } from 'zustand';

import type { AppJob } from '../types';

export interface JobsState {
  jobs: AppJob[];
}

export interface JobsActions {
  setJobs: (next: AppJob[]) => void;
  /**
   * Prepend `job` and drop any existing entry with the same id.
   * Matches the prior `setJobs(c => [job, ...c.filter(j => j.id !== job.id)])`
   * call sites in App.tsx (single detect, batch detect, export).
   */
  upsertJob: (job: AppJob) => void;
  /**
   * Prepend many jobs and drop any prior entries that share an id with
   * the incoming batch. Used by handleDetectSelectedVideos.
   */
  upsertJobs: (next: AppJob[]) => void;
  removeJob: (id: string) => void;
}

export type JobsSlice = JobsState & JobsActions;

export const createJobsSlice: StateCreator<JobsSlice, [], [], JobsSlice> = (set) => ({
  jobs: [],
  setJobs: (next) => set({ jobs: [...next] }),
  upsertJob: (job) =>
    set((state) => ({
      jobs: [job, ...state.jobs.filter((existing) => existing.id !== job.id)],
    })),
  upsertJobs: (incoming) =>
    set((state) => {
      const incomingIds = new Set(incoming.map((job) => job.id));
      return {
        jobs: [...incoming, ...state.jobs.filter((existing) => !incomingIds.has(existing.id))],
      };
    }),
  removeJob: (id) =>
    set((state) => ({
      jobs: state.jobs.filter((existing) => existing.id !== id),
    })),
});
