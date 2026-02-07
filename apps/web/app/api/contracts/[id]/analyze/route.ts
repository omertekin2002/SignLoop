import { NextResponse } from 'next/server';
import { auth } from "@clerk/nextjs/server";
import { analyzeText } from '@/lib/analysis';
import {
  createAnalysisForContract,
  getContractByIdForUser,
  getUserSettingsByUserId,
} from "@/lib/server-db";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const contract = await getContractByIdForUser(userId, id);
  
  if (!contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }

  if (!contract.text) {
    return NextResponse.json({ error: 'Contract has no text content. Upload a file first.' }, { status: 400 });
  }

  try {
    const settings = await getUserSettingsByUserId(userId);
    const { result, provider, model } = await analyzeText(contract.text, undefined, {
      primaryModel: settings?.primaryModel ?? null,
    });
    await createAnalysisForContract({
      userId,
      contractId: contract.id,
      riskBadge: typeof result.risk_badge === "string" ? result.risk_badge : null,
      resultJson: result as Record<string, unknown>,
      llmProvider: provider ?? null,
      llmModel: model ?? null,
    });

    return NextResponse.json({ message: 'Analysis complete', jobId: 'done' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Analysis failed";
    console.error('Analysis error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
