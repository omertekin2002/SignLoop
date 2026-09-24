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

/** Preserve HTTP status for fetch-based reads as well as Axios requests. */
export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (axios.isCancel(error) || (error instanceof Error && error.name === "AbortError")) {
    return false;
  }
  const status = error instanceof ApiRequestError
    ? error.status
    : axios.isAxiosError(error) ? error.response?.status : undefined;
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return false;
  }
  return failureCount < 3;
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as ApiError)?.response?.data;
  return data?.message || data?.error || fallback;
}
