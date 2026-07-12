import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import {
  deleteProjectForUser,
  getProjectByIdForUser,
  getProjectStorageKeys,
} from "@/lib/server-db";
import { deleteObjects } from "@/lib/object-storage";
import { isUuid } from "@/lib/utils";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const project = await getProjectByIdForUser(userId, id);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Delete storage objects while DB references still exist, so a crash
  // between storage and DB cleanup leaves retryable DB records rather
  // than permanently orphaned files.
  const storageKeys = await getProjectStorageKeys(userId, id);
  try {
    await deleteObjects(storageKeys);
  } catch (error: unknown) {
    console.error(
      "Failed to delete project storage before database cleanup:",
      error,
    );
    return NextResponse.json(
      { error: "Could not remove every project file. Please retry." },
      { status: 502 },
    );
  }

  const result = await deleteProjectForUser({ userId, projectId: id });

  if (!result.deleted) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
