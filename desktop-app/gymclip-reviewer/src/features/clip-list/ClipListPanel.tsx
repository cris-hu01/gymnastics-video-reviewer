/**
 * ClipListPanel — the middle "候选片段" sidebar between the video list
 * and the review surface.
 *
 * Why a standalone panel rather than nesting under ReviewPanel:
 *   - The list outlives any individual clip (it stays visible while you
 *     switch between clips), so coupling it to ReviewPanel's
 *     "activeClip || empty-state" branch would force needless re-renders.
 *   - Search / status filter / group-collapse state belongs together
 *     with the list itself, not with the player chrome to its right.
 *
 * What stays in App.tsx (passed in as props):
 *   - `groupedFilteredClips`, `filteredClips`, `clipOrdinalById`,
 *     `videoById`, `platformRecordById` — all derived from project state.
 *   - Selection state (`selectedClipIdSet`) — lives in the zustand
 *     selection slice; we still pass it as a prop to keep the panel
 *     ignorant of the store layout.
 *   - Search / filter setters and the clip mutation callbacks. The
 *     panel surfaces them in inputs/buttons and routes pointer events
 *     to them via props.
 *
 * Preserved testids:
 *   - `clip-item-${clip.id}` on each clip button (D-phase).
 */
import type {MouseEvent as ReactMouseEvent} from 'react';

import {ChevronDown, ChevronUp, FileVideo, Filter, RefreshCw, Search} from 'lucide-react';

import {StatusBadge} from '../../components/StatusBadge';
import {TriStateCheckboxButton} from '../../components/TriStateCheckboxButton';
import {retryClipStage} from '../../api';
import {
  bindingTheme,
  getClipDisplayCountry,
  getClipDisplayName,
  getClipFailureStage,
  getClipRuntimeStatusText,
  getClipUploadItem,
  isClipExportSelectable,
} from '../../lib/filters';
import {clipEffectiveDuration} from '../../lib/clip-math';
import {firstDisplayText, formatClock, formatDuration, pipelineToneClass, statusLabel} from '../../lib/format';
import type {
  AppJob,
  CandidateClip,
  ClipStatus,
  PlatformRecord,
  ProjectState,
} from '../../types';

type FilterStatus = ClipStatus | 'all';
type ProjectVideo = ProjectState['videos'][number];

interface GroupedClips {
  id: string;
  title: string;
  scopeId: string;
  video: ProjectVideo;
  clips: CandidateClip[];
  isDirectClipGroup: boolean;
}

export interface ClipListPanelProps {
  clips: CandidateClip[];
  filteredClips: CandidateClip[];
  groupedFilteredClips: GroupedClips[];
  collapsedClipGroupIds: string[];
  activeClipId: string | null;
  selectedClipIds: Set<string>;
  exportTargetClipsCount: number;
  videoById: Map<string, ProjectVideo>;
  platformRecordById: Map<string, PlatformRecord>;
  clipOrdinalById: Map<string, number>;
  activeExportJob: AppJob | null;
  lockedExportClipIdSet: Set<string>;
  savedOutputDir: string;
  ossAccessKeyId: string;
  ossAccessKeySecret: string;
  searchQuery: string;
  filterStatus: FilterStatus;
  onSearchQuery: (next: string) => void;
  onFilterStatus: (next: FilterStatus) => void;
  toggleClipGroup: (groupId: string) => void;
  getClipGroupSelectionState: (clipIds: string[]) => 'checked' | 'indeterminate' | 'unchecked';
  toggleSelectAllClipsInGroup: (clipIds: string[]) => void;
  handleClipCardClick: (clip: CandidateClip, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onProjectFromRetry: (project: ProjectState) => void;
}

const STATUS_TABS: Array<FilterStatus> = ['all', 'pending', 'kept', 'deleted', 'exported'];

export function ClipListPanel(props: ClipListPanelProps) {
  const {
    clips,
    filteredClips,
    groupedFilteredClips,
    collapsedClipGroupIds,
    activeClipId,
    selectedClipIds,
    exportTargetClipsCount,
    videoById,
    platformRecordById,
    clipOrdinalById,
    activeExportJob,
    lockedExportClipIdSet,
    savedOutputDir,
    ossAccessKeyId,
    ossAccessKeySecret,
    searchQuery,
    filterStatus,
    onSearchQuery,
    onFilterStatus,
    toggleClipGroup,
    getClipGroupSelectionState,
    toggleSelectAllClipsInGroup,
    handleClipCardClick,
    onProjectFromRetry,
  } = props;

  return (
    <section className="w-96 border-r border-gray-200 bg-white flex flex-col shrink-0">
      <div className="p-4 border-b border-gray-200 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">候选片段</h2>
          <div className="flex items-center gap-2 text-xs text-gray-500 font-medium">
            {exportTargetClipsCount > 0 && <span>已选 {exportTargetClipsCount}</span>}
            <span>{filteredClips.length} 个结果</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="搜索运动员..."
              value={searchQuery}
              onChange={(event) => onSearchQuery(event.target.value)}
              className="w-full bg-gray-100 border-transparent rounded-lg py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:bg-white focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all"
            />
          </div>
          <button className="p-1.5 rounded-lg bg-gray-100 text-gray-600 transition-colors cursor-default">
            <Filter size={16} />
          </button>
        </div>

        <div className="flex p-1 bg-gray-100/80 rounded-lg">
          {STATUS_TABS.map((status) => (
            <button
              key={status}
              onClick={() => onFilterStatus(status)}
              className={`flex-1 text-xs py-1.5 rounded-md capitalize font-medium transition-all ${
                filterStatus === status
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {status === 'all' ? '全部' : statusLabel(status)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {clips.length === 0 && (
          <div className="text-sm text-gray-400 px-2 py-4">
            导入原视频并完成检测，或直接导入已有片段后，候选片段会显示在这里。
          </div>
        )}
        {clips.length > 0 && filteredClips.length === 0 && (
          <div className="text-sm text-gray-400 px-2 py-4">当前筛选条件下没有候选片段。</div>
        )}
        {groupedFilteredClips.map(({id, title, clips: groupedClips}) => {
          const isCollapsed = collapsedClipGroupIds.includes(id);
          const hasActiveClip = groupedClips.some((clip) => clip.id === activeClipId);
          const groupExportableClipIds = groupedClips
            .filter((clip) => isClipExportSelectable(clip.status))
            .map((clip) => clip.id);
          const groupSelectionState = getClipGroupSelectionState(groupExportableClipIds);

          return (
            <div key={id} className="rounded-xl border border-gray-200 overflow-hidden bg-white">
              <div
                className={`w-full px-2.5 py-1.5 flex items-center justify-between gap-2 transition-colors ${
                  hasActiveClip ? 'bg-gray-100' : 'bg-gray-50 hover:bg-gray-100'
                }`}
              >
                <div className="min-w-0 flex flex-1 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleClipGroup(id)}
                    className="flex items-center justify-center rounded p-0.5 text-gray-400 transition-colors hover:bg-white hover:text-gray-700"
                    title={isCollapsed ? '展开分组' : '收起分组'}
                  >
                    {isCollapsed ? <ChevronDown size={14} className="shrink-0" /> : <ChevronUp size={14} className="shrink-0" />}
                  </button>
                  <TriStateCheckboxButton
                    state={groupSelectionState}
                    disabled={groupExportableClipIds.length === 0}
                    onClick={() => toggleSelectAllClipsInGroup(groupExportableClipIds)}
                    title={groupExportableClipIds.length === 0 ? '当前分组没有可导出的片段' : '全选当前分组可导出的片段'}
                  />
                  <button
                    type="button"
                    onClick={() => toggleClipGroup(id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="text-sm font-medium text-gray-700 truncate">{title}</span>
                  </button>
                </div>
                <span className="text-[10px] font-medium text-gray-500 shrink-0">{groupedClips.length} 个</span>
              </div>

              {!isCollapsed && (
                <div className="p-2 space-y-2 border-t border-gray-100">
                  {groupedClips.map((clip) => {
                    const clipVideo = videoById.get(clip.video_id) ?? null;
                    const linkedRecord = clip.linked_platform_record_id
                      ? platformRecordById.get(clip.linked_platform_record_id) ?? null
                      : null;
                    const theme = linkedRecord ? bindingTheme(linkedRecord.id) : null;
                    const displayName = getClipDisplayName(clip, linkedRecord, clipVideo);
                    const displayCountry = getClipDisplayCountry(clip, linkedRecord);
                    const linkedLabel = linkedRecord
                      ? firstDisplayText(
                          displayName === linkedRecord.english_name
                            ? linkedRecord.user_name
                            : linkedRecord.english_name,
                          linkedRecord.user_name,
                        ) || '已绑定卡片'
                      : null;
                    const isExportSelected = selectedClipIds.has(clip.id);
                    const runtimeStatusText = getClipRuntimeStatusText(clip, activeExportJob, lockedExportClipIdSet);

                    return (
                      <button
                        key={clip.id}
                        data-testid={`clip-item-${clip.id}`}
                        onClick={(event) => handleClipCardClick(clip, event)}
                        className={`relative w-full text-left p-2.5 rounded-xl border transition-all flex gap-3 ${
                          activeClipId === clip.id
                            ? 'bg-red-50/60 border-red-200 shadow-sm ring-1 ring-red-100'
                            : isExportSelected
                              ? 'bg-red-50/40 border-red-100 shadow-sm hover:bg-red-50/50'
                              : 'border-transparent hover:bg-gray-50'
                        }`}
                      >
                        {linkedRecord && theme && (
                          <span
                            className="absolute left-1 top-2 bottom-2 w-1 rounded-full"
                            style={{backgroundColor: theme.accent}}
                          />
                        )}

                        <div className="relative w-24 h-14 rounded-lg bg-gray-100 shrink-0 overflow-hidden border border-gray-200/50 flex items-center justify-center">
                          <FileVideo size={20} className="text-gray-300" />
                          <div className="absolute bottom-1 right-1 bg-black/60 backdrop-blur-md px-1.5 py-0.5 rounded text-[10px] font-mono text-white font-medium">
                            {formatDuration(clipEffectiveDuration(clip))}
                          </div>
                        </div>

                        <div className="flex-1 min-w-0 py-0.5 flex flex-col justify-between">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p
                                className={`text-sm truncate ${
                                  activeClipId === clip.id
                                    ? 'text-gray-900 font-semibold'
                                    : 'text-gray-700 font-medium'
                                }`}
                              >
                                {displayName}
                              </p>
                              {!linkedRecord && clipVideo?.source_kind === 'direct_clip' && (
                                <div className="mt-1 text-[11px] text-gray-400 truncate">{clipVideo.file_name}</div>
                              )}
                              {linkedLabel && theme && (
                                <div
                                  className="mt-1 inline-flex max-w-full items-center gap-1.5 text-[11px] font-medium"
                                  style={{color: theme.text}}
                                >
                                  <span
                                    className="h-2 w-2 rounded-full shrink-0"
                                    style={{backgroundColor: theme.accent}}
                                  />
                                  <span className="truncate">{linkedLabel}</span>
                                </div>
                              )}
                            </div>
                            <span className="text-xs font-mono text-gray-400 shrink-0">{displayCountry}</span>
                          </div>

                          <div className="flex items-center justify-between mt-1 gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-xs text-gray-500 font-mono">{formatClock(clip.review_start)}</span>
                              {linkedRecord && theme && (
                                <span
                                  className="truncate text-[11px] font-medium"
                                  style={{color: theme.text}}
                                >
                                  片段#{clipOrdinalById.get(clip.id) ?? '--'}
                                </span>
                              )}
                            </div>
                            <ClipStatusBadge
                              clip={clip}
                              activeExportJob={activeExportJob}
                              lockedExportClipIdSet={lockedExportClipIdSet}
                              savedOutputDir={savedOutputDir}
                              ossAccessKeyId={ossAccessKeyId}
                              ossAccessKeySecret={ossAccessKeySecret}
                              onProjectFromRetry={onProjectFromRetry}
                            />
                          </div>
                          {runtimeStatusText && (
                            <div className="mt-1 text-[11px] text-amber-600 truncate">{runtimeStatusText}</div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Pipeline-stage status pill rendered to the right of each clip card.
 * Pulled into its own component because the chain of `if` branches was
 * obscuring the surrounding list layout.
 */
function ClipStatusBadge({
  clip,
  activeExportJob,
  lockedExportClipIdSet,
  savedOutputDir,
  ossAccessKeyId,
  ossAccessKeySecret,
  onProjectFromRetry,
}: {
  clip: CandidateClip;
  activeExportJob: AppJob | null;
  lockedExportClipIdSet: Set<string>;
  savedOutputDir: string;
  ossAccessKeyId: string;
  ossAccessKeySecret: string;
  onProjectFromRetry: (project: ProjectState) => void;
}) {
  const uploadItem = getClipUploadItem(activeExportJob, clip.id);
  const activeJobClipId = String(activeExportJob?.progress.clip_id || '');
  const activeStage = activeJobClipId === clip.id ? String(activeExportJob?.progress.stage || '') : '';
  const failureStage = getClipFailureStage(clip);

  if (failureStage) {
    const failLabels: Record<string, string> = {
      export: '导出失败',
      oss: 'OSS失败',
      platform: '回写失败',
    };
    return (
      <span className="inline-flex items-center gap-0.5">
        <span
          className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('danger')}`}
        >
          {failLabels[failureStage] ?? '失败'}
        </span>
        <button
          type="button"
          className="p-0.5 rounded hover:bg-gray-100 text-red-500"
          title="重试"
          onClick={(e) => {
            e.stopPropagation();
            void retryClipStage(clip.id, failureStage as 'export' | 'oss' | 'platform', {
              output_dir: savedOutputDir || undefined,
              oss_access_key_id: ossAccessKeyId.trim() || undefined,
              oss_access_key_secret: ossAccessKeySecret.trim() || undefined,
            })
              .then((res) => {
                if (res.project) onProjectFromRetry(res.project);
              })
              .catch(() => undefined);
          }}
        >
          <RefreshCw size={12} />
        </button>
      </span>
    );
  }

  if (activeStage === 'local_export') {
    return (
      <span
        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}
      >
        导出中
      </span>
    );
  }
  if (uploadItem?.stage === 'oss_upload' || activeStage === 'oss_upload') {
    const pct = uploadItem && uploadItem.percent > 0 ? ` ${Math.round(uploadItem.percent)}%` : '';
    return (
      <span
        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}
      >
        OSS上传中{pct}
      </span>
    );
  }
  if (uploadItem?.stage === 'platform_callback' || activeStage === 'platform_callback') {
    return (
      <span
        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}
      >
        回写中
      </span>
    );
  }

  if (clip.platform_sync_status === 'synced') {
    return (
      <span
        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('success')}`}
      >
        已回写
      </span>
    );
  }
  if (clip.uploaded_url || clip.platform_sync_status === 'uploading_done') {
    if (uploadItem?.stage === 'queued' || lockedExportClipIdSet.has(clip.id)) {
      return (
        <span
          className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}
        >
          回写队列中
        </span>
      );
    }
    return (
      <span
        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('success')}`}
      >
        已上传
      </span>
    );
  }
  if (clip.exported_path) {
    if (uploadItem?.stage === 'queued' || lockedExportClipIdSet.has(clip.id)) {
      return (
        <span
          className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}
        >
          上传队列中
        </span>
      );
    }
    return (
      <span
        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('success')}`}
      >
        已导出
      </span>
    );
  }
  if (lockedExportClipIdSet.has(clip.id)) {
    return (
      <span
        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pipelineToneClass('warning')}`}
      >
        导出队列中
      </span>
    );
  }

  return <StatusBadge status={clip.status} />;
}
