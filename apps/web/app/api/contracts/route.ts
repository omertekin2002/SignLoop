import { NextResponse } from "next/server";
import { parseJsonBody, parsePaginationParams, requireUserId } from "@/lib/api-auth";
import { createContractForUser, listContractsByUserId } from "@/lib/server-db";
import { MAX_CONTRACT_SEARCH_LENGTH } from "@/lib/contract-search";
import { ProjectNotFoundError } from "@/lib/errors";
import { isUuid } from "@/lib/utils";

export async function GET(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { searchParams } = new URL(req.url);
  // A blank search is no search; a title search spans every contract, standalone or in a project.
  const search = searchParams.get("q")?.trim() || null;
  if (search && [...search].length > MAX_CONTRACT_SEARCH_LENGTH) {
    return NextResponse.json(
      { error: `Search must be at most ${MAX_CONTRACT_SEARCH_LENGTH} characters` },
      { status: 400 },
    );
  }

  const result = await listContractsByUserId(userId, parsePaginationParams(req), searchParams.get("standalone") === "true", search);
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

  // Validate projectId is a UUID (or absent) before it reaches the uuid-typed query, which would
  // otherwise throw 22P02 and surface as an unhandled 500.
  const projectId = body.projectId ?? null;
  if (projectId !== null && !isUuid(projectId)) {
    return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
  }

  try {
    const contract = await createContractForUser({ userId, title, projectId });

    return NextResponse.json(contract, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    throw error;
  }
}
