import type {Dispatch, SetStateAction} from 'react';
import {useMemo, useState} from 'react';

import {createLocalCard, deleteLocalCard, updateLocalCard} from '../../api';
import type {PlatformRecord, ProjectState} from '../../types';
import {computeLocalCardAutoTotal} from '../../lib/clip-math';
import {emptyLocalCardForm, localCardRecordToForm} from '../../lib/utils';
import type {LocalCardFormState} from '../../lib/utils';

export interface UseLocalCardOptions {
  activeVideoId: string | null;
  videoScopedPlatformRecords: PlatformRecord[];
  platformRecords: PlatformRecord[];
  scoreSearchQuery: string;
  scoreApparatusFilter: string;
  onProjectUpdate: (project: ProjectState) => void;
  setErrorMessage: (value: string | null) => void;
  setSuccessMessage: (value: string | null) => void;
  /** After successful create, optionally sync the apparatus filter. */
  syncScoreApparatusFilter: (sportItemId: number) => void;
}

export interface LocalCardApi {
  localCardDraft: LocalCardFormState | null;
  setLocalCardDraft: Dispatch<SetStateAction<LocalCardFormState | null>>;
  editingLocalCardId: string | null;
  editingLocalCardForm: LocalCardFormState | null;
  setEditingLocalCardForm: Dispatch<SetStateAction<LocalCardFormState | null>>;
  localCardSaving: boolean;
  localPlatformRecords: PlatformRecord[];
  localCardNameSuggestions: string[];
  lastUsedLocalSportItemId: string;
  beginCreateDraft: () => void;
  handleSaveLocalCardDraft: () => Promise<void>;
  handleSaveLocalCardEdit: (recordId: string) => Promise<void>;
  handleDeleteLocalCardClick: (recordId: string) => Promise<void>;
  startEditingLocalCard: (record: PlatformRecord) => void;
  cancelDraft: () => void;
  cancelEdit: () => void;
}

function validateLocalCardForm(form: LocalCardFormState): string | null {
  if (!form.user_name.trim()) return '姓名不能为空';
  if (!form.sport_item_id.trim()) return '请选择项目';
  return null;
}

function buildLocalCardPayload(form: LocalCardFormState) {
  const total = form.total_overridden && form.total_score.trim() !== ''
    ? form.total_score.trim()
    : computeLocalCardAutoTotal(form);
  return {
    user_name: form.user_name.trim(),
    english_name: form.english_name.trim() || undefined,
    country: form.country.trim() || undefined,
    sport_item_id: Number(form.sport_item_id),
    difficulty_score: form.difficulty_score.trim() || '0',
    execution_score: form.execution_score.trim() || '0',
    bonus_score: form.bonus_score.trim() || '0',
    penalty_score: form.penalty_score.trim() || '0',
    total_score: total,
  };
}

export function useLocalCard(options: UseLocalCardOptions): LocalCardApi {
  const {
    activeVideoId,
    videoScopedPlatformRecords,
    platformRecords,
    scoreSearchQuery,
    scoreApparatusFilter,
    onProjectUpdate,
    setErrorMessage,
    setSuccessMessage,
    syncScoreApparatusFilter,
  } = options;

  const [localCardDraft, setLocalCardDraft] = useState<LocalCardFormState | null>(null);
  const [editingLocalCardId, setEditingLocalCardId] = useState<string | null>(null);
  const [editingLocalCardForm, setEditingLocalCardForm] = useState<LocalCardFormState | null>(null);
  const [localCardSaving, setLocalCardSaving] = useState(false);

  const localPlatformRecords = useMemo(() => {
    const query = scoreSearchQuery.trim().toLowerCase();
    return videoScopedPlatformRecords.filter((entry) => {
      if (!entry.is_local) return false;
      const matchesApparatus =
        scoreApparatusFilter === 'all' ||
        String(entry.sport_item_id ?? '') === scoreApparatusFilter;
      if (!matchesApparatus) return false;
      if (!query) return true;
      return (
        entry.user_name.toLowerCase().includes(query) ||
        entry.english_name.toLowerCase().includes(query) ||
        entry.country.toLowerCase().includes(query)
      );
    });
  }, [videoScopedPlatformRecords, scoreSearchQuery, scoreApparatusFilter]);

  const localCardNameSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const sorted = [...platformRecords]
      .filter((r) => r.is_local && r.user_name.trim())
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    const result: string[] = [];
    for (const record of sorted) {
      if (seen.has(record.user_name)) continue;
      seen.add(record.user_name);
      result.push(record.user_name);
    }
    return result;
  }, [platformRecords]);

  const lastUsedLocalSportItemId = useMemo(() => {
    const recent = [...platformRecords]
      .filter((r) => r.is_local && r.sport_item_id != null)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
    return recent ? String(recent.sport_item_id) : '';
  }, [platformRecords]);

  function beginCreateDraft() {
    setEditingLocalCardId(null);
    setEditingLocalCardForm(null);
    setLocalCardDraft((current) =>
      current ?? {...emptyLocalCardForm(), sport_item_id: lastUsedLocalSportItemId},
    );
  }

  async function handleSaveLocalCardDraft() {
    if (!activeVideoId || !localCardDraft || localCardSaving) return;
    const validation = validateLocalCardForm(localCardDraft);
    if (validation) {
      setErrorMessage(validation);
      return;
    }
    setLocalCardSaving(true);
    try {
      const response = await createLocalCard(activeVideoId, buildLocalCardPayload(localCardDraft));
      onProjectUpdate(response.project);
      setLocalCardDraft(null);
      const newSportItemId = response.record.sport_item_id;
      if (newSportItemId != null) {
        syncScoreApparatusFilter(newSportItemId);
      }
      setErrorMessage(null);
      setSuccessMessage('已创建本地补录卡片');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '创建本地补录卡片失败');
    } finally {
      setLocalCardSaving(false);
    }
  }

  async function handleSaveLocalCardEdit(recordId: string) {
    if (!activeVideoId || !editingLocalCardForm || localCardSaving) return;
    const validation = validateLocalCardForm(editingLocalCardForm);
    if (validation) {
      setErrorMessage(validation);
      return;
    }
    setLocalCardSaving(true);
    try {
      const response = await updateLocalCard(activeVideoId, recordId, buildLocalCardPayload(editingLocalCardForm));
      onProjectUpdate(response.project);
      setEditingLocalCardId(null);
      setEditingLocalCardForm(null);
      setErrorMessage(null);
      setSuccessMessage('已更新本地补录卡片');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '更新本地补录卡片失败');
    } finally {
      setLocalCardSaving(false);
    }
  }

  async function handleDeleteLocalCardClick(recordId: string) {
    if (!activeVideoId || localCardSaving) return;
    // No window.confirm here (discovery 3-1): the native modal freezes the
    // window and steals focus mid-review, violating the "never block the video"
    // rule. The caller (LocalCardInlineForm's delete button) performs an inline
    // two-step confirm instead, so by the time we get here the user has already
    // confirmed.
    setLocalCardSaving(true);
    try {
      const response = await deleteLocalCard(activeVideoId, recordId);
      onProjectUpdate(response.project);
      if (editingLocalCardId === recordId) {
        setEditingLocalCardId(null);
        setEditingLocalCardForm(null);
      }
      setErrorMessage(null);
      setSuccessMessage('已删除本地补录卡片');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '删除本地补录卡片失败');
    } finally {
      setLocalCardSaving(false);
    }
  }

  function startEditingLocalCard(record: PlatformRecord) {
    setLocalCardDraft(null);
    setEditingLocalCardId(record.id);
    setEditingLocalCardForm(localCardRecordToForm(record));
  }

  function cancelDraft() {
    setLocalCardDraft(null);
  }

  function cancelEdit() {
    setEditingLocalCardId(null);
    setEditingLocalCardForm(null);
  }

  return {
    localCardDraft,
    setLocalCardDraft,
    editingLocalCardId,
    editingLocalCardForm,
    setEditingLocalCardForm,
    localCardSaving,
    localPlatformRecords,
    localCardNameSuggestions,
    lastUsedLocalSportItemId,
    beginCreateDraft,
    handleSaveLocalCardDraft,
    handleSaveLocalCardEdit,
    handleDeleteLocalCardClick,
    startEditingLocalCard,
    cancelDraft,
    cancelEdit,
  };
}
