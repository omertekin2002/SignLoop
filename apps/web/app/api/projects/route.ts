import { NextResponse } from 'next/server';
import { auth } from "@clerk/nextjs/server";
import { createProjectForUser, listProjectsByUserId } from "@/lib/server-db";

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
  const offset = searchParams.get("offset") ? Number(searchParams.get("offset")) : undefined;

  const result = await listProjectsByUserId(userId, { limit, offset });
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { title?: string; description?: string };
  const title = typeof body.title === "string" ? body.title.trim() : "";

  if (!title) {
    return NextResponse.json({ error: "Project title is required" }, { status: 400 });
  }

  const project = await createProjectForUser({
    userId,
    title,
    description: typeof body.description === "string" ? body.description.trim() || null : null,
  });

  return NextResponse.json(project, { status: 201 });
}
