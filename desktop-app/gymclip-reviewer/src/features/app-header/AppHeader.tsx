/**
 * AppHeader — the top bar above the three-pane layout.
 *
 * What lives here:
 *   - GymClip logo + name + the in-header toast bubble (success / error).
 *   - API key entry field (gated behind a "show API key" toggle), with
 *     remember-me checkbox and secure-storage status.
 *   - File <input> elements for video import (two, one per mode).
 *   - Import / detect / export trigger buttons.
 *
 * Why pull the toast bubble in here rather than alongside ErrorBanner:
 *   Its physical placement is inside the header (between the logo and
 *   the buttons). Re-anchoring it to the body would force a fixed-
 *   position overlay and we lose the in-flow layout that hides it on
 *   small screens. Moving the JSX along with the header keeps the
 *   visual contract intact.
 *
 * Preserved D-phase testids:
 *   `import-file-input`, `import-file-input-direct-clip`,
 *   `import-trigger`, `import-trigger-direct-clip`, `export-trigger`.
 */
import type {FC} from 'react';
import {useEffect, useRef, useState} from 'react';
import {AlertCircle, CheckCircle2, Download, FileVideo, Info, Key, Upload, XCircle} from 'lucide-react';

import type {AppJob, ProjectState} from '../../types';
import type {ExportJobsApi} from '../export';
import type {VideoImportApi} from '../import';

type ToastKind = 'success' | 'error' | 'info';

type AppToast = {
  id: number;
  kind: ToastKind;
  message: string;
};

const TOAST_DURATION_MS: Record<ToastKind, number> = {
  error: 6000,
  success: 3500,
  info: 3500,
};

/**
 * A single toast bubble that owns its own enter-animation + auto-dismiss timer.
 *
 * - Multi-line: the message wraps (no `truncate`) so long batch-failure lists
 *   are fully readable (discovery 4-1).
 * - Hover pauses dismissal: while the pointer is over the bubble the timer is
 *   cleared and restarted on leave, so the user can read at their own pace.
 * - On fade-out it calls `onDismiss(id)` so the parent removes it from the
 *   queue.
 */
interface ToastBubbleProps {
  toast: AppToast;
  onDismiss: (id: number) => void;
}

const ToastBubble: FC<ToastBubbleProps> = ({toast, onDismiss}) => {
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const dismissTimerRef = useRef<number | null>(null);
  const removeTimerRef = useRef<number | null>(null);

  // Enter animation: mount hidden, flip visible on the next frame.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Auto-dismiss timer, paused while hovered. Re-armed whenever hover ends.
  useEffect(() => {
    if (hovered) {
      if (dismissTimerRef.current != null) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      return;
    }
    dismissTimerRef.current = window.setTimeout(() => {
      setVisible(false);
      removeTimerRef.current = window.setTimeout(() => onDismiss(toast.id), 200);
    }, TOAST_DURATION_MS[toast.kind]);
    return () => {
      if (dismissTimerRef.current != null) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [hovered, toast.id, toast.kind, onDismiss]);

  useEffect(
    () => () => {
      if (removeTimerRef.current != null) window.clearTimeout(removeTimerRef.current);
    },
    [],
  );

  const tone =
    toast.kind === 'error'
      ? {
          shell: 'border-red-200/90 bg-gradient-to-r from-red-50/95 via-white to-red-50/65 text-red-700',
          badge: 'border-red-200 bg-red-100/90 text-red-600',
          text: 'text-red-700',
        }
      : toast.kind === 'info'
        ? {
            shell: 'border-gray-200/90 bg-gradient-to-r from-gray-50/95 via-white to-gray-50/65 text-gray-700',
            badge: 'border-gray-200 bg-gray-100/90 text-gray-500',
            text: 'text-gray-700',
          }
        : {
            shell: 'border-green-200/90 bg-gradient-to-r from-green-50/95 via-white to-green-50/65 text-green-700',
            badge: 'border-green-200 bg-green-100/90 text-green-600',
            text: 'text-green-700',
          };

  return (
    <div
      className="pointer-events-auto flex items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`max-w-[26rem] rounded-[1.05rem] border px-3 py-1.5 shadow-[0_8px_22px_rgba(15,23,42,0.09)] ring-1 ring-white/70 backdrop-blur-xl transition-all duration-200 ease-out ${tone.shell} ${
          visible ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
        }`}
      >
        <div className="flex items-start gap-2">
          <div
            className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${tone.badge}`}
          >
            {toast.kind === 'error' ? (
              <AlertCircle size={14} strokeWidth={2.25} />
            ) : toast.kind === 'info' ? (
              <Info size={14} strokeWidth={2.25} />
            ) : (
              <CheckCircle2 size={14} strokeWidth={2.25} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div
              className={`whitespace-pre-wrap break-words text-[13px] font-medium leading-snug tracking-[0.01em] ${tone.text}`}
            >
              {toast.message}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export interface AppHeaderProps {
  desktopBridge: typeof window.gymclipDesktop;
  toasts: AppToast[];
  onDismissToast: (id: number) => void;
  showApiKey: boolean;
  setShowApiKey: (value: boolean | ((prev: boolean) => boolean)) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  rememberApiKey: boolean;
  setRememberApiKey: (value: boolean) => void;
  supportsSecureStorage: boolean;
  isPersistingApiKey: boolean;
  handleClearSavedApiKey: () => void;

  importApi: VideoImportApi;

  activeVideo: ProjectState['videos'][number] | null;
  activeDetectJob: AppJob | null;
  activeDetectCancelRequested: boolean;
  shouldShowDetectControls: boolean;
  startDetectCount: number;
  isBatchDetecting: boolean;
  shouldUseSelectedVideosForDetect: boolean;
  handleCancelDetect: (videoId: string) => void;
  handleDetectPrimaryAction: () => void;

  exportApi: ExportJobsApi;
  hasOssCredentials: boolean;
  activeExportJob: AppJob | null;
  onCancelExport: () => void;
}

export function AppHeader(props: AppHeaderProps) {
  const {
    desktopBridge,
    toasts,
    onDismissToast,
    showApiKey,
    setShowApiKey,
    apiKey,
    setApiKey,
    rememberApiKey,
    setRememberApiKey,
    supportsSecureStorage,
    isPersistingApiKey,
    handleClearSavedApiKey,
    importApi,
    activeVideo,
    activeDetectJob,
    activeDetectCancelRequested,
    shouldShowDetectControls,
    startDetectCount,
    isBatchDetecting,
    shouldUseSelectedVideosForDetect,
    handleCancelDetect,
    handleDetectPrimaryAction,
    exportApi,
    hasOssCredentials,
    activeExportJob,
    onCancelExport,
  } = props;
  const {
    isImporting,
    importMode,
    openImportSourcePicker,
    handleImportFiles,
    fileInputRef,
    directClipFileInputRef,
  } = importApi;
  const {setShowExport} = exportApi;

  return (
    <header className="h-14 border-b border-gray-200 bg-white/80 backdrop-blur-xl flex items-center justify-between px-4 shrink-0 z-10">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-red-500 flex items-center justify-center text-white font-bold shadow-sm">
          G
        </div>
        <h1 className="text-gray-900 font-semibold tracking-tight">GymClip Reviewer</h1>
        {toasts.length > 0 && (
          <div className="pointer-events-none ml-1 flex flex-col items-start gap-1.5 self-center">
            {toasts.map((toast) => (
              <ToastBubble key={toast.id} toast={toast} onDismiss={onDismissToast} />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="h-10 flex items-center bg-gray-100 rounded-lg px-1.5">
          <button
            onClick={() => setShowApiKey((prev) => !prev)}
            className={`h-8 w-8 flex items-center justify-center rounded-md transition-colors ${
              showApiKey ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-900'
            }`}
            title="配置 AI Key"
          >
            <Key size={16} />
          </button>
          <div
            className={`h-full overflow-hidden transition-all duration-300 ease-in-out flex items-center ${
              showApiKey ? 'w-[26rem] opacity-100 ml-1.5' : 'w-0 opacity-0'
            }`}
          >
            <input
              type="password"
              placeholder="输入 AI API Key..."
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className="h-8 bg-transparent border-none focus:outline-none text-sm px-2 w-full text-gray-700 placeholder:text-gray-400"
            />
            {desktopBridge?.isDesktop && (
              <label
                className={`h-8 flex items-center gap-1.5 px-2 text-xs whitespace-nowrap ${
                  supportsSecureStorage ? 'text-gray-600' : 'text-gray-400'
                }`}
              >
                <input
                  type="checkbox"
                  checked={rememberApiKey}
                  disabled={!supportsSecureStorage}
                  onChange={(event) => setRememberApiKey(event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-gray-300"
                />
                记住
              </label>
            )}
            {desktopBridge?.isDesktop && apiKey && (
              <button
                onClick={handleClearSavedApiKey}
                className="h-8 w-8 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 transition-colors"
                title="清除已保存的 API Key"
              >
                <XCircle size={14} />
              </button>
            )}
            {desktopBridge?.isDesktop && supportsSecureStorage && (
              <span className="h-8 flex items-center px-2 text-[11px] text-gray-400 whitespace-nowrap">
                {isPersistingApiKey ? '保存中...' : rememberApiKey ? '已安全保存' : '仅本次使用'}
              </span>
            )}
          </div>
        </div>

        <div className="w-px h-6 bg-gray-300 mx-1" />

        <input
          ref={fileInputRef}
          data-testid="import-file-input"
          type="file"
          accept="video/*,.mp4,.mov,.mkv,.avi,.flv,.wmv"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) {
              void handleImportFiles(event.target.files, 'full_video');
            }
            event.target.value = '';
          }}
        />
        <input
          ref={directClipFileInputRef}
          data-testid="import-file-input-direct-clip"
          type="file"
          accept="video/*,.mp4,.mov,.mkv,.avi,.flv,.wmv"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) {
              void handleImportFiles(event.target.files, 'direct_clip');
            }
            event.target.value = '';
          }}
        />

        <button
          data-testid="import-trigger"
          onClick={() => void openImportSourcePicker('full_video')}
          className="w-32 h-10 px-3 py-1.5 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium flex items-center justify-center gap-2 whitespace-nowrap transition-colors disabled:opacity-50"
          disabled={isImporting}
        >
          <Upload size={16} />
          {isImporting && importMode === 'full_video' ? '导入中...' : '导入原视频'}
        </button>
        <button
          data-testid="import-trigger-direct-clip"
          onClick={() => void openImportSourcePicker('direct_clip')}
          className="w-36 h-10 px-3 py-1.5 text-sm rounded-lg bg-white hover:bg-gray-50 text-gray-700 font-medium flex items-center justify-center gap-2 whitespace-nowrap transition-colors border border-gray-200 disabled:opacity-50"
          disabled={isImporting}
        >
          <FileVideo size={16} />
          {isImporting && importMode === 'direct_clip' ? '导入中...' : '导入已有片段'}
        </button>
        {activeDetectJob ? (
          <button
            onClick={() => activeVideo && void handleCancelDetect(activeVideo.id)}
            className="px-3 py-1.5 text-sm rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 font-medium flex items-center gap-2 border border-amber-200 shadow-sm transition-colors disabled:opacity-50"
            disabled={!activeVideo || activeDetectCancelRequested}
          >
            <XCircle size={16} />
            {activeDetectCancelRequested
              ? '取消中...'
              : activeDetectJob.status === 'queued'
                ? '取消排队'
                : '取消检测'}
          </button>
        ) : shouldShowDetectControls ? (
          <button
            onClick={() => void handleDetectPrimaryAction()}
            className="w-32 h-10 px-3 py-1.5 text-sm rounded-lg bg-gray-900 hover:bg-black text-white font-medium flex items-center justify-center gap-2 whitespace-nowrap shadow-sm transition-colors disabled:opacity-50"
            disabled={startDetectCount === 0 || isBatchDetecting}
          >
            <CheckCircle2 size={16} />
            {isBatchDetecting
              ? '加入队列中...'
              : shouldUseSelectedVideosForDetect && startDetectCount > 0
                ? `开始检测 (${startDetectCount})`
                : '开始检测'}
          </button>
        ) : (
          <div className="w-32 h-10 px-3 py-1.5 text-sm rounded-lg bg-gray-100 text-gray-500 font-medium flex items-center justify-center whitespace-nowrap">
            无需检测
          </div>
        )}
        <button
          data-testid="export-trigger"
          onClick={() => {
            exportApi.setExportOperation('export_and_upload');
            exportApi.setIsOssCredentialsExpanded(!hasOssCredentials);
            exportApi.setIsUploadSettingsExpanded(false);
            setShowExport(true);
          }}
          className="w-32 h-10 px-3 py-1.5 text-sm rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-2 whitespace-nowrap shadow-sm transition-colors disabled:opacity-50"
          disabled={Boolean(activeExportJob)}
        >
          <Download size={16} />
          {activeExportJob ? '导出中...' : '导出片段'}
        </button>
        {activeExportJob ? (
          <button
            data-testid="export-cancel"
            onClick={onCancelExport}
            disabled={activeExportJob.progress?.stage === 'cancel_requested'}
            title={
              activeExportJob.progress?.stage === 'cancel_requested'
                ? '正在取消导出...'
                : '取消当前导出任务'
            }
            className="h-10 px-3 py-1.5 text-sm rounded-lg border border-red-300 bg-white hover:bg-red-50 text-red-600 font-medium flex items-center justify-center gap-1.5 whitespace-nowrap shadow-sm transition-colors disabled:opacity-50"
          >
            <XCircle size={16} />
            {activeExportJob.progress?.stage === 'cancel_requested' ? '取消中...' : '取消导出'}
          </button>
        ) : null}
      </div>
    </header>
  );
}
