import { NextResponse } from 'next/server';
import { db } from '@/lib/store';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contract = db.contracts.find((c) => c.id === id);
  if (!contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }

  // Handle FormData
  const formData = await req.formData();
  const file = formData.get('file') as File;

  if (!file) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  }

  // Mock text extraction
  const mockText = `
  EMPLOYMENT AGREEMENT

  This Employment Agreement (the "Agreement") is made effective as of ${new Date().toLocaleDateString()}, by and between Company Inc. ("Employer") and John Doe ("Employee").

  1. TERM. The term of this Agreement shall commence on Start Date and shall continue until terminated by either party.
  
  2. COMPENSATION. Employee shall receive a base salary of $100,000 per year, paid bi-weekly.
  
  3. TERMINATION. Either party may terminate this Agreement at any time, with or without cause, upon 14 days written notice.
  
  4. NON-COMPETE. Employee agrees not to work for a competitor for a period of 2 years after termination within a 100-mile radius.
  
  5. GOVERNING LAW. This Agreement shall be governed by the laws of the State of California.
  `;
  
  contract.text = mockText;
  
  return NextResponse.json({ success: true, message: 'File uploaded and text extracted' });
}