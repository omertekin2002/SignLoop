import { NextResponse } from "next/server";
import { parseJsonBody, requireUserId } from "@/lib/api-auth";
import {
  CONTRACT_NOTE_MAX_CHARACTERS,
  parseContractNotesUpdate,
} from "@/lib/contract-notes";
import {
  getContractNotesForUser,
  saveContractNotesForUser,
} from "@/lib/server-db";
import { isUuid } from "@/lib/utils";

/**
 * The owner's personal decision notes for a contract. Before the first save they are empty, with
 * null `createdAt` and `updatedAt`.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  const notes = await getContractNotesForUser(userId, id);
  if (!notes) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  return NextResponse.json(notes);
}

/**
 * Save the notes: `{ "acceptanceReasons": string, "openQuestions": string, "expectedUpdatedAt":
 * string | null }`, where `expectedUpdatedAt` is the `updatedAt` last read. A save that another
 * save has overtaken returns 409 with the stored notes and changes nothing.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  const update = parseContractNotesUpdate(await parseJsonBody<unknown>(req));
  if (!update) {
    return NextResponse.json(
      {
        error: `Send { "acceptanceReasons": text, "openQuestions": text, "expectedUpdatedAt": the updatedAt you last read, or null } with each note at most ${CONTRACT_NOTE_MAX_CHARACTERS} characters.`,
      },
      { status: 400 },
    );
  }

  const { expectedUpdatedAt, ...notes } = update;
  const result = await saveContractNotesForUser(userId, id, notes, expectedUpdatedAt);
  switch (result.status) {
    case "not_found":
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    case "conflict":
      return NextResponse.json(
        {
          error: "These notes were changed elsewhere. Reload them before saving again.",
          notes: result.notes,
        },
        { status: 409 },
      );
    case "saved":
      return NextResponse.json(result.notes);
  }
}
