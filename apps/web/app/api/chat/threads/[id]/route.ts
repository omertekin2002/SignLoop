import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import {
  deleteChatThreadForUser,
  getChatThreadByIdForUser,
} from "@/lib/server-db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  try {
    const { id } = await params;
    const thread = await getChatThreadByIdForUser(userId, id);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    return NextResponse.json({ data: thread });
  } catch (error) {
    console.error("Failed to fetch chat thread:", error);
    return NextResponse.json({ error: "Failed to fetch chat thread" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  try {
    const { id } = await params;
    const deleted = await deleteChatThreadForUser({ userId, threadId: id });
    if (!deleted) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete chat thread:", error);
    return NextResponse.json({ error: "Failed to delete chat thread" }, { status: 500 });
  }
}
