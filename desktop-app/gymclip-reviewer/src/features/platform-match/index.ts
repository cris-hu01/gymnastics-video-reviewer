/**
 * Feature barrel for the right platform-records sidebar. Pre-A3 this UI
 * lived inline in App.tsx; A3-5 extracted it.
 */
export {PlatformMatchPanel} from './PlatformMatchPanel';
export type {
  PlatformMatchGroup,
  PlatformMatchGroupVenue,
  PlatformMatchPanelProps,
  PlatformMatchScopeSummary,
} from './PlatformMatchPanel';
export {usePlatformMatchPanel} from './usePlatformMatchPanel';
export type {PlatformMatchPanelLocalState} from './usePlatformMatchPanel';
