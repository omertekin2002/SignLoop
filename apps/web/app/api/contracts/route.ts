import { NextResponse } from 'next/server';
import { auth } from "@clerk/nextjs/server";
import { createContractForUser, listContractsByUserId } from "@/lib/server-db";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contracts = await listContractsByUserId(userId);
  return NextResponse.json(contracts);
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { title?: string; projectId?: string | null };
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
