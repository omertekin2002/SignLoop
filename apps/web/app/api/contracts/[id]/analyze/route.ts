import { operationProgressResponse } from "@/lib/operation-progress-response";
import { type ReportProgress } from "@/lib/operation-progress";
import { NextResponse, after } from "next/server";
import { requireUserId } from "@/lib/api-auth";
import { isUuid } from "@/lib/utils";
import { finalizeAnalysisResult } from "@/lib/analysis-sources";
import { analyzeText } from "@/lib/analysis";
import { admissionRejectedResponse, admitAnalysis } from "@/lib/chat-admission";
import {
  rateLimitHeaders,
  type AccountQuota,
  type AdmissionReason,
} from "@/lib/inference-policy";
import {
  claimGenerationOperation,
  createAnalysisForContract,
  getContractAnalysisGateForUser,
  getContractWithLatestAnalysisForUser,
  getProjectContextForAnalysis,
  getUserSettingsByUserId,
} from "@/lib/server-db";
import { ContractRevisionChangedError } from "@/lib/errors";
import { GenerationTimings } from "@/lib/generation-timings";
import {
  getModelAvailabilitySnapshot,
  resolveAvailablePrimaryModel,
} from "@/lib/model-settings";

// Reserve 30 seconds of the route budget for persistence and response completion.
export const maxDuration = 300;
const OPERATION_TIMEOUT_MS = 270_000;
// A long contract's section and merge calls stop this long before the operation deadline, so its
// partial result, with coverage notices for the sections that missed it, can still be stored.
const ANALYSIS_DEADLINE_MARGIN_MS = 10_000;

const ADMISSION_REJECTIONS: Record<AdmissionReason, string> = {
  busy: "Analysis is waiting for other requests to finish. Please try again shortly.",
  hourly:
    "Analysis and chat share an hourly usage limit. Please try again later.",
  daily: "Analysis is at its daily request limit. Please try again later.",
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return operationProgressResponse(req, (request, report) =>
    executePost(request, { params }, report),
  );
}

async function executePost(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  progress?: ReportProgress,
) {
  const timings = new GenerationTimings("analysis");
  timings.enabled = true;
  let operationSignal = req.signal;
  try {
    const authed = await timings.measure("auth", () => requireUserId());
    if (authed instanceof NextResponse) return authed;
    const { userId } = authed;

    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { error: "Contract not found" },
        { status: 404 },
      );
    }
    const force = new URL(req.url).searchParams.get("force") === "true";

    // Reuse a current result before taking the lease or reading the contract body. Re-uploading
    // marks the contract DRAFT, so a historical analysis does not block the new revision.
    if (!force) {
      const gate = await timings.measure("gate", () =>
        getContractAnalysisGateForUser(userId, id),
      );
      if (!gate) {
        return NextResponse.json(
          { error: "Contract not found" },
          { status: 404 },
        );
      }
      if (!gate.hasText) {
        return NextResponse.json(
          { error: "Contract has no text content. Upload a file first." },
          { status: 400 },
        );
      }
      if (gate.status === "ANALYZED" && gate.latestAnalysisId) {
        timings.outcome = "reused";
        return NextResponse.json({
          message: "Analysis already exists",
          jobId: "done",
          analysisId: gate.latestAnalysisId,
        });
      }
    }

    const release = await timings.measure("lease", () =>
      claimGenerationOperation(userId, "contract", id, 360),
    );
    if (!release)
      return NextResponse.json(
        { error: "Analysis is already running for this contract." },
        { status: 409 },
      );
    const startedAt = Date.now();
    operationSignal = AbortSignal.any([
      req.signal,
      AbortSignal.timeout(OPERATION_TIMEOUT_MS),
    ]);
    let releaseAdmission: (() => Promise<void>) | undefined;
    let quota: AccountQuota | undefined;
    try {
      const contract = await timings.measure("contract", () =>
        getContractWithLatestAnalysisForUser(userId, id),
      );

      if (!contract) {
        return NextResponse.json(
          { error: "Contract not found" },
          { status: 404 },
        );
      }

      if (!contract.text?.trim()) {
        return NextResponse.json(
          { error: "Contract has no text content. Upload a file first." },
          { status: 400 },
        );
      }
      const contractText = contract.text;
      const projectId = contract.projectId;

      // The gate ran before the lease. A result committed in between should still be reused.
      if (!force && contract.status === "ANALYZED" && contract.latestAnalysis) {
        timings.outcome = "reused";
        return NextResponse.json({
          message: "Analysis already exists",
          jobId: "done",
          analysisId: contract.latestAnalysis.id,
        });
      }

      try {
        try {
          const admission = await timings.measure("admission", () =>
            admitAnalysis(userId),
          );
          if ("retryAfter" in admission) {
            return admissionRejectedResponse(
              admission,
              ADMISSION_REJECTIONS[admission.reason],
            );
          }
          releaseAdmission = admission.release;
          quota = admission.quota;
        } catch {
          return NextResponse.json(
            {
              error:
                "Analysis is temporarily unavailable. Please try again shortly.",
            },
            { status: 503 },
          );
        }
        progress?.("preparing", rateLimitHeaders(quota));
        if (progress) operationSignal.throwIfAborted();
        const [settings, contextDocuments, modelSnapshot] = await Promise.all([
          timings.measure("settings", () => getUserSettingsByUserId(userId)),
          projectId
            ? timings.measure("context", () =>
                getProjectContextForAnalysis(userId, projectId),
              )
            : Promise.resolve([]),
          timings.measure("model_discovery", () =>
            getModelAvailabilitySnapshot({
              deferRefresh: (refresh) => after(refresh),
              onSource: (source) => {
                timings.discoverySource = source;
              },
            }),
          ),
        ]);
        const selectedPrimaryModel = resolveAvailablePrimaryModel(
          settings?.primaryModel,
          modelSnapshot.availablePrimaryModels,
        );
        // The jurisdiction the owner confirmed reaches both the prompt and finalization, so they
        // agree on whether comparisons may be requested and kept. Without one, nothing changes:
        // finalization withholds regional comparisons.
        const region = contract.confirmedJurisdiction ?? undefined;
        if (progress) operationSignal.throwIfAborted();
        progress?.("analyzing");
        timings.outcome = "error";
        const { result, provider, model, promptTokens, completionTokens } =
          await timings.measure("generation", () =>
            analyzeText(contractText, region ? { region } : undefined, {
              primaryModel: selectedPrimaryModel,
              signal: operationSignal,
              deadline:
                startedAt + OPERATION_TIMEOUT_MS - ANALYSIS_DEADLINE_MARGIN_MS,
              contextDocuments: contextDocuments.map((document) => ({
                title: document.title,
                documentType: document.documentType,
                text: document.extractedText,
                originalCharacterCount: document.originalCharacterCount,
              })),
            }),
          );
        timings.mark("generation_complete");
        const finalizedResult = finalizeAnalysisResult(
          result,
          {
            id: contract.id,
            text: contractText,
            extractionWarning: contract.extractionWarning,
            region: region ?? null,
          },
          contextDocuments,
        );
        if (progress) operationSignal.throwIfAborted();
        progress?.("saving");
        const created = await timings.measure("persistence", async () =>
          createAnalysisForContract({
            userId,
            contractId: contract.id,
            expectedRevision: contract.revision,
            riskBadge:
              typeof result.risk_badge === "string" ? result.risk_badge : null,
            resultJson: finalizedResult,
            llmProvider: provider ?? null,
            llmModel: model ?? null,
            llmPromptTokens: promptTokens,
            llmCompletionTokens: completionTokens,
            processingTimeMs: Date.now() - startedAt,
          }),
        );

        timings.outcome = "success";
        timings.mark("response_ready");

        return NextResponse.json(
          {
            message: "Analysis complete",
            jobId: "done",
            analysisId: created.id,
          },
          { headers: rateLimitHeaders(quota) },
        );
      } catch (error: unknown) {
        timings.outcome = "error";
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
    } finally {
      const endRelease = timings.start("release");
      await releaseAdmission?.().catch((error) =>
        console.error("Analysis admission release failed", error),
      );
      await release().catch((error) =>
        console.error("Analysis lease release failed", error),
      );
      endRelease();
    }
  } catch (error) {
    timings.outcome = "error";
    throw error;
  } finally {
    timings.finish(
      timings.outcome !== "success" &&
        timings.outcome !== "reused" &&
        operationSignal.aborted,
    );
  }
}
