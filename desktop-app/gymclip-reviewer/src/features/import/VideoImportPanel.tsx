import React from 'react';
import {Upload, XCircle} from 'lucide-react';

import {categoryLabel} from '../../lib/format';
import {normalizeCategory, sportKey} from '../../lib/utils';
import type {VideoImportApi} from './useVideoImport';
import {IMPORT_MAG_OPTIONS, IMPORT_WAG_OPTIONS} from './useVideoImport';

export interface VideoImportPanelProps {
  api: VideoImportApi;
}

export const VideoImportPanel = React.memo(function VideoImportPanel({api}: VideoImportPanelProps) {
  const {
    showImportModal,
    importMode,
    isImporting,
    pendingImportVideos,
    pendingDirectClipFiles,
    directClipSelectedMatchIds,
    directClipSelectedFrequenciesByMatchId,
    directClipPreview,
    platformMatches,
    isLoadingPlatformMatches,
    loadingFrequencyMatchIds,
    previewByImportId,
    directClipScopeQueries,
    directClipValidationError,
    directClipRequiresManualApparatus,
    directClipManualSportKeySet,
    directClipHasAllMag,
    directClipHasAllWag,
    openImportSourcePicker,
    closeImportModal,
    handleSubmitImport,
    getMatchById,
    getFrequenciesForMatch,
    getSelectedFrequenciesForItem,
    getDerivedCategoryForItem,
    getEffectiveSportKeysForItem,
    getItemValidationError,
    setPendingVideoMatch,
    togglePendingVideoFrequency,
    togglePendingVideoApparatus,
    setPendingVideoApparatusGroup,
    toggleDirectClipMatch,
    toggleDirectClipFrequency,
    toggleDirectClipApparatus,
    setDirectClipApparatusGroup,
  } = api;

  if (!showImportModal) return null;

  return (
    <div className="fixed inset-0 z-40 bg-gray-900/40 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-6xl max-h-[88vh] bg-white border border-gray-100 rounded-3xl shadow-2xl overflow-hidden flex flex-col">
        <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-white">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              {importMode === 'direct_clip' ? '导入已有片段' : '导入视频与平台成绩卡片'}
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              {importMode === 'direct_clip'
                ? '这一批片段共用一套平台查询条件；每个文件导入后直接成为一个可绑定、可导出的候选片段。'
                : '每个视频独立选择比赛与场次；单项会自动识别项目，全能和团体按视频实际内容手动勾选项目。'}
            </p>
          </div>
          <button
            onClick={closeImportModal}
            disabled={isImporting}
            className="text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-40"
          >
            <XCircle size={22} />
          </button>
        </div>

        {importMode === 'full_video' ? (
          <div className="flex-1 min-h-0 grid grid-cols-[1.55fr_0.85fr]">
            <div className="border-r border-gray-100 min-h-0 flex flex-col bg-gray-50/40">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-gray-900">待导入视频</div>
                  <div className="text-xs text-gray-500 mt-1">{pendingImportVideos.length} 个文件</div>
                </div>
                <button
                  onClick={() => void openImportSourcePicker('full_video')}
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                >
                  <Upload size={15} />
                  重新选择视频
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {pendingImportVideos.map((item) => {
                  const match = getMatchById(item.matchId);
                  const availableFrequencies = getFrequenciesForMatch(item.matchId);
                  const selectedFrequencyIdSet = new Set(item.selectedFrequencies.map((frequency) => frequency.id));
                  const selectedFrequencies = getSelectedFrequenciesForItem(item);
                  const derivedCategory = getDerivedCategoryForItem(item);
                  const effectiveSportKeys = getEffectiveSportKeysForItem(item);
                  const effectiveSportKeySet = new Set(effectiveSportKeys);
                  const isAutoDerivedByVenue = derivedCategory === 'EF' || derivedCategory === 'QF';
                  const canChooseManualApparatus = selectedFrequencies.length > 0 && !isAutoDerivedByVenue;
                  const hasAllMag = IMPORT_MAG_OPTIONS.every((option) => effectiveSportKeySet.has(sportKey(1, option.id)));
                  const hasAllWag = IMPORT_WAG_OPTIONS.every((option) => effectiveSportKeySet.has(sportKey(2, option.id)));
                  const validationMessage = getItemValidationError(item);
                  const isLoadingFrequencies = item.matchId ? Boolean(loadingFrequencyMatchIds[item.matchId]) : false;
                  const preview = previewByImportId[item.clientFileId];
                  // suppress unused match warning
                  void match;
                  return (
                    <div key={item.clientFileId} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-gray-900 truncate">{item.name}</div>
                          <div className="mt-1 text-xs text-gray-500">
                            {(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-gray-400">平台卡片预览</div>
                          <div className={`mt-1 text-sm font-semibold ${preview?.error ? 'text-red-500' : 'text-gray-900'}`}>
                            {preview?.loading
                              ? '查询中...'
                              : preview?.error
                                ? '查询失败'
                                : preview?.count != null
                                  ? `${preview.count} 条`
                                  : '待选择'}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <label className="space-y-2 block">
                          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">赛事</span>
                          <select
                            value={item.matchId ?? ''}
                            onChange={(event) => setPendingVideoMatch(item.clientFileId, event.target.value || null)}
                            className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700"
                          >
                            <option value="">选择赛事</option>
                            {platformMatches.map((platformMatch) => (
                              <option key={platformMatch.id} value={platformMatch.id}>
                                {platformMatch.match_name}
                              </option>
                            ))}
                          </select>
                          {isLoadingPlatformMatches && <div className="text-[11px] text-gray-400">正在加载赛事列表...</div>}
                        </label>

                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">场次</span>
                            {selectedFrequencies.length > 0 && (
                              <span className="text-[11px] text-gray-400">已选 {selectedFrequencies.length} 个</span>
                            )}
                          </div>
                          {!item.matchId ? (
                            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-400">
                              请先为当前视频选择赛事，再从该比赛中勾选一个或多个场次。
                            </div>
                          ) : isLoadingFrequencies ? (
                            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-400">
                              正在加载该赛事的场次列表...
                            </div>
                          ) : availableFrequencies.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-400">
                              当前赛事没有可用场次。
                            </div>
                          ) : (
                            <div className="max-h-44 overflow-y-auto rounded-xl border border-gray-200 bg-white divide-y divide-gray-100">
                              {availableFrequencies.map((frequency) => {
                                const checked = selectedFrequencyIdSet.has(frequency.id);
                                return (
                                  <label key={frequency.id} className="flex items-start gap-3 px-3 py-2.5 text-sm cursor-pointer hover:bg-gray-50">
                                    <input
                                      type="checkbox"
                                      className="mt-0.5 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                      checked={checked}
                                      onChange={() => togglePendingVideoFrequency(item.clientFileId, frequency)}
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block text-gray-800 break-words">{frequency.venue}</span>
                                      <span className="mt-0.5 block text-[11px] text-gray-400">{categoryLabel(normalizeCategory(frequency.category))}</span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div>
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">男子项目</span>
                            <button
                              onClick={() => setPendingVideoApparatusGroup(item.clientFileId, 1, IMPORT_MAG_OPTIONS.map((option) => option.id))}
                              className={`rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors ${
                                hasAllMag
                                  ? 'bg-gray-900 border-gray-900 text-white'
                                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                              }`}
                              disabled={!canChooseManualApparatus}
                            >
                              全部
                            </button>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {IMPORT_MAG_OPTIONS.map((option) => {
                              const selected = effectiveSportKeySet.has(sportKey(1, option.id));
                              return (
                                <button
                                  key={`mag-${option.id}`}
                                  onClick={() => togglePendingVideoApparatus(item.clientFileId, 1, option.id)}
                                  className={`rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                                    selected
                                      ? 'bg-gray-900 border-gray-900 text-white'
                                      : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                                  }`}
                                  disabled={!canChooseManualApparatus}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div>
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">女子项目</span>
                            <button
                              onClick={() => setPendingVideoApparatusGroup(item.clientFileId, 2, IMPORT_WAG_OPTIONS.map((option) => option.id))}
                              className={`rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors ${
                                hasAllWag
                                  ? 'bg-gray-900 border-gray-900 text-white'
                                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                              }`}
                              disabled={!canChooseManualApparatus}
                            >
                              全部
                            </button>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {IMPORT_WAG_OPTIONS.map((option) => {
                              const selected = effectiveSportKeySet.has(sportKey(2, option.id));
                              return (
                                <button
                                  key={`wag-${option.id}`}
                                  onClick={() => togglePendingVideoApparatus(item.clientFileId, 2, option.id)}
                                  className={`rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                                    selected
                                      ? 'bg-gray-900 border-gray-900 text-white'
                                      : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                                  }`}
                                  disabled={!canChooseManualApparatus}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs">
                          {validationMessage ? (
                            <span className="text-gray-400">{validationMessage}</span>
                          ) : preview?.error ? (
                            <span className="text-red-500">{preview.error}</span>
                          ) : preview?.loading ? (
                            <span className="text-gray-600">正在查询平台卡片...</span>
                          ) : preview?.count != null ? (
                            <span className="text-gray-600">将为该视频加载 {preview.count} 张平台成绩卡片。</span>
                          ) : (
                            <span className="text-gray-400">
                              {isAutoDerivedByVenue
                                ? '已按场次自动同步项目，确认场次后会自动查询预览。'
                                : '完成当前视频的比赛、场次和项目选择后自动查询预览。'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="min-h-0 flex flex-col bg-white">
              <div className="px-5 py-4 border-b border-gray-100">
                <div className="text-sm font-semibold text-gray-900">导入规则</div>
                <div className="mt-1 text-xs text-gray-500">每个视频独立选择比赛和场次，右侧卡片只显示当前视频命中的平台记录。</div>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-500 space-y-2">
                  <p>导入要求：</p>
                  <p>1. 每个视频都要单独选择比赛与一个或多个场次。</p>
                  <p>2. 同一视频允许混合男子与女子内容，但已选场次必须属于同一比赛类型。</p>
                  <p>3. 单项/资格赛会根据场次自动识别项目；全能和团体请手动勾选视频实际包含的项目。</p>
                  <p>4. 预览成功后，导入会缓存该视频对应的平台卡片，右侧绑定栏只看当前视频。</p>
                  <p>5. 团体赛不在导入阶段选国家，绑定时通过右侧国家筛选缩小范围。</p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-[1.1fr_0.9fr]">
            <div className="border-r border-gray-100 min-h-0 flex flex-col bg-gray-50/40">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-gray-900">共享平台查询条件</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {directClipPreview.loading
                      ? '平台卡片预览查询中...'
                      : directClipPreview.error
                        ? '平台卡片预览失败'
                        : directClipPreview.count != null
                          ? `命中 ${directClipPreview.count} 张卡片`
                          : '选择比赛、场次、项目后自动预览'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-400">查询组</div>
                  <div className="text-sm font-semibold text-gray-900">{directClipScopeQueries.length}</div>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">比赛</span>
                    <span className="text-[11px] text-gray-400">已选 {directClipSelectedMatchIds.length} 个</span>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-2xl border border-gray-200 bg-white divide-y divide-gray-100">
                    {platformMatches.map((match) => {
                      const checked = directClipSelectedMatchIds.includes(match.id);
                      return (
                        <label key={match.id} className="flex items-start gap-3 px-3 py-2.5 text-sm cursor-pointer hover:bg-gray-50">
                          <input
                            type="checkbox"
                            className="mt-0.5 rounded border-gray-300 text-red-500 focus:ring-red-500"
                            checked={checked}
                            onChange={() => toggleDirectClipMatch(match.id)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-gray-800 break-words">{match.match_name}</span>
                            {match.city && (
                              <span className="mt-0.5 block text-[11px] text-gray-400">{match.city}</span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">场次</div>
                  {directClipSelectedMatchIds.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-gray-200 bg-white px-3 py-3 text-xs text-gray-400">
                      先选择一个或多个比赛，再为每个比赛勾选场次。
                    </div>
                  ) : (
                    directClipSelectedMatchIds.map((matchId) => {
                      const match = getMatchById(matchId);
                      const availableFrequencies = getFrequenciesForMatch(matchId);
                      const selectedFrequencyIdSet = new Set((directClipSelectedFrequenciesByMatchId[matchId] ?? []).map((frequency) => frequency.id));
                      const isLoadingFrequencies = Boolean(loadingFrequencyMatchIds[matchId]);
                      return (
                        <div key={matchId} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-semibold text-gray-900">{match?.match_name || '未命名比赛'}</div>
                            <div className="text-[11px] text-gray-400">
                              已选 {(directClipSelectedFrequenciesByMatchId[matchId] ?? []).length} 个场次
                            </div>
                          </div>
                          {isLoadingFrequencies ? (
                            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-400">
                              正在加载该比赛的场次列表...
                            </div>
                          ) : availableFrequencies.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-400">
                              当前比赛没有可用场次。
                            </div>
                          ) : (
                            <div className="max-h-44 overflow-y-auto rounded-xl border border-gray-200 bg-white divide-y divide-gray-100">
                              {availableFrequencies.map((frequency) => {
                                const checked = selectedFrequencyIdSet.has(frequency.id);
                                return (
                                  <label key={frequency.id} className="flex items-start gap-3 px-3 py-2.5 text-sm cursor-pointer hover:bg-gray-50">
                                    <input
                                      type="checkbox"
                                      className="mt-0.5 rounded border-gray-300 text-red-500 focus:ring-red-500"
                                      checked={checked}
                                      onChange={() => toggleDirectClipFrequency(matchId, frequency)}
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block text-gray-800 break-words">{frequency.venue}</span>
                                      <span className="mt-0.5 block text-[11px] text-gray-400">{categoryLabel(normalizeCategory(frequency.category))}</span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">共享项目选择</div>
                      <div className="mt-1 text-[11px] text-gray-500">
                        EF / QF 会按场次自动识别项目；AA / TF 使用这里的手动选择。
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">男子项目</span>
                      <button
                        onClick={() => setDirectClipApparatusGroup(1, IMPORT_MAG_OPTIONS.map((option) => option.id))}
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors ${
                          directClipHasAllMag
                            ? 'bg-gray-900 border-gray-900 text-white'
                            : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}
                        disabled={!directClipRequiresManualApparatus}
                      >
                        全部
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {IMPORT_MAG_OPTIONS.map((option) => {
                        const selected = directClipManualSportKeySet.has(sportKey(1, option.id));
                        return (
                          <button
                            key={`direct-mag-${option.id}`}
                            onClick={() => toggleDirectClipApparatus(1, option.id)}
                            className={`rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                              selected
                                ? 'bg-gray-900 border-gray-900 text-white'
                                : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                            }`}
                            disabled={!directClipRequiresManualApparatus}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">女子项目</span>
                      <button
                        onClick={() => setDirectClipApparatusGroup(2, IMPORT_WAG_OPTIONS.map((option) => option.id))}
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-medium border transition-colors ${
                          directClipHasAllWag
                            ? 'bg-gray-900 border-gray-900 text-white'
                            : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}
                        disabled={!directClipRequiresManualApparatus}
                      >
                        全部
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {IMPORT_WAG_OPTIONS.map((option) => {
                        const selected = directClipManualSportKeySet.has(sportKey(2, option.id));
                        return (
                          <button
                            key={`direct-wag-${option.id}`}
                            onClick={() => toggleDirectClipApparatus(2, option.id)}
                            className={`rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
                              selected
                                ? 'bg-gray-900 border-gray-900 text-white'
                                : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                            }`}
                            disabled={!directClipRequiresManualApparatus}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs">
                    {directClipValidationError ? (
                      <span className="text-gray-400">{directClipValidationError}</span>
                    ) : directClipPreview.error ? (
                      <span className="text-red-500">{directClipPreview.error}</span>
                    ) : directClipPreview.loading ? (
                      <span className="text-gray-600">正在查询平台成绩卡片...</span>
                    ) : directClipPreview.count != null ? (
                      <span className="text-gray-600">本批片段将共享 {directClipPreview.count} 张平台成绩卡片。</span>
                    ) : (
                      <span className="text-gray-400">完成比赛、场次和项目选择后，会自动生成平台成绩卡片预览。</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex flex-col bg-white">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-gray-900">待导入片段</div>
                  <div className="text-xs text-gray-500 mt-1">{pendingDirectClipFiles.length} 个文件</div>
                </div>
                <button
                  onClick={() => void openImportSourcePicker('direct_clip')}
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                >
                  <Upload size={15} />
                  重新选择片段
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-3 bg-gray-50/40">
                {pendingDirectClipFiles.map((item) => (
                  <div key={item.clientFileId} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="text-sm font-semibold text-gray-900 truncate">{item.name}</div>
                    <div className="mt-1 text-xs text-gray-500">
                      {(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                    </div>
                  </div>
                ))}
                <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-4 text-sm text-gray-500 space-y-2">
                  <p>导入规则：</p>
                  <p>1. 这一批片段共用一个卡片池，可同时覆盖多个比赛、多个场次和多个项目。</p>
                  <p>2. 每个文件导入后会直接生成一个候选片段，默认保留，可立即绑定和导出。</p>
                  <p>3. 右侧卡片区会按比赛和场次分组展示，继续复用现有性别、项目、国家筛选。</p>
                  <p>4. 导出、重命名、OSS 上传和平台回写全部沿用现有逻辑。</p>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="p-5 border-t border-gray-100 flex justify-end gap-3 bg-white">
          <button
            onClick={closeImportModal}
            disabled={isImporting}
            className="px-4 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium text-sm transition-colors border border-gray-200 shadow-sm disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={() => void handleSubmitImport()}
            disabled={
              importMode === 'direct_clip'
                ? (
                  isImporting ||
                  pendingDirectClipFiles.length === 0 ||
                  Boolean(directClipValidationError) ||
                  directClipPreview.loading ||
                  Boolean(directClipPreview.error)
                )
                : (
                  isImporting ||
                  pendingImportVideos.length === 0 ||
                  pendingImportVideos.some(
                    (item) =>
                      Boolean(getItemValidationError(item)) ||
                      previewByImportId[item.clientFileId]?.loading ||
                      Boolean(previewByImportId[item.clientFileId]?.error),
                  )
                )
            }
            className="px-5 py-2.5 rounded-xl bg-gray-900 hover:bg-black text-white font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
          >
            {isImporting ? '导入中...' : importMode === 'direct_clip' ? '确认导入已有片段' : '确认导入'}
          </button>
        </div>
      </div>
    </div>
  );
});
