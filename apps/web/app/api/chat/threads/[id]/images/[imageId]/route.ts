import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { getChatImageForUser } from "@/lib/server-db";
import { isUuid } from "@/lib/utils";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; imageId: string }> }) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { id, imageId } = await params;
  if (!isUuid(id) || !isUuid(imageId)) return new Response(null, { status: 404 });
  const image = await getChatImageForUser(authed.userId, id, imageId);
  if (!image) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(image), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
