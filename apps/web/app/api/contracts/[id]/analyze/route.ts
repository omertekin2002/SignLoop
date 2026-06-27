import { NextResponse } from 'next/server';
import { requireUserId } from "@/lib/api-auth";
import { getErrorMessage, isUuid } from "@/lib/utils";
import { analyzeText } from '@/lib/analysis';
import {
  createAnalysisForContract,
  getContractWithLatestAnalysisForUser,
  getUserSettingsByUserId,
} from "@/lib/server-db";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }
  const force = new URL(req.url).searchParams.get("force") === "true";

  const contract = await getContractWithLatestAnalysisForUser(userId, id);

  if (!contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }

  if (!contract.text) {
    return NextResponse.json({ error: 'Contract has no text content. Upload a file first.' }, { status: 400 });
  }

  // Idempotency: unless the caller explicitly forces a re-run, reuse the existing analysis
  // instead of inserting a duplicate row (the previous behavior piled up duplicates per click).
  if (!force && contract.latestAnalysis) {
    return NextResponse.json({
      message: 'Analysis already exists',
      jobId: 'done',
      analysisId: contract.latestAnalysis.id,
    });
  }

  try {
    const settings = await getUserSettingsByUserId(userId);
    const { result, provider, model } = await analyzeText(contract.text, undefined, {
      primaryModel: settings?.primaryModel ?? null,
      signal: req.signal,
    });
    const created = await createAnalysisForContract({
      userId,
      contractId: contract.id,
      riskBadge: typeof result.risk_badge === "string" ? result.risk_badge : null,
      resultJson: result as Record<string, unknown>,
      llmProvider: provider ?? null,
      llmModel: model ?? null,
    });

    return NextResponse.json({ message: 'Analysis complete', jobId: 'done', analysisId: created.id });
  } catch (error: unknown) {
    const message = getErrorMessage(error, "Analysis failed");
    console.error('Analysis error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
