import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query, clientQuery, release, connect } = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@vercel/postgres", () => ({ sql: { query, connect } }));

import {
  claimGenerationOperation,
  deleteAnalysisForContract,
} from "./server-db";

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
