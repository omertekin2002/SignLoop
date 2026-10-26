import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { getAnalysisForUser, getContractSourceForUser } from "@/lib/server-db";
import {
  citationForReport,
  JURISDICTION_CITATION,
  SOURCE_PAGE_SIZE,
  SourceRevisionSchema,
} from "@/lib/source-citations";
import { isUuid } from "@/lib/utils";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const reply = (body: unknown, status = 200) =>
    NextResponse.json(body, {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "Contract not found" }, 404);
  const query = new URL(req.url).searchParams;
  const offsetValue = query.get("offset") ?? "0";
  const analysisId = query.get("analysisId");
  const flag = query.get("flag");
  const revision = query.get("revision");
  if (
    [...query.keys()].some(
      (key) =>
        !["offset", "revision", "analysisId", "flag"].includes(key) ||
        query.getAll(key).length !== 1,
    ) ||
    !/^\d{1,10}$/.test(offsetValue) ||
    Number(offsetValue) > 2_147_483_646 ||
    (revision !== null && !SourceRevisionSchema.safeParse(revision).success) ||
    (analysisId !== null && !isUuid(analysisId)) ||
    (analysisId === null) !== (flag === null) ||
    // A red flag's index, or the governing-law quotation behind the jurisdiction proposal.
    (flag !== null && flag !== JURISDICTION_CITATION && !/^\d{1,5}$/.test(flag))
  )
    return reply({ error: "Invalid source request" }, 400);

  const offset = Number(offsetValue);
  let citation = null;
  if (analysisId && flag !== null) {
    const analysis = await getAnalysisForUser(authed.userId, id, analysisId);
    if (!analysis) return reply({ error: "Analysis no longer available" }, 404);
    citation = citationForReport(
      analysis.resultJson,
      id,
      flag === JURISDICTION_CITATION ? JURISDICTION_CITATION : Number(flag),
    );
    if (!citation || citation.revision !== revision)
      return reply(
        { error: "Verified source quotation unavailable for this finding" },
        422,
      );
  }
  const source = await getContractSourceForUser({
    userId: authed.userId,
    contractId: id,
    offset,
    revision,
    ...(analysisId ? { analysisId } : {}),
    ...(citation ? { citation } : {}),
  });
  if (!source) return reply({ error: "Source no longer available" }, 404);
  if (revision !== null && source.revision !== revision)
    return reply(
      {
        error:
          "Source changed. The text used by this analysis is no longer available. Open the current source separately.",
      },
      409,
    );
  if (citation && !source.highlightMatches)
    return reply(
      {
        error:
          "This quotation could not be verified against the analyzed contract excerpt",
      },
      422,
    );
  if (offset > 0 && offset >= source.totalCharacters)
    return reply({ error: "Source page is out of range" }, 416);
  const end = offset + Array.from(source.text ?? "").length;
  return reply({
    contractId: id,
    revision: source.revision,
    text: source.text ?? "",
    offset,
    totalCharacters: source.totalCharacters,
    nextOffset: end < source.totalCharacters ? end : null,
    previousOffset: offset > 0 ? Math.max(0, offset - SOURCE_PAGE_SIZE) : null,
    extractionWarning: source.extractionWarning,
    highlight:
      citation && citation.start >= offset && citation.end <= end
        ? citation
        : null,
  });
}
