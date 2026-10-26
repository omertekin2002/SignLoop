import { after, NextResponse } from "next/server";
import { parseJsonBody, requireUserId } from "@/lib/api-auth";
import { parseJurisdictionUpdate } from "@/lib/regional-comparisons";
import {
  deleteContractForUser,
  getContractByIdForUser,
  setContractJurisdictionForUser,
} from "@/lib/server-db";
import { flushStorageDeletions } from "@/lib/storage-cleanup";
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
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  const contract = await getContractByIdForUser(
    userId,
    id,
    Number(new URL(req.url).searchParams.get("analysisOffset") ?? 0),
  );
  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  // The detail UI renders analysis metadata and never consumes the extracted source text.
  // Keep that potentially large, confidential payload server-side for the analysis route.
  return NextResponse.json(contract);
}

/**
 * Confirm, change, or clear the contract's jurisdiction: `{ "jurisdiction": string | null }`.
 * Analyses run afterwards receive it as their region; existing reports are left as they are.
 */
export async function PATCH(
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
  const update = parseJurisdictionUpdate(await parseJsonBody<unknown>(req));
  if (!update) {
    return NextResponse.json(
      {
        error:
          'Send { "jurisdiction": name } with a jurisdiction of at most 100 characters, or null to clear it.',
      },
      { status: 400 },
    );
  }

  const saved = await setContractJurisdictionForUser({
    userId,
    contractId: id,
    jurisdiction: update.jurisdiction,
  });
  if (!saved) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  return NextResponse.json(saved);
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
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  const result = await deleteContractForUser({ userId, contractId: id });

  if (!result.deleted) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  after(() => flushStorageDeletions().then(() => {}));
  return NextResponse.json({ success: true });
}
