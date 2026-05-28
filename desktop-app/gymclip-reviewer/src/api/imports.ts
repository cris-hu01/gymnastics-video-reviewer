import type {ImportProjectResponse, PlatformScopeQuery} from '../types';
import {request} from './http';

type ImportProjectFile = {
  clientFileId: string;
  file: File | null;
  path?: string | null;
  matchId?: string | null;
  matchName: string;
  frequencyInfoIds: string[];
  venues: string[];
  category: string;
  sportSelectionKeys: string[];
  sportItemIds: number[];
};

type ImportDirectClipFile = {
  clientFileId: string;
  file: File | null;
  path?: string | null;
};

export async function importProjectFiles(
  files: Array<ImportProjectFile>,
): Promise<ImportProjectResponse> {
  const shouldUseJsonPaths = files.every((item) => !item.file && item.path);
  if (shouldUseJsonPaths) {
    return request<ImportProjectResponse>('/api/project/import', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        files: files.map((item) => ({
          path: item.path,
          match_id: item.matchId ?? null,
          match_name: item.matchName,
          frequency_info_ids: item.frequencyInfoIds,
          venues: item.venues,
          category: item.category,
          sport_selection_keys: item.sportSelectionKeys,
          sport_item_ids: item.sportItemIds,
        })),
      }),
    });
  }
  const formData = new FormData();
  formData.append(
    'contexts_json',
    JSON.stringify(
      files.map((item) => ({
        client_file_id: item.clientFileId,
        match_id: item.matchId ?? null,
        match_name: item.matchName,
        frequency_info_ids: item.frequencyInfoIds,
        venues: item.venues,
        category: item.category,
        sport_selection_keys: item.sportSelectionKeys,
        sport_item_ids: item.sportItemIds,
      })),
    ),
  );
  files.forEach((item) => {
    if (item.file) {
      formData.append('files', item.file);
      formData.append('file_client_ids', item.clientFileId);
    }
  });
  return request<ImportProjectResponse>('/api/project/import', {
    method: 'POST',
    body: formData,
  });
}

export async function importDirectClipFiles(
  files: Array<ImportDirectClipFile>,
  scopeQueries: PlatformScopeQuery[],
  previewCacheKey?: string | null,
): Promise<ImportProjectResponse> {
  const shouldUseJsonPaths = files.every((item) => !item.file && item.path);
  if (shouldUseJsonPaths) {
    return request<ImportProjectResponse>('/api/project/import-direct-clips', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        scope_queries: scopeQueries,
        preview_cache_key: previewCacheKey ?? null,
        files: files.map((item) => ({path: item.path})),
      }),
    });
  }
  const formData = new FormData();
  formData.append('scope_queries_json', JSON.stringify(scopeQueries));
  if (previewCacheKey) {
    formData.append('preview_cache_key', previewCacheKey);
  }
  files.forEach((item) => {
    if (item.file) {
      formData.append('files', item.file);
      formData.append('file_client_ids', item.clientFileId);
    }
  });
  return request<ImportProjectResponse>('/api/project/import-direct-clips', {
    method: 'POST',
    body: formData,
  });
}
