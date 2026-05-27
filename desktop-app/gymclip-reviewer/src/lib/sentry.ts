import * as Sentry from '@sentry/react';

/**
 * Sensitive keys that should not appear in stack-frame `vars` payloads.
 * TODO(C-5): refine PII filtering — this is a placeholder list; C-5 will
 *            introduce a centralized, well-tested redactor shared across
 *            renderer / electron-main / backend Sentry pipelines.
 */
const SENSITIVE_VAR_KEYS = ['accessKey', 'accessKeyId', 'accessKeySecret', 'secret', 'password'];

/**
 * Filter potential PII / credentials from a Sentry event before it leaves the
 * browser. Currently only inspects `exception.values[*].stacktrace.frames[*].vars`
 * and replaces matching keys with the literal "[Filtered]".
 *
 * TODO(C-5): refine PII filtering — extend to breadcrumbs, request payloads,
 *            and OSS signed-URL query params; add unit tests.
 */
function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  try {
    const values = event.exception?.values;
    if (!values) return event;
    for (const value of values) {
      const frames = value.stacktrace?.frames;
      if (!frames) continue;
      for (const frame of frames) {
        const vars = frame.vars;
        if (!vars || typeof vars !== 'object') continue;
        for (const key of Object.keys(vars)) {
          const lowered = key.toLowerCase();
          if (SENSITIVE_VAR_KEYS.some((sensitive) => lowered.includes(sensitive.toLowerCase()))) {
            (vars as Record<string, unknown>)[key] = '[Filtered]';
          }
        }
      }
    }
  } catch {
    // Never let scrubbing throw — fall through and let Sentry send the
    // original event rather than crash the host application.
  }
  return event;
}

/**
 * Initialize Sentry React SDK.
 *
 * Behavior:
 * - DSN is read from `import.meta.env.VITE_SENTRY_DSN_FRONTEND`.
 * - If the DSN is empty (e.g. dev environment without `.env.local`) we skip
 *   `Sentry.init` entirely and emit a single `console.info` so engineers know
 *   error reporting is dormant — this is intentional and not an error.
 * - The whole `init` call is wrapped in try/catch so that a malformed DSN or
 *   broken SDK build cannot take the renderer down with it.
 * - `release` / `environment` come from `VITE_SENTRY_RELEASE` /
 *   `VITE_SENTRY_ENVIRONMENT`, with safe fallbacks.
 * - `beforeSend` invokes the placeholder PII scrubber (see `scrubEvent`).
 * - Anonymous `userId` wiring (C-5): init runs synchronously (so it's in
 *   place before `ReactDOM.createRoot`), then we fire-and-forget query the
 *   Electron preload bridge for the persisted `{userId, telemetryEnabled}`.
 *   - If `telemetryEnabled === false`, we immediately `Sentry.close()` to
 *     respect the user's opt-out without delaying React mount.
 *   - Otherwise we attach `Sentry.setUser({ id: userId })` so renderer
 *     events share the same anonymous identity as main + backend.
 */
export function initSentry(): void {
  try {
    const dsn = (import.meta.env.VITE_SENTRY_DSN_FRONTEND as string | undefined) ?? '';
    if (!dsn) {
      // eslint-disable-next-line no-console
      console.info('[sentry] VITE_SENTRY_DSN_FRONTEND is empty; Sentry frontend reporting disabled.');
      return;
    }

    const release = (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || 'unknown';
    const environment = (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) || 'development';

    Sentry.init({
      dsn,
      release,
      environment,
      // Browser tracing is intentionally disabled for now; we only want
      // error capture in the foundational refactor. Performance/tracing
      // will be reconsidered in a later milestone.
      integrations: [
        // Sentry.browserTracingIntegration(), // disabled — see comment above
      ],
      // No performance traces yet.
      tracesSampleRate: 0,
      // PII scrubbing — see scrubEvent / TODO(C-5).
      beforeSend: (event) => scrubEvent(event as Sentry.ErrorEvent),
    });

    // Cross-tier anonymous user.id (C-5): fire-and-forget — never block React.
    // 在 Electron 环境下通过 preload bridge 拿持久化的 telemetry config；
    // 在浏览器环境下 (`window.gymclipDesktop` 不存在) 直接保持匿名。
    if (typeof window !== 'undefined' && window.gymclipDesktop?.getTelemetryConfig) {
      window.gymclipDesktop
        .getTelemetryConfig()
        .then((cfg) => {
          if (!cfg.telemetryEnabled) {
            // eslint-disable-next-line no-console
            console.info('[sentry] renderer: telemetry opt-out, closing client.');
            Sentry.close(2000);
            return;
          }
          if (cfg.userId) {
            Sentry.setUser({ id: cfg.userId });
          }
        })
        .catch(() => {
          // 静默：preload bridge 读取失败不应影响应用主流程，
          // 保持匿名上报降级即可。
        });
    } else {
      // 浏览器环境（无 Electron bridge）：保持匿名。
      Sentry.setUser(null);
    }
  } catch (err) {
    // Sentry initialization must never crash the host app — swallow and log.
    // eslint-disable-next-line no-console
    console.warn('[sentry] initSentry failed; continuing without error reporting.', err);
  }
}

export const SentryErrorBoundary = Sentry.ErrorBoundary;
