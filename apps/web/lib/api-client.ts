import axios, { type AxiosError } from 'axios';

export const apiClient = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// API error responses use either `message` or `error` for the human-readable text. Shared type +
// extractor so callers stop re-declaring `AxiosError<{ message?: string }>` and the read chain.
export type ApiErrorPayload = { message?: string; error?: string };
export type ApiError = AxiosError<ApiErrorPayload>;

export function getApiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as ApiError)?.response?.data;
  return data?.message || data?.error || fallback;
}
