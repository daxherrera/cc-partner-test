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

// The cross-app linked account Privy attaches after linking CC. The CC wallet
// lives in `embeddedWallets` here — not the top-level `wallet` account.
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
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { linkCrossAppAccount } = useCrossAppAccounts();
  const { identityToken } = useIdentityToken();
  // Live connected Solana wallets — the cross-app CC wallet surfaces here
  // (connectorType 'cross_app'), even when the identity token's cross_app
  // linked account reports an empty embeddedWallets array.
  const { wallets } = useWallets();

  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [result, setResult] = useState<CallResult>({ status: 'idle' });

  // Step 2 — link the CC wallet to the *already-authenticated* partner
  // session. linkCrossAppAccount requires authenticated === true, so the user
  // must complete Step 1 (partner login) first. Linking opens Collector
  // Crypt's OAuth consent, where the user authenticates as their real CC
  // account and approves sharing their embedded wallet.
  const link = useCallback(async () => {
    setLinking(true);
    setLinkError(null);
    try {
      await linkCrossAppAccount({ appId: CC_PRIVY_APP_ID });
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinking(false);
    }
  }, [linkCrossAppAccount]);

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
  // ConnectedStandardSolanaWallet exposes only `address` + `standardWallet`
  // (wallet-standard, with a `name`). A cross-app wallet reports the provider
  // name (e.g. "Collector Crypt"); the partner's own embedded wallet reports
  // "Privy". Prefer the linked-account embedded wallet, then a provider-named
  // wallet from the live hook.
  const walletName = (w: (typeof wallets)[number]) =>
    (w as { standardWallet?: { name?: string } }).standardWallet?.name ?? '';
  const crossAppWallet = wallets.find(w => /collector|crypt/i.test(walletName(w)));
  const ccWallet =
    crossApp?.embeddedWallets?.[0]?.address ?? crossAppWallet?.address;
  const decodedIdentity = identityToken ? decodeJwtClaims(identityToken) : null;
  const googleEmail = (
    user?.linkedAccounts?.find(a => a.type === 'google_oauth') as
      | { email?: string }
      | undefined
  )?.email;
  const partnerLabel =
    googleEmail ??
    (user?.email as { address?: string } | undefined)?.address ??
    user?.id ??
    '—';

  if (!ready) return <Shell>Booting Privy…</Shell>;

  return (
    <Shell>
      <h1 style={{ marginTop: 0 }}>CC Partner Test — Connect Collector Crypt</h1>
      <p style={{ color: '#9ca3af' }}>
        Link a user&apos;s <strong>Collector Crypt wallet</strong> to this
        partner app with Privy global (cross-app) wallets. Two steps: first
        sign in to the partner app, then link Collector Crypt — linking opens
        CC&apos;s consent screen where the user authenticates with their CC
        account and approves sharing their embedded wallet.
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
        title='1. Connect to the partner app'
        right={
          authenticated ? (
            <Button variant='secondary' onClick={() => logout()}>
              Log out
            </Button>
          ) : undefined
        }
      >
        {authenticated ? (
          <>
            <div style={{ color: '#4ade80', marginBottom: 8 }}>
              ✓ Connected as <code>{partnerLabel}</code>
            </div>
            <Row label='Partner Privy DID' value={user?.id ?? '—'} />
          </>
        ) : (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              linkCrossAppAccount requires an authenticated session, so sign in
              to the partner app first (email, Google, or a wallet).
            </p>
            <Button onClick={login}>Connect to partner app</Button>
          </>
        )}
      </Section>

      <Section title='2. Link your Collector Crypt wallet'>
        {!authenticated && (
          <div style={{ color: '#6b7280' }}>Complete step 1 first.</div>
        )}
        {authenticated && !crossApp && (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              Provider app: <code>{CC_PRIVY_APP_ID}</code>. Calls{' '}
              <code>linkCrossAppAccount({'{ appId }'})</code> → Collector
              Crypt&apos;s consent screen. Sign in there with your CC account so
              the right wallet is shared.
            </p>
            <Button onClick={link}>
              {linking ? 'Opening Collector Crypt…' : 'Link Collector Crypt'}
            </Button>
            {linkError && (
              <div style={{ color: '#f87171', marginTop: 12 }}>{linkError}</div>
            )}
          </>
        )}
        {authenticated && crossApp && (
          <>
            <div style={{ color: '#4ade80', marginBottom: 8 }}>
              ✓ Collector Crypt linked.
            </div>
            <Row
              label='Provider'
              value={
                crossApp.providerApp?.name
                  ? `${crossApp.providerApp.name} (${crossApp.providerApp.id})`
                  : crossApp.providerApp?.id ?? '—'
              }
            />
            <Row label='CC user (subject)' value={crossApp.subject ?? '—'} />
            <Row label='Signed-in email' value={partnerLabel} />
            <Row label='CC wallet' value={ccWallet ?? '—'} />
            {crossApp.smartWallets?.length > 0 && (
              <Row
                label='CC smart wallets'
                value={crossApp.smartWallets.map(w => w.address).join(', ')}
              />
            )}
            <details style={{ marginTop: 12 }} open>
              <summary style={{ color: '#9ca3af', cursor: 'pointer' }}>
                Connected wallets — useWallets() ({wallets.length})
              </summary>
              <pre style={preStyle}>
                {JSON.stringify(
                  wallets.map(w => ({
                    address: w.address,
                    name: walletName(w),
                  })),
                  null,
                  2,
                )}
              </pre>
            </details>
            {!ccWallet && (
              <div style={{ color: '#fbbf24', fontSize: 13, marginTop: 8 }}>
                Linked, but no cross-app wallet surfaced yet. Check the
                useWallets() dump above — if your CC wallet is there with
                connectorType &quot;cross_app&quot;, it&apos;ll show as CC
                wallet; if not, the CC OAuth authenticated the wrong account
                (subject has no shared wallet).
              </div>
            )}
          </>
        )}
      </Section>

      <Section title='3. Identity token (the Bearer you send to CC)'>
        {!crossApp && <div style={{ color: '#6b7280' }}>Link first.</div>}
        {crossApp && (
          <>
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
          </>
        )}
      </Section>

      <Section title='4. Call Collector Crypt API (optional)'>
        {!crossApp && <div style={{ color: '#6b7280' }}>Link first.</div>}
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
