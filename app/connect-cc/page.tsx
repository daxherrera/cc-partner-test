'use client';

import {
  useCrossAppAccounts,
  useIdentityToken,
  usePrivy,
} from '@privy-io/react-auth';
import { useCallback, useState } from 'react';

// Collector Crypt's production Privy app — the *provider* whose global
// wallets this app connects to. Override with NEXT_PUBLIC_CC_PRIVY_APP_ID
// if you're pointing at a different CC environment.
const CC_PRIVY_APP_ID =
  process.env.NEXT_PUBLIC_CC_PRIVY_APP_ID ?? 'cmdgt21w400lgky0mkn069jui';

// Collector Crypt production API. Only used by the optional "Call CC API"
// section below, which forwards the Privy identity token as a Bearer.
const apiUrl = (
  process.env.NEXT_PUBLIC_CC_API_URL || 'https://api.collectorcrypt.com'
).replace(/\/+$/, '');

// The cross-app linked account Privy attaches after a global-wallet login.
// The CC wallet lives in `embeddedWallets` here — NOT in the top-level
// `wallet` account — which is why a naive `type === 'wallet'` lookup comes
// back empty for cross-app users.
type CrossAppLinkedAccount = {
  type: 'cross_app';
  subject: string;
  providerApp: { id: string; name?: string; logoUrl?: string };
  embeddedWallets: { address: string }[];
  smartWallets: { address: string }[];
};

function findCrossApp(
  user: ReturnType<typeof usePrivy>['user'],
): CrossAppLinkedAccount | undefined {
  return user?.linkedAccounts?.find(a => a.type === 'cross_app') as
    | CrossAppLinkedAccount
    | undefined;
}

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
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export default function ConnectCcPage() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { loginWithCrossAppAccount, linkCrossAppAccount } =
    useCrossAppAccounts();
  const { identityToken } = useIdentityToken();

  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [result, setResult] = useState<CallResult>({ status: 'idle' });

  const connect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      // Unauthenticated → log in with the CC wallet (opens Privy's hosted
      // CC login where the user signs in with email + approves sharing).
      // Already authenticated → link the CC wallet to this session instead.
      if (authenticated) {
        await linkCrossAppAccount({ appId: CC_PRIVY_APP_ID });
      } else {
        await loginWithCrossAppAccount({ appId: CC_PRIVY_APP_ID });
      }
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [authenticated, linkCrossAppAccount, loginWithCrossAppAccount]);

  const callCC = useCallback(
    async (label: string, path: string, init?: RequestInit) => {
      setResult({ status: 'pending', label });
      try {
        if (!identityToken)
          throw new Error('No Privy identity token yet — connect first');
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
      } catch (err) {
        setResult({
          status: 'error',
          label,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [identityToken],
  );

  const crossApp = findCrossApp(user);
  const ccWallet = crossApp?.embeddedWallets?.[0]?.address;
  const decodedIdentity = identityToken ? decodeJwtClaims(identityToken) : null;

  if (!ready) return <Shell>Booting Privy…</Shell>;

  return (
    <Shell>
      <h1 style={{ marginTop: 0 }}>CC Partner Test — Connect Collector Crypt</h1>
      <p style={{ color: '#9ca3af' }}>
        Connect a user&apos;s <strong>Collector Crypt wallet</strong> to this
        partner app using Privy&apos;s global (cross-app) wallets. The user
        clicks one button, signs in to Collector Crypt with their email in
        Privy&apos;s hosted consent screen, and approves sharing their wallet —
        no seed phrase, no separate account. Their CC embedded wallet then
        comes back on this session&apos;s <code>cross_app</code> linked account.
      </p>
      <p style={{ color: '#9ca3af' }}>
        <a href='/' style={{ color: '#a5f3fc' }}>
          ← Track A (partner Privy identity tokens)
        </a>{' '}
        ·{' '}
        <a href='/siws' style={{ color: '#a5f3fc' }}>
          Track B (native SIWS)
        </a>
      </p>

      <Section
        title='1. Connect with Collector Crypt'
        right={
          authenticated ? (
            <Button variant='secondary' onClick={() => logout()}>
              Log out
            </Button>
          ) : undefined
        }
      >
        {!crossApp && (
          <p style={{ color: '#9ca3af', marginTop: 0 }}>
            Provider app: <code>{CC_PRIVY_APP_ID}</code>. Clicking below calls{' '}
            <code>
              {authenticated ? 'linkCrossAppAccount' : 'loginWithCrossAppAccount'}
              ({'{ appId }'})
            </code>{' '}
            and hands off to Privy&apos;s Collector Crypt consent screen.
          </p>
        )}
        {!crossApp && (
          <Button onClick={connect}>
            {connecting ? 'Opening Collector Crypt…' : 'Connect with Collector Crypt'}
          </Button>
        )}
        {crossApp && (
          <div style={{ color: '#4ade80' }}>
            ✓ Collector Crypt wallet connected.
          </div>
        )}
        {connectError && (
          <div style={{ color: '#f87171', marginTop: 12 }}>{connectError}</div>
        )}
      </Section>

      <Section title='2. Connected Collector Crypt account'>
        {!crossApp && (
          <div style={{ color: '#6b7280' }}>Not connected yet.</div>
        )}
        {crossApp && (
          <>
            <Row
              label='Provider'
              value={
                crossApp.providerApp?.name
                  ? `${crossApp.providerApp.name} (${crossApp.providerApp.id})`
                  : crossApp.providerApp?.id ?? '—'
              }
            />
            <Row label='CC user (subject)' value={crossApp.subject ?? '—'} />
            <Row label='CC wallet' value={ccWallet ?? '—'} />
            {crossApp.embeddedWallets?.length > 1 && (
              <Row
                label='Other CC wallets'
                value={crossApp.embeddedWallets
                  .slice(1)
                  .map(w => w.address)
                  .join(', ')}
              />
            )}
            {crossApp.smartWallets?.length > 0 && (
              <Row
                label='CC smart wallets'
                value={crossApp.smartWallets.map(w => w.address).join(', ')}
              />
            )}
            <Row label='This session (Privy DID)' value={user?.id ?? '—'} />
          </>
        )}
      </Section>

      <Section title='3. Identity token (the Bearer you send to CC)'>
        {!crossApp && (
          <div style={{ color: '#6b7280' }}>Connect first.</div>
        )}
        {crossApp && (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              Privy issues an identity token for this session. Its{' '}
              <code>linked_accounts</code> carry the <code>cross_app</code>{' '}
              entry above — Collector Crypt&apos;s backend verifies the token
              against your partner app&apos;s JWKS and reads the CC wallet from
              it.
            </p>
            <Row
              label='Present?'
              value={identityToken ? `yes (len ${identityToken.length})` : 'no'}
            />
            {decodedIdentity && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ color: '#9ca3af', cursor: 'pointer' }}>
                  Decoded identity token claims
                </summary>
                <pre style={preStyle}>
                  {JSON.stringify(decodedIdentity, null, 2)}
                </pre>
                {identityToken && (
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(identityToken)
                    }
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
          </>
        )}
      </Section>

      <Section title='4. Call Collector Crypt API (optional)'>
        {!crossApp && <div style={{ color: '#6b7280' }}>Connect first.</div>}
        {crossApp && (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              Sends the identity token as <code>Authorization: Bearer</code> to
              Collector Crypt. Requires this partner app to be registered in
              CC&apos;s <code>PartnerApp</code> table and its origin allowed.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <Button onClick={() => callCC('GET /users/info', '/users/info')}>
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
            </div>
          </>
        )}
      </Section>

      <Section title='5. Result'>
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
      <div style={{ color: '#9ca3af', minWidth: 180 }}>{label}</div>
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
