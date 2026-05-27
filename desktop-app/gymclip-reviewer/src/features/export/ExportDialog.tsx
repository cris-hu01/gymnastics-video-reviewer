import React from 'react';
import {CheckCircle2, ChevronDown, ChevronUp, FolderOpen, XCircle} from 'lucide-react';

import type {AppJob, CandidateClip} from '../../types';
import {EXPORT_OPERATION_DETAILS} from '../../lib/utils';
import type {ExportJobsApi, ExportMode} from './useExportJobs';

const EXPORT_MODE_DETAILS: Record<ExportMode, {label: string; description: string}> = {
  standard: {
    label: '标准',
    description: '兼容性优先，默认模式。适合大多数导出场景。',
  },
  fast: {
    label: '快速',
    description: '更快导出，但压缩效率更低，文件通常更大。',
  },
};

export interface ExportDialogProps {
  api: ExportJobsApi;
  desktopBridge: typeof window.gymclipDesktop;
  isPersistingApiKey: boolean;
  exportTargetClipsCount: number;
  exportTargetBoundCount: number;
  exportTargetLocalBoundCount: number;
  uploadOnlyInvalidClips: CandidateClip[];
  uploadOnlySourceSummary: {exportedFileCount: number; directSourceCount: number};
  activeExportJob: AppJob | null | undefined;
  renderJobProgress: (job: AppJob) => string;
  renderJobPercent: (job: AppJob) => number;
  onExport: () => void;
  onPickExportDirectory: () => void;
}

export const ExportDialog = React.memo(function ExportDialog(props: ExportDialogProps) {
  const {
    api,
    desktopBridge,
    isPersistingApiKey,
    exportTargetClipsCount,
    exportTargetBoundCount,
    exportTargetLocalBoundCount,
    uploadOnlyInvalidClips,
    uploadOnlySourceSummary,
    activeExportJob,
    renderJobProgress,
    renderJobPercent,
    onExport,
    onPickExportDirectory,
  } = props;
  const {
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
    hasOssCredentials,
    hasSavedOutputDir,
    persistDefaultOutputDirectory,
    clearOssCredentialsViaBridge,
  } = api;

  if (!showExport) return null;

  return (
    <div data-testid="export-dialog" className="fixed inset-0 z-40 bg-gray-900/40 backdrop-blur-sm flex items-center justify-center">
      <div className="w-[520px] max-h-[min(92vh,920px)] bg-white border border-gray-100 rounded-3xl shadow-2xl flex flex-col overflow-hidden">
        <div className="shrink-0 p-5 border-b border-gray-100 flex items-center justify-between bg-white">
          <h3 className="text-lg font-semibold text-gray-900">导出与上传</h3>
          <button data-testid="export-close" onClick={() => setShowExport(false)} className="text-gray-400 hover:text-gray-600 transition-colors">
            <XCircle size={22} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6 space-y-6 bg-gray-50/50">
          <div className="flex items-center justify-between p-4 rounded-2xl bg-white border border-gray-200 shadow-sm">
            <div>
              <p className="text-sm font-medium text-gray-500 mb-1">准备执行</p>
              <p className="text-2xl font-bold text-gray-900">
                {exportTargetClipsCount} <span className="text-base font-medium text-gray-500">个片段</span>
              </p>
              <p className="mt-2 text-xs text-gray-500">
                {exportTargetClipsCount > 0
                  ? exportOperation === 'export_only'
                    ? '当前模式只做本地导出，不上传 OSS，也不回写平台。'
                    : exportOperation === 'upload_only'
                      ? uploadOnlyInvalidClips.length > 0
                        ? `仅上传要求所选片段已绑定平台卡片，且已导出或满足已有片段原片直传条件；当前有 ${uploadOnlyInvalidClips.length} 个片段不满足条件。`
                        : `当前将直接上传所选片段；默认优先上传已导出文件，仅当没有导出文件时才会重命名原片直传。已绑定平台卡片会在 OSS 成功后自动回写平台。`
                      : `当前将导出所选片段；其中 ${Math.max(exportTargetBoundCount - exportTargetLocalBoundCount, 0)} 个已绑定平台卡片会自动上传 OSS 并回写平台${exportTargetLocalBoundCount > 0 ? `，${exportTargetLocalBoundCount} 个本地补录片段会落入"本地补录"子文件夹` : ''}。`
                  : '请先在候选片段列表中选择要导出的片段。'}
              </p>
            </div>
            <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-gray-900">
              <CheckCircle2 size={24} />
            </div>
          </div>

          <div className="space-y-3">
            <label className="text-sm font-semibold text-gray-700">执行模式</label>
            <div className="grid grid-cols-3 gap-2">
              {(['export_only', 'upload_only', 'export_and_upload'] as const).map((operation) => (
                <button
                  key={operation}
                  type="button"
                  onClick={() => setExportOperation(operation)}
                  className={`rounded-2xl border px-3 py-3 text-left transition-colors ${
                    exportOperation === operation
                      ? 'border-red-200 bg-red-50 text-red-600'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <div className="text-sm font-semibold">{EXPORT_OPERATION_DETAILS[operation].label}</div>
                  <div className={`mt-1 text-xs ${exportOperation === operation ? 'text-red-500' : 'text-gray-500'}`}>
                    {EXPORT_OPERATION_DETAILS[operation].description}
                  </div>
                </button>
              ))}
            </div>
            {exportOperation === 'upload_only' && uploadOnlyInvalidClips.length > 0 && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                仅上传要求所选片段已绑定平台卡片，且已导出或满足已有片段原片直传条件。请先处理不满足条件的片段。
              </div>
            )}
            {exportOperation === 'upload_only' && exportTargetClipsCount > 0 && uploadOnlyInvalidClips.length === 0 && (
              <div className="rounded-2xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-700">
                当前上传来源：已导出文件 {uploadOnlySourceSummary.exportedFileCount} 个；原片直传 {uploadOnlySourceSummary.directSourceCount} 个。
                规则：如果片段已有导出文件，优先上传导出文件；只有没有导出文件时，才会对未编辑的已有片段重命名原文件后直传。
              </div>
            )}
            {exportOperation !== 'export_only' && exportTargetLocalBoundCount > 0 && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                选中片段中有 {exportTargetLocalBoundCount} 个绑定本地补录卡片，将自动跳过上传与平台回写，{exportOperation === 'upload_only' ? '仅作为跳过处理' : '本地导出后落入"本地补录"子文件夹'}。
              </div>
            )}
          </div>

          {exportOperation !== 'export_only' && (
            <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-gray-900">上传设置</div>
                  <div className="text-xs text-gray-500">自动记住同时上传文件数和单文件分片线程。</div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsUploadSettingsExpanded((current) => !current)}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100"
                >
                  {isUploadSettingsExpanded ? '收起' : '展开'}
                  {isUploadSettingsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
              {isUploadSettingsExpanded && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-2 text-sm font-semibold text-gray-700">
                      同时上传文件数
                      <input
                        type="number"
                        min={1}
                        max={6}
                        value={uploadParallelFiles}
                        onChange={(event) => setUploadParallelFiles(Math.max(1, Number(event.target.value) || 1))}
                        className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 shadow-sm"
                      />
                    </label>
                    <label className="space-y-2 text-sm font-semibold text-gray-700">
                      单文件分片线程
                      <input
                        type="number"
                        min={1}
                        max={8}
                        value={uploadPartThreads}
                        onChange={(event) => setUploadPartThreads(Math.max(1, Number(event.target.value) || 1))}
                        className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 shadow-sm"
                      />
                    </label>
                  </div>
                  <p className="text-xs text-gray-400">默认使用 2 个文件并发上传，每个文件 4 个分片线程。网络或磁盘吃满时可调低。</p>
                </>
              )}
            </div>
          )}

          {exportOperation !== 'upload_only' && (
            <div className="space-y-3">
              <label className="text-sm font-semibold text-gray-700">默认导出目录</label>
              <input
                data-testid="export-output-dir"
                type="text"
                value={outputDir}
                onChange={(event) => setOutputDir(event.target.value)}
                onBlur={() => {
                  if (outputDir.trim()) {
                    void persistDefaultOutputDirectory(outputDir);
                  }
                }}
                placeholder="输入或选择默认导出目录"
                className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 font-mono shadow-sm"
              />
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    if (hasSavedOutputDir) {
                      setOutputDir(savedOutputDir);
                    }
                  }}
                  disabled={!hasSavedOutputDir}
                  className="rounded-xl border border-gray-200 bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-200 disabled:opacity-50"
                >
                  使用默认目录
                </button>
                {desktopBridge?.isDesktop && (
                  <button
                    onClick={onPickExportDirectory}
                    className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
                  >
                    <FolderOpen size={16} />
                    选择文件夹
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-400">
                {hasSavedOutputDir ? '当前已记住这个目录，下次打开会默认回填。' : '输入或选择目录后，app 会记住它作为下次默认目录。'}
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-gray-900">OSS 凭证</div>
                <div className="text-xs text-gray-500">
                  {hasOssCredentials ? '已配置，可用于包含上传的模式。' : '未配置完整 OSS 凭证，包含上传的模式将无法开始。'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {(isPersistingOssCredentials || isPersistingApiKey) && (
                  <div className="text-xs text-gray-400">保存中...</div>
                )}
                <button
                  type="button"
                  onClick={() => setIsOssCredentialsExpanded((current) => !current)}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100"
                >
                  {isOssCredentialsExpanded ? '收起' : '展开'}
                  {isOssCredentialsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
            </div>
            {isOssCredentialsExpanded && (
              <>
                <div className="grid grid-cols-1 gap-3">
                  <label className="space-y-1.5">
                    <div className="text-xs font-medium text-gray-600">AccessKey ID</div>
                    <input
                      type="text"
                      value={ossAccessKeyId}
                      onChange={(event) => setOssAccessKeyId(event.target.value)}
                      placeholder="输入 OSS AccessKey ID"
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700 shadow-sm"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <div className="text-xs font-medium text-gray-600">AccessKey Secret</div>
                    <input
                      type="password"
                      value={ossAccessKeySecret}
                      onChange={(event) => setOssAccessKeySecret(event.target.value)}
                      placeholder="输入 OSS AccessKey Secret"
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700 shadow-sm"
                    />
                  </label>
                </div>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className={hasOssCredentials ? 'text-green-600' : 'text-amber-600'}>
                    {hasOssCredentials ? '已就绪，可执行 OSS 上传' : '未配置完整 OSS 凭证，已绑定片段将无法上传'}
                  </span>
                  {desktopBridge?.isDesktop && (
                    <button
                      onClick={() => void clearOssCredentialsViaBridge()}
                      className="text-gray-500 hover:text-gray-700"
                    >
                      清除凭证
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {activeExportJob && (
            <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm space-y-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-red-500 transition-all duration-300"
                  style={{width: `${renderJobPercent(activeExportJob)}%`}}
                />
              </div>
              <div className="text-base text-gray-700">{renderJobProgress(activeExportJob)}</div>
              {activeExportJob.error_message && (
                <div className="text-xs text-red-600">{activeExportJob.error_message}</div>
              )}
            </div>
          )}

          {exportOperation !== 'upload_only' && (
            <div className="space-y-3">
              <label className="text-sm font-semibold text-gray-700">编码模式</label>
              <select
                value={exportMode}
                onChange={(event) => setExportMode(event.target.value as ExportMode)}
                className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700 shadow-sm"
              >
                <option value="standard">标准</option>
                <option value="fast">快速</option>
              </select>
              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="text-sm font-semibold text-gray-900">{EXPORT_MODE_DETAILS[exportMode].label}</div>
                <div className="mt-1 text-xs text-gray-500">{EXPORT_MODE_DETAILS[exportMode].description}</div>
              </div>
            </div>
          )}

          {exportSummary && (
            <div className="rounded-2xl bg-white border border-gray-200 p-4 text-sm text-gray-600 space-y-1 shadow-sm">
              <div>执行模式：{EXPORT_OPERATION_DETAILS[exportSummary.operation].label}</div>
              <div>输出目录：{exportSummary.output_directory}</div>
              <div>尝试导出：{exportSummary.attempted}</div>
              <div>本地导出成功：{exportSummary.exported}</div>
              <div>OSS 上传成功：{exportSummary.uploaded}</div>
              <div>平台回写成功：{exportSummary.synced}</div>
              <div>失败：{exportSummary.failed}</div>
            </div>
          )}

        </div>

        <div className="shrink-0 border-t border-gray-100 bg-white px-6 py-4">
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowExport(false)}
              className="px-4 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium text-sm transition-colors border border-gray-200 shadow-sm"
            >
              关闭
            </button>
            <button
              data-testid="export-confirm"
              onClick={onExport}
              disabled={exportTargetClipsCount === 0 || Boolean(activeExportJob)}
              className="px-5 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
            >
              {activeExportJob
                ? (activeExportJob.status === 'queued' ? '排队中...' : '处理中...')
                : `开始${EXPORT_OPERATION_DETAILS[exportOperation].label}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
