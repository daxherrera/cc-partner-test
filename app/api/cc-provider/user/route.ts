import { NextRequest, NextResponse } from 'next/server';

const apiUrl = (
  process.env.NEXT_PUBLIC_CC_API_URL || 'https://api.collectorcrypt.com'
).replace(/\/+$/, '');

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return NextResponse.json(
      { message: 'Missing Collector Crypt provider token' },
      { status: 401 },
    );
  }

  try {
    const response = await fetch(`${apiUrl}/users/info`, {
      cache: 'no-store',
      headers: { Authorization: authorization },
    });
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': response.headers.get('content-type') || 'application/json',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? `Collector Crypt request failed: ${error.message}`
            : 'Collector Crypt request failed',
      },
      { status: 502 },
    );
  }
}
