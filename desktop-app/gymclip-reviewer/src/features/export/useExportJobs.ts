import type {MutableRefObject} from 'react';
import {useEffect, useRef, useState} from 'react';

import type {AppJob} from '../../types';
import {
  buildExportCompletedNotification,
  buildExportFailedNotification,
  loadBrowserDefaultExportDirectory,
  loadBrowserUploadSettings,
  saveBrowserDefaultExportDirectory,
  saveBrowserUploadSettings,
} from '../../lib/utils';
import type {ExportOperation} from '../../lib/utils';
import {summarizeExportJob} from '../../lib/clip-math';

export type ExportMode = 'standard' | 'fast';

export interface ExportSummaryState {
  operation: ExportOperation;
  attempted: number;
  exported: number;
  failed: number;
  uploaded: number;
  synced: number;
  output_directory: string;
}

export interface UseExportJobsOptions {
  desktopBridge: typeof window.gymclipDesktop;
  jobs: AppJob[];
  setErrorMessage: (value: string | null) => void;
  setSuccessMessage: (value: string | null) => void;
  /** Whether secure-storage flow has finished priming (gates OSS persistence). */
  apiKeyPersistenceReadyRef: MutableRefObject<boolean>;
  supportsSecureStorage: boolean;
}

export interface ExportJobsApi {
  // state
  showExport: boolean;
  setShowExport: (value: boolean) => void;
  outputDir: string;
  setOutputDir: (value: string) => void;
  savedOutputDir: string;
  exportMode: ExportMode;
  setExportMode: (value: ExportMode) => void;
  exportOperation: ExportOperation;
  setExportOperation: (value: ExportOperation) => void;
  uploadParallelFiles: number;
  setUploadParallelFiles: (value: number) => void;
  uploadPartThreads: number;
  setUploadPartThreads: (value: number) => void;
  isUploadSettingsExpanded: boolean;
  setIsUploadSettingsExpanded: (value: boolean | ((prev: boolean) => boolean)) => void;
  ossAccessKeyId: string;
  setOssAccessKeyId: (value: string) => void;
  ossAccessKeySecret: string;
  setOssAccessKeySecret: (value: string) => void;
  isPersistingOssCredentials: boolean;
  isOssCredentialsExpanded: boolean;
  setIsOssCredentialsExpanded: (value: boolean | ((prev: boolean) => boolean)) => void;
  exportSummary: ExportSummaryState | null;
  setExportSummary: (value: ExportSummaryState | null) => void;
  hasOssCredentials: boolean;
  hasSavedOutputDir: boolean;
  // handlers
  persistDefaultOutputDirectory: (nextPath: string) => Promise<void>;
  clearOssCredentialsViaBridge: () => Promise<void>;
}

export function useExportJobs(options: UseExportJobsOptions): ExportJobsApi {
  const {
    desktopBridge,
    jobs,
    setErrorMessage,
    setSuccessMessage,
    apiKeyPersistenceReadyRef,
    supportsSecureStorage,
  } = options;

  const [showExport, setShowExport] = useState(false);
  const [outputDir, setOutputDir] = useState('');
  const [savedOutputDir, setSavedOutputDir] = useState('');
  const [exportMode, setExportMode] = useState<ExportMode>('standard');
  const [exportOperation, setExportOperation] = useState<ExportOperation>('export_and_upload');
  const [uploadParallelFiles, setUploadParallelFiles] = useState(2);
  const [uploadPartThreads, setUploadPartThreads] = useState(4);
  const [isUploadSettingsExpanded, setIsUploadSettingsExpanded] = useState(false);
  const [ossAccessKeyId, setOssAccessKeyId] = useState('');
  const [ossAccessKeySecret, setOssAccessKeySecret] = useState('');
  const [isPersistingOssCredentials, setIsPersistingOssCredentials] = useState(false);
  const [isOssCredentialsExpanded, setIsOssCredentialsExpanded] = useState(true);
  const [exportSummary, setExportSummary] = useState<ExportSummaryState | null>(null);

  const uploadSettingsPersistenceReadyRef = useRef(false);
  const handledJobIdsRef = useRef<Set<string>>(new Set());
  const notifiedDesktopJobIdsRef = useRef<Set<string>>(new Set());
  const desktopNotificationPrimedRef = useRef(false);

  const hasOssCredentials = Boolean(ossAccessKeyId.trim() && ossAccessKeySecret.trim());
  const hasSavedOutputDir = savedOutputDir.trim().length > 0;

  // ---- Effect: load persisted export-related settings on mount ----
  useEffect(() => {
    if (!desktopBridge?.isDesktop) {
      const browserDefaultDirectory = loadBrowserDefaultExportDirectory();
      const browserUploadSettings = loadBrowserUploadSettings();
      if (browserDefaultDirectory) {
        setSavedOutputDir(browserDefaultDirectory);
        setOutputDir(browserDefaultDirectory);
      }
      setUploadParallelFiles(browserUploadSettings.uploadParallelFiles);
      setUploadPartThreads(browserUploadSettings.uploadPartThreads);
      uploadSettingsPersistenceReadyRef.current = true;
      return;
    }

    let cancelled = false;

    void desktopBridge
      .loadOssCredentials()
      .then((response) => {
        if (cancelled) return;
        if (response.accessKeyId) setOssAccessKeyId(response.accessKeyId);
        if (response.accessKeySecret) setOssAccessKeySecret(response.accessKeySecret);
      })
      .catch(() => {
        // ignore
      });

    void desktopBridge
      .loadDefaultExportDirectory()
      .then((response) => {
        if (cancelled) return;
        const nextDirectory = String(response.defaultExportDirectory || '').trim();
        if (!nextDirectory) return;
        setSavedOutputDir(nextDirectory);
        setOutputDir(nextDirectory);
      })
      .catch(() => {
        // ignore
      });

    void desktopBridge
      .loadUploadSettings()
      .then((response) => {
        if (cancelled) return;
        setUploadParallelFiles(response.uploadParallelFiles);
        setUploadPartThreads(response.uploadPartThreads);
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        if (!cancelled) {
          uploadSettingsPersistenceReadyRef.current = true;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [desktopBridge]);

  // ---- Effect: debounce-persist upload settings ----
  useEffect(() => {
    if (!uploadSettingsPersistenceReadyRef.current) return;

    const timer = window.setTimeout(async () => {
      const nextParallelFiles = Math.max(1, uploadParallelFiles);
      const nextPartThreads = Math.max(1, uploadPartThreads);
      if (desktopBridge?.isDesktop && desktopBridge.loadUploadSettings && desktopBridge.saveUploadSettings) {
        try {
          await desktopBridge.saveUploadSettings(nextParallelFiles, nextPartThreads);
        } catch {
          // ignore persistence failures to avoid blocking export configuration
        }
      } else {
        saveBrowserUploadSettings(nextParallelFiles, nextPartThreads);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [desktopBridge, uploadParallelFiles, uploadPartThreads]);

  // ---- Effect: debounce-persist OSS credentials ----
  useEffect(() => {
    if (!desktopBridge?.isDesktop) return;
    if (!apiKeyPersistenceReadyRef.current) return;
    if (!supportsSecureStorage) return;

    const timer = window.setTimeout(async () => {
      const trimmedId = ossAccessKeyId.trim();
      const trimmedSecret = ossAccessKeySecret.trim();
      if (!trimmedId && !trimmedSecret) {
        setIsPersistingOssCredentials(true);
        try {
          await desktopBridge.clearOssCredentials();
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : '清除 OSS 凭证失败');
        } finally {
          setIsPersistingOssCredentials(false);
        }
        return;
      }
      if (!trimmedId || !trimmedSecret) {
        return;
      }
      setIsPersistingOssCredentials(true);
      try {
        await desktopBridge.saveOssCredentials(trimmedId, trimmedSecret);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '保存 OSS 凭证失败');
      } finally {
        setIsPersistingOssCredentials(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [desktopBridge, supportsSecureStorage, ossAccessKeyId, ossAccessKeySecret, apiKeyPersistenceReadyRef, setErrorMessage]);

  // ---- Effect: react to terminal job statuses (toast / exportSummary) ----
  useEffect(() => {
    for (const job of jobs) {
      if (job.status === 'queued' || job.status === 'running') continue;
      if (handledJobIdsRef.current.has(job.id)) continue;
      handledJobIdsRef.current.add(job.id);

      if (job.status === 'failed') {
        setErrorMessage(job.error_message || `${job.kind === 'detect' ? '检测' : '导出'}任务失败`);
        continue;
      }

      if (job.status === 'cancelled') {
        if (job.kind === 'detect') {
          setSuccessMessage('检测已取消');
        }
        continue;
      }

      if (job.kind === 'detect') {
        const totalCandidates = Number(job.result.total_candidates || 0);
        setSuccessMessage(`检测完成，生成 ${totalCandidates} 个候选片段`);
        continue;
      }

      if (job.kind === 'export') {
        const summary = summarizeExportJob(job, outputDir);
        const {operation} = summary;
        setExportSummary(summary);
        if (operation === 'export_only') {
          setSuccessMessage(`导出完成：本地 ${summary.exported}/${summary.attempted}`);
        } else if (operation === 'upload_only') {
          setSuccessMessage(`上传完成：OSS ${summary.uploaded}/${summary.attempted}，回写 ${summary.synced}`);
        } else {
          setSuccessMessage(`导出完成：本地 ${summary.exported}/${summary.attempted}，上传 ${summary.uploaded}，回写 ${summary.synced}`);
        }
      }
    }
  }, [jobs, outputDir, setErrorMessage, setSuccessMessage]);

  // ---- Effect: desktop system notification for finished export jobs ----
  useEffect(() => {
    if (!desktopBridge?.isDesktop || !desktopBridge.showSystemNotification) return;

    if (!desktopNotificationPrimedRef.current) {
      for (const job of jobs) {
        if (job.status === 'queued' || job.status === 'running') continue;
        notifiedDesktopJobIdsRef.current.add(job.id);
      }
      desktopNotificationPrimedRef.current = true;
      return;
    }

    for (const job of jobs) {
      if (job.status === 'queued' || job.status === 'running') continue;
      if (notifiedDesktopJobIdsRef.current.has(job.id)) continue;
      notifiedDesktopJobIdsRef.current.add(job.id);
      if (job.kind !== 'export') continue;

      const payload =
        job.status === 'failed'
          ? buildExportFailedNotification(job, outputDir)
          : job.status === 'completed'
            ? buildExportCompletedNotification(summarizeExportJob(job, outputDir))
            : null;
      if (!payload) continue;

      void desktopBridge.showSystemNotification(payload).catch(() => {
        // Ignore notification failures and keep in-app status as the source of truth.
      });
    }
  }, [desktopBridge, jobs, outputDir]);

  // ---- Handlers ---------------------------------------------------------
  async function persistDefaultOutputDirectory(nextPath: string) {
    const trimmed = nextPath.trim();
    if (!trimmed) return;

    if (desktopBridge?.isDesktop && desktopBridge.loadDefaultExportDirectory && desktopBridge.saveDefaultExportDirectory) {
      await desktopBridge.saveDefaultExportDirectory(trimmed);
    } else {
      saveBrowserDefaultExportDirectory(trimmed);
    }
    setSavedOutputDir(trimmed);
  }

  async function clearOssCredentialsViaBridge() {
    setOssAccessKeyId('');
    setOssAccessKeySecret('');
    if (desktopBridge?.clearOssCredentials) {
      await desktopBridge.clearOssCredentials();
    }
  }

  return {
    showExport,
    setShowExport,
    outputDir,
    setOutputDir,
    savedOutputDir,
    exportMode,
    setExportMode,
    exportOperation,
    setExportOperation,
    uploadParallelFiles,
    setUploadParallelFiles,
    uploadPartThreads,
    setUploadPartThreads,
    isUploadSettingsExpanded,
    setIsUploadSettingsExpanded,
    ossAccessKeyId,
    setOssAccessKeyId,
    ossAccessKeySecret,
    setOssAccessKeySecret,
    isPersistingOssCredentials,
    isOssCredentialsExpanded,
    setIsOssCredentialsExpanded,
    exportSummary,
    setExportSummary,
    hasOssCredentials,
    hasSavedOutputDir,
    persistDefaultOutputDirectory,
    clearOssCredentialsViaBridge,
  };
}
