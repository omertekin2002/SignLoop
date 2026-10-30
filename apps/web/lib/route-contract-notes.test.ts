import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getContractNotesForUser, saveContractNotesForUser } = vi.hoisted(() => ({
  auth: vi.fn(),
  getContractNotesForUser: vi.fn(),
  saveContractNotesForUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({ getContractNotesForUser, saveContractNotesForUser }));

import { GET, PUT } from "@/app/api/contracts/[id]/notes/route";
import { CONTRACT_NOTE_MAX_CHARACTERS } from "@/lib/contract-notes";

const CONTRACT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const SAVED_AT = "2026-10-30T09:00:00.123Z";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const getRequest = () => new Request(`http://localhost/api/contracts/${CONTRACT_ID}/notes`);
const putRequest = (body: unknown) =>
  new Request(`http://localhost/api/contracts/${CONTRACT_ID}/notes`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const notes = {
  acceptanceReasons: "Rent is fixed for two years.",
  openQuestions: "Who repairs the boiler?",
};
const record = (overrides: Record<string, unknown> = {}) => ({
  contractId: CONTRACT_ID,
  ...notes,
  createdAt: SAVED_AT,
  updatedAt: SAVED_AT,
  ...overrides,
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/contracts/[id]/notes", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await GET(getRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getContractNotesForUser).not.toHaveBeenCalled();
  });

  it.each(["not-a-uuid", "../../etc/passwd", `${CONTRACT_ID}-extra`, ""])(
    "returns 404 for the id %j without querying the database",
    async (id) => {
      auth.mockResolvedValue({ userId: "owner" });

      const response = await GET(getRequest(), params(id));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Contract not found" });
      expect(getContractNotesForUser).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when the contract is missing or belongs to another user", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    getContractNotesForUser.mockResolvedValue(null);

    const response = await GET(getRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(getContractNotesForUser).toHaveBeenCalledWith("intruder", CONTRACT_ID);
  });

  it("returns empty notes with null timestamps before the first save", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    const unsaved = record({ acceptanceReasons: "", openQuestions: "", createdAt: null, updatedAt: null });
    getContractNotesForUser.mockResolvedValue(unsaved);

    const response = await GET(getRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(unsaved);
  });

  it("returns the owner's saved notes", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    getContractNotesForUser.mockResolvedValue(record());

    const response = await GET(getRequest(), params(CONTRACT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(record());
    expect(getContractNotesForUser).toHaveBeenCalledWith("owner", CONTRACT_ID);
  });
});

describe("PUT /api/contracts/[id]/notes", () => {
  it("returns 401 without touching the database when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await PUT(putRequest({ ...notes, expectedUpdatedAt: null }), params(CONTRACT_ID));

    expect(response.status).toBe(401);
    expect(saveContractNotesForUser).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed id without querying the database", async () => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await PUT(putRequest({ ...notes, expectedUpdatedAt: null }), params("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(saveContractNotesForUser).not.toHaveBeenCalled();
  });

  const tooLong = "a".repeat(CONTRACT_NOTE_MAX_CHARACTERS + 1);
  it.each([
    ["invalid JSON", "{"],
    ["an empty body", ""],
    ["a missing expectedUpdatedAt", notes],
    ["a missing note", { acceptanceReasons: "Fine", expectedUpdatedAt: null }],
    ["a non-string note", { ...notes, openQuestions: 3, expectedUpdatedAt: null }],
    ["an unknown field", { ...notes, expectedUpdatedAt: null, userId: "intruder" }],
    ["an expectedUpdatedAt that is not a timestamp", { ...notes, expectedUpdatedAt: "yesterday" }],
    ["acceptance reasons over the limit", { ...notes, acceptanceReasons: tooLong, expectedUpdatedAt: null }],
    ["open questions over the limit", { ...notes, openQuestions: tooLong, expectedUpdatedAt: null }],
    ["a NUL character, which PostgreSQL text cannot store", { ...notes, openQuestions: "a\u0000b", expectedUpdatedAt: null }],
  ])("returns 400 for %s without saving", async (_label, body) => {
    auth.mockResolvedValue({ userId: "owner" });

    const response = await PUT(putRequest(body), params(CONTRACT_ID));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(String(CONTRACT_NOTE_MAX_CHARACTERS));
    expect(saveContractNotesForUser).not.toHaveBeenCalled();
  });

  it("counts the limit in code points, as PostgreSQL's char_length does", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    saveContractNotesForUser.mockResolvedValue({ status: "saved", notes: record() });
    // Each emoji is two UTF-16 code units but one code point.
    const atLimit = "😀".repeat(CONTRACT_NOTE_MAX_CHARACTERS);

    const response = await PUT(
      putRequest({ acceptanceReasons: atLimit, openQuestions: "", expectedUpdatedAt: null }),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(200);
    expect(saveContractNotesForUser).toHaveBeenCalledWith(
      "owner",
      CONTRACT_ID,
      { acceptanceReasons: atLimit, openQuestions: "" },
      null,
    );
  });

  it("returns 404 when the contract is missing or belongs to another user", async () => {
    auth.mockResolvedValue({ userId: "intruder" });
    saveContractNotesForUser.mockResolvedValue({ status: "not_found" });

    const response = await PUT(putRequest({ ...notes, expectedUpdatedAt: null }), params(CONTRACT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
    expect(saveContractNotesForUser).toHaveBeenCalledWith("intruder", CONTRACT_ID, notes, null);
  });

  it("returns 409 with the stored notes when another save overtook this one", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    const newer = record({ openQuestions: "Saved in another tab", updatedAt: "2026-10-30T09:05:00.000Z" });
    saveContractNotesForUser.mockResolvedValue({ status: "conflict", notes: newer });

    const response = await PUT(
      putRequest({ ...notes, expectedUpdatedAt: SAVED_AT }),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.notes).toEqual(newer);
    expect(body.error).toMatch(/changed elsewhere/);
    expect(saveContractNotesForUser).toHaveBeenCalledWith("owner", CONTRACT_ID, notes, SAVED_AT);
  });

  it("saves the owner's notes and returns them with the new revision", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    const saved = record({ updatedAt: "2026-10-30T09:10:00.000Z" });
    saveContractNotesForUser.mockResolvedValue({ status: "saved", notes: saved });

    const response = await PUT(
      putRequest({ ...notes, expectedUpdatedAt: "2026-10-30T12:00:00.123+03:00" }),
      params(CONTRACT_ID),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(saved);
    expect(saveContractNotesForUser).toHaveBeenCalledWith(
      "owner",
      CONTRACT_ID,
      notes,
      "2026-10-30T12:00:00.123+03:00",
    );
  });

  it("lets a database failure reject instead of mapping it to a response", async () => {
    auth.mockResolvedValue({ userId: "owner" });
    saveContractNotesForUser.mockRejectedValue(new Error("connection lost"));

    await expect(
      PUT(putRequest({ ...notes, expectedUpdatedAt: null }), params(CONTRACT_ID)),
    ).rejects.toThrow("connection lost");
  });
});
