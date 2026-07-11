'use client';

import {
  useCrossAppAccounts,
  useIdentityToken,
  usePrivy,
} from '@privy-io/react-auth';
import { useWallets } from '@privy-io/react-auth/solana';
import { useCallback, useState } from 'react';

// Collector Crypt's Privy app (the global-wallet provider). Override with
// NEXT_PUBLIC_CC_PRIVY_APP_ID; defaults to CC production.
const CC_PRIVY_APP_ID =
  process.env.NEXT_PUBLIC_CC_PRIVY_APP_ID ?? 'cmdgt21w400lgky0mkn069jui';

const apiUrl = (
  process.env.NEXT_PUBLIC_CC_API_URL || 'https://api.collectorcrypt.com'
).replace(/\/+$/, '');

// The cross-app linked account Privy attaches after signing in with CC. For a Solana
// global-wallet provider the shared wallet address lands in `embeddedWallets`
// (chain-agnostic {address}[]). We dump the raw object so we can SEE what CC
// actually returns instead of guessing.
type CrossAppLinkedAccount = {
  type: 'cross_app';
  subject: string;
  providerApp: { id: string; name?: string; logoUrl?: string };
  embeddedWallets: { address: string }[];
  smartWallets: { address: string }[];
};

type AnyUser = ReturnType<typeof usePrivy>['user'];

function findCrossApp(user: AnyUser): CrossAppLinkedAccount | undefined {
  return user?.linkedAccounts?.find(a => a.type === 'cross_app') as
    | CrossAppLinkedAccount
    | undefined;
}

// Pull every plausible Solana address out of a cross_app account, whatever key
// Privy tucked it under (embeddedWallets / smartWallets / a bare `wallets` /
// walletsV2 / a top-level address). base58, 32–44 chars, no 0/O/I/l.
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function crossAppAddresses(ca: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (!v || depth > 4) return;
    if (typeof v === 'string') {
      if (B58.test(v)) out.add(v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(x => visit(x, depth + 1));
      return;
    }
    if (typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>))
        visit(val, depth + 1);
    }
  };
  visit(ca, 0);
  return [...out];
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

// JSON.stringify that survives circular refs, BigInt, and functions so we can
// dump live Privy objects (wallet instances carry methods + back-refs).
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === 'bigint') return `${v.toString()}n`;
      if (typeof v === 'function') return `[fn ${v.name || 'anon'}]`;
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    },
    2,
  );
}

// A ConnectedStandardSolanaWallet is a class instance — its data hides behind
// getters, so Object.keys() misses most of it. Probe the fields we care about
// explicitly, then merge in own-enumerable keys for anything else.
function walletSnapshot(w: unknown): Record<string, unknown> {
  const o = w as Record<string, unknown> & {
    standardWallet?: { name?: string };
  };
  const snap: Record<string, unknown> = {
    address: o.address,
    type: o.type,
    chainType: o.chainType,
    walletClientType: o.walletClientType,
    connectorType: o.connectorType,
    imported: o.imported,
    delegated: o.delegated,
    standardWalletName: o.standardWallet?.name,
  };
  for (const k of Object.keys(o)) if (!(k in snap)) snap[k] = o[k];
  return snap;
}

export default function ConnectCcPage() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { loginWithCrossAppAccount, unlinkCrossAppAccount } =
    useCrossAppAccounts();
  const { identityToken } = useIdentityToken();
  // Live connected Solana wallets. NOTE: for Solana this hook filters strictly
  // on chainType === 'solana' over connected + embedded wallets — it does NOT
  // include cross-app accounts. The CC wallet is NOT expected here; it lives on
  // the cross_app linked account. Dumped anyway so we can see the partner's own
  // embedded wallet vs anything unexpected.
  const { wallets } = useWallets();

  const [connecting, setConnecting] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [result, setResult] = useState<CallResult>({ status: 'idle' });

  // CC is the identity provider for this session. Starting from a logged-out
  // state avoids attempting to attach an existing CC identity to a separate
  // partner identity, which Privy correctly rejects as an account collision.
  const connect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      await loginWithCrossAppAccount({ appId: CC_PRIVY_APP_ID });
    } catch (err) {
      console.error('[connect-cc] loginWithCrossAppAccount threw:', err);
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [loginWithCrossAppAccount]);

  const unlinkAndRetry = useCallback(async () => {
    const subject = findCrossApp(user)?.subject;
    if (!subject) return;
    setUnlinking(true);
    setConnectError(null);
    try {
      try {
        await unlinkCrossAppAccount({ subject });
      } catch (err) {
        // Privy does not allow unlinking when cross_app is the user's only
        // authentication account. Logging out still clears the requester
        // session and allows a fresh provider-account selection.
        const message = err instanceof Error ? err.message : String(err);
        if (!/only one account/i.test(message)) throw err;
      }
      await logout();
      setResult({ status: 'idle' });
    } catch (err) {
      console.error('[connect-cc] unlinkCrossAppAccount threw:', err);
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlinking(false);
    }
  }, [logout, unlinkCrossAppAccount, user]);

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
        setResult({ status: 'done', label, httpStatus: res.status, ok: res.ok, body });
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

  const effectiveUser = user;
  const crossApp = findCrossApp(effectiveUser);
  const crossAppAddrs = crossApp ? crossAppAddresses(crossApp) : [];
  const sharedCcWallet =
    crossApp?.embeddedWallets?.[0]?.address ??
    crossApp?.smartWallets?.[0]?.address ??
    crossAppAddrs[0];
  const ccWallet = sharedCcWallet;

  const decodedIdentity = identityToken ? decodeJwtClaims(identityToken) : null;
  const googleEmail = (
    effectiveUser?.linkedAccounts?.find(a => a.type === 'google_oauth') as
      | { email?: string }
      | undefined
  )?.email;
  const partnerLabel =
    googleEmail ??
    (effectiveUser?.email as { address?: string } | undefined)?.address ??
    effectiveUser?.id ??
    '—';

  if (!ready) return <Shell>Booting Privy…</Shell>;

  return (
    <Shell>
      <h1 style={{ marginTop: 0 }}>CC Partner Test — Connect Collector Crypt</h1>
      <p style={{ color: '#9ca3af' }}>
        Connect a user&apos;s <strong>Collector Crypt wallet</strong> to this
        partner app with Privy global (cross-app) wallets. Collector Crypt&apos;s
        consent screen authenticates the user with their CC account and shares
        their existing embedded wallet into the partner session.
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
          crossApp ? (
            <Button variant='secondary' onClick={unlinkAndRetry}>
              {unlinking ? 'Resetting…' : 'Reset CC and retry'}
            </Button>
          ) : authenticated ? (
            <Button variant='secondary' onClick={() => logout()}>
              Log out
            </Button>
          ) : undefined
        }
      >
        {crossApp && (
          <div style={{ color: '#4ade80', marginBottom: 8 }}>
            ✓ Signed in with Collector Crypt.
          </div>
        )}
        {authenticated && !crossApp && (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              This browser is already signed in to the partner app as{' '}
              <code>{partnerLabel}</code>. Log out before connecting so Collector
              Crypt becomes the identity provider for this session.
            </p>
            <Button onClick={() => logout()}>Log out to connect CC</Button>
          </>
        )}
        {!authenticated && (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              Sign in to Collector Crypt with your email and approve access to
              your existing CC wallet.
            </p>
            <Button onClick={connect}>
              {connecting ? 'Opening Collector Crypt…' : 'Connect with Collector Crypt'}
            </Button>
          </>
        )}
        {connectError && (
          <div style={{ color: '#f87171', marginTop: 12 }}>{connectError}</div>
        )}
      </Section>

      <Section title='2. Connected Collector Crypt account'>
        {!crossApp && <div style={{ color: '#6b7280' }}>Not connected yet.</div>}
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
            <Row label='Session identity' value={partnerLabel} />
            <Row label='CC wallet' value={ccWallet ?? '— (none shared)'} />
            <Row
              label='Wallet source'
              value={
                sharedCcWallet
                  ? 'Privy shared embedded wallet'
                    : '—'
              }
            />
            <Row
              label='embeddedWallets[]'
              value={
                (crossApp.embeddedWallets ?? []).map(w => w.address).join(', ') ||
                '(empty)'
              }
            />
            <Row
              label='smartWallets[]'
              value={
                (crossApp.smartWallets ?? []).map(w => w.address).join(', ') ||
                '(empty)'
              }
            />
            <Row
              label='any b58 addr found'
              value={crossAppAddrs.join(', ') || '(none)'}
            />
            {!ccWallet && (
              <div style={{ color: '#fbbf24', fontSize: 13, marginTop: 8 }}>
                Collector Crypt authenticated, but shared no wallet address.
                Read the raw cross_app dump below to verify the provider response.
              </div>
            )}
          </>
        )}
      </Section>

      <Section title='3. Raw debug dump (source of truth)'>
        <Dump label='cross_app linked account (source: usePrivy)'>
          {crossApp ? safeStringify(crossApp) : '(no cross_app account yet)'}
        </Dump>
        <Dump label={`user.linkedAccounts (${effectiveUser?.linkedAccounts?.length ?? 0})`}>
          {safeStringify(effectiveUser?.linkedAccounts ?? [])}
        </Dump>
        <Dump label={`useWallets() — Solana connected/embedded (${wallets.length})`}>
          {safeStringify(wallets.map(walletSnapshot))}
        </Dump>
        <Dump label='full user object'>
          {safeStringify(effectiveUser)}
        </Dump>
        <Dump label='decoded identity token claims'>
          {decodedIdentity ? safeStringify(decodedIdentity) : '(no identity token)'}
        </Dump>
      </Section>

      <Section title='4. Identity token (the Bearer you send to CC)'>
        {!crossApp && <div style={{ color: '#6b7280' }}>Connect first.</div>}
        {crossApp && (
          <>
            <Row
              label='Present?'
              value={identityToken ? `yes (len ${identityToken.length})` : 'no'}
            />
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
          </>
        )}
      </Section>

      <Section title='5. Call Collector Crypt API (optional)'>
        {!crossApp && <div style={{ color: '#6b7280' }}>Connect first.</div>}
        {crossApp && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <Button onClick={() => callCC('GET /users/info', '/users/info')}>
              My profile
            </Button>
            <Button onClick={() => callCC('GET /users/cards', '/users/cards')}>
              My cards
            </Button>
            <Button
              onClick={() => callCC('GET /shipping-address', '/shipping-address')}
            >
              My shipping addresses
            </Button>
          </div>
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

function Dump({ label, children }: { label: string; children: string }) {
  return (
    <details style={{ marginBottom: 10 }} open>
      <summary style={{ color: '#9ca3af', cursor: 'pointer', fontSize: 13 }}>
        {label}
      </summary>
      <pre style={preStyle}>{children}</pre>
    </details>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', fontSize: 14, padding: '4px 0' }}>
      <div style={{ color: '#9ca3af', minWidth: 200 }}>{label}</div>
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
      <div style={{ color: result.ok ? '#4ade80' : '#f87171', marginBottom: 8 }}>
        {result.label} — {result.httpStatus} {result.ok ? 'OK' : 'FAIL'}
      </div>
      <pre style={preStyle}>
        {typeof result.body === 'string'
          ? result.body
          : safeStringify(result.body)}
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
