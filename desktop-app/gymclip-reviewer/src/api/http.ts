// Backend base URL. In the desktop app the port is chosen dynamically (the
// main process probes for a free port in 8000-8099) and handed to the renderer
// via the app:get-backend-base-url IPC channel before React mounts — see
// src/main.tsx. Until that resolves (and in pure-browser dev) we fall back to
// the VITE_API_BASE_URL env or the legacy fixed 8000. Kept mutable so the IPC
// value can override it; `request`/`buildMediaUrl` read it live on every call.
let apiBaseUrl: string = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000';

export function setApiBaseUrl(baseUrl: string | null | undefined): void {
  const trimmed = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : '';
  if (trimmed) {
    apiBaseUrl = trimmed;
  }
}

const API_TOKEN_HEADER = 'X-Gymclip-Token';

// Per-launch API token handed over by the Electron main process via IPC
// (window.gymclipDesktop.getApiToken). src/main.tsx awaits it BEFORE mounting
// React, so the first batch of requests and any synchronously-built media
// URLs already carry it. Stays null in pure-browser dev against a bare
// backend (no GYMCLIP_API_TOKEN -> backend does not enforce auth).
let apiToken: string | null = null;

export function setApiToken(token: string | null): void {
  apiToken = token && token.length > 0 ? token : null;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (apiToken) {
    headers.set(API_TOKEN_HEADER, apiToken);
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    cache: 'no-store',
    ...init,
    headers,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (typeof data?.detail === 'string') {
        message = data.detail;
      }
    } catch {
      // ignore json parse errors for non-json responses
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

/**
 * Build an absolute media URL for `<video>`/`<img>` src attributes.
 *
 * Media elements cannot attach request headers, so the API token rides along
 * as a `?token=` query param instead. Relative backend paths (e.g. the
 * `/api/thumbnails/...` urls returned by the thumbnail endpoint) are
 * prefixed with the backend base URL so they resolve against the backend
 * rather than the renderer origin (vite dev server / file://).
 */
export function buildMediaUrl(pathOrUrl: string): string {
  const absolute = pathOrUrl.startsWith('/') ? `${apiBaseUrl}${pathOrUrl}` : pathOrUrl;
  if (!apiToken) {
    return absolute;
  }
  const separator = absolute.includes('?') ? '&' : '?';
  return `${absolute}${separator}token=${encodeURIComponent(apiToken)}`;
}

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}
