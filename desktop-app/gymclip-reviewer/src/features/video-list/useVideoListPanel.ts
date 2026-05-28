/**
 * useVideoListPanel — UI-only state for the left video sidebar.
 *
 * Pre-A3 these `useState` hooks lived in App.tsx alongside dozens of
 * other unrelated UI flags. They are kept inside the panel because they
 * are read by *exactly one* place (the sidebar) — promoting them to the
 * store would just be cargo-culting.
 *
 * Cross-domain state (selectedVideoIds, activeVideoId, project) lives in
 * the zustand store; the VideoListPanel component subscribes to those
 * directly.
 */
import type {Dispatch, SetStateAction} from 'react';
import {useState} from 'react';

export interface VideoContextMenu {
  x: number;
  y: number;
  videoId: string;
}

export interface VideoListPanelLocalState {
  collapsedVideoFolderIds: string[];
  setCollapsedVideoFolderIds: Dispatch<SetStateAction<string[]>>;
  isVideoSidebarCollapsed: boolean;
  setIsVideoSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  videoContextMenu: VideoContextMenu | null;
  setVideoContextMenu: Dispatch<SetStateAction<VideoContextMenu | null>>;
}

export function useVideoListPanel(): VideoListPanelLocalState {
  const [collapsedVideoFolderIds, setCollapsedVideoFolderIds] = useState<string[]>([]);
  const [isVideoSidebarCollapsed, setIsVideoSidebarCollapsed] = useState(false);
  const [videoContextMenu, setVideoContextMenu] = useState<VideoContextMenu | null>(null);

  return {
    collapsedVideoFolderIds,
    setCollapsedVideoFolderIds,
    isVideoSidebarCollapsed,
    setIsVideoSidebarCollapsed,
    videoContextMenu,
    setVideoContextMenu,
  };
}
