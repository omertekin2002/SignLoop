import { afterEach, describe, expect, it, vi } from "vitest";
import { AxiosError, CanceledError, type InternalAxiosRequestConfig } from "axios";
import { QueryClient } from "@tanstack/react-query";
import { apiClient, ApiRequestError, shouldRetryQuery } from "./api-client";
import { fetchSettings } from "./settings";

function axiosError(status: number) {
  return new AxiosError("HTTP error", undefined, undefined, undefined, {
    status, statusText: "Error", headers: {}, data: {}, config: {} as InternalAxiosRequestConfig,
  });
}

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => { apiClient.defaults.adapter = originalAdapter; });

describe("query retry policy", () => {
  it.each([400, 401, 403, 404, 409, 422])("does not retry permanent HTTP %s failures", async (status) => {
    for (const error of [axiosError(status), new ApiRequestError("HTTP error", status)]) {
      const client = new QueryClient();
      const queryFn = vi.fn().mockRejectedValue(error);
      await expect(client.fetchQuery({ queryKey: ["missing"], queryFn, retry: shouldRetryQuery, retryDelay: 0 })).rejects.toBe(error);
      expect(queryFn).toHaveBeenCalledTimes(1);
      client.clear();
    }
  });

  it.each([408, 429, 500, 503])("allows bounded recovery from HTTP %s", async (status) => {
    const client = new QueryClient();
    const queryFn = vi.fn().mockRejectedValueOnce(axiosError(status)).mockResolvedValue("recovered");
    await expect(client.fetchQuery({ queryKey: ["transient"], queryFn, retry: shouldRetryQuery, retryDelay: 0 })).resolves.toBe("recovered");
    expect(queryFn).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it("bounds network retries and does not retry canceled requests", async () => {
    const client = new QueryClient();
    const error = new TypeError("Failed to fetch");
    const queryFn = vi.fn().mockRejectedValue(error);
    await expect(client.fetchQuery({ queryKey: ["offline"], queryFn, retry: shouldRetryQuery, retryDelay: 0 })).rejects.toBe(error);
    expect(queryFn).toHaveBeenCalledTimes(4);
    expect(shouldRetryQuery(0, new CanceledError())).toBe(false);
    expect(shouldRetryQuery(0, new DOMException("Canceled", "AbortError"))).toBe(false);
    client.clear();
  });

  it("propagates query cancellation through settings to the HTTP adapter", async () => {
    const client = new QueryClient();
    let aborted = false;
    apiClient.defaults.adapter = (config) => new Promise((_resolve, reject) => {
      config.signal?.addEventListener?.("abort", () => {
        aborted = true;
        reject(new CanceledError());
      });
    });
    const pending = client.fetchQuery({ queryKey: ["settings"], queryFn: ({ signal }) => fetchSettings({ signal }) });
    const rejection = expect(pending).rejects.toBeDefined();
    await client.cancelQueries({ queryKey: ["settings"] });
    await rejection;
    expect(aborted).toBe(true);
    client.clear();
  });
});
