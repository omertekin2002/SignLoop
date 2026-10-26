import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPayloadFromClientToken } from "@vercel/blob/client";

const {
  auth,
  createDirectUploadIntent,
  getContractMetaForUser,
  isProjectOwnedByUser,
  blobHead,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  createDirectUploadIntent: vi.fn(),
  getContractMetaForUser: vi.fn(),
  isProjectOwnedByUser: vi.fn(),
  blobHead: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/server-db", () => ({
  createDirectUploadIntent,
  getContractMetaForUser,
  isProjectOwnedByUser,
}));
// handleUpload is real: it signs the token locally, so the test can decode what the browser gets.
vi.mock("@vercel/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/blob")>()),
  head: blobHead,
}));

import { BlobNotFoundError } from "@vercel/blob";
import { GET, POST } from "@/app/api/uploads/route";

const CONTRACT_ID = "11e3e947-f71f-4ecd-a901-adbf24edbb8a";
const PROJECT_ID = "5b7d7f63-8f61-4a52-9d6f-3a0c1b2e4d10";
const PATHNAME = "uploads/0b6c3c1e-8d7a-4f2b-9c1d-2e3f4a5b6c7d";
const INTENT_ID = "33e3e947-f71f-4ecd-a901-adbf24edbb8a";

const tokenRequest = (
  payload: { pathname?: string; clientPayload?: string | null; multipart?: boolean } = {},
  type = "blob.generate-client-token",
) =>
  new Request("http://localhost/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type,
      payload: {
        pathname: PATHNAME,
        clientPayload: JSON.stringify({ contractId: CONTRACT_ID }),
        multipart: false,
        ...payload,
      },
    }),
  });

beforeEach(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore_secret");
  vi.stubEnv("BLOB_ACCESS", "");
  auth.mockResolvedValue({ userId: "owner" });
  getContractMetaForUser.mockResolvedValue({ id: CONTRACT_ID });
  isProjectOwnedByUser.mockResolvedValue(true);
  blobHead.mockRejectedValue(new BlobNotFoundError());
  createDirectUploadIntent.mockResolvedValue({ id: INTENT_ID });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/uploads", () => {
  it("returns 401 when signed out", async () => {
    auth.mockResolvedValue({ userId: null });

    expect((await GET()).status).toBe(401);
  });

  it("offers private direct uploads up to 10 MiB when Blob has a read-write token", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      directUpload: { access: "private" },
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
  });

  it("follows a public store's access setting", async () => {
    vi.stubEnv("BLOB_ACCESS", "public");

    expect(await (await GET()).json()).toMatchObject({
      directUpload: { access: "public" },
    });
  });

  it.each([
    ["local storage", {}],
    ["a store-ID (OIDC) Blob setup, which cannot sign client tokens", { BLOB_STORE_ID: "store" }],
  ])("keeps multipart uploads up to 4 MiB with %s", async (_label, env) => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    expect(await (await GET()).json()).toEqual({
      directUpload: null,
      maxFileSizeBytes: 4 * 1024 * 1024,
    });
  });
});

describe("POST /api/uploads", () => {
  it("records the cleanup intent, then issues a token bound to the pathname and limits", async () => {
    const before = Date.now();
    const response = await POST(tokenRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { type: string; clientToken: string };
    expect(body.type).toBe("blob.generate-client-token");
    expect(createDirectUploadIntent).toHaveBeenCalledExactlyOnceWith({
      userId: "owner",
      pathname: PATHNAME,
      cleanupKey: `blob:${PATHNAME}`,
      target: { kind: "contract", id: CONTRACT_ID },
    });
    expect(getContractMetaForUser).toHaveBeenCalledExactlyOnceWith("owner", CONTRACT_ID);
    expect(blobHead).toHaveBeenCalledExactlyOnceWith(PATHNAME, expect.anything());

    const token = getPayloadFromClientToken(body.clientToken);
    expect(token).toMatchObject({
      pathname: PATHNAME,
      maximumSizeInBytes: 10 * 1024 * 1024,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(token.allowedContentTypes).toEqual(
      expect.arrayContaining([
        "application/pdf",
        "text/plain",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/png",
        "application/octet-stream",
      ]),
    );
    expect(token.allowedContentTypes).not.toContain("text/html");
    expect(token.allowedContentTypes).not.toContain("image/svg+xml");
    expect(token.validUntil).toBeGreaterThan(before);
    expect(token.validUntil).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
    // No completion callback: the finalize request saves the file.
    expect(token.onUploadCompleted).toBeUndefined();
  });

  it("issues a token for the owner's project", async () => {
    const response = await POST(
      tokenRequest({ clientPayload: JSON.stringify({ projectId: PROJECT_ID }) }),
    );

    expect(response.status).toBe(200);
    expect(isProjectOwnedByUser).toHaveBeenCalledExactlyOnceWith("owner", PROJECT_ID);
    expect(createDirectUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "project", id: PROJECT_ID } }),
    );
  });

  it("issues no token when the cleanup intent cannot be recorded", async () => {
    createDirectUploadIntent.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(tokenRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Could not start the upload. Please try again.",
    });
  });

  it("returns 401 for unauthenticated callers before reading the body", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await POST(tokenRequest());

    expect(response.status).toBe(401);
    expect(createDirectUploadIntent).not.toHaveBeenCalled();
  });

  it("returns 404 when Blob client uploads are not configured", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    const response = await POST(tokenRequest());

    expect(response.status).toBe(404);
    expect(createDirectUploadIntent).not.toHaveBeenCalled();
  });

  it.each([
    ["another owner's contract", { contractId: CONTRACT_ID }, "Contract not found"],
    ["another owner's project", { projectId: PROJECT_ID }, "Project not found"],
  ])("returns 404 for %s without recording anything", async (_label, payload, error) => {
    auth.mockResolvedValue({ userId: "intruder" });
    getContractMetaForUser.mockResolvedValue(null);
    isProjectOwnedByUser.mockResolvedValue(false);

    const response = await POST(
      tokenRequest({ clientPayload: JSON.stringify(payload) }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error });
    expect(blobHead).not.toHaveBeenCalled();
    expect(createDirectUploadIntent).not.toHaveBeenCalled();
  });

  it("returns 404 when the target is deleted between the check and the intent", async () => {
    createDirectUploadIntent.mockResolvedValue(null);

    const response = await POST(tokenRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Contract not found" });
  });

  it.each([
    ["an owner-scoped path", "contracts/owner/lease.pdf"],
    ["a filename suffix", `${PATHNAME}.pdf`],
    ["a nested path", `${PATHNAME}/x`],
    ["a traversal", `uploads/../${PATHNAME.slice(8)}`],
    ["an uppercase UUID", PATHNAME.toUpperCase().replace("UPLOADS", "uploads")],
    ["an empty pathname", ""],
  ])("rejects a client-chosen pathname with %s", async (_label, pathname) => {
    const response = await POST(tokenRequest({ pathname }));

    expect(response.status).toBe(400);
    expect(createDirectUploadIntent).not.toHaveBeenCalled();
  });

  it.each([
    ["no client payload", null],
    ["malformed JSON", "{"],
    ["a non-UUID contract", JSON.stringify({ contractId: "../x" })],
    ["both targets", JSON.stringify({ contractId: CONTRACT_ID, projectId: PROJECT_ID })],
    ["an unknown target", JSON.stringify({ threadId: CONTRACT_ID })],
  ])("rejects %s", async (_label, clientPayload) => {
    const response = await POST(tokenRequest({ clientPayload }));

    expect(response.status).toBe(400);
    expect(getContractMetaForUser).not.toHaveBeenCalled();
    expect(createDirectUploadIntent).not.toHaveBeenCalled();
  });

  it("rejects multipart client uploads", async () => {
    const response = await POST(tokenRequest({ multipart: true }));

    expect(response.status).toBe(400);
    expect(createDirectUploadIntent).not.toHaveBeenCalled();
  });

  it("rejects upload-completed callbacks and other event types", async () => {
    for (const type of ["blob.upload-completed", "other"]) {
      const response = await POST(tokenRequest({}, type));
      expect(response.status).toBe(400);
    }
    expect(createDirectUploadIntent).not.toHaveBeenCalled();
  });

  it("refuses a pathname that already holds a blob, so no intent can delete it", async () => {
    blobHead.mockResolvedValue({ pathname: PATHNAME });

    const response = await POST(tokenRequest());

    expect(response.status).toBe(409);
    expect(createDirectUploadIntent).not.toHaveBeenCalled();
  });

  it("refuses a pathname with another unclaimed token", async () => {
    createDirectUploadIntent.mockResolvedValue("conflict");

    const response = await POST(tokenRequest());

    expect(response.status).toBe(409);
  });

  it("fails closed when Blob cannot say whether the pathname is free", async () => {
    blobHead.mockRejectedValue(new Error("Blob unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(tokenRequest());

    expect(response.status).toBe(500);
    expect(createDirectUploadIntent).not.toHaveBeenCalled();
  });
});
