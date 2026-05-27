/**
 * VideoListPanel — the left sidebar that lists imported videos grouped
 * by match/folder. Extracted from App.tsx as part of A3-4.
 *
 * Design:
 *   - Cross-domain state (selectedVideoIds, activeVideoId, project) is
 *     read directly from the zustand store — no prop drilling.
 *   - UI-only state (folder collapse, sidebar collapse, context menu)
 *     comes from `useVideoListPanel()` and is passed down via the
 *     `local` prop.
 *   - Helpers that depend on App.tsx-level memos (videoFolders,
 *     detectJobsByVideoId, selectedStartableVideos, etc.) are passed
 *     down as props. Pulling those memos out of App.tsx is out of scope
 *     for A3 — A4 will do that as part of the playback/trim split.
 *   - All 17 D-phase data-testid values are preserved verbatim.
 *
 * Why include the context menu inside the panel: it operates on a
 * videoId picked by right-clicking a list item; logically it lives in
 * the same domain as the list itself.
 */
import {ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, FileVideo, Trash2, XCircle} from 'lucide-react';
import type {ReactNode} from 'react';

import {TriStateCheckboxButton} from '../../components/TriStateCheckboxButton';
import {categoryLabel, formatDuration, formatSportItemLabel, videoStatusClass, videoStatusLabel} from '../../lib/format';
import {useStore} from '../../store';
import type {AppJob, ProjectState} from '../../types';

import type {VideoListPanelLocalState} from './useVideoListPanel';

type ProjectVideo = ProjectState['videos'][number];

export interface VideoFolderEntry {
  id: string;
  title: string;
  scopeId: string;
  isDirectClipGroup: boolean;
  videos: ProjectVideo[];
}

export interface VideoListPanelProps {
  local: VideoListPanelLocalState;
  isLoading: boolean;
  videos: ProjectVideo[];
  videoFolders: VideoFolderEntry[];
  detectJobsByVideoId: Map<string, AppJob>;
  selectedCancellableVideos: ProjectVideo[];
  selectedDeletableVideos: ProjectVideo[];
  /** App-level helpers passed through (see file header). */
  toggleSelectAllVideos: () => void;
  toggleVideoFolder: (folderId: string) => void;
  getVideoFolderSelectionState: (videoIds: string[]) => 'checked' | 'indeterminate' | 'unchecked';
  toggleSelectAllVideosInFolder: (videoIds: string[]) => void;
  toggleVideoSelection: (videoId: string) => void;
  onCancelSelectedVideos: () => void;
  onDeleteSelectedVideos: () => void;
  onCancelDetect: (videoId: string) => void;
  onDeleteVideo: (videoId: string) => void;
  renderVideoProgress: (video: ProjectVideo) => ReactNode;
}

export function VideoListPanel(props: VideoListPanelProps) {
  const {
    local,
    isLoading,
    videos,
    videoFolders,
    detectJobsByVideoId,
    selectedCancellableVideos,
    selectedDeletableVideos,
    toggleSelectAllVideos,
    toggleVideoFolder,
    getVideoFolderSelectionState,
    toggleSelectAllVideosInFolder,
    toggleVideoSelection,
    onCancelSelectedVideos,
    onDeleteSelectedVideos,
    onCancelDetect,
    onDeleteVideo,
    renderVideoProgress,
  } = props;

  const {
    collapsedVideoFolderIds,
    isVideoSidebarCollapsed,
    setIsVideoSidebarCollapsed,
    setVideoContextMenu,
  } = local;

  // Cross-domain state straight from the store. Subscribing here means
  // App.tsx no longer needs to thread these through the component tree.
  const selectedVideoIds = useStore((s) => s.selectedVideoIds);
  const activeVideoId = useStore((s) => s.activeVideoId);
  const setActiveVideoId = useStore((s) => s.setActiveVideoId);

  return (
    <aside className={`${isVideoSidebarCollapsed ? 'w-14' : 'w-72'} border-r border-gray-200 bg-gray-50/50 flex flex-col shrink-0 transition-all duration-300`}>
      <div className={`border-b border-gray-200 ${isVideoSidebarCollapsed ? 'p-2' : 'p-4 space-y-3'}`}>
        <div className="flex items-center justify-between gap-3">
          {!isVideoSidebarCollapsed ? (
            <>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">视频任务 ({videos.length})</h2>
              <div className="flex items-center gap-2">
                {selectedVideoIds.size > 0 && (
                  <span className="text-[11px] font-medium text-gray-500">已选 {selectedVideoIds.size}</span>
                )}
                <button
                  onClick={() => setIsVideoSidebarCollapsed(true)}
                  className="rounded-lg p-1 text-gray-400 hover:bg-white hover:text-gray-700"
                  title="收起视频栏"
                >
                  <ChevronLeft size={16} />
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={() => setIsVideoSidebarCollapsed(false)}
              className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg bg-white text-gray-500 shadow-sm hover:text-gray-900"
              title="展开视频栏"
            >
              <ChevronRight size={16} />
            </button>
          )}
        </div>
        {!isVideoSidebarCollapsed && videos.length > 0 && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={toggleSelectAllVideos}
              className="min-w-0 flex-1 px-2 py-1 text-[11px] rounded-lg bg-white border border-gray-200 text-gray-600 hover:border-gray-300 hover:text-gray-900 transition-colors disabled:opacity-50"
              disabled={videos.length === 0}
            >
              {selectedVideoIds.size === videos.length ? '取消全选' : '全选'}
            </button>
            <button
              onClick={onCancelSelectedVideos}
              className="min-w-0 flex-1 px-2 py-1 text-[11px] rounded-lg bg-white border border-gray-200 text-amber-700 hover:border-amber-200 hover:bg-amber-50 transition-colors disabled:opacity-50"
              disabled={selectedCancellableVideos.length === 0}
            >
              批量取消
            </button>
            <button
              onClick={onDeleteSelectedVideos}
              className="min-w-0 flex-1 px-2 py-1 text-[11px] rounded-lg bg-white border border-gray-200 text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors disabled:opacity-50"
              disabled={selectedDeletableVideos.length === 0}
            >
              批量删除
            </button>
          </div>
        )}
      </div>
      <div className={`flex-1 overflow-y-auto ${isVideoSidebarCollapsed ? 'p-2' : 'p-3 space-y-2'}`}>
        {isLoading && !isVideoSidebarCollapsed && <p className="text-sm text-gray-400 px-2">加载项目中...</p>}
        {!isLoading && videos.length === 0 && !isVideoSidebarCollapsed && (
          <div className="text-sm text-gray-400 px-2 py-4">拖拽视频到窗口，或点击顶部“导入视频”。</div>
        )}
        {videoFolders.map((folder) => {
          const folderVideoIds = folder.videos.map((video) => video.id);
          const folderSelectionState = getVideoFolderSelectionState(folderVideoIds);
          const isFolderCollapsed = collapsedVideoFolderIds.includes(folder.id);
          const hasActiveVideo = folder.videos.some((video) => video.id === activeVideoId);

          if (isVideoSidebarCollapsed) {
            const firstVideo = folder.videos[0];
            return (
              <button
                key={folder.id}
                onClick={() => {
                  setActiveVideoId(firstVideo?.id ?? null);
                  setIsVideoSidebarCollapsed(false);
                }}
                className={`mb-2 flex h-10 w-10 items-center justify-center rounded-xl border ${
                  hasActiveVideo ? 'bg-white border-gray-300 shadow-sm text-gray-900' : 'border-transparent text-gray-500 hover:bg-white'
                }`}
                title={folder.title}
              >
                <FileVideo size={16} />
              </button>
            );
          }

          return (
            <div key={folder.id} className="rounded-xl border border-gray-200 overflow-hidden bg-white">
              <div className={`w-full px-2.5 py-1.5 flex items-center justify-between gap-2 ${hasActiveVideo ? 'bg-gray-100' : 'bg-gray-50'}`}>
                <div className="min-w-0 flex flex-1 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleVideoFolder(folder.id)}
                    className="flex items-center justify-center rounded p-0.5 text-gray-400 transition-colors hover:bg-white hover:text-gray-700"
                    title={isFolderCollapsed ? '展开文件夹' : '收起文件夹'}
                  >
                    {isFolderCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                  </button>
                  <TriStateCheckboxButton
                    state={folderSelectionState}
                    disabled={folderVideoIds.length === 0}
                    onClick={() => toggleSelectAllVideosInFolder(folderVideoIds)}
                    title="全选当前文件夹"
                  />
                  <button
                    type="button"
                    onClick={() => toggleVideoFolder(folder.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="text-sm font-medium text-gray-700 truncate">{folder.title}</span>
                  </button>
                </div>
                <span className="text-[10px] font-medium text-gray-500 shrink-0">{folder.videos.length} 个</span>
              </div>
              {!isFolderCollapsed && (
                <div className="p-2 space-y-2 border-t border-gray-100">
                  {folder.videos.map((video) => {
                    const videoDetectJob = detectJobsByVideoId.get(video.id) ?? null;
                    const isCancellingVideoDetect =
                      videoDetectJob != null && String(videoDetectJob.progress.stage || '') === 'cancel_requested';
                    const isSelected = selectedVideoIds.has(video.id);
                    return (
                      <div
                        key={video.id}
                        data-testid={`video-item-${video.id}`}
                        onClick={() => setActiveVideoId(video.id)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setVideoContextMenu({x: event.clientX, y: event.clientY, videoId: video.id});
                        }}
                        className={`w-full cursor-pointer text-left p-3 rounded-xl border transition-all ${
                          activeVideoId === video.id
                            ? 'bg-white border-gray-200 shadow-sm'
                            : 'border-transparent hover:bg-gray-100/80'
                        } ${isSelected ? 'ring-1 ring-gray-300' : ''}`}
                      >
                        <div className="flex items-start gap-3">
                          <label
                            className="mt-0.5 flex items-center cursor-pointer"
                            title="选择该视频"
                          >
                            <input
                              data-testid={`video-select-${video.id}`}
                              type="checkbox"
                              checked={isSelected}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => {
                                event.stopPropagation();
                                toggleVideoSelection(video.id);
                              }}
                              className="h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                            />
                          </label>
                          <div className={`mt-0.5 ${videoStatusClass(video.status, video.source_kind)}`}>
                            <FileVideo size={18} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <p className={`text-sm truncate ${activeVideoId === video.id ? 'text-gray-900 font-semibold' : 'text-gray-700 font-medium'}`}>
                                {video.file_name}
                              </p>
                              <div className="flex shrink-0 items-center gap-1">
                                {videoDetectJob && (
                                  <button
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onCancelDetect(video.id);
                                    }}
                                    disabled={isCancellingVideoDetect}
                                    className="rounded-lg p-1 text-amber-600 hover:bg-amber-50 disabled:opacity-40 disabled:hover:bg-transparent"
                                    title={isCancellingVideoDetect ? '正在取消检测' : videoDetectJob.status === 'queued' ? '取消排队检测' : '取消当前检测'}
                                  >
                                    <XCircle size={14} />
                                  </button>
                                )}
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onDeleteVideo(video.id);
                                  }}
                                  disabled={video.status === 'detecting'}
                                  className="rounded-lg p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400"
                                  title={video.status === 'detecting' ? '检测中无法删除' : '删除视频任务'}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                            <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
                              <span className="flex items-center gap-1">
                                <Clock size={12} /> {formatDuration(video.duration)}
                              </span>
                              <span>{videoStatusLabel(video)}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-400">
                              {video.category && (
                                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{categoryLabel(video.category)}</span>
                              )}
                              {video.venue && (
                                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{video.venue}</span>
                              )}
                              {video.sport_item_ids.map((id) => (
                                <span key={`${video.id}-${id}`} className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">
                                  {formatSportItemLabel(id, video.sex)}
                                </span>
                              ))}
                              {video.team_country && (
                                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{video.team_country}</span>
                              )}
                            </div>
                            <div className={`mt-1 text-xs ${video.status === 'detecting' ? 'text-orange-500' : video.status === 'error' ? 'text-red-500' : 'text-gray-400'}`}>
                              {renderVideoProgress(video)}
                            </div>
                            {video.error_message && <div className="mt-1 text-xs text-red-500 truncate">{video.error_message}</div>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
