'use client';

import { useIdentityToken, usePrivy } from '@privy-io/react-auth';
import { useCallback, useState } from 'react';

const apiUrl = (
  process.env.NEXT_PUBLIC_CC_API_URL ?? 'https://dev-api.collectorcrypt.com'
).replace(/\/+$/, '');

type CCUser = {
  id?: string;
  wallet?: string;
  email?: string;
  role?: string;
  [key: string]: unknown;
};

type CallResult =
  | { status: 'idle' }
  | { status: 'pending'; label: string }
  | {
      status: 'done';
      label: string;
      httpStatus: number;
      ok: boolean;
      body: unknown;
    }
  | { status: 'error'; label: string; message: string };

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return res.text();
  }
}

export default function Page() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { identityToken } = useIdentityToken();

  const [ccUser, setCcUser] = useState<CCUser | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [result, setResult] = useState<CallResult>({ status: 'idle' });
  const [nftAddressesInput, setNftAddressesInput] = useState('');
  const [shippingAddressId, setShippingAddressId] = useState('');

  const callCC = useCallback(
    async (label: string, path: string, init?: RequestInit) => {
      setResult({ status: 'pending', label });
      try {
        if (!identityToken)
          throw new Error('No Privy identity token yet — log in first');
        const res = await fetch(`${apiUrl}${path}`, {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
            Authorization: `Bearer ${identityToken}`,
          },
        });
        const body = await parseBody(res);
        setResult({
          status: 'done',
          label,
          httpStatus: res.status,
          ok: res.ok,
          body,
        });
        return { ok: res.ok, status: res.status, body };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setResult({ status: 'error', label, message });
        return null;
      }
    },
    [identityToken],
  );

  const connect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      if (!identityToken) {
        setConnectError('No Privy identity token yet — log in first');
        return;
      }
      const res = await fetch(`${apiUrl}/users/info`, {
        headers: { Authorization: `Bearer ${identityToken}` },
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setConnectError(
          `CollectorCrypt rejected the token (${res.status}): ${
            typeof body === 'string' ? body : JSON.stringify(body)
          }`,
        );
        return;
      }
      setCcUser(body as CCUser);
    } finally {
      setConnecting(false);
    }
  }, [identityToken]);

  const reset = useCallback(() => {
    setCcUser(null);
    setConnectError(null);
    setResult({ status: 'idle' });
  }, []);

  const handleLogout = useCallback(async () => {
    reset();
    await logout();
  }, [logout, reset]);

  if (!ready) return <Shell>Booting Privy…</Shell>;

  if (!authenticated)
    return (
      <Shell>
        <h1 style={{ marginTop: 0 }}>CC Partner Test</h1>
        <p style={{ color: '#9ca3af' }}>
          Reference integration showing how a partner app authenticates its
          users to CollectorCrypt&apos;s API. Authenticate with your own Privy
          app, then send the resulting Privy <strong>identity token</strong>{' '}
          as a Bearer header to CollectorCrypt.
        </p>
        <p style={{ color: '#9ca3af' }}>
          Target backend: <code>{apiUrl}</code>
        </p>
        <Button onClick={login}>Log in with Partner Privy</Button>
      </Shell>
    );

  const solanaWallet = user?.linkedAccounts?.find(
    (a: any) => a.type === 'wallet' && a.chainType === 'solana',
  ) as { address?: string } | undefined;

  const userEmail =
    (user?.email as any)?.address ??
    (user?.linkedAccounts?.find(
      (a: any) => typeof (a as any).email === 'string',
    ) as any)?.email ??
    '—';

  const decodedIdentity = identityToken ? decodeJwtClaims(identityToken) : null;

  return (
    <Shell>
      <h1 style={{ marginTop: 0 }}>CC Partner Test</h1>
      <p style={{ color: '#9ca3af' }}>
        Target backend: <code>{apiUrl}</code>
      </p>

      <Section
        title='1. Partner Privy session'
        right={
          <Button onClick={handleLogout} variant='secondary'>
            Log out
          </Button>
        }
      >
        <Row label='DID' value={user?.id ?? '—'} />
        <Row label='Email' value={userEmail} />
        <Row label='Solana wallet' value={solanaWallet?.address ?? '—'} />
      </Section>

      <Section title='2. Identity token (the Bearer we send)'>
        <p style={{ color: '#9ca3af', marginTop: 0 }}>
          Privy issues an identity token alongside the access token. It carries
          the user&apos;s linked accounts (wallets, email) as claims, signed by
          your partner app&apos;s key. CollectorCrypt&apos;s backend verifies
          it against your app&apos;s public JWKS at{' '}
          <code>https://auth.privy.io/api/v1/apps/{`{partnerAppId}`}/jwks.json</code>{' '}
          and reads the wallet from the claims — no app secret exchanged.
        </p>
        <Row
          label='Present?'
          value={identityToken ? `yes (len ${identityToken.length})` : 'no'}
        />
        {decodedIdentity && (
          <details style={{ marginTop: 12 }} open>
            <summary style={{ color: '#9ca3af', cursor: 'pointer' }}>
              Decoded identity token claims
            </summary>
            <pre style={preStyle}>
              {JSON.stringify(decodedIdentity, null, 2)}
            </pre>
            {identityToken && (
              <button
                onClick={() => navigator.clipboard.writeText(identityToken)}
                style={{
                  background: '#27272e',
                  border: 'none',
                  borderRadius: 6,
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: 13,
                  marginTop: 8,
                  padding: '6px 12px',
                }}
              >
                Copy raw identity token
              </button>
            )}
          </details>
        )}
      </Section>

      <Section title='3. Connect to CollectorCrypt'>
        {!ccUser && !connectError && (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              Sends the identity token as <code>Authorization: Bearer</code> to{' '}
              <code>GET /users/info</code>. On 200, CC has registered (or
              found) your user keyed on the wallet from the token.
            </p>
            <Button onClick={connect}>
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </>
        )}
        {connectError && (
          <>
            <div style={{ color: '#f87171', marginBottom: 12 }}>
              {connectError}
            </div>
            <Button onClick={connect}>
              {connecting ? 'Retrying…' : 'Retry'}
            </Button>
          </>
        )}
        {ccUser && (
          <>
            <Row label='CC user id' value={ccUser.id ?? '—'} />
            <Row label='Role' value={ccUser.role ?? '—'} />
            <Row label='Wallet' value={ccUser.wallet ?? '—'} />
            <Row label='Email' value={ccUser.email ?? '—'} />
          </>
        )}
      </Section>

      <Section title='4. User-self API'>
        {!ccUser && (
          <div style={{ color: '#6b7280' }}>Connect first.</div>
        )}
        {ccUser && (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              Endpoints a partner-originated user can call with their identity
              token. Admin / shipper / vault routes are deliberately blocked
              for partner users by CC&apos;s backend — partners only see the
              user-self surface.
            </p>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
                marginBottom: 16,
              }}
            >
              <Button
                onClick={() => callCC('GET /users/info', '/users/info')}
              >
                My profile
              </Button>
              <Button
                onClick={() => callCC('GET /users/cards', '/users/cards')}
              >
                My cards
              </Button>
              <Button
                onClick={() =>
                  callCC('GET /shipping-address', '/shipping-address')
                }
              >
                My shipping addresses
              </Button>
              <Button
                onClick={() =>
                  callCC('GET /outbound-shipment', '/outbound-shipment')
                }
              >
                My outbound shipments
              </Button>
            </div>
            <p style={{ color: '#9ca3af', marginTop: 16 }}>
              Mutations — these write to the connected user&apos;s account.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <Button
                onClick={() =>
                  callCC('PATCH /users/update', '/users/update', {
                    method: 'PATCH',
                    body: JSON.stringify({
                      bio: `partner-test bio @ ${new Date().toISOString()}`,
                    }),
                  })
                }
              >
                Update bio
              </Button>
              <Button
                onClick={() =>
                  callCC(
                    'POST /shipping-address/create',
                    '/shipping-address/create',
                    {
                      method: 'POST',
                      body: JSON.stringify({
                        fullName: 'Partner Test User',
                        country: 'US',
                        streetAddress: '123 Example St',
                        city: 'San Francisco',
                        state: 'CA',
                        zip: '94103',
                        phoneNumber: '+15555550100',
                        isDefault: false,
                      }),
                    },
                  )
                }
              >
                Add a shipping address
              </Button>
            </div>
          </>
        )}
      </Section>

      <Section title='5. Redeem cards (composite burn-prepare)'>
        {!ccUser && (
          <div style={{ color: '#6b7280' }}>Connect first.</div>
        )}
        {ccUser && (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              Calls{' '}
              <code>POST /redeem/prepare</code> — the one-shot composite that
              creates an outbound shipment in <code>Created</code> status and
              returns unsigned burn transactions for you to sign. The user&apos;s
              wallet must own each NFT and hold enough USDC to cover{' '}
              <code>totalCost</code>; the burn transactions atomically transfer
              shipping payment alongside the burn.
            </p>
            <div style={{ marginBottom: 12 }}>
              <label
                style={{
                  color: '#9ca3af',
                  display: 'block',
                  fontSize: 13,
                  marginBottom: 4,
                }}
              >
                NFT addresses (comma-separated)
              </label>
              <textarea
                value={nftAddressesInput}
                onChange={e => setNftAddressesInput(e.target.value)}
                placeholder='So1aMint1…, So1aMint2…'
                rows={3}
                style={{
                  background: '#0b0b0f',
                  border: '1px solid #27272e',
                  borderRadius: 6,
                  color: '#e5e7eb',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 13,
                  padding: '8px 10px',
                  width: '100%',
                }}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label
                style={{
                  color: '#9ca3af',
                  display: 'block',
                  fontSize: 13,
                  marginBottom: 4,
                }}
              >
                Shipping address ID (run{' '}
                <code>GET /shipping-address</code> in section 4 to find one)
              </label>
              <input
                value={shippingAddressId}
                onChange={e => setShippingAddressId(e.target.value)}
                placeholder='shippingAddr_…'
                style={{
                  background: '#0b0b0f',
                  border: '1px solid #27272e',
                  borderRadius: 6,
                  color: '#e5e7eb',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 13,
                  minWidth: 320,
                  padding: '8px 10px',
                  width: '100%',
                }}
              />
            </div>
            <Button
              onClick={() => {
                const nftAddresses = nftAddressesInput
                  .split(/[\s,]+/)
                  .map(s => s.trim())
                  .filter(Boolean);
                callCC('POST /redeem/prepare', '/redeem/prepare', {
                  method: 'POST',
                  body: JSON.stringify({
                    nftAddresses,
                    shippingAddressId,
                    coin: 'USDC',
                  }),
                });
              }}
            >
              Prepare redemption
            </Button>
          </>
        )}
      </Section>

      <Section title='6. Result'>
        <ResultView result={result} />
      </Section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ margin: '0 auto', maxWidth: 820, padding: '40px 24px' }}>
      {children}
    </div>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: '#14141a',
        border: '1px solid #27272e',
        borderRadius: 8,
        marginBottom: 16,
        padding: 16,
      }}
    >
      <div
        style={{
          alignItems: 'center',
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <div
          style={{
            color: '#a5f3fc',
            fontSize: 12,
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', fontSize: 14, padding: '4px 0' }}>
      <div style={{ color: '#9ca3af', minWidth: 140 }}>{label}</div>
      <div
        style={{
          color: '#e5e7eb',
          fontFamily: 'ui-monospace, monospace',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Button({
  onClick,
  children,
  variant = 'primary',
  style,
}: {
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary';
  style?: React.CSSProperties;
}) {
  const primary = variant === 'primary';
  return (
    <button
      onClick={onClick}
      style={{
        background: primary ? '#676FFF' : '#27272e',
        border: 'none',
        borderRadius: 6,
        color: 'white',
        cursor: 'pointer',
        fontSize: 14,
        fontWeight: 600,
        padding: '10px 16px',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function ResultView({ result }: { result: CallResult }) {
  if (result.status === 'idle')
    return <div style={{ color: '#6b7280' }}>No call yet.</div>;

  if (result.status === 'pending')
    return <div style={{ color: '#a5f3fc' }}>{result.label}… pending</div>;

  if (result.status === 'error')
    return (
      <div>
        <div style={{ color: '#f87171', marginBottom: 8 }}>
          {result.label} — error
        </div>
        <pre style={preStyle}>{result.message}</pre>
      </div>
    );

  return (
    <div>
      <div
        style={{
          color: result.ok ? '#4ade80' : '#f87171',
          marginBottom: 8,
        }}
      >
        {result.label} — {result.httpStatus} {result.ok ? 'OK' : 'FAIL'}
      </div>
      <pre style={preStyle}>
        {typeof result.body === 'string'
          ? result.body
          : JSON.stringify(result.body, null, 2)}
      </pre>
    </div>
  );
}

const preStyle: React.CSSProperties = {
  background: '#0b0b0f',
  border: '1px solid #27272e',
  borderRadius: 6,
  color: '#e5e7eb',
  fontSize: 13,
  margin: 0,
  maxHeight: 320,
  overflow: 'auto',
  padding: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};
