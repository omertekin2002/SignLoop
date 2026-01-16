import { NextResponse } from 'next/server';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (id === 'done') {
        return NextResponse.json({
            status: 'SUCCEEDED',
            result: { provider: 'openrouter', llmModel: 'xiaomi/mimo-v2-flash:free' }
        });
    }
    return NextResponse.json({ status: 'FAILED', error: 'Job not found' });
}