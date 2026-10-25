import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { getChatFileForUser } from "@/lib/server-db";
import { isUuid } from "@/lib/utils";

/** Serve a thread owner's original file bytes as a private, non-cacheable download. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { id, fileId } = await params;
  if (!isUuid(id) || !isUuid(fileId))
    return new Response(null, { status: 404 });
  const file = await getChatFileForUser(authed.userId, id, fileId);
  if (!file) return new Response(null, { status: 404 });
  const encodedName = encodeURIComponent(file.name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16)}`,
  );
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mediaType,
      "Content-Disposition": `attachment; filename="document.${
        file.name
          .split(".")
          .at(-1)
          ?.replace(/[^a-z0-9]/gi, "") || "txt"
      }"; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
