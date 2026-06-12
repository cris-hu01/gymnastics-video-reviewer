export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000';

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
  const response = await fetch(`${API_BASE_URL}${path}`, {
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
 * prefixed with API_BASE_URL so they resolve against the backend rather
 * than the renderer origin (vite dev server / file://).
 */
export function buildMediaUrl(pathOrUrl: string): string {
  const absolute = pathOrUrl.startsWith('/') ? `${API_BASE_URL}${pathOrUrl}` : pathOrUrl;
  if (!apiToken) {
    return absolute;
  }
  const separator = absolute.includes('?') ? '&' : '?';
  return `${absolute}${separator}token=${encodeURIComponent(apiToken)}`;
}

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}
