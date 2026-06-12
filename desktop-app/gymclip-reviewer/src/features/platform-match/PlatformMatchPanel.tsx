/**
 * PlatformMatchPanel — the right sidebar that lists platform score cards
 * for the active clip. Extracted from App.tsx as part of A3-5.
 *
 * Design:
 *   - Cross-domain state (activeVideo derived from activeVideoId, activeClip
 *     derived from activeClipId) comes in through props because both rely on
 *     project-state memoization that still lives in App.tsx. The panel does
 *     not subscribe to the store directly for them — that would duplicate
 *     the memo wiring and risk drift.
 *   - Panel-local filter state lives in usePlatformMatchPanel() and is also
 *     read by App-level memos (videoScopedPlatformRecords etc.) plus
 *     useLocalCard; both call sites stay in App.tsx and forward the
 *     local-state tuple here via the `local` prop.
 *   - LocalCardPanel continues to render inside this aside (it's the local
 *     supplement to the platform list).
 *   - No D-phase testids touched.
 */
import {Search} from 'lucide-react';

import {ScoreFilterDropdown} from '../../components/ScoreFilterDropdown';
import type {ScoreFilterOption} from '../../components/ScoreFilterDropdown';
import {bindingTheme} from '../../lib/filters';
import {categoryLabel, formatScoreValue, primaryScoreValue, scoreFormulaLabel} from '../../lib/format';
import type {CandidateClip, PlatformRecord, ProjectState} from '../../types';
import {LocalCardPanel} from '../local-card';
import type {LocalCardApi} from '../local-card';

import type {PlatformMatchPanelLocalState} from './usePlatformMatchPanel';

type ProjectVideo = ProjectState['videos'][number];

export interface PlatformMatchGroupVenue {
  venue: string;
  records: PlatformRecord[];
}

export interface PlatformMatchGroup {
  matchName: string;
  venues: PlatformMatchGroupVenue[];
}

export interface PlatformMatchScopeSummary {
  matchText: string;
  venueText: string;
}

export interface PlatformMatchPanelProps {
  local: PlatformMatchPanelLocalState;
  activeClip: CandidateClip | null;
  activeVideo: ProjectVideo | null;
  activeClipLockedByExport: boolean;
  activeScopeSummary: PlatformMatchScopeSummary;
  videoScopedPlatformRecords: PlatformRecord[];
  filteredPlatformRecords: PlatformRecord[];
  groupedPlatformRecords: PlatformMatchGroup[];
  scoreApparatusOptions: ScoreFilterOption[];
  scoreSexOptions: ScoreFilterOption[];
  scoreCountryOptions: ScoreFilterOption[];
  clipOrdinalById: Map<string, number>;
  localCardApi: LocalCardApi;
  localPlatformRecords: PlatformRecord[];
  onBindScoreCard: (recordId: string | null) => void;
}

export function PlatformMatchPanel(props: PlatformMatchPanelProps) {
  const {
    local,
    activeClip,
    activeVideo,
    activeClipLockedByExport,
    activeScopeSummary,
    videoScopedPlatformRecords,
    filteredPlatformRecords,
    groupedPlatformRecords,
    scoreApparatusOptions,
    scoreSexOptions,
    scoreCountryOptions,
    clipOrdinalById,
    localCardApi,
    localPlatformRecords,
    onBindScoreCard,
  } = props;

  const {
    scoreSearchQuery,
    setScoreSearchQuery,
    scoreApparatusFilter,
    setScoreApparatusFilter,
    scoreSexFilter,
    setScoreSexFilter,
    scoreCountryFilter,
    setScoreCountryFilter,
    openScoreFilter,
    setOpenScoreFilter,
  } = local;

  // Map each bindable visible card to its 1-9 hotkey number. Must mirror the
  // global handler exactly: same filteredPlatformRecords order, and cards bound
  // to a *different* clip are skipped (not numbered) so the badge a user sees
  // matches the digit that binds it. Only the first nine bindable cards get a
  // number; the rest are bindable by click only.
  const hotkeyIndexById = new Map<string, number>();
  filteredPlatformRecords
    .filter(
      (record) =>
        record.linked_clip_ids.length === 0 ||
        (activeClip != null && record.linked_clip_ids.includes(activeClip.id)),
    )
    .slice(0, 9)
    .forEach((record, index) => {
      hotkeyIndexById.set(record.id, index + 1);
    });

  return (
    <aside className={`${activeClip ? 'w-[19rem] border-l border-gray-200' : 'w-0'} bg-white flex flex-col shrink-0 overflow-hidden transition-all duration-300`}>
      {activeClip && (
        <>
          <div className="p-4 border-b border-gray-200 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">成绩卡片</h2>
                <div className="mt-1 text-sm font-medium text-gray-900">
                  {activeVideo ? `${activeScopeSummary.matchText} · ${activeScopeSummary.venueText}` : '未选择视频'}
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  {activeVideo ? `${categoryLabel(activeVideo.category)} · ${activeVideo.file_name}` : '平台成绩卡片'}
                </div>
              </div>
              {activeVideo && (
                <button
                  type="button"
                  onClick={localCardApi.beginCreateDraft}
                  disabled={localCardApi.localCardDraft != null}
                  title="新增本地补录卡片"
                  className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                >
                  + 本地补录
                </button>
              )}
            </div>

            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                id="score-search-input"
                type="text"
                placeholder="搜索姓名或国家... ( / )"
                value={scoreSearchQuery}
                onChange={(event) => setScoreSearchQuery(event.target.value)}
                className="w-full bg-gray-100 border-transparent rounded-lg py-2 pl-9 pr-3 text-sm focus:outline-none focus:bg-white focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all"
              />
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <ScoreFilterDropdown
                id="apparatus"
                placeholder="项目"
                allLabel="全部项目"
                value={scoreApparatusFilter}
                options={scoreApparatusOptions}
                openFilter={openScoreFilter}
                onToggle={setOpenScoreFilter}
                onChange={setScoreApparatusFilter}
              />
              <ScoreFilterDropdown
                id="sex"
                placeholder="性别"
                allLabel="全部性别"
                value={scoreSexFilter}
                options={scoreSexOptions}
                openFilter={openScoreFilter}
                onToggle={setOpenScoreFilter}
                onChange={setScoreSexFilter}
              />
              <ScoreFilterDropdown
                id="country"
                placeholder="国家"
                allLabel="全部国家"
                value={scoreCountryFilter}
                options={scoreCountryOptions}
                openFilter={openScoreFilter}
                onToggle={setOpenScoreFilter}
                onChange={setScoreCountryFilter}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-gray-50/40">
            {!activeVideo && (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-500">
                当前没有选中视频。
              </div>
            )}
            {activeVideo && videoScopedPlatformRecords.length === 0 && !localCardApi.localCardDraft && (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-500">
                当前视频上下文没有查到平台成绩卡片。请检查导入时选择的比赛、场次和项目；或点击右上角「+ 本地补录」手动添加。
              </div>
            )}
            {activeVideo && videoScopedPlatformRecords.length > 0 && filteredPlatformRecords.length === 0 && localPlatformRecords.length === 0 && (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-500">
                当前筛选条件下没有命中的成绩卡片。
              </div>
            )}
            <LocalCardPanel
              api={localCardApi}
              activeClip={activeClip}
              activeClipLockedByExport={activeClipLockedByExport}
              clipOrdinalById={clipOrdinalById}
              onBindScoreCard={onBindScoreCard}
            />
            {groupedPlatformRecords.map((matchGroup) => (
              <div key={matchGroup.matchName} className="space-y-2">
                <div className="px-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  {matchGroup.matchName}
                </div>
                {matchGroup.venues.map((venueGroup) => (
                  <div key={`${matchGroup.matchName}-${venueGroup.venue}`} className="space-y-2">
                    <div className="px-1 text-[11px] text-gray-400">{venueGroup.venue}</div>
                    {venueGroup.records.map((entry) => {
                      const isActive = activeClip.linked_platform_record_id === entry.id;
                      const isBound = entry.linked_clip_ids.length > 0;
                      const isBoundElsewhere = isBound && !entry.linked_clip_ids.includes(activeClip.id);
                      const hotkeyNumber = hotkeyIndexById.get(entry.id);
                      const theme = bindingTheme(entry.id);
                      const linkedClipLabels = entry.linked_clip_ids
                        .map((clipId) => clipOrdinalById.get(clipId))
                        .filter((value): value is number => value != null)
                        .map((value) => `#${value}`);
                      const displayVenue = entry.category === 'EF' ? '' : (entry.venue || activeVideo?.venue || '');
                      const bindingLabel = isActive
                        ? `片段${linkedClipLabels[0] ?? `#${clipOrdinalById.get(activeClip.id) ?? '--'}`}`
                        : isBoundElsewhere
                          ? `片段${linkedClipLabels[0]}`
                          : null;

                      return (
                        <button
                          key={entry.id}
                          type="button"
                          disabled={isBoundElsewhere || activeClipLockedByExport}
                          onClick={(event) => {
                            event.currentTarget.blur();
                            if (isBoundElsewhere || activeClipLockedByExport) return;
                            onBindScoreCard(isActive ? null : entry.id);
                          }}
                          className={`relative w-full rounded-2xl border border-gray-200/80 bg-white px-3 py-2.5 text-left transition-all shadow-[0_6px_18px_rgba(15,23,42,0.05)] ${
                            isActive
                              ? 'hover:border-gray-200'
                              : isBoundElsewhere || activeClipLockedByExport
                                ? 'cursor-not-allowed opacity-90'
                                : 'hover:border-gray-200 hover:shadow-[0_10px_24px_rgba(15,23,42,0.08)]'
                          }`}
                        >
                          {(isActive || isBound) && (
                            <span
                              className="absolute left-1 top-2 bottom-2 w-1 rounded-full"
                              style={{backgroundColor: theme.accent}}
                            />
                          )}
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-[15px] font-semibold leading-5 text-gray-900 truncate">
                                {hotkeyNumber != null && !isBoundElsewhere && !activeClipLockedByExport && (
                                  <kbd
                                    className="mr-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-gray-200 bg-gray-100 px-1 align-middle text-[10px] font-semibold leading-none text-gray-400"
                                    title={`按 ${hotkeyNumber} 绑定此卡片`}
                                  >
                                    {hotkeyNumber}
                                  </kbd>
                                )}
                                {entry.english_name || entry.user_name || '未命名'}
                              </p>
                              {entry.user_name && (
                                <div className="mt-0.5 text-[11px] text-gray-500 truncate">{entry.user_name}</div>
                              )}
                              <div className="mt-1 text-[11px] text-gray-500 truncate">
                                {(entry.country || '--')} · {(entry.sport_item_label || '--')}
                              </div>
                              {displayVenue && (
                                <div className="mt-0.5 text-[11px] text-gray-400 truncate">{displayVenue}</div>
                              )}
                              <div className="mt-2 text-[11px] font-semibold text-black whitespace-nowrap overflow-hidden text-ellipsis">
                                {scoreFormulaLabel(entry)}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-xl font-bold text-black">{primaryScoreValue(entry)}</div>
                              {entry.vault_attempt != null && (
                                <div className="text-[11px] text-gray-500">第 {entry.vault_attempt} 跳</div>
                              )}
                              {entry.single_score && (
                                <div className="text-[11px] text-gray-500">单跳 {formatScoreValue(entry.single_score)}</div>
                              )}
                              {bindingLabel && (
                                <div
                                  className="mt-1 text-[11px] font-medium"
                                  style={{color: theme.text}}
                                >
                                  {bindingLabel}
                                </div>
                              )}
                            </div>
                          </div>
                          {!isBound && (
                            <div className="mt-2 text-[11px] text-gray-400">
                              {activeClipLockedByExport ? '导出批次中，只读' : '可绑定'}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
