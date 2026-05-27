import type {RefObject} from 'react';
import {useEffect, useMemo, useRef, useState} from 'react';

import {
  fetchPlatformFrequencies,
  fetchPlatformMatches,
  fetchPlatformRecords,
  importDirectClipFiles,
  importProjectFiles,
  previewScopePlatformRecords,
} from '../../api';
import type {
  PlatformCategory,
  PlatformFrequency,
  PlatformMatch,
  PlatformScopeQuery,
  ProjectState,
} from '../../types';
import {
  createPendingDirectClipFile,
  createPendingImportVideo,
  deriveSelectionFromVenue,
  isDesktopImportSource,
  normalizeCategory,
  sportKey,
  toggleSportKey,
} from '../../lib/utils';
import type {
  DesktopImportSource,
  PendingDirectClipFile,
  PendingImportVideo,
} from '../../lib/utils';
import {parseSportKey} from '../../lib/format';

export type ImportMode = 'full_video' | 'direct_clip';

export const IMPORT_MAG_OPTIONS = [
  {id: 0, label: 'FX'},
  {id: 1, label: 'PH'},
  {id: 2, label: 'SR'},
  {id: 3, label: 'VT'},
  {id: 4, label: 'PB'},
  {id: 5, label: 'HB'},
] as const;

export const IMPORT_WAG_OPTIONS = [
  {id: 3, label: 'VT'},
  {id: 6, label: 'UB'},
  {id: 7, label: 'BB'},
  {id: 0, label: 'FX'},
] as const;

export interface UseVideoImportOptions {
  desktopBridge: typeof window.gymclipDesktop;
  onProjectUpdate: (project: ProjectState) => void;
  onActiveVideoId: (videoId: string) => void;
  setErrorMessage: (value: string | null) => void;
  setSuccessMessage: (value: string | null) => void;
}

export interface VideoImportApi {
  // state surface
  showImportModal: boolean;
  importMode: ImportMode;
  isImporting: boolean;
  pendingImportVideos: PendingImportVideo[];
  pendingDirectClipFiles: PendingDirectClipFile[];
  directClipSelectedMatchIds: string[];
  directClipSelectedFrequenciesByMatchId: Record<string, PlatformFrequency[]>;
  directClipManualSportKeys: string[];
  directClipPreview: {count: number | null; loading: boolean; error: string | null; cacheKey: string | null};
  platformMatches: PlatformMatch[];
  isLoadingPlatformMatches: boolean;
  platformFrequenciesByMatchId: Record<string, PlatformFrequency[]>;
  loadingFrequencyMatchIds: Record<string, boolean>;
  previewByImportId: Record<string, {count: number | null; loading: boolean; error: string | null}>;
  fileInputRef: RefObject<HTMLInputElement>;
  directClipFileInputRef: RefObject<HTMLInputElement>;
  // helpers exposed
  directClipScopeQueries: PlatformScopeQuery[];
  directClipValidationError: string | null;
  directClipRequiresManualApparatus: boolean;
  directClipDerivedSportKeys: string[];
  directClipEffectiveSportKeys: string[];
  directClipManualSportKeySet: Set<string>;
  directClipHasAllMag: boolean;
  directClipHasAllWag: boolean;
  // handlers
  openImportSourcePicker: (mode: ImportMode) => Promise<void>;
  handleImportFiles: (
    fileList: FileList | File[] | DesktopImportSource[],
    mode?: ImportMode,
  ) => Promise<void>;
  closeImportModal: () => void;
  handleSubmitImport: () => Promise<void>;
  getMatchById: (matchId: string | null) => PlatformMatch | null;
  getFrequenciesForMatch: (matchId: string | null) => PlatformFrequency[];
  getSelectedFrequenciesForItem: (item: PendingImportVideo) => PlatformFrequency[];
  getDerivedCategoryForItem: (item: PendingImportVideo) => PlatformCategory | '';
  getEffectiveSportKeysForItem: (item: PendingImportVideo) => string[];
  getItemValidationError: (item: PendingImportVideo) => string | null;
  setPendingVideoMatch: (clientFileId: string, matchId: string | null) => void;
  togglePendingVideoFrequency: (clientFileId: string, frequency: PlatformFrequency) => void;
  togglePendingVideoApparatus: (clientFileId: string, sex: number, sportItemId: number) => void;
  setPendingVideoApparatusGroup: (clientFileId: string, sex: number, ids: number[]) => void;
  toggleDirectClipMatch: (matchId: string) => void;
  toggleDirectClipFrequency: (matchId: string, frequency: PlatformFrequency) => void;
  toggleDirectClipApparatus: (sex: number, sportItemId: number) => void;
  setDirectClipApparatusGroup: (sex: number, ids: number[]) => void;
}

export function useVideoImport(options: UseVideoImportOptions): VideoImportApi {
  const {desktopBridge, onProjectUpdate, onActiveVideoId, setErrorMessage, setSuccessMessage} = options;

  const [showImportModal, setShowImportModal] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>('full_video');
  const [isImporting, setIsImporting] = useState(false);
  const [pendingImportVideos, setPendingImportVideos] = useState<PendingImportVideo[]>([]);
  const [pendingDirectClipFiles, setPendingDirectClipFiles] = useState<PendingDirectClipFile[]>([]);
  const [directClipSelectedMatchIds, setDirectClipSelectedMatchIds] = useState<string[]>([]);
  const [directClipSelectedFrequenciesByMatchId, setDirectClipSelectedFrequenciesByMatchId] = useState<
    Record<string, PlatformFrequency[]>
  >({});
  const [directClipManualSportKeys, setDirectClipManualSportKeys] = useState<string[]>([]);
  const [directClipPreview, setDirectClipPreview] = useState<{
    count: number | null;
    loading: boolean;
    error: string | null;
    cacheKey: string | null;
  }>({count: null, loading: false, error: null, cacheKey: null});
  const [platformMatches, setPlatformMatches] = useState<PlatformMatch[]>([]);
  const [isLoadingPlatformMatches, setIsLoadingPlatformMatches] = useState(false);
  const [platformFrequenciesByMatchId, setPlatformFrequenciesByMatchId] = useState<
    Record<string, PlatformFrequency[]>
  >({});
  const [loadingFrequencyMatchIds, setLoadingFrequencyMatchIds] = useState<Record<string, boolean>>({});
  const [previewByImportId, setPreviewByImportId] = useState<
    Record<string, {count: number | null; loading: boolean; error: string | null}>
  >({});

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const directClipFileInputRef = useRef<HTMLInputElement | null>(null);
  const platformFrequenciesByMatchIdRef = useRef<Record<string, PlatformFrequency[]>>({});
  const loadingFrequencyMatchIdsRef = useRef<Record<string, boolean>>({});

  // Derived helpers ---------------------------------------------------------
  function getMatchById(matchId: string | null): PlatformMatch | null {
    if (!matchId) return null;
    return platformMatches.find((item) => item.id === matchId) ?? null;
  }

  function getFrequenciesForMatch(matchId: string | null): PlatformFrequency[] {
    if (!matchId) return [];
    return platformFrequenciesByMatchId[matchId] ?? [];
  }

  function getSelectedFrequenciesForItem(item: PendingImportVideo): PlatformFrequency[] {
    return item.selectedFrequencies;
  }

  function getDerivedCategoryForItem(item: PendingImportVideo): PlatformCategory | '' {
    const categories = Array.from(
      new Set(
        getSelectedFrequenciesForItem(item)
          .map((frequency) => normalizeCategory(frequency.category))
          .filter((value): value is PlatformCategory => value !== ''),
      ),
    );
    if (categories.length !== 1) return '';
    return categories[0];
  }

  function getDerivedSportKeysForItem(item: PendingImportVideo): string[] {
    const category = getDerivedCategoryForItem(item);
    if (!(category === 'EF' || category === 'QF')) return [];
    const next = new Set<string>();
    getSelectedFrequenciesForItem(item).forEach((frequency) => {
      const derived = deriveSelectionFromVenue(frequency.venue);
      if (derived.sex != null && derived.sportItemId != null) {
        next.add(sportKey(derived.sex, derived.sportItemId));
      }
    });
    return Array.from(next);
  }

  function getEffectiveSportKeysForItem(item: PendingImportVideo): string[] {
    const category = getDerivedCategoryForItem(item);
    return category === 'EF' || category === 'QF'
      ? getDerivedSportKeysForItem(item)
      : item.manualSportKeys;
  }

  function getEffectiveSportItemIdsForItem(item: PendingImportVideo): number[] {
    return Array.from(
      new Set(
        getEffectiveSportKeysForItem(item)
          .map((key) => parseSportKey(key))
          .filter((value): value is {sex: number; sportItemId: number} => value != null)
          .map((value) => value.sportItemId),
      ),
    ).sort((a, b) => a - b);
  }

  function getItemValidationError(item: PendingImportVideo): string | null {
    const match = getMatchById(item.matchId);
    if (!match) return '请选择赛事';
    const selectedFrequencies = getSelectedFrequenciesForItem(item);
    if (selectedFrequencies.length === 0) return '请至少选择一个场次';
    const categoryValues = Array.from(
      new Set(
        selectedFrequencies
          .map((frequency) => normalizeCategory(frequency.category))
          .filter((value): value is PlatformCategory => value !== ''),
      ),
    );
    if (categoryValues.length !== 1) return '同一视频的场次必须属于同一比赛类型';
    if (getEffectiveSportKeysForItem(item).length === 0) {
      return categoryValues[0] === 'EF' || categoryValues[0] === 'QF'
        ? '当前场次无法自动识别项目，请检查场次名称'
        : '请至少选择一个项目';
    }
    return null;
  }

  // Direct-clip derived data ------------------------------------------------
  const directClipSelectedCategories = useMemo(
    () =>
      Array.from(
        new Set(
          directClipSelectedMatchIds.flatMap((matchId) =>
            (directClipSelectedFrequenciesByMatchId[matchId] ?? [])
              .map((frequency) => normalizeCategory(frequency.category))
              .filter((value): value is PlatformCategory => value !== ''),
          ),
        ),
      ),
    [directClipSelectedFrequenciesByMatchId, directClipSelectedMatchIds],
  );
  const directClipRequiresManualApparatus = directClipSelectedCategories.some(
    (category) => category === 'AA' || category === 'TF',
  );
  const directClipDerivedSportKeys = useMemo(
    () =>
      Array.from(
        new Set(
          directClipSelectedMatchIds.flatMap((matchId) =>
            (directClipSelectedFrequenciesByMatchId[matchId] ?? [])
              .filter((frequency) => {
                const category = normalizeCategory(frequency.category);
                return category === 'EF' || category === 'QF';
              })
              .map((frequency) => deriveSelectionFromVenue(frequency.venue))
              .filter((value) => value.sex != null && value.sportItemId != null)
              .map((value) => sportKey(value.sex as number, value.sportItemId as number)),
          ),
        ),
      ),
    [directClipSelectedFrequenciesByMatchId, directClipSelectedMatchIds],
  );
  const directClipEffectiveSportKeys = useMemo(
    () =>
      directClipRequiresManualApparatus
        ? [...directClipManualSportKeys]
        : [...directClipDerivedSportKeys],
    [directClipDerivedSportKeys, directClipManualSportKeys, directClipRequiresManualApparatus],
  );
  const directClipManualSportKeySet = useMemo(
    () => new Set(directClipEffectiveSportKeys),
    [directClipEffectiveSportKeys],
  );
  const directClipHasAllMag = IMPORT_MAG_OPTIONS.every((option) =>
    directClipManualSportKeySet.has(sportKey(1, option.id)),
  );
  const directClipHasAllWag = IMPORT_WAG_OPTIONS.every((option) =>
    directClipManualSportKeySet.has(sportKey(2, option.id)),
  );
  const directClipScopeQueries = useMemo<PlatformScopeQuery[]>(() => {
    const queries: PlatformScopeQuery[] = [];
    directClipSelectedMatchIds.forEach((matchId) => {
      const match = getMatchById(matchId);
      if (!match) return;
      const selectedFrequencies = directClipSelectedFrequenciesByMatchId[matchId] ?? [];
      const groupedByCategory = new Map<PlatformCategory, PlatformFrequency[]>();
      selectedFrequencies.forEach((frequency) => {
        const category = normalizeCategory(frequency.category);
        if (!category) return;
        const existing = groupedByCategory.get(category) ?? [];
        existing.push(frequency);
        groupedByCategory.set(category, existing);
      });

      groupedByCategory.forEach((categoryFrequencies, category) => {
        const sportSelectionKeys =
          category === 'EF' || category === 'QF'
            ? Array.from(
                new Set(
                  categoryFrequencies
                    .map((frequency) => deriveSelectionFromVenue(frequency.venue))
                    .filter((value) => value.sex != null && value.sportItemId != null)
                    .map((value) => sportKey(value.sex as number, value.sportItemId as number)),
                ),
              )
            : [...directClipEffectiveSportKeys];
        const sportItemIds = Array.from(
          new Set(
            sportSelectionKeys
              .map((key) => parseSportKey(key))
              .filter((value): value is {sex: number; sportItemId: number} => value != null)
              .map((value) => value.sportItemId),
          ),
        ).sort((a, b) => a - b);
        if (categoryFrequencies.length === 0 || sportItemIds.length === 0) return;
        const sexes = Array.from(
          new Set(
            sportSelectionKeys
              .map((key) => parseSportKey(key))
              .filter((value): value is {sex: number; sportItemId: number} => value != null)
              .map((value) => value.sex),
          ),
        );
        queries.push({
          match_id: matchId,
          match_name: match.match_name,
          frequency_info_id: categoryFrequencies[0]?.id ?? null,
          frequency_info_ids: categoryFrequencies.map((frequency) => frequency.id),
          venue: categoryFrequencies[0]?.venue ?? '',
          venues: categoryFrequencies.map((frequency) => frequency.venue),
          category,
          sex: sexes.length === 1 ? sexes[0] : null,
          sport_selection_keys: sportSelectionKeys,
          sport_item_ids: sportItemIds,
          team_country: null,
        });
      });
    });
    return queries;
  }, [directClipEffectiveSportKeys, directClipSelectedFrequenciesByMatchId, directClipSelectedMatchIds, platformMatches]);
  const directClipValidationError = useMemo(() => {
    if (pendingDirectClipFiles.length === 0) return '请先选择已有片段文件';
    if (directClipSelectedMatchIds.length === 0) return '请至少选择一个比赛';
    for (const matchId of directClipSelectedMatchIds) {
      const match = getMatchById(matchId);
      if (!match) return '存在无效的比赛选择';
      const selectedFrequencies = directClipSelectedFrequenciesByMatchId[matchId] ?? [];
      if (selectedFrequencies.length === 0) {
        return `请至少为比赛《${match.match_name}》选择一个场次`;
      }
      if (selectedFrequencies.some((frequency) => normalizeCategory(frequency.category) === '')) {
        return `比赛《${match.match_name}》存在无法识别比赛类型的场次`;
      }
    }
    if (directClipRequiresManualApparatus && directClipEffectiveSportKeys.length === 0) {
      return '当前包含全能或团体场次，请至少选择一个项目';
    }
    if (directClipScopeQueries.length === 0) {
      return '当前选择无法生成平台卡片查询条件';
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    directClipEffectiveSportKeys.length,
    directClipRequiresManualApparatus,
    directClipScopeQueries.length,
    directClipSelectedFrequenciesByMatchId,
    directClipSelectedMatchIds,
    pendingDirectClipFiles.length,
    platformMatches,
  ]);

  // Effects -----------------------------------------------------------------
  // Load platform matches when the modal opens
  useEffect(() => {
    if (!showImportModal) {
      setIsLoadingPlatformMatches(false);
      return;
    }
    if (platformMatches.length > 0) return;
    let cancelled = false;
    setIsLoadingPlatformMatches(true);
    void fetchPlatformMatches()
      .then((response) => {
        if (cancelled) return;
        setPlatformMatches(response.matches);
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : '无法读取赛事列表');
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoadingPlatformMatches(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showImportModal, platformMatches.length, setErrorMessage]);

  // Keep refs in sync with state for use by the frequency loader effect
  useEffect(() => {
    platformFrequenciesByMatchIdRef.current = platformFrequenciesByMatchId;
  }, [platformFrequenciesByMatchId]);

  useEffect(() => {
    loadingFrequencyMatchIdsRef.current = loadingFrequencyMatchIds;
  }, [loadingFrequencyMatchIds]);

  // Fetch frequencies for currently-selected match ids
  useEffect(() => {
    if (!showImportModal) {
      loadingFrequencyMatchIdsRef.current = {};
      setLoadingFrequencyMatchIds({});
      return;
    }
    const seenMatchIds = new Set<string>();
    const targetMatchIds =
      importMode === 'direct_clip'
        ? directClipSelectedMatchIds.reduce<string[]>((result, matchId) => {
            if (!matchId || seenMatchIds.has(matchId)) return result;
            seenMatchIds.add(matchId);
            if (
              !platformFrequenciesByMatchIdRef.current[matchId] &&
              !loadingFrequencyMatchIdsRef.current[matchId]
            ) {
              result.push(matchId);
            }
            return result;
          }, [])
        : pendingImportVideos.reduce<string[]>((result, item) => {
            if (!item.matchId || seenMatchIds.has(item.matchId)) return result;
            seenMatchIds.add(item.matchId);
            if (
              !platformFrequenciesByMatchIdRef.current[item.matchId] &&
              !loadingFrequencyMatchIdsRef.current[item.matchId]
            ) {
              result.push(item.matchId);
            }
            return result;
          }, []);
    if (targetMatchIds.length === 0) return;

    const nextLoadingState = {...loadingFrequencyMatchIdsRef.current};
    targetMatchIds.forEach((matchId) => {
      nextLoadingState[matchId] = true;
    });
    loadingFrequencyMatchIdsRef.current = nextLoadingState;
    setLoadingFrequencyMatchIds(nextLoadingState);

    void Promise.all(
      targetMatchIds.map(async (matchId) => {
        const match = platformMatches.find((item) => item.id === matchId) ?? null;
        if (!match) return [matchId, []] as const;
        const response = await fetchPlatformFrequencies({
          matchId,
          matchName: match.match_name,
        });
        return [matchId, response.frequencies] as const;
      }),
    )
      .then((entries) => {
        const nextFrequencyMap = {...platformFrequenciesByMatchIdRef.current};
        for (const [matchId, frequencies] of entries) {
          nextFrequencyMap[matchId] = frequencies;
        }
        platformFrequenciesByMatchIdRef.current = nextFrequencyMap;
        setPlatformFrequenciesByMatchId(nextFrequencyMap);
      })
      .catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : '无法读取场次列表');
      })
      .finally(() => {
        const settledLoadingState = {...loadingFrequencyMatchIdsRef.current};
        targetMatchIds.forEach((matchId) => {
          delete settledLoadingState[matchId];
        });
        loadingFrequencyMatchIdsRef.current = settledLoadingState;
        setLoadingFrequencyMatchIds(settledLoadingState);
      });
  }, [directClipSelectedMatchIds, importMode, pendingImportVideos, platformMatches, showImportModal, setErrorMessage]);

  // Preview platform record counts as user edits the form
  useEffect(() => {
    if (!showImportModal) {
      setPreviewByImportId({});
      setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
      return;
    }

    if (importMode === 'direct_clip') {
      let cancelled = false;
      if (directClipValidationError) {
        setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
        return () => {
          cancelled = true;
        };
      }

      setDirectClipPreview((current) => ({
        count: current.count,
        loading: true,
        error: null,
        cacheKey: current.cacheKey,
      }));
      const timer = window.setTimeout(() => {
        void previewScopePlatformRecords(directClipScopeQueries)
          .then((response) => {
            if (cancelled) return;
            setDirectClipPreview({
              count: response.count,
              loading: false,
              error: null,
              cacheKey: response.cache_key ?? null,
            });
          })
          .catch((error) => {
            if (cancelled) return;
            setDirectClipPreview({
              count: null,
              loading: false,
              error: error instanceof Error ? error.message : '预览失败',
              cacheKey: null,
            });
          });
      }, 500);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    let cancelled = false;

    async function loadPreviews() {
      const nextState: Record<string, {count: number | null; loading: boolean; error: string | null}> = {};
      pendingImportVideos.forEach((item) => {
        nextState[item.clientFileId] = {count: null, loading: false, error: null};
      });
      setPreviewByImportId(nextState);

      for (const item of pendingImportVideos) {
        const validationError = getItemValidationError(item);
        if (validationError) continue;

        const match = getMatchById(item.matchId);
        const selectedFrequencies = getSelectedFrequenciesForItem(item);
        const category = getDerivedCategoryForItem(item);
        const sportItemIds = getEffectiveSportItemIdsForItem(item);
        if (!match || selectedFrequencies.length === 0 || !category || sportItemIds.length === 0) {
          continue;
        }

        setPreviewByImportId((current) => ({
          ...current,
          [item.clientFileId]: {count: current[item.clientFileId]?.count ?? null, loading: true, error: null},
        }));
        try {
          const response = await fetchPlatformRecords({
            matchId: item.matchId,
            matchName: match.match_name,
            frequencyInfoIds: selectedFrequencies.map((frequency) => frequency.id),
            venues: selectedFrequencies.map((frequency) => frequency.venue),
            category,
            sportSelectionKeys: getEffectiveSportKeysForItem(item),
            sportItemIds,
          });
          if (cancelled) return;
          setPreviewByImportId((current) => ({
            ...current,
            [item.clientFileId]: {count: response.count, loading: false, error: null},
          }));
        } catch (error) {
          if (cancelled) return;
          setPreviewByImportId((current) => ({
            ...current,
            [item.clientFileId]: {
              count: null,
              loading: false,
              error: error instanceof Error ? error.message : '预览失败',
            },
          }));
        }
      }
    }

    void loadPreviews();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    directClipScopeQueries,
    directClipValidationError,
    importMode,
    pendingImportVideos,
    platformFrequenciesByMatchId,
    platformMatches,
    showImportModal,
  ]);

  // Handlers ---------------------------------------------------------------
  async function handleImportFiles(
    fileList: FileList | File[] | DesktopImportSource[],
    mode: ImportMode = 'full_video',
  ) {
    const rawEntries: Array<File | DesktopImportSource> = fileList instanceof FileList
      ? Array.from(fileList)
      : [...fileList];
    const entries = rawEntries.filter((item) =>
      isDesktopImportSource(item)
        ? !item.name.startsWith('.') && /\.(mp4|mov|mkv|avi|flv|wmv)$/i.test(item.name)
        : !item.name.startsWith('.') && (item.type.startsWith('video/') || /\.(mp4|mov|mkv|avi|flv|wmv)$/i.test(item.name)),
    );
    if (!entries.length) {
      setErrorMessage('未检测到支持的视频文件');
      return;
    }
    setImportMode(mode);
    if (mode === 'direct_clip') {
      setPendingDirectClipFiles(entries.map((file) => createPendingDirectClipFile(file)));
      setDirectClipSelectedMatchIds([]);
      setDirectClipSelectedFrequenciesByMatchId({});
      setDirectClipManualSportKeys([]);
      setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
      setPendingImportVideos([]);
      setPreviewByImportId({});
    } else {
      setPendingImportVideos(entries.map((file) => createPendingImportVideo(file)));
      setPendingDirectClipFiles([]);
      setDirectClipSelectedMatchIds([]);
      setDirectClipSelectedFrequenciesByMatchId({});
      setDirectClipManualSportKeys([]);
      setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
    }
    setPreviewByImportId({});
    setShowImportModal(true);
    setErrorMessage(null);
    setSuccessMessage(null);
  }

  async function openImportSourcePicker(mode: ImportMode) {
    if (desktopBridge?.isDesktop && desktopBridge.selectImportSources) {
      try {
        const sources = await desktopBridge.selectImportSources();
        if (sources.length > 0) {
          await handleImportFiles(sources, mode);
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '选择导入文件夹失败');
      }
      return;
    }
    if (mode === 'direct_clip') {
      directClipFileInputRef.current?.click();
    } else {
      fileInputRef.current?.click();
    }
  }

  function closeImportModal() {
    if (isImporting) return;
    setShowImportModal(false);
    setImportMode('full_video');
    setPendingImportVideos([]);
    setPendingDirectClipFiles([]);
    setDirectClipSelectedMatchIds([]);
    setDirectClipSelectedFrequenciesByMatchId({});
    setDirectClipManualSportKeys([]);
    setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
    setPreviewByImportId({});
    setIsLoadingPlatformMatches(false);
    setLoadingFrequencyMatchIds({});
  }

  function updatePendingImportVideo(
    clientFileId: string,
    updater: (item: PendingImportVideo) => PendingImportVideo,
  ) {
    setPendingImportVideos((current) =>
      current.map((item) => (item.clientFileId === clientFileId ? updater(item) : item)),
    );
  }

  function resetPreviewForImportVideo(clientFileId: string) {
    setPreviewByImportId((current) => ({
      ...current,
      [clientFileId]: {count: null, loading: false, error: null},
    }));
  }

  function resetDirectClipPreview() {
    setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
  }

  function togglePendingVideoApparatus(clientFileId: string, sex: number, sportItemId: number) {
    updatePendingImportVideo(clientFileId, (item) => ({
      ...item,
      manualSportKeys: toggleSportKey(item.manualSportKeys, sportKey(sex, sportItemId)),
    }));
    resetPreviewForImportVideo(clientFileId);
  }

  function setPendingVideoApparatusGroup(clientFileId: string, sex: number, ids: number[]) {
    updatePendingImportVideo(clientFileId, (item) => {
      const keys = ids.map((id) => sportKey(sex, id));
      const hasAll = keys.every((key) => item.manualSportKeys.includes(key));
      return {
        ...item,
        manualSportKeys: hasAll
          ? item.manualSportKeys.filter((key) => !keys.includes(key))
          : Array.from(new Set([...item.manualSportKeys.filter((key) => !keys.includes(key)), ...keys])),
      };
    });
    resetPreviewForImportVideo(clientFileId);
  }

  function setPendingVideoMatch(clientFileId: string, matchId: string | null) {
    updatePendingImportVideo(clientFileId, (item) => ({
      ...item,
      matchId,
      selectedFrequencies: [],
      manualSportKeys: [],
    }));
    resetPreviewForImportVideo(clientFileId);
  }

  function togglePendingVideoFrequency(clientFileId: string, frequency: PlatformFrequency) {
    updatePendingImportVideo(clientFileId, (item) => {
      const nextSelectedFrequencies = item.selectedFrequencies.some((entry) => entry.id === frequency.id)
        ? item.selectedFrequencies.filter((entry) => entry.id !== frequency.id)
        : [...item.selectedFrequencies, frequency];
      const nextCategories = Array.from(
        new Set(
          nextSelectedFrequencies
            .map((entry) => normalizeCategory(entry.category))
            .filter((value): value is PlatformCategory => value !== ''),
        ),
      );
      if (nextCategories.length > 1) {
        setErrorMessage('同一视频只能选择同一比赛类型的场次');
        return item;
      }
      return {
        ...item,
        selectedFrequencies: nextSelectedFrequencies,
        manualSportKeys:
          nextCategories[0] === 'EF' || nextCategories[0] === 'QF'
            ? []
            : item.manualSportKeys,
      };
    });
    resetPreviewForImportVideo(clientFileId);
  }

  function toggleDirectClipMatch(matchId: string) {
    setDirectClipSelectedMatchIds((current) => {
      const exists = current.includes(matchId);
      const next = exists ? current.filter((id) => id !== matchId) : [...current, matchId];
      if (exists) {
        setDirectClipSelectedFrequenciesByMatchId((currentFrequencies) => {
          const copy = {...currentFrequencies};
          delete copy[matchId];
          return copy;
        });
      }
      return next;
    });
    resetDirectClipPreview();
  }

  function toggleDirectClipFrequency(matchId: string, frequency: PlatformFrequency) {
    setDirectClipSelectedFrequenciesByMatchId((current) => {
      const existing = current[matchId] ?? [];
      return {
        ...current,
        [matchId]: existing.some((entry) => entry.id === frequency.id)
          ? existing.filter((entry) => entry.id !== frequency.id)
          : [...existing, frequency],
      };
    });
    resetDirectClipPreview();
  }

  function toggleDirectClipApparatus(sex: number, sportItemId: number) {
    setDirectClipManualSportKeys((current) => toggleSportKey(current, sportKey(sex, sportItemId)));
    resetDirectClipPreview();
  }

  function setDirectClipApparatusGroup(sex: number, ids: number[]) {
    setDirectClipManualSportKeys((current) => {
      const keys = ids.map((id) => sportKey(sex, id));
      const hasAll = keys.every((key) => current.includes(key));
      return hasAll
        ? current.filter((key) => !keys.includes(key))
        : Array.from(new Set([...current.filter((key) => !keys.includes(key)), ...keys]));
    });
    resetDirectClipPreview();
  }

  async function handleSubmitImport() {
    if (isImporting) return;
    if (importMode === 'direct_clip') {
      if (directClipValidationError) {
        setErrorMessage(directClipValidationError);
        return;
      }
      if (directClipPreview.error) {
        setErrorMessage(directClipPreview.error);
        return;
      }

      setIsImporting(true);
      setSuccessMessage(null);
      try {
        const response = await importDirectClipFiles(
          pendingDirectClipFiles.map((item) => ({
            clientFileId: item.clientFileId,
            file: item.file,
            path: item.path,
          })),
          directClipScopeQueries,
          directClipPreview.cacheKey,
        );
        onProjectUpdate(response.project);
        if (response.imported_videos.length > 0) {
          onActiveVideoId(response.imported_videos[0].id);
        }
        setErrorMessage(null);
        setSuccessMessage(`已导入 ${response.imported_count} 个已有片段`);
        setShowImportModal(false);
        setImportMode('full_video');
        setPendingDirectClipFiles([]);
        setDirectClipSelectedMatchIds([]);
        setDirectClipSelectedFrequenciesByMatchId({});
        setDirectClipManualSportKeys([]);
        setDirectClipPreview({count: null, loading: false, error: null, cacheKey: null});
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '导入已有片段失败');
      } finally {
        setIsImporting(false);
      }
      return;
    }

    const invalidRow = pendingImportVideos.find((item) => Boolean(getItemValidationError(item)));
    if (invalidRow) {
      setErrorMessage(`请先完成视频《${invalidRow.name}》的比赛、场次和项目选择`);
      return;
    }
    const failedPreview = pendingImportVideos.find((item) => previewByImportId[item.clientFileId]?.error);
    if (failedPreview) {
      setErrorMessage(`视频《${failedPreview.name}》的平台卡片预览失败，请先修正查询条件`);
      return;
    }

    setIsImporting(true);
    setSuccessMessage(null);
    try {
      const response = await importProjectFiles(
        pendingImportVideos.flatMap((item) => {
          const match = getMatchById(item.matchId);
          const selectedFrequencies = getSelectedFrequenciesForItem(item);
          const category = getDerivedCategoryForItem(item);
          const sportItemIds = getEffectiveSportItemIdsForItem(item);
          if (!match || selectedFrequencies.length === 0 || !category || sportItemIds.length === 0) {
            return [];
          }
          return [{
            clientFileId: item.clientFileId,
            file: item.file,
            path: item.path,
            matchId: item.matchId,
            matchName: match.match_name,
            frequencyInfoIds: selectedFrequencies.map((frequency) => frequency.id),
            venues: selectedFrequencies.map((frequency) => frequency.venue),
            category,
            sportSelectionKeys: getEffectiveSportKeysForItem(item),
            sportItemIds,
          }];
        }),
      );
      onProjectUpdate(response.project);
      if (response.imported_videos.length > 0) {
        onActiveVideoId(response.imported_videos[0].id);
      }
      setErrorMessage(null);
      setSuccessMessage(`已导入 ${response.imported_count} 个视频`);
      setShowImportModal(false);
      setPendingImportVideos([]);
      setPreviewByImportId({});
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '导入失败');
    } finally {
      setIsImporting(false);
    }
  }

  return {
    showImportModal,
    importMode,
    isImporting,
    pendingImportVideos,
    pendingDirectClipFiles,
    directClipSelectedMatchIds,
    directClipSelectedFrequenciesByMatchId,
    directClipManualSportKeys,
    directClipPreview,
    platformMatches,
    isLoadingPlatformMatches,
    platformFrequenciesByMatchId,
    loadingFrequencyMatchIds,
    previewByImportId,
    fileInputRef,
    directClipFileInputRef,
    directClipScopeQueries,
    directClipValidationError,
    directClipRequiresManualApparatus,
    directClipDerivedSportKeys,
    directClipEffectiveSportKeys,
    directClipManualSportKeySet,
    directClipHasAllMag,
    directClipHasAllWag,
    openImportSourcePicker,
    handleImportFiles,
    closeImportModal,
    handleSubmitImport,
    getMatchById,
    getFrequenciesForMatch,
    getSelectedFrequenciesForItem,
    getDerivedCategoryForItem,
    getEffectiveSportKeysForItem,
    getItemValidationError,
    setPendingVideoMatch,
    togglePendingVideoFrequency,
    togglePendingVideoApparatus,
    setPendingVideoApparatusGroup,
    toggleDirectClipMatch,
    toggleDirectClipFrequency,
    toggleDirectClipApparatus,
    setDirectClipApparatusGroup,
  };
}
