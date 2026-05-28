/**
 * e2e/main-flow.spec.ts — happy-path Electron smoke test.
 *
 * Stage 1 (this commit): launch Electron, wait for the first BrowserWindow,
 * assert the window title, and poll the backend's /api/health until it
 * responds 200 OK (this confirms the backend Python subprocess has booted
 * and bound to 127.0.0.1:8000).
 *
 * Stage 2 (follow-up): drive the actual import → review → export flow via
 * the testid selectors in ./testids. Step skeletons are sketched below
 * with `test.skip(...)` so reviewers can see the intended coverage.
 */
import {test, expect, _electron as electron, type ElectronApplication, type Page} from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';
import {TESTIDS} from './testids';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const FIXTURE_5S = path.resolve(__dirname, 'fixtures', 'sample-5s.mp4');

/**
 * Pre-seed an Electron userData dir with telemetry.json so the consent
 * dialog (electron/main.cjs:_maybeShowConsentDialog) does NOT block
 * window creation. Without this, app.firstWindow() times out waiting for
 * the user to dismiss the dialog.
 */
function prepareUserDataDir(suffix: string): string {
  const dir = path.join(os.tmpdir(), `gymclip-e2e-userdata-${suffix}-${Date.now()}`);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(
    path.join(dir, 'telemetry.json'),
    JSON.stringify(
      {
        userId: '00000000-0000-4000-8000-000000000000',
        telemetryEnabled: false,
        consentVersion: 1,
        decidedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf-8',
  );
  return dir;
}

test.describe('main flow', () => {
  let app: ElectronApplication;
  let window: Page;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = prepareUserDataDir('main-flow');
    app = await electron.launch({
      args: [ROOT, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        // Disable Sentry on all three layers so e2e doesn't ping
        // external services.
        SENTRY_DSN_FRONTEND: '',
        SENTRY_DSN_ELECTRON: '',
        SENTRY_DSN_BACKEND: '',
        GYMCLIP_TELEMETRY_ENABLED: '0',
        // Sandbox workspace so e2e runs don't touch the dev workspace.
        GYMCLIP_WORKSPACE: process.env.GYMCLIP_WORKSPACE ?? '/tmp/gymclip-e2e',
      },
      timeout: 60_000,
    });
    // Pipe Electron main-process logs into Playwright stdout so a failing
    // beforeAll has something actionable to inspect (backend startup
    // errors, port conflicts, missing Python deps, etc.).
    app.process().stdout?.on('data', (data) => console.log(`[main] ${data}`));
    app.process().stderr?.on('data', (data) => console.error(`[main:err] ${data}`));
    window = await app.firstWindow();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('launches Electron and exposes a window with the GymClip title', async () => {
    await expect(window).toHaveTitle(/GymClip/i);
  });

  test('backend /api/health responds 200 within 30s of launch', async () => {
    // Poll from the renderer process so we exercise the same fetch path
    // production code uses (Electron's net stack + CORS).
    await window.waitForFunction(
      async () => {
        try {
          const response = await fetch('http://127.0.0.1:8000/api/health');
          return response.ok;
        } catch {
          return false;
        }
      },
      undefined,
      {timeout: 30_000, polling: 1_000},
    );
  });

  // --- Stage 2 placeholders -------------------------------------------------
  // These outline the full import → review → export coverage we want.
  // Each is `test.skip(...)` until the prerequisites land (Electron file
  // chooser stub, deterministic detector for synthetic fixtures, etc.).

  test.skip('imports a video via setInputFiles on the file input', async () => {
    // Reveal hidden file input, attach fixture, wait for the new video item.
    const input = window.locator(`[data-testid="${TESTIDS.importFileInput}"]`);
    await input.setInputFiles(FIXTURE_5S);
    // TODO: await window.locator('[data-testid^="video-item-"]').first().waitFor();
  });

  test.skip('selects the first candidate clip and shows trim handles', async () => {
    // TODO: click first clip-item-*, assert trim-handle-start/end are visible.
  });

  test.skip('opens export dialog and confirms export', async () => {
    // TODO: click export-trigger, fill export-output-dir, click export-confirm,
    // wait for activeExportJob progress -> succeeded, assert mp4 exists.
  });
});
