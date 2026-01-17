import { NextResponse } from 'next/server';
import { db } from '@/lib/store';
import { processFile, validateMimeType } from '@/lib/text-extraction';

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

  const mimeType = file.type || 'application/octet-stream';

  // Validate file type
  try {
    validateMimeType(mimeType);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  try {
    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract text from file
    const { text, method, confidence } = await processFile(buffer, mimeType);

    if (!text || text.length === 0) {
      return NextResponse.json(
        { error: 'Could not extract any text from the file' },
        { status: 400 }
      );
    }

    // Store extracted text in contract
    contract.text = text;

    return NextResponse.json({
      success: true,
      message: 'File uploaded and text extracted',
      extractionMethod: method,
      confidence,
      textLength: text.length,
    });
  } catch (error: any) {
    console.error('Text extraction failed:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to extract text from file' },
      { status: 500 }
    );
  }
}