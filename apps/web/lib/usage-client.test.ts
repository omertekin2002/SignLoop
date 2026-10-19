import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { InternalAxiosRequestConfig } from "axios";
import { apiClient } from "./api-client";
import type { AccountQuota, UsageResponse } from "./inference-policy";
import {
  admissionRejectionMessage,
  analysisUsageNote,
  composerUsageNote,
  describeUsage,
  fetchUsage,
  formatResetTime,
  parseAccountQuota,
  parseAdmissionRejection,
  parseUsageResponse,
  syncUsage,
  USAGE_QUERY_KEY,
  usageMeterTone,
} from "./usage-client";

const resetAt = "2026-10-19T15:00:00.000Z";
const now = Date.parse("2026-10-19T14:40:00.000Z");
const quota = (used: number, reset = resetAt): AccountQuota => ({
  limit: 30,
  used,
  remaining: 30 - used,
  resetAt: reset,
  concurrency: { limit: 2, inUse: 0 },
});
const usage = (used: number): UsageResponse => ({
  account: quota(used),
  shared: ["chat", "analysis"],
  service: "ok",
});

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
});

describe("reset times", () => {
  it.each([
    ["UTC", "15:00"],
    ["Europe/Istanbul", "18:00"],
    ["America/New_York", "11:00"],
  ])("shows a same-day reset as wall-clock time in %s", (timeZone, time) => {
    expect(formatResetTime(resetAt, now, timeZone)).toBe(time);
  });

  it("adds the date only when the reset falls on another local day", () => {
    const midnight = "2026-10-20T00:00:00.000Z";
    const lateEvening = Date.parse("2026-10-19T23:30:00.000Z");
    expect(formatResetTime(midnight, lateEvening, "UTC")).toBe("Oct 20, 00:00");
    expect(formatResetTime(midnight, lateEvening, "Europe/Istanbul")).toBe(
      "03:00",
    );
    expect(formatResetTime(midnight, lateEvening, "America/New_York")).toBe(
      "20:00",
    );
  });
});

describe("captions", () => {
  it("describes settings usage with its reset and sharing", () => {
    expect(describeUsage(quota(18), now, "UTC")).toBe(
      "18 of 30 used this hour · resets 15:00 · shared by chat and analysis",
    );
    expect(describeUsage({ ...quota(30), used: 31 }, now, "UTC")).toMatch(
      /^30 of 30 used/,
    );
  });

  it.each([
    [undefined, ""],
    [24, ""],
    [25, "5 left this hour"],
    [29, "1 left this hour"],
    [30, "No requests left this hour · resets 15:00"],
  ])("appends a composer note after %s used: %j", (used, note) => {
    expect(
      composerUsageNote(
        used === undefined ? undefined : quota(used),
        now,
        "UTC",
      ),
    ).toBe(note);
  });

  it("states what an analysis costs, or when the allowance returns", () => {
    expect(analysisUsageNote(undefined)).toBe("");
    expect(analysisUsageNote(quota(18), now, "UTC")).toBe(
      "Uses 1 of 12 remaining (shared with chat)",
    );
    expect(analysisUsageNote(quota(30), now, "UTC")).toBe(
      "No requests left this hour · resets 15:00 (shared with chat)",
    );
  });

  it.each([
    [23, "normal"],
    [24, "low"],
    [29, "low"],
    [30, "empty"],
  ] as const)("tones the meter after %i of 30 used as %s", (used, tone) => {
    expect(usageMeterTone(quota(used))).toBe(tone);
  });

  it("rewords only hourly and daily rejections", () => {
    expect(
      admissionRejectionMessage(
        { reason: "hourly", resetAt, quota: quota(30) },
        now,
        "UTC",
      ),
    ).toBe(
      "You've used all 30 requests this hour, shared by chat and analysis. They reset at 15:00.",
    );
    expect(
      admissionRejectionMessage(
        {
          reason: "daily",
          resetAt: "2026-10-20T00:00:00.000Z",
          quota: quota(4),
        },
        now,
        "UTC",
      ),
    ).toBe(
      "SignLoop has reached its daily request limit. Please try again after Oct 20, 00:00.",
    );
    expect(
      admissionRejectionMessage(
        { reason: "busy", resetAt, quota: null },
        now,
        "UTC",
      ),
    ).toBeNull();
  });
});

describe("parsing", () => {
  it("accepts well-formed quotas and rejects anything else", () => {
    expect(parseAccountQuota(quota(18))).toEqual(quota(18));
    expect(parseAccountQuota({ ...quota(18), extra: 1 })).toEqual(quota(18));
    for (const invalid of [
      null,
      [],
      { ...quota(18), used: -1 },
      { ...quota(18), remaining: 1.5 },
      { ...quota(18), limit: "30" },
      { ...quota(18), resetAt: "soon" },
      { ...quota(18), concurrency: null },
      { ...quota(18), concurrency: { limit: 2 } },
    ])
      expect(parseAccountQuota(invalid)).toBeNull();
  });

  it("validates the usage response and its coarse service status", () => {
    expect(parseUsageResponse(usage(18))).toEqual(usage(18));
    expect(
      parseUsageResponse({ ...usage(18), shared: ["chat", "billing"] })?.shared,
    ).toEqual(["chat"]);
    expect(parseUsageResponse({ ...usage(18), service: "down" })).toBeNull();
    expect(parseUsageResponse({ ...usage(18), account: {} })).toBeNull();
  });

  it("reads a rejection's reason, reset, and optional quota", () => {
    expect(
      parseAdmissionRejection({ reason: "hourly", resetAt, quota: quota(30) }),
    ).toEqual({
      reason: "hourly",
      resetAt,
      quota: quota(30),
    });
    expect(parseAdmissionRejection({ reason: "busy", resetAt })).toEqual({
      reason: "busy",
      resetAt,
      quota: null,
    });
    expect(parseAdmissionRejection({ reason: "weekly", resetAt })).toBeNull();
    expect(parseAdmissionRejection({ reason: "daily" })).toBeNull();
    expect(parseAdmissionRejection("Too many requests")).toBeNull();
  });
});

describe("fetchUsage", () => {
  it("reads and validates /api/usage", async () => {
    let requested: string | undefined;
    apiClient.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      requested = `${config.baseURL}${config.url}`;
      return {
        data: usage(18),
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    };

    await expect(fetchUsage()).resolves.toEqual(usage(18));
    expect(requested).toBe("/api/usage");
  });

  it("rejects a malformed body", async () => {
    apiClient.defaults.adapter = async (
      config: InternalAxiosRequestConfig,
    ) => ({
      data: { account: null },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    });

    await expect(fetchUsage()).rejects.toThrow("malformed");
  });
});

describe("syncUsage", () => {
  function observeUsage(client: QueryClient, data: UsageResponse) {
    const queryFn = vi.fn().mockResolvedValue(data);
    const observer = new QueryObserver(client, {
      queryKey: USAGE_QUERY_KEY,
      queryFn,
      staleTime: Infinity,
    });
    return { queryFn, unsubscribe: observer.subscribe(() => {}) };
  }

  it("applies a response's quota in place and only marks usage stale", async () => {
    const client = new QueryClient();
    const { queryFn, unsubscribe } = observeUsage(client, usage(10));
    await vi.waitFor(() =>
      expect(client.getQueryData(USAGE_QUERY_KEY)).toEqual(usage(10)),
    );

    await syncUsage(client, quota(11));

    expect(client.getQueryData(USAGE_QUERY_KEY)).toEqual({
      ...usage(10),
      account: quota(11),
    });
    expect(client.getQueryState(USAGE_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(queryFn).toHaveBeenCalledOnce();
    unsubscribe();
    client.clear();
  });

  it("refetches when a finished request carried no quota", async () => {
    const client = new QueryClient();
    const { queryFn, unsubscribe } = observeUsage(client, usage(3));
    await vi.waitFor(() =>
      expect(client.getQueryData(USAGE_QUERY_KEY)).toEqual(usage(3)),
    );

    await syncUsage(client);

    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
    client.clear();
  });

  it("never moves usage backwards within a window when replies finish out of order", async () => {
    const client = new QueryClient();
    client.setQueryData(USAGE_QUERY_KEY, usage(12));
    const account = () =>
      client.getQueryData<UsageResponse>(USAGE_QUERY_KEY)?.account;

    await syncUsage(client, quota(11));
    expect(account()?.used).toBe(12);

    const nextHour = "2026-10-19T16:00:00.000Z";
    await syncUsage(client, quota(1, nextHour));
    expect(account()).toEqual(quota(1, nextHour));

    // A reply admitted in the previous window finishes late.
    await syncUsage(client, quota(29));
    expect(account()).toEqual(quota(1, nextHour));
    client.clear();
  });

  it("creates no usage data for a client that never loaded it", async () => {
    const client = new QueryClient();

    await syncUsage(client, quota(3));

    expect(client.getQueryData(USAGE_QUERY_KEY)).toBeUndefined();
  });
});
