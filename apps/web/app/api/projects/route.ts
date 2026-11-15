import { NextResponse } from "next/server";
import { parseJsonBody, parsePaginationParams, requireUserId } from "@/lib/api-auth";
import { createProjectForUser, listProjectsByUserId } from "@/lib/server-db";
import { MAX_CONTRACT_SEARCH_LENGTH } from "@/lib/contract-search";

export async function GET(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { searchParams } = new URL(req.url);
  // A blank search is no search; a title search spans every page of the owner's projects.
  const search = searchParams.get("q")?.trim() || null;
  if (search && [...search].length > MAX_CONTRACT_SEARCH_LENGTH) {
    return NextResponse.json(
      { error: `Search must be at most ${MAX_CONTRACT_SEARCH_LENGTH} characters` },
      { status: 400 },
    );
  }

  const result = await listProjectsByUserId(userId, parsePaginationParams(req), search);
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const body = await parseJsonBody<{ title?: string; description?: string }>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
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
