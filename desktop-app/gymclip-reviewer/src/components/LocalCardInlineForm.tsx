import React from 'react';

import {computeLocalCardAutoTotal} from '../lib/clip-math';
import {stopFormShortcutPropagation} from '../lib/utils';
import type {LocalCardFormState} from '../lib/utils';

const SPORT_ITEM_LABELS: Record<number, string> = {
  0: '自由体操',
  1: '鞍马',
  2: '吊环',
  3: '跳马',
  4: '双杠',
  5: '单杠',
  6: '高低杠',
  7: '平衡木',
};

const LOCAL_CARD_SPORT_OPTIONS: Array<{value: string; label: string}> = Object.entries(
  SPORT_ITEM_LABELS,
).map(([id, label]) => ({value: id, label: `${label} (${id})`}));

const LOCAL_CARD_NAME_DATALIST_ID = 'local-card-name-suggestions';

export type LocalCardInlineFormProps = {
  form: LocalCardFormState;
  setForm: (updater: (prev: LocalCardFormState) => LocalCardFormState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  title: string;
  onDelete?: () => void;
  nameSuggestions?: string[];
};

function LocalCardInlineFormComponent({
  form,
  setForm,
  onSave,
  onCancel,
  saving,
  title,
  onDelete,
  nameSuggestions,
}: LocalCardInlineFormProps) {
  const autoTotal = computeLocalCardAutoTotal(form);
  const totalDisplay =
    form.total_overridden && form.total_score.trim() !== '' ? form.total_score : autoTotal;
  return (
    <div
      className="rounded-2xl border border-amber-300 bg-amber-50/70 p-3 shadow-sm space-y-2.5"
      onKeyDown={stopFormShortcutPropagation}
    >
      {nameSuggestions && nameSuggestions.length > 0 && (
        <datalist id={LOCAL_CARD_NAME_DATALIST_ID}>
          {nameSuggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-200/70 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
          本地补录
        </span>
        <span className="text-[11px] text-amber-700">{title}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px] text-amber-900">
          姓名 *
          <input
            type="text"
            value={form.user_name}
            onChange={(event) => setForm((prev) => ({...prev, user_name: event.target.value}))}
            list={nameSuggestions && nameSuggestions.length > 0 ? LOCAL_CARD_NAME_DATALIST_ID : undefined}
            autoComplete="off"
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          英文名
          <input
            type="text"
            value={form.english_name}
            onChange={(event) => setForm((prev) => ({...prev, english_name: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          国家
          <input
            type="text"
            value={form.country}
            onChange={(event) => setForm((prev) => ({...prev, country: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          项目 *
          <select
            value={form.sport_item_id}
            onChange={(event) => setForm((prev) => ({...prev, sport_item_id: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          >
            <option value="">-- 选择 --</option>
            {LOCAL_CARD_SPORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <label className="block text-[11px] text-amber-900">
          难度 D
          <input
            type="number"
            step="0.1"
            value={form.difficulty_score}
            onChange={(event) => setForm((prev) => ({...prev, difficulty_score: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          执行 E
          <input
            type="number"
            step="0.1"
            value={form.execution_score}
            onChange={(event) => setForm((prev) => ({...prev, execution_score: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          加点
          <input
            type="number"
            step="0.1"
            value={form.bonus_score}
            onChange={(event) => setForm((prev) => ({...prev, bonus_score: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
        <label className="block text-[11px] text-amber-900">
          扣分
          <input
            type="number"
            step="0.1"
            value={form.penalty_score}
            onChange={(event) => setForm((prev) => ({...prev, penalty_score: event.target.value}))}
            className="mt-0.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
        </label>
      </div>
      <label className="block text-[11px] text-amber-900">
        总分 {!form.total_overridden && <span className="text-[10px] text-amber-700">(自动 = D + E + 加点 − 扣分)</span>}
        <div className="mt-0.5 flex items-center gap-2">
          <input
            type="number"
            step="0.001"
            value={totalDisplay}
            onChange={(event) => setForm((prev) => ({...prev, total_score: event.target.value, total_overridden: true}))}
            className="w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-sm font-semibold text-gray-900 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
          />
          {form.total_overridden && (
            <button
              type="button"
              onClick={() => setForm((prev) => ({...prev, total_score: '', total_overridden: false}))}
              className="text-[11px] text-amber-700 underline hover:text-amber-900"
            >
              恢复自动
            </button>
          )}
        </div>
      </label>
      <div className="flex items-center justify-end gap-2 pt-1">
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            className="mr-auto inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-[12px] text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            删除
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-gray-200 bg-white px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded-md border border-amber-600 bg-amber-600 px-3 py-1 text-[12px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
}

export const LocalCardInlineForm = React.memo(LocalCardInlineFormComponent);
