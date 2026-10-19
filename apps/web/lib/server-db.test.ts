import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query, clientQuery, release, connect, randomInt } = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  randomInt: vi.fn(),
}));

vi.mock("@vercel/postgres", () => ({ sql: { query, connect } }));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomInt,
}));

import {
  claimChatAdmission,
  claimGenerationOperation,
  deleteAnalysisForContract,
  getInferenceQuota,
} from "./server-db";
import { admissionLimits } from "./inference-policy";

const entityId = "abcdef01-2345-4678-9abc-def012345678";
const olderId = "abcdef01-2345-4678-9abc-def012345679";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SKIP_SCHEMA_BOOTSTRAP", "1");
  connect.mockResolvedValue({ query: clientQuery, release });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("generation UUID identity", () => {
  const leases = new Map<string, string>();

  beforeEach(() => {
    leases.clear();
    query.mockImplementation(
      async (statement: string, [key, token]: string[]) => {
        if (statement.startsWith("INSERT INTO generation_operations")) {
          if (leases.has(key!)) return { rowCount: 0 };
          leases.set(key!, token!);
          return { rowCount: 1 };
        }
        expect(statement).toBe(
          "DELETE FROM generation_operations WHERE entity_key = $1 AND token = $2",
        );
        if (leases.get(key!) === token) leases.delete(key!);
        return { rowCount: 0 };
      },
    );
  });

  it.each(["contract", "chat"] as const)(
    "shares one %s lease across mixed UUID casing and permits retry after release",
    async (kind) => {
      const first = await claimGenerationOperation("Owner", kind, entityId, 60);
      expect(first).not.toBeNull();
      expect(
        await claimGenerationOperation(
          "Owner",
          kind,
          entityId.toUpperCase(),
          60,
        ),
      ).toBeNull();
      expect(leases.size).toBe(1);
      await first!();
      const retry = await claimGenerationOperation(
        "Owner",
        kind,
        entityId.toUpperCase(),
        60,
      );
      expect(retry).not.toBeNull();
      await retry!();
      expect(leases.size).toBe(0);
    },
  );

  it("preserves case-sensitive owner IDs and separates entity kinds", async () => {
    const claims = await Promise.all([
      claimGenerationOperation("Owner", "contract", entityId.toUpperCase(), 60),
      claimGenerationOperation("owner", "contract", entityId, 60),
      claimGenerationOperation("Owner", "chat", entityId, 60),
    ]);
    expect(claims.every(Boolean)).toBe(true);
    expect([...leases.keys()]).toEqual([
      `contract:Owner:${entityId}`,
      `contract:owner:${entityId}`,
      `chat:Owner:${entityId}`,
    ]);
    await Promise.all(claims.map((claim) => claim!()));
  });

  it("keeps mixed-case takeover releases scoped to the claiming token", async () => {
    const stale = await claimGenerationOperation(
      "Owner",
      "contract",
      entityId,
      60,
    );
    expect(stale).not.toBeNull();
    // Model the expired row being eligible for replacement by the next INSERT.
    leases.clear();
    const fresh = await claimGenerationOperation(
      "Owner",
      "contract",
      entityId.toUpperCase(),
      60,
    );
    expect(fresh).not.toBeNull();
    await stale!();
    expect(
      await claimGenerationOperation("Owner", "contract", entityId, 60),
    ).toBeNull();
    await fresh!();
    const retry = await claimGenerationOperation(
      "Owner",
      "contract",
      entityId,
      60,
    );
    expect(retry).not.toBeNull();
    await retry!();
  });
});

describe("analysis deletion UUID identity", () => {
  it.each([
    { analysisId: entityId.toUpperCase(), deletingLatest: true },
    { analysisId: olderId.toUpperCase(), deletingLatest: false },
  ])(
    "identifies latest deletion for $analysisId",
    async ({ analysisId, deletingLatest }) => {
      clientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1 }) // owner-scoped contract lock
        .mockResolvedValueOnce({ rows: [{ id: entityId }] }) // latest analysis
        .mockResolvedValueOnce({ rows: [{ id: analysisId.toLowerCase() }] }) // DELETE
        .mockResolvedValueOnce({}) // status update
        .mockResolvedValueOnce({}); // COMMIT

      expect(
        await deleteAnalysisForContract({
          userId: "Owner",
          contractId: entityId.toUpperCase(),
          analysisId,
        }),
      ).toBe(true);
      expect(clientQuery.mock.calls[0]).toEqual(["BEGIN"]);
      expect(clientQuery.mock.calls[1]).toEqual([
        "SELECT id FROM contracts WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [entityId.toUpperCase(), "Owner"],
      ]);
      expect(clientQuery.mock.calls[3]?.[1]).toEqual([
        analysisId,
        entityId.toUpperCase(),
        "Owner",
        null,
      ]);
      expect(clientQuery.mock.calls[4]).toEqual([
        expect.stringContaining("AND ($3 OR NOT EXISTS"),
        [entityId.toUpperCase(), "Owner", deletingLatest],
      ]);
      expect(clientQuery.mock.calls[5]).toEqual(["COMMIT"]);
      expect(release).toHaveBeenCalledOnce();
    },
  );
});

describe("admission decisions", () => {
  // Epoch seconds as the state query returns them (database clock).
  const now = 1_792_418_400.25; // 2026-10-19T14:00:00.250Z
  const hourResetsAt = 1_792_422_000; // 15:00Z
  const dayResetsAt = 1_792_454_400; // 2026-10-20T00:00Z
  const limits = {
    principal: "principal",
    hourlyLimit: 30,
    concurrency: 2,
    globalDailyLimit: 1_000,
    globalConcurrency: 8,
  };
  const idle = {
    active: 0,
    own: 0,
    daily: 0,
    hourly: 0,
    dbNow: now,
    hourResetsAt,
    dayResetsAt,
    ownSlotFreesAt: null as number | null,
    anySlotFreesAt: null as number | null,
  };

  function arrangeState(state: Partial<typeof idle>) {
    clientQuery.mockImplementation(async (statement: string) =>
      statement.includes('AS "dbNow"')
        ? { rows: [{ ...idle, ...state }] }
        : { rows: [], rowCount: 0 },
    );
  }
  const statements = () =>
    clientQuery.mock.calls.map(([statement]) => statement);

  beforeEach(() => randomInt.mockReturnValue(0));

  it("rejects a full hour with the seconds until its reset, plus 0-15 s jitter", async () => {
    arrangeState({ hourly: 30, own: 1 });

    const rejection = await claimChatAdmission(limits);

    expect(rejection).toEqual({
      retryAfter: 3_600,
      reason: "hourly",
      resetAt: "2026-10-19T15:00:00.000Z",
      quota: {
        limit: 30,
        used: 30,
        remaining: 0,
        resetAt: "2026-10-19T15:00:00.000Z",
        concurrency: { limit: 2, inUse: 1 },
      },
    });
    expect(randomInt).toHaveBeenCalledExactlyOnceWith(16);
    expect(statements()).toContain("ROLLBACK");
    expect(statements().some((text) => text.includes("INSERT"))).toBe(false);

    randomInt.mockReturnValue(15);
    expect(await claimChatAdmission(limits)).toMatchObject({
      retryAfter: 3_615,
    });
  });

  it("reports the service-wide day before the account hour when both are spent", async () => {
    arrangeState({ daily: 1_000, hourly: 30 });

    expect(await claimChatAdmission(limits)).toMatchObject({
      retryAfter: 36_000,
      reason: "daily",
      resetAt: "2026-10-20T00:00:00.000Z",
    });
  });

  it.each([
    [
      "the caller's slots",
      { own: 2, ownSlotFreesAt: now + 4.5, anySlotFreesAt: now + 1 },
      5,
      now + 4.5,
    ],
    [
      "service slots",
      { own: 1, active: 8, anySlotFreesAt: now + 9 },
      9,
      now + 9,
    ],
    ["long-lived slots", { own: 2, ownSlotFreesAt: now + 300 }, 30, now + 30],
  ])(
    "waits at most 30 s when %s are busy, or until one expires",
    async (_label, state, retryAfter, resetsAt) => {
      arrangeState(state);

      expect(await claimChatAdmission(limits)).toMatchObject({
        retryAfter,
        reason: "busy",
        resetAt: new Date(resetsAt * 1000).toISOString(),
      });
    },
  );

  it("admits under every limit and reports the quota including this claim", async () => {
    arrangeState({ hourly: 17, own: 1, active: 5, daily: 400 });

    const grant = await claimChatAdmission(limits);

    expect(grant).toEqual({
      release: expect.any(Function),
      quota: {
        limit: 30,
        used: 18,
        remaining: 12,
        resetAt: "2026-10-19T15:00:00.000Z",
        concurrency: { limit: 2, inUse: 2 },
      },
    });
    expect(statements().filter((text) => text.includes("INSERT"))).toHaveLength(
      2,
    );
    expect(statements().at(-1)).toBe("COMMIT");
    expect(randomInt).not.toHaveBeenCalled();
  });

  describe("getInferenceQuota", () => {
    const principal = createHash("sha256").update("user_123").digest("hex");

    // Use the service-wide defaults even when a local .env.local overrides them.
    beforeEach(() => {
      vi.stubEnv("CHAT_DAILY_REQUEST_LIMIT", "");
      vi.stubEnv("CHAT_CONCURRENCY_LIMIT", "");
    });

    it("reads the claim's state query once through the pool, with no lock or writes", async () => {
      arrangeState({});
      await claimChatAdmission(admissionLimits("user_123"));
      const claimRead = clientQuery.mock.calls.find(([statement]) =>
        statement.includes('AS "dbNow"'),
      );
      query.mockResolvedValue({ rows: [{ ...idle, hourly: 4, own: 1 }] });

      await getInferenceQuota("user_123");

      expect(query).toHaveBeenCalledOnce();
      expect(query.mock.calls[0]).toEqual(claimRead);
      expect(query.mock.calls[0]).toEqual([expect.any(String), [principal]]);
      expect(query.mock.calls[0]![0]).not.toMatch(
        /INSERT|UPDATE|DELETE|advisory|FOR UPDATE|BEGIN/i,
      );
      expect(connect).toHaveBeenCalledOnce(); // the claim's transaction only
    });

    it("returns the account quota and a coarse status, never service-wide counts", async () => {
      query.mockResolvedValue({
        rows: [{ ...idle, hourly: 18, own: 1, active: 3, daily: 999 }],
      });

      expect(await getInferenceQuota("user_123")).toEqual({
        account: {
          limit: 30,
          used: 18,
          remaining: 12,
          resetAt: "2026-10-19T15:00:00.000Z",
          concurrency: { limit: 2, inUse: 1 },
        },
        service: "ok",
      });
    });

    it.each([
      [{ daily: 1_000, active: 8 }, "exhausted"],
      [{ daily: 999, active: 8 }, "busy"],
      [{ daily: 999, active: 7 }, "ok"],
    ])("maps service-wide state %o to %s", async (state, service) => {
      query.mockResolvedValue({ rows: [{ ...idle, ...state }] });

      expect((await getInferenceQuota("user_123")).service).toBe(service);
    });
  });
});
