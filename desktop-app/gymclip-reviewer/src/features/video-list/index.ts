/**
 * Feature barrel for the left video sidebar. Pre-A3 this UI lived inline
 * in App.tsx; A3-4 extracted it so playback/trim work in A4 has a smaller
 * surface to navigate.
 */
export {VideoListPanel} from './VideoListPanel';
export type {VideoFolderEntry, VideoListPanelProps} from './VideoListPanel';
export {useVideoListPanel} from './useVideoListPanel';
export type {VideoContextMenu, VideoListPanelLocalState} from './useVideoListPanel';
