import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { isUuid } from "@/lib/utils";
import { analyzeText } from "@/lib/analysis";
import {
  createAnalysisForContract,
  getContractWithLatestAnalysisForUser,
  getProjectContextForAnalysis,
  getUserSettingsByUserId,
} from "@/lib/server-db";
import { ContractRevisionChangedError } from "@/lib/errors";
import {
  getModelAvailabilitySnapshot,
  resolveAvailablePrimaryModel,
} from "@/lib/model-settings";

export async function POST(
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
  const force = new URL(req.url).searchParams.get("force") === "true";

  const contract = await getContractWithLatestAnalysisForUser(userId, id);

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (!contract.text?.trim()) {
    return NextResponse.json(
      { error: "Contract has no text content. Upload a file first." },
      { status: 400 },
    );
  }

  // Idempotency: reuse an existing result only while the contract is still ANALYZED. Re-uploading
  // text marks it DRAFT, so historical results must not block analysis of the new revision.
  if (!force && contract.status === "ANALYZED" && contract.latestAnalysis) {
    return NextResponse.json({
      message: "Analysis already exists",
      jobId: "done",
      analysisId: contract.latestAnalysis.id,
    });
  }

  try {
    const [settings, contextDocuments, modelSnapshot] = await Promise.all([
      getUserSettingsByUserId(userId),
      contract.projectId
        ? getProjectContextForAnalysis(userId, contract.projectId)
        : Promise.resolve([]),
      getModelAvailabilitySnapshot({ forceRefresh: true }),
    ]);
    const selectedPrimaryModel = resolveAvailablePrimaryModel(
      settings?.primaryModel,
      modelSnapshot.availablePrimaryModels,
    );
    const { result, provider, model } = await analyzeText(
      contract.text,
      undefined,
      {
        primaryModel: selectedPrimaryModel,
        signal: req.signal,
        contextDocuments: contextDocuments.map((document) => ({
          title: document.title,
          documentType: document.documentType,
          text: document.extractedText,
          originalCharacterCount: document.originalCharacterCount,
        })),
      },
    );
    const created = await createAnalysisForContract({
      userId,
      contractId: contract.id,
      expectedRevision: contract.revision,
      riskBadge:
        typeof result.risk_badge === "string" ? result.risk_badge : null,
      resultJson: result as Record<string, unknown>,
      llmProvider: provider ?? null,
      llmModel: model ?? null,
    });

    return NextResponse.json({
      message: "Analysis complete",
      jobId: "done",
      analysisId: created.id,
    });
  } catch (error: unknown) {
    if (error instanceof ContractRevisionChangedError) {
      return NextResponse.json(
        {
          error:
            "The contract changed while analysis was running. Please analyze it again.",
        },
        { status: 409 },
      );
    }
    console.error("Analysis error:", error);
    return NextResponse.json(
      { error: "Analysis failed. Please try again." },
      { status: 500 },
    );
  }
}
