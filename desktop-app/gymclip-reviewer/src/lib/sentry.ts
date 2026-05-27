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
 * - `anonymousUserId` cross-tier correlation is intentionally deferred to
 *   C-5: the Electron preload bridge (`window.gymclipDesktop`) does not yet
 *   expose an `anonymousUserId`, so we set the user context to undefined now
 *   and will wire it through in C-5.
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

    // anonymousUserId wiring is deferred to C-5; the Electron preload bridge
    // does not yet expose it. When that lands, call Sentry.setUser({ id }).
    Sentry.setUser(null);
  } catch (err) {
    // Sentry initialization must never crash the host app — swallow and log.
    // eslint-disable-next-line no-console
    console.warn('[sentry] initSentry failed; continuing without error reporting.', err);
  }
}

export const SentryErrorBoundary = Sentry.ErrorBoundary;
