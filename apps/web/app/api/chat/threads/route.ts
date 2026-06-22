import { NextResponse } from "next/server";
import { parseJsonBody, requireUserId } from "@/lib/api-auth";
import {
  createChatThreadForUser,
  listChatThreadsByUserId,
} from "@/lib/server-db";

export async function GET(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  try {
    const { searchParams } = new URL(req.url);
    const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
    const offset = searchParams.get("offset") ? Number(searchParams.get("offset")) : undefined;

    const result = await listChatThreadsByUserId(userId, { limit, offset });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to list chat threads:", error);
    return NextResponse.json({ error: "Failed to list chat threads" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  try {
    const payload = (await parseJsonBody<{ title?: string }>(req)) ?? {};
    const title = typeof payload.title === "string" ? payload.title : undefined;

    const created = await createChatThreadForUser({ userId, title });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    console.error("Failed to create chat thread:", error);
    return NextResponse.json({ error: "Failed to create chat thread" }, { status: 500 });
  }
}
