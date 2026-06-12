export {};

declare global {
  interface Window {
    gymclipDesktop?: {
      isDesktop: boolean;
      // Local API auth: per-launch token from the Electron main process.
      // Optional so an older preload paired with a newer renderer degrades
      // to no-auth instead of crashing.
      getApiToken?: () => Promise<string>;
      loadApiKey: () => Promise<{ supported: boolean; apiKey: string | null }>;
      saveApiKey: (apiKey: string) => Promise<{ supported: boolean }>;
      clearApiKey: () => Promise<{ supported: boolean }>;
      loadOssCredentials: () => Promise<{ supported: boolean; accessKeyId: string | null; accessKeySecret: string | null }>;
      saveOssCredentials: (accessKeyId: string, accessKeySecret: string) => Promise<{ supported: boolean }>;
      clearOssCredentials: () => Promise<{ supported: boolean }>;
      loadDefaultExportDirectory: () => Promise<{ defaultExportDirectory: string | null }>;
      saveDefaultExportDirectory: (defaultExportDirectory: string) => Promise<{ defaultExportDirectory: string | null }>;
      loadUploadSettings: () => Promise<{ uploadParallelFiles: number; uploadPartThreads: number }>;
      saveUploadSettings: (uploadParallelFiles: number, uploadPartThreads: number) => Promise<{ uploadParallelFiles: number; uploadPartThreads: number }>;
      selectDirectory: (initialPath?: string) => Promise<string | null>;
      selectImportSources: (initialPath?: string) => Promise<Array<{ path: string; name: string; size: number }>>;
      showSystemNotification: (payload: { title: string; subtitle?: string; body?: string }) => Promise<{ shown: boolean; reason?: string }>;
      // === Telemetry / Sentry consent (C-5) ===
      getTelemetryConfig: () => Promise<{ userId: string; telemetryEnabled: boolean }>;
      setTelemetryConsent: (enabled: boolean) => Promise<{ userId: string; telemetryEnabled: boolean }>;
      // === Auto-updater (E-5) ===
      onUpdateAvailable?: (cb: (info: { version: string; releaseNotes?: string; releaseName?: string }) => void) => void;
      onDownloadProgress?: (cb: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => void;
      onUpdateDownloaded?: (cb: (info: { version: string; releaseNotes?: string; releaseName?: string }) => void) => void;
      quitAndInstall?: () => Promise<void>;
    };
  }
}
