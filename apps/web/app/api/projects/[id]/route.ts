import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { deleteProjectForUser, getProjectByIdForUser } from "@/lib/server-db";
import { deleteObject } from "@/lib/object-storage";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const project = await getProjectByIdForUser(userId, id);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await deleteProjectForUser({ userId, projectId: id });

  if (!result.deleted) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  await Promise.allSettled(result.storageKeys.map((key) => deleteObject(key)));
  return NextResponse.json({ success: true });
}
