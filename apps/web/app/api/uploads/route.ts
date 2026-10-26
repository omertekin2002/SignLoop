import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserId } from "@/lib/api-auth";
import {
  blobExists,
  getBlobAccess,
  getUploadCleanupKey,
  isDirectUploadAvailable,
} from "@/lib/object-storage";
import {
  createDirectUploadIntent,
  getContractMetaForUser,
  isProjectOwnedByUser,
  type DirectUploadTarget,
} from "@/lib/server-db";
import { DECLARABLE_UPLOAD_MIME_TYPES } from "@/lib/text-extraction";
import {
  DIRECT_UPLOAD_PATHNAME,
  MAX_DIRECT_UPLOAD_FILE_SIZE,
  MAX_MULTIPART_UPLOAD_FILE_SIZE,
} from "@/lib/upload-constants";
import { isUuid } from "@/lib/utils";

// Long enough to start one upload; finalize must still claim the blob within the intent's hour.
const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

const clientPayloadSchema = z.union([
  z.object({ contractId: z.string().refine(isUuid) }).strict(),
  z.object({ projectId: z.string().refine(isUuid) }).strict(),
]);

class TokenRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** How the browser should upload contracts and project documents, and the size limit it has. */
export async function GET() {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const direct = isDirectUploadAvailable();
  return NextResponse.json(
    {
      directUpload: direct ? { access: getBlobAccess() } : null,
      maxFileSizeBytes: direct
        ? MAX_DIRECT_UPLOAD_FILE_SIZE
        : MAX_MULTIPART_UPLOAD_FILE_SIZE,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Issue a client token for one direct-to-Blob upload into the caller's own contract or project.
 * The cleanup intent is recorded before the token exists, so an upload that is never finalized is
 * deleted by the storage outbox. No upload-completed callback is registered: the finalize request
 * to the upload route is what saves the file.
 */
export async function POST(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;
  if (!isDirectUploadAvailable()) {
    return NextResponse.json(
      { error: "Direct uploads are not configured." },
      { status: 404 },
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Invalid upload request" }, { status: 400 });
  }
  if (body?.type !== "blob.generate-client-token") {
    return NextResponse.json({ error: "Invalid upload request" }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
        if (multipart || !DIRECT_UPLOAD_PATHNAME.test(pathname)) {
          throw new TokenRefusal(400, "Invalid upload request");
        }
        let target: DirectUploadTarget;
        try {
          const payload = clientPayloadSchema.parse(
            JSON.parse(clientPayload ?? ""),
          );
          target =
            "contractId" in payload
              ? { kind: "contract", id: payload.contractId }
              : { kind: "project", id: payload.projectId };
        } catch {
          throw new TokenRefusal(400, "Invalid upload request");
        }

        const owned =
          target.kind === "contract"
            ? Boolean(await getContractMetaForUser(userId, target.id))
            : await isProjectOwnedByUser(userId, target.id);
        if (!owned) {
          throw new TokenRefusal(
            404,
            target.kind === "contract" ? "Contract not found" : "Project not found",
          );
        }
        // allowOverwrite: false stops the upload from replacing an existing blob, but an intent
        // for a taken pathname would later delete that blob, so refuse the token instead.
        if (await blobExists(pathname, req.signal)) {
          throw new TokenRefusal(409, "Upload path is already in use.");
        }
        const intent = await createDirectUploadIntent({
          userId,
          pathname,
          cleanupKey: getUploadCleanupKey(pathname),
          target,
        });
        if (intent === "conflict") {
          throw new TokenRefusal(409, "Upload path is already in use.");
        }
        if (!intent) {
          throw new TokenRefusal(
            404,
            target.kind === "contract" ? "Contract not found" : "Project not found",
          );
        }

        return {
          allowedContentTypes: [...DECLARABLE_UPLOAD_MIME_TYPES],
          maximumSizeInBytes: MAX_DIRECT_UPLOAD_FILE_SIZE,
          validUntil: Date.now() + TOKEN_LIFETIME_MS,
          addRandomSuffix: false,
          allowOverwrite: false,
          tokenPayload: null,
        };
      },
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error: unknown) {
    if (error instanceof TokenRefusal) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Upload token request failed:", error);
    return NextResponse.json(
      { error: "Could not start the upload. Please try again." },
      { status: 500 },
    );
  }
}
