import { NextResponse } from 'next/server';

// Allowlist the methods the demo actually uses. Forwarding arbitrary JSON-RPC
// would let anyone hitting the deployed URL drain the Helius quota.
const ALLOWED_METHODS = new Set(['searchAssets', 'getTokenAccountsByOwner']);

export async function POST(req: Request) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'HELIUS_API_KEY not set on the server' },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const method =
    body && typeof body === 'object' && 'method' in body
      ? String((body as { method: unknown }).method)
      : '';
  if (!ALLOWED_METHODS.has(method)) {
    return NextResponse.json(
      { error: `method '${method}' not allowed` },
      { status: 400 },
    );
  }

  const network =
    process.env.NEXT_PUBLIC_SOLANA_NETWORK === 'mainnet'
      ? 'mainnet'
      : 'devnet';

  const upstream = await fetch(
    `https://${network}.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/json',
    },
  });
}
