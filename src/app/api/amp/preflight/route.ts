import { NextResponse } from 'next/server';
import { ampPreflight } from '@/lib/amp/preflight';

export async function GET() {
  try {
    const result = await ampPreflight();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

