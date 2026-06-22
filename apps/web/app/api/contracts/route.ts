import { NextResponse } from "next/server";
import { parseJsonBody, requireUserId } from "@/lib/api-auth";
import { createContractForUser, listContractsByUserId } from "@/lib/server-db";

export async function GET(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { searchParams } = new URL(req.url);
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
  const offset = searchParams.get("offset") ? Number(searchParams.get("offset")) : undefined;

  const result = await listContractsByUserId(userId, { limit, offset });
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const body = await parseJsonBody<{ title?: string; projectId?: string | null }>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Untitled Contract";

  try {
    const contract = await createContractForUser({
      userId,
      title,
      projectId: body.projectId ?? null,
    });

    return NextResponse.json(contract, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Project not found") {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    throw error;
  }
}
