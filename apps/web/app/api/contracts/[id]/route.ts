import { NextResponse } from 'next/server';
import { db } from '@/lib/store';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contract = db.contracts.find((c) => c.id === id);
  if (!contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }
  return NextResponse.json(contract);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
  const index = db.contracts.findIndex((c) => c.id === id);
  if (index === -1) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }
  db.contracts.splice(index, 1);
  return NextResponse.json({ success: true });
}