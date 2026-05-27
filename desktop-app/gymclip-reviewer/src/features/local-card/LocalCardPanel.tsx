import React from 'react';

import {LocalCardInlineForm} from '../../components/LocalCardInlineForm';
import type {CandidateClip} from '../../types';
import {primaryScoreValue, scoreFormulaLabel} from '../../lib/format';
import {bindingTheme} from '../../lib/filters';
import type {LocalCardApi} from './useLocalCard';

export interface LocalCardPanelProps {
  api: LocalCardApi;
  activeClip: CandidateClip | null;
  activeClipLockedByExport: boolean;
  clipOrdinalById: Map<string, number>;
  onBindScoreCard: (recordId: string | null) => void;
}

export const LocalCardPanel = React.memo(function LocalCardPanel(props: LocalCardPanelProps) {
  const {api, activeClip, activeClipLockedByExport, clipOrdinalById, onBindScoreCard} = props;
  const {
    localCardDraft,
    setLocalCardDraft,
    editingLocalCardId,
    editingLocalCardForm,
    setEditingLocalCardForm,
    localCardSaving,
    localPlatformRecords,
    localCardNameSuggestions,
    handleSaveLocalCardDraft,
    handleSaveLocalCardEdit,
    handleDeleteLocalCardClick,
    startEditingLocalCard,
    cancelDraft,
    cancelEdit,
  } = api;

  if (!activeClip) return null;

  return (
    <>
      {localCardDraft && (
        <LocalCardInlineForm
          form={localCardDraft}
          setForm={(updater) => setLocalCardDraft((prev) => (prev ? updater(prev) : prev))}
          onSave={() => void handleSaveLocalCardDraft()}
          onCancel={cancelDraft}
          saving={localCardSaving}
          title="新建本地补录卡片"
          nameSuggestions={localCardNameSuggestions}
        />
      )}
      {localPlatformRecords.length > 0 && (
        <div className="space-y-2">
          <div className="px-1 text-[11px] font-semibold uppercase tracking-wider text-amber-700">
            本地补录
          </div>
          {localPlatformRecords.map((entry) => {
            const isActive = activeClip.linked_platform_record_id === entry.id;
            const isBound = entry.linked_clip_ids.length > 0;
            const isBoundElsewhere = isBound && !entry.linked_clip_ids.includes(activeClip.id);
            const theme = bindingTheme(entry.id);
            const linkedClipLabels = entry.linked_clip_ids
              .map((clipId) => clipOrdinalById.get(clipId))
              .filter((value): value is number => value != null)
              .map((value) => `#${value}`);
            const bindingLabel = isActive
              ? `片段${linkedClipLabels[0] ?? `#${clipOrdinalById.get(activeClip.id) ?? '--'}`}`
              : isBoundElsewhere
                ? `片段${linkedClipLabels[0]}`
                : null;

            if (editingLocalCardId === entry.id && editingLocalCardForm) {
              return (
                <React.Fragment key={entry.id}>
                  <LocalCardInlineForm
                    form={editingLocalCardForm}
                    setForm={(updater) => setEditingLocalCardForm((prev) => (prev ? updater(prev) : prev))}
                    onSave={() => void handleSaveLocalCardEdit(entry.id)}
                    onCancel={cancelEdit}
                    saving={localCardSaving}
                    title="编辑本地补录卡片"
                    onDelete={() => void handleDeleteLocalCardClick(entry.id)}
                    nameSuggestions={localCardNameSuggestions}
                  />
                </React.Fragment>
              );
            }

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
                className={`relative w-full rounded-2xl border border-amber-200 bg-amber-50/40 px-3 py-2.5 text-left transition-all shadow-[0_6px_18px_rgba(15,23,42,0.05)] ${
                  isActive
                    ? 'hover:border-amber-300'
                    : isBoundElsewhere || activeClipLockedByExport
                      ? 'cursor-not-allowed opacity-90'
                      : 'hover:border-amber-300 hover:shadow-[0_10px_24px_rgba(15,23,42,0.08)]'
                }`}
              >
                {(isActive || isBound) && (
                  <span
                    className="absolute left-1 top-2 bottom-2 w-1 rounded-full"
                    style={{backgroundColor: theme.accent}}
                  />
                )}
                <div className="absolute right-2 top-2 flex items-center gap-1">
                  <span className="rounded-full bg-amber-200/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                    本地补录
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      startEditingLocalCard(entry);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.stopPropagation();
                        event.preventDefault();
                        startEditingLocalCard(entry);
                      }
                    }}
                    className="cursor-pointer rounded-md border border-amber-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-100"
                  >
                    编辑
                  </span>
                </div>
                <div className="flex items-start justify-between gap-3 pr-20">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold leading-5 text-gray-900 truncate">
                      {entry.english_name || entry.user_name || '未命名'}
                    </p>
                    {entry.user_name && (
                      <div className="mt-0.5 text-[11px] text-gray-500 truncate">{entry.user_name}</div>
                    )}
                    <div className="mt-1 text-[11px] text-gray-500 truncate">
                      {(entry.country || '--')} · {(entry.sport_item_label || '--')}
                    </div>
                    <div className="mt-2 text-[11px] font-semibold text-black whitespace-nowrap overflow-hidden text-ellipsis">
                      {scoreFormulaLabel(entry)}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-xl font-bold text-black">{primaryScoreValue(entry)}</div>
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
      )}
    </>
  );
});
