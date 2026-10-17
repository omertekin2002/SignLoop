import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, fastQuery, release, connect, ensureSchema, randomUUID } =
  vi.hoisted(() => ({
    query: vi.fn(),
    fastQuery: vi.fn(),
    release: vi.fn(),
    connect: vi.fn(),
    ensureSchema: vi.fn(),
    randomUUID: vi.fn(),
  }));

vi.mock("@vercel/postgres", () => ({ sql: { connect, query: fastQuery } }));
vi.mock("./server-db", () => ({ ensureSchema }));
vi.mock("node:crypto", () => ({ randomUUID }));

import { AuthIdentityError, resolveWorkOSUserId } from "./auth-identity";

const ownerId = "fe38d076-12df-4bf2-90d0-fcb19ede8af4";
let existingOwner: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  existingOwner = undefined;
  randomUUID.mockReturnValue(ownerId);
  connect.mockResolvedValue({ query, release });
  fastQuery.mockImplementation(async () => ({
    rows: existingOwner ? [{ user_id: existingOwner }] : [],
  }));
  query.mockImplementation(async (statement: string, values?: string[]) => {
    if (statement.startsWith("SELECT user_id")) {
      return { rows: existingOwner ? [{ user_id: existingOwner }] : [] };
    }
    if (statement.startsWith("INSERT INTO application_users")) {
      return { rows: [{ id: values![0] }] };
    }
    if (statement.startsWith("INSERT INTO auth_identities")) {
      return { rows: [{ user_id: values![1] }] };
    }
    return { rows: [] };
  });
});

describe("WorkOS application identity", () => {
  it("creates and commits a separate application UUID for a new subject", async () => {
    expect(await resolveWorkOSUserId({ id: "user_workos" })).toBe(ownerId);
    expect(ensureSchema).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("VALUES ('workos', $1, $2)"),
      ["user_workos", ownerId],
    );
    expect(query.mock.calls[0]).toEqual(["BEGIN"]);
    expect(query.mock.calls.at(-1)).toEqual(["COMMIT"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("reuses the stored owner without allocating another UUID", async () => {
    existingOwner = "previous-owner";
    expect(await resolveWorkOSUserId({ id: "user_workos" })).toBe(
      "previous-owner",
    );
    expect(randomUUID).not.toHaveBeenCalled();
    expect(fastQuery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("AND subject = $1"),
      ["user_workos"],
    );
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("rechecks after locking when another first login has already created the identity", async () => {
    existingOwner = ownerId;
    fastQuery.mockResolvedValueOnce({ rows: [] });
    expect(await resolveWorkOSUserId({ id: "user_workos" })).toBe(ownerId);
    expect(randomUUID).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(
      query.mock.calls.some(([statement]) => statement.startsWith("INSERT")),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves opaque subject casing and whitespace", async () => {
    const subject = " User_WorkOS ";
    await resolveWorkOSUserId({ id: subject });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      [JSON.stringify(["workos", subject])],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("AND subject = $1"),
      [subject],
    );
    expect(fastQuery).toHaveBeenCalledWith(
      expect.stringContaining("AND subject = $1"),
      [subject],
    );
  });

  it.each([undefined, null, "", "legacy-clerk-owner", "unknown-external-id"])(
    "ignores externalId %s for new users and existing mappings",
    async (externalId) => {
      const user = {
        id: "user_workos",
        externalId,
        email: "same@example.test",
      };
      expect(await resolveWorkOSUserId(user)).toBe(ownerId);
      existingOwner = ownerId;
      expect(await resolveWorkOSUserId(user)).toBe(ownerId);
      const boundValues = [
        ...fastQuery.mock.calls,
        ...query.mock.calls,
      ].flatMap(([, values]) => values ?? []);
      expect(boundValues).not.toContain("same@example.test");
      if (externalId) expect(boundValues).not.toContain(externalId);
      expect(
        query.mock.calls.some(([statement]) => statement.includes("'clerk'")),
      ).toBe(false);
    },
  );

  it("retries UUID collisions instead of inheriting an existing owner", async () => {
    const collision = "1efb7947-1b51-42a6-84f7-cfe00a0f659f";
    randomUUID.mockReturnValueOnce(collision).mockReturnValueOnce(ownerId);
    const normalQuery = query.getMockImplementation()!;
    query.mockImplementation(async (statement: string, values?: string[]) => {
      if (
        statement.startsWith("INSERT INTO application_users") &&
        values?.[0] === collision
      )
        return { rows: [] };
      return normalQuery(statement, values);
    });
    expect(await resolveWorkOSUserId({ id: "user_workos" })).toBe(ownerId);
    expect(randomUUID).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("VALUES ('workos', $1, $2)"),
      ["user_workos", ownerId],
    );
  });

  it("rolls back a uniqueness conflict without returning the candidate owner", async () => {
    const normalQuery = query.getMockImplementation()!;
    query.mockImplementation(async (statement: string, values?: string[]) => {
      if (statement.startsWith("INSERT INTO auth_identities"))
        return { rows: [] };
      return normalQuery(statement, values);
    });
    await expect(
      resolveWorkOSUserId({ id: "user_workos" }),
    ).rejects.toBeInstanceOf(AuthIdentityError);
    expect(query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves database errors and releases the transaction even if rollback fails", async () => {
    const failure = new Error("database unavailable");
    query.mockRejectedValue(failure);
    await expect(resolveWorkOSUserId({ id: "user_workos" })).rejects.toBe(
      failure,
    );
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a missing subject before opening the database", async () => {
    await expect(resolveWorkOSUserId({ id: "" })).rejects.toBeInstanceOf(
      AuthIdentityError,
    );
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(fastQuery).not.toHaveBeenCalled();
  });
});
