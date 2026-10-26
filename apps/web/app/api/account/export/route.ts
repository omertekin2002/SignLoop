import { NextResponse } from "next/server";
import { createAccountExport, exportFileName } from "@/lib/account-export";
import { requireUserId } from "@/lib/api-auth";
import { getAccountExportForUser } from "@/lib/server-db";

// The ZIP streams, so its size is not bound by Vercel's 4.5 MB limit on buffered responses; the
// download must finish within the function's duration instead.
export const maxDuration = 300;

/** Download everything the signed-in owner keeps in SignLoop as one streamed ZIP. */
export async function GET(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;

  let data;
  try {
    data = await getAccountExportForUser(authed.userId);
  } catch (error) {
    console.error("Failed to read account export:", error);
    return NextResponse.json({ error: "Failed to export your data" }, { status: 500 });
  }

  const exportedAt = new Date();
  const body = createAccountExport({
    userId: authed.userId,
    data,
    exportedAt,
    signal: req.signal,
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${exportFileName(exportedAt)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
