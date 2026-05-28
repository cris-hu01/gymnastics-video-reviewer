/**
 * usePlatformMatchPanel — UI-only filter state for the right platform-match
 * sidebar.
 *
 * Why these aren't in the zustand store:
 *   - They're consumed by App-level memos (videoScopedPlatformRecords,
 *     filteredPlatformRecords, scoreApparatusOptions, …) and by useLocalCard.
 *     Keeping them as plain useState avoids forcing every memo to subscribe
 *     to the store explicitly.
 *   - They reset on activePlatformScopeId change via an App-level useEffect;
 *     pulling them into the store would relocate that reset logic without
 *     reducing surface area.
 *   - All four filters + the search query are UI-only — no other domain
 *     reads or writes them.
 *
 * The hook is invoked from App.tsx (not from PlatformMatchPanel) because the
 * App-level memos depend on the same state. PlatformMatchPanel receives the
 * tuple via the `local` prop.
 */
import type {Dispatch, SetStateAction} from 'react';
import {useState} from 'react';

import type {ScoreFilterMenu} from '../../components/ScoreFilterDropdown';

export interface PlatformMatchPanelLocalState {
  scoreSearchQuery: string;
  setScoreSearchQuery: Dispatch<SetStateAction<string>>;
  scoreApparatusFilter: string;
  setScoreApparatusFilter: Dispatch<SetStateAction<string>>;
  scoreSexFilter: string;
  setScoreSexFilter: Dispatch<SetStateAction<string>>;
  scoreCountryFilter: string;
  setScoreCountryFilter: Dispatch<SetStateAction<string>>;
  openScoreFilter: ScoreFilterMenu | null;
  setOpenScoreFilter: Dispatch<SetStateAction<ScoreFilterMenu | null>>;
}

export function usePlatformMatchPanel(): PlatformMatchPanelLocalState {
  const [scoreSearchQuery, setScoreSearchQuery] = useState('');
  const [scoreApparatusFilter, setScoreApparatusFilter] = useState('all');
  const [scoreSexFilter, setScoreSexFilter] = useState('all');
  const [scoreCountryFilter, setScoreCountryFilter] = useState('all');
  const [openScoreFilter, setOpenScoreFilter] = useState<ScoreFilterMenu | null>(null);

  return {
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
  };
}
