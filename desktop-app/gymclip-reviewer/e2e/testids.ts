// e2e/testids.ts — single source of truth for data-testid values.
//
// All Playwright specs MUST import from this file and reference values via
// the exported TESTIDS object (or its helper functions for dynamic ids).
// React components in src/ MUST use string values matching exactly.
//
// Keep this file in sync with src/* `data-testid="..."` props.

export const TESTIDS = {
  // Top header — import / export controls
  importTrigger: 'import-trigger',
  importTriggerDirectClip: 'import-trigger-direct-clip',
  importFileInput: 'import-file-input',
  importFileInputDirectClip: 'import-file-input-direct-clip',
  exportTrigger: 'export-trigger',
  exportConfirm: 'export-confirm',
  exportOutputDir: 'export-output-dir',
  exportClose: 'export-close',

  // Video list (left sidebar)
  videoItem: (id: string) => `video-item-${id}`,
  videoSelect: (id: string) => `video-select-${id}`,

  // Candidate clip list (middle)
  clipItem: (id: string) => `clip-item-${id}`,
  clipStatusBadge: 'clip-status-badge',

  // Trim editor / player controls
  trimHandleStart: 'trim-handle-start',
  trimHandleEnd: 'trim-handle-end',
  playerPlayToggle: 'player-play-toggle',
} as const;

export type TestIdKey = keyof typeof TESTIDS;
