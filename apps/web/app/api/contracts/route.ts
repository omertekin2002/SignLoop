import { NextResponse } from 'next/server';
import { db } from '@/lib/store';

export async function GET() {
  return NextResponse.json(db.contracts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
}

export async function POST(req: Request) {
  const body = await req.json();
  const newContract = {
    id: crypto.randomUUID(),
    title: body.title || 'Untitled Contract',
    status: 'DRAFT' as const,
    createdAt: new Date().toISOString(),
    analyses: [],
  };
  db.contracts.push(newContract);
  return NextResponse.json(newContract);
}