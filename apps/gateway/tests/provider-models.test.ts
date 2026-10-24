import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPrimaryModelAvailabilityCache,
  discoverPrimaryModelAvailability,
} from "../src/pipeline/provider-models";

const primary = {
  baseURL: "https://primary.example.test/v1",
  apiKey: "primary-secret",
  model: "provider/configured-model",
};

afterEach(() => {
  clearPrimaryModelAvailabilityCache();
});

describe("primary model discovery", () => {
  it("reports an advertised configured model", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer primary-secret",
      );
      return new Response(
        JSON.stringify({ data: [{ id: "provider/configured-model" }] }),
        { status: 200 },
      );
    });

    await expect(
      discoverPrimaryModelAvailability(primary, { fetch: fetchMock }),
    ).resolves.toBe("available");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://primary.example.test/v1/models",
    );
  });

  it("reports definite absence only from a valid successful model list", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "provider/other" }] }), {
        status: 200,
      }),
    );

    await expect(
      discoverPrimaryModelAvailability(primary, { fetch: fetchMock }),
    ).resolves.toBe("unavailable");
  });

  it("treats unsupported, transient, and malformed discovery as advisory", async () => {
    await expect(
      discoverPrimaryModelAvailability(primary, {
        fetch: async () => new Response("not supported", { status: 404 }),
      }),
    ).resolves.toBe("unknown");
    await expect(
      discoverPrimaryModelAvailability(primary, {
        fetch: async () => {
          throw new Error("temporary network failure");
        },
      }),
    ).resolves.toBe("unknown");
    await expect(
      discoverPrimaryModelAvailability(primary, {
        fetch: async () => new Response("{}", { status: 200 }),
      }),
    ).resolves.toBe("unknown");
  });

  it("caches successful discovery results for the configured TTL", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ id: "provider/configured-model" }] }),
        { status: 200 },
      ),
    );

    await discoverPrimaryModelAvailability(primary, {
      fetch: fetchMock,
      now: () => 1_000,
      cacheTtlMs: 500,
    });
    await discoverPrimaryModelAvailability(primary, {
      fetch: fetchMock,
      now: () => 1_499,
      cacheTtlMs: 500,
    });
    await discoverPrimaryModelAvailability(primary, {
      fetch: fetchMock,
      now: () => 1_500,
      cacheTtlMs: 500,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("briefly remembers unknown availability instead of rechecking on every request", async () => {
    const fetchMock = vi.fn(
      async () => new Response("not supported", { status: 404 }),
    );
    const discoverAt = (now: number) =>
      discoverPrimaryModelAvailability(primary, {
        fetch: fetchMock,
        now: () => now,
        unknownCacheTtlMs: 100,
      });

    await expect(discoverAt(1_000)).resolves.toBe("unknown");
    await expect(discoverAt(1_099)).resolves.toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(discoverAt(1_100)).resolves.toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not remember a check the caller cancelled", async () => {
    const controller = new AbortController();
    const reason = new DOMException("request cancelled", "AbortError");
    await expect(
      discoverPrimaryModelAvailability(primary, {
        signal: controller.signal,
        fetch: async () => {
          controller.abort(reason);
          throw reason;
        },
      }),
    ).rejects.toBe(reason);

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: primary.model }] }), {
          status: 200,
        }),
    );
    await expect(
      discoverPrimaryModelAvailability(primary, { fetch: fetchMock }),
    ).resolves.toBe("available");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("request cancelled", "AbortError");
    controller.abort(reason);

    await expect(
      discoverPrimaryModelAvailability(primary, {
        signal: controller.signal,
        fetch: vi.fn(),
      }),
    ).rejects.toBe(reason);
  });
});
