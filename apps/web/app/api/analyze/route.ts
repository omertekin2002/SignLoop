import { NextRequest, NextResponse } from 'next/server';
import { analyzeText } from '@/lib/analysis';

export async function POST(req: NextRequest) {
    try {
        const { text, metadata } = await req.json();

        if (!text) {
            return NextResponse.json({ error: 'No text provided' }, { status: 400 });
        }

        const { result } = await analyzeText(text, metadata);
        return NextResponse.json({ result });

    } catch (error: any) {
        console.error('Analysis failed:', error);
        return NextResponse.json({ error: error.message || 'Analysis failed' }, { status: 500 });
    }
}