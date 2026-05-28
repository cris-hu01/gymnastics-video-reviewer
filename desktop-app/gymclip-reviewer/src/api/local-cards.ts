import type {
  LocalCardCreatePayload,
  LocalCardUpdatePayload,
  PlatformRecord,
  ProjectState,
  UpdateClipResponse,
} from '../types';
import {request} from './http';

export type LocalCardResponse = {
  record: PlatformRecord;
  project: ProjectState;
};

export async function createLocalCard(
  videoId: string,
  payload: LocalCardCreatePayload,
): Promise<LocalCardResponse> {
  return request<LocalCardResponse>(`/api/videos/${videoId}/local-cards`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
}

export async function updateLocalCard(
  videoId: string,
  recordId: string,
  payload: LocalCardUpdatePayload,
): Promise<LocalCardResponse> {
  return request<LocalCardResponse>(
    `/api/videos/${videoId}/local-cards/${recordId}`,
    {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteLocalCard(
  videoId: string,
  recordId: string,
): Promise<UpdateClipResponse> {
  return request<UpdateClipResponse>(
    `/api/videos/${videoId}/local-cards/${recordId}`,
    {method: 'DELETE'},
  );
}
