export {};

declare global {
  interface Window {
    gymclipDesktop?: {
      isDesktop: boolean;
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
    };
  }
}
