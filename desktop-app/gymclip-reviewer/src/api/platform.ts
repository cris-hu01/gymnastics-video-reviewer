import type {
  PlatformFrequenciesResponse,
  PlatformMatchesResponse,
  PlatformRecordsResponse,
  PlatformScopeQuery,
  PlatformTeamCountriesResponse,
} from '../types';
import {request} from './http';

export async function fetchPlatformMatches(): Promise<PlatformMatchesResponse> {
  return request<PlatformMatchesResponse>('/api/platform/matches');
}

export async function fetchPlatformFrequencies(params: {
  matchId?: string | null;
  matchName?: string;
  category?: string;
}): Promise<PlatformFrequenciesResponse> {
  const query = new URLSearchParams();
  if (params.matchId != null) query.set('match_id', String(params.matchId));
  if (params.matchName) query.set('match_name', params.matchName);
  if (params.category) query.set('category', params.category);
  return request<PlatformFrequenciesResponse>(`/api/platform/frequencies?${query.toString()}`);
}

export async function fetchPlatformTeamCountries(params: {
  frequencyInfoId: string;
  sex: number;
  matchName?: string;
  venue?: string;
}): Promise<PlatformTeamCountriesResponse> {
  const query = new URLSearchParams({
    frequency_info_id: String(params.frequencyInfoId),
    sex: String(params.sex),
  });
  if (params.matchName) query.set('match_name', params.matchName);
  if (params.venue) query.set('venue', params.venue);
  return request<PlatformTeamCountriesResponse>(`/api/platform/team-countries?${query.toString()}`);
}

export async function fetchPlatformRecords(params: {
  matchId?: string | null;
  matchName: string;
  frequencyInfoIds: string[];
  venues: string[];
  category: string;
  sportSelectionKeys: string[];
  sportItemIds: number[];
}): Promise<PlatformRecordsResponse> {
  const query = new URLSearchParams({
    match_name: params.matchName,
    category: params.category,
    sport_item_ids: params.sportItemIds.join(','),
  });
  if (params.matchId != null) query.set('match_id', String(params.matchId));
  params.frequencyInfoIds.forEach((id) => query.append('frequency_info_ids', String(id)));
  params.venues.forEach((venue) => query.append('venues', venue));
  params.sportSelectionKeys.forEach((key) => query.append('sport_selection_keys', key));
  return request<PlatformRecordsResponse>(`/api/platform/records?${query.toString()}`);
}

export async function previewScopePlatformRecords(
  scopeQueries: PlatformScopeQuery[],
): Promise<PlatformRecordsResponse> {
  return request<PlatformRecordsResponse>('/api/platform/records/preview-scope', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({scope_queries: scopeQueries}),
  });
}
