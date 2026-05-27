import type {JobListResponse, JobResponse} from '../types';
import {request} from './http';

export async function fetchJobs(): Promise<JobListResponse> {
  return request<JobListResponse>('/api/jobs');
}

export async function fetchJob(jobId: string): Promise<JobResponse> {
  return request<JobResponse>(`/api/jobs/${jobId}`);
}
