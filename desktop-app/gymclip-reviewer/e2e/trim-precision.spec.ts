/**
 * e2e/trim-precision.spec.ts — verifies the exported mp4 length matches
 * the user's trim selection within a small tolerance.
 *
 * Currently SKIPPED: programmatic pointer-drag of the timeline trim
 * handles is non-trivial (the handles capture pointermove/pointerup on
 * `document`, and we need pixel-precise math against the timeline rect).
 *
 * Once we expose either:
 *   1. A keyboard shortcut to nudge trim by 0.1s (already partly wired —
 *      see App.tsx handleKeyDown around line 1370), OR
 *   2. A `data-trim-bounds` JSON attribute on the timeline container so
 *      the test can compute the exact px offset for a given seconds value
 *
 * ...we can unskip this and assert the exported file's
 * `ffprobe -show_format` duration falls within ±0.1s of the requested
 * trim range.
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

// Same prep helper used by main-flow.spec — pre-seed telemetry.json so the
// first-run consent dialog (electron/main.cjs) doesn't block window creation.
function prepareUserDataDir(suffix: string): string {
  const dir = path.join(os.tmpdir(), `gymclip-e2e-userdata-${suffix}-${Date.now()}`);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(
    path.join(dir, 'telemetry.json'),
    JSON.stringify(
      {
        userId: '00000000-0000-4000-8000-000000000001',
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

test.describe('trim precision', () => {
  let app: ElectronApplication;
  let window: Page;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = prepareUserDataDir('trim');
    app = await electron.launch({
      args: [ROOT, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        SENTRY_DSN_FRONTEND: '',
        SENTRY_DSN_ELECTRON: '',
        SENTRY_DSN_BACKEND: '',
        GYMCLIP_TELEMETRY_ENABLED: '0',
        GYMCLIP_WORKSPACE: process.env.GYMCLIP_WORKSPACE ?? '/tmp/gymclip-e2e-trim',
      },
    });
    window = await app.firstWindow();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test.skip('dragging trim-handle-end produces an mp4 within ±0.1s tolerance', async () => {
    // 1. Import sample-5s.mp4 via setInputFiles on [data-testid="import-file-input"].
    // 2. Wait for clip to appear: [data-testid^="clip-item-"].
    // 3. Click the first clip to load it into the trim editor.
    // 4. Read the timeline container rect.
    // 5. Drag [data-testid="trim-handle-end"] left by (rect.width * 0.4)
    //    which should shorten the clip from 5s -> ~3s.
    // 6. Click [data-testid="export-trigger"], fill [data-testid="export-output-dir"]
    //    with a tmp path, click [data-testid="export-confirm"].
    // 7. Poll backend job list until done.
    // 8. Spawn `ffprobe -show_format -of json <exported.mp4>`, parse duration,
    //    expect(duration).toBeCloseTo(3.0, 1).

    const trimEnd = window.locator(`[data-testid="${TESTIDS.trimHandleEnd}"]`);
    await expect(trimEnd).toBeVisible();
  });
});
