import {defineConfig} from '@playwright/test';

/**
 * Playwright configuration for GymClip Reviewer Electron e2e tests.
 *
 * - testDir: './e2e' — all *.spec.ts files live alongside fixtures and
 *   shared selector constants in e2e/.
 * - timeout: 60s per test — Electron launch + backend bootstrap is slow
 *   on cold caches (Python venv unpack, port bind, etc.).
 * - retries: only on CI (flaky preview / GPU init quirks). Local runs
 *   fail fast so the dev sees the actual error.
 * - reporter: GitHub annotations in CI, list reporter locally.
 * - trace / screenshot: retained only on failure to keep artifacts small.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {timeout: 10_000},
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Electron e2e must run serially — one app instance per spec
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
