import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  createChatThreadForUser,
  listChatThreadsByUserId,
} from "@/lib/server-db";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const threads = await listChatThreadsByUserId(userId);
    return NextResponse.json({ data: threads });
  } catch (error) {
    console.error("Failed to list chat threads:", error);
    return NextResponse.json({ error: "Failed to list chat threads" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await req.json().catch(() => ({}));
    const title =
      payload && typeof payload.title === "string" ? payload.title : undefined;

    const created = await createChatThreadForUser({ userId, title });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    console.error("Failed to create chat thread:", error);
    return NextResponse.json({ error: "Failed to create chat thread" }, { status: 500 });
  }
}
