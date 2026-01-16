import { NextResponse } from 'next/server';
import { db } from '@/lib/store';
import { analyzeText } from '@/lib/analysis';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contract = db.contracts.find((c) => c.id === id);
  
  if (!contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }

  if (!contract.text) {
    return NextResponse.json({ error: 'Contract has no text content. Upload a file first.' }, { status: 400 });
  }

  try {
    // Synchronous analysis for prototype
    const { result, model } = await analyzeText(contract.text);
    
    const analysisRecord = {
      id: crypto.randomUUID(),
      contractId: contract.id,
      riskBadge: result.risk_badge,
      resultJson: result,
      llmModel: model,
      createdAt: new Date().toISOString(),
    };

    if (!contract.analyses) contract.analyses = [];
    contract.analyses.unshift(analysisRecord);
    contract.latestAnalysis = analysisRecord;
    contract.status = 'ANALYZED';

    return NextResponse.json({ message: 'Analysis complete', jobId: 'done' });
  } catch (error: any) {
    console.error('Analysis error:', error);
    return NextResponse.json({ error: error.message || 'Analysis failed' }, { status: 500 });
  }
}