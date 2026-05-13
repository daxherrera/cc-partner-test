'use client';

import { Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { useCallback, useEffect, useState } from 'react';
import { CcAsset, fetchCcAssets } from '../helius';

const apiUrl = (
  process.env.NEXT_PUBLIC_CC_API_URL || 'https://dev-api.collectorcrypt.com'
).replace(/\/+$/, '');

const defaultPartnerSlug =
  process.env.NEXT_PUBLIC_CC_SIWS_PARTNER_SLUG || 'cc-partner-test';

const solanaNetwork: 'mainnet' | 'devnet' =
  process.env.NEXT_PUBLIC_SOLANA_NETWORK === 'mainnet' ? 'mainnet' : 'devnet';
const usdcMint =
  process.env.NEXT_PUBLIC_USDC_MINT ??
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{
    publicKey: { toString(): string };
  }>;
  disconnect: () => Promise<void>;
  signMessage: (
    message: Uint8Array,
    encoding?: 'utf8',
  ) => Promise<{ signature: Uint8Array }>;
  signTransaction: <T extends Transaction | VersionedTransaction>(
    transaction: T,
  ) => Promise<T>;
}

function getPhantom(): PhantomProvider | null {
  if (typeof window === 'undefined') return null;
  const anyWindow = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  const p = anyWindow.phantom?.solana ?? anyWindow.solana;
  return p && p.isPhantom ? p : (p ?? null);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Backend returns base64-encoded serialized transactions. Phantom signs
 * Transaction or VersionedTransaction objects, so we have to deserialize.
 * Try VersionedTransaction first (newer message format); fall back to
 * legacy Transaction. */
function deserializeUnsignedTx(
  b64: string,
): Transaction | VersionedTransaction {
  const bytes = base64ToBytes(b64);
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

function serializeSignedTx(
  tx: Transaction | VersionedTransaction,
): Uint8Array {
  // Legacy Transaction.serialize() defaults to `requireAllSignatures: true`
  // which throws when a partner / fee-payer hasn't co-signed yet. Bypass
  // that check — Phantom's user signature is all this leg of the flow has.
  if ('version' in tx) return tx.serialize();
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchUsdcBalance(wallet: string): Promise<number> {
  const res = await fetch('/api/helius', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'cc-usdc-balance',
      method: 'getTokenAccountsByOwner',
      params: [wallet, { mint: usdcMint }, { encoding: 'jsonParsed' }],
    }),
  });
  if (!res.ok) throw new Error(`Helius ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const accounts = json?.result?.value ?? [];
  let total = 0;
  for (const acc of accounts) {
    const ui = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    if (typeof ui === 'number') total += ui;
  }
  return total;
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

interface NonceResponse {
  nonce: string;
  expiresAt: number;
  message: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface PreparedRedemption {
  outboundShipmentId: string;
  transactions?: string[];
  evmTransactions?: unknown[];
  totalCost?: string;
}

export default function SiwsPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [partnerSlug, setPartnerSlug] = useState(defaultPartnerSlug);
  const [domain, setDomain] = useState('');
  const [uri, setUri] = useState('');
  const [nonceData, setNonceData] = useState<NonceResponse | null>(null);
  const [tokens, setTokens] = useState<TokenPair | null>(null);
  const [siwsErr, setSiwsErr] = useState<string | null>(null);
  const [result, setResult] = useState<CallResult>({ status: 'idle' });
  const [shippingAddressId, setShippingAddressId] = useState('');
  const [nftAddressesInput, setNftAddressesInput] = useState('');
  const [providerDetected, setProviderDetected] = useState<boolean | null>(
    null,
  );
  const [assets, setAssets] = useState<CcAsset[] | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(
    new Set(),
  );
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [usdcError, setUsdcError] = useState<string | null>(null);
  const [preparedRedemption, setPreparedRedemption] =
    useState<PreparedRedemption | null>(null);
  const [signingSubmit, setSigningSubmit] = useState(false);

  useEffect(() => {
    if (!domain && typeof window !== 'undefined')
      setDomain(window.location.hostname);
    if (!uri && typeof window !== 'undefined')
      setUri(`${window.location.protocol}//${window.location.host}`);
    setProviderDetected(getPhantom() !== null);
  }, [domain, uri]);

  const connectPhantom = useCallback(async () => {
    setConnecting(true);
    setSiwsErr(null);
    try {
      const p = getPhantom();
      if (!p) {
        setSiwsErr(
          'No Solana wallet detected. Install Phantom (or any window.solana provider) and reload.',
        );
        return;
      }
      const { publicKey } = await p.connect();
      setWallet(publicKey.toString());
    } catch (err) {
      setSiwsErr(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const p = getPhantom();
    if (p) await p.disconnect();
    setWallet(null);
    setNonceData(null);
    setTokens(null);
    setSiwsErr(null);
    setResult({ status: 'idle' });
    setAssets(null);
    setSelectedAssetIds(new Set());
    setUsdcBalance(null);
    setPreparedRedemption(null);
  }, []);

  const mintNonce = useCallback(async () => {
    setSiwsErr(null);
    setNonceData(null);
    if (!wallet) {
      setSiwsErr('Connect a wallet first.');
      return;
    }
    try {
      const res = await fetch(`${apiUrl}/auth/wallet/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet,
          partnerAppId: partnerSlug,
          domain,
          uri,
        }),
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setSiwsErr(
          `Nonce mint failed (${res.status}): ${
            typeof body === 'string' ? body : JSON.stringify(body)
          }`,
        );
        return;
      }
      setNonceData(body as NonceResponse);
    } catch (err) {
      setSiwsErr(err instanceof Error ? err.message : String(err));
    }
  }, [wallet, partnerSlug, domain, uri]);

  const signAndVerify = useCallback(async () => {
    setSiwsErr(null);
    if (!nonceData) {
      setSiwsErr('Mint a nonce first.');
      return;
    }
    const p = getPhantom();
    if (!p) {
      setSiwsErr('No wallet provider available.');
      return;
    }
    try {
      const messageBytes = new TextEncoder().encode(nonceData.message);
      const { signature } = await p.signMessage(messageBytes, 'utf8');
      const signatureB58 = bs58.encode(signature);
      const res = await fetch(`${apiUrl}/auth/wallet/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: nonceData.message,
          signature: signatureB58,
        }),
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setSiwsErr(
          `Verify failed (${res.status}): ${
            typeof body === 'string' ? body : JSON.stringify(body)
          }`,
        );
        return;
      }
      setTokens(body as TokenPair);
      setNonceData(null);
    } catch (err) {
      setSiwsErr(err instanceof Error ? err.message : String(err));
    }
  }, [nonceData]);

  const refreshSession = useCallback(async () => {
    if (!tokens) return;
    try {
      const res = await fetch(`${apiUrl}/auth/wallet/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setSiwsErr(
          `Refresh failed (${res.status}): ${
            typeof body === 'string' ? body : JSON.stringify(body)
          }`,
        );
        return;
      }
      setTokens(body as TokenPair);
    } catch (err) {
      setSiwsErr(err instanceof Error ? err.message : String(err));
    }
  }, [tokens]);

  const logoutSession = useCallback(async () => {
    if (!tokens) return;
    // Pass the access token too — the server revokes both in one call so a
    // logged-out session can't keep using the access token for the rest of
    // its 15-min TTL.
    await fetch(`${apiUrl}/auth/wallet/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    setTokens(null);
    setPreparedRedemption(null);
  }, [tokens]);

  const callCC = useCallback(
    async (label: string, path: string, init?: RequestInit) => {
      setResult({ status: 'pending', label });
      try {
        if (!tokens) throw new Error('No SIWS access token yet — sign in first');
        const res = await fetch(`${apiUrl}${path}`, {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
            Authorization: `Bearer ${tokens.accessToken}`,
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
    [tokens],
  );

  const loadAssets = useCallback(async () => {
    if (!wallet) {
      setAssetsError('Connect a wallet first.');
      return;
    }
    setAssetsLoading(true);
    setAssetsError(null);
    try {
      const found = await fetchCcAssets(wallet);
      setAssets(found);
      setSelectedAssetIds(new Set());
    } catch (err) {
      setAssetsError(err instanceof Error ? err.message : String(err));
    } finally {
      setAssetsLoading(false);
    }
  }, [wallet]);

  const toggleAssetSelected = useCallback((id: string) => {
    setSelectedAssetIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const useSelectedForRedemption = useCallback(() => {
    setNftAddressesInput(Array.from(selectedAssetIds).join(',\n'));
  }, [selectedAssetIds]);

  const loadUsdcBalance = useCallback(async () => {
    if (!wallet) return;
    setUsdcError(null);
    try {
      const balance = await fetchUsdcBalance(wallet);
      setUsdcBalance(balance);
    } catch (err) {
      setUsdcError(err instanceof Error ? err.message : String(err));
      setUsdcBalance(null);
    }
  }, [wallet]);

  const estimateRedemption = useCallback(async () => {
    const nftAddresses = nftAddressesInput
      .split(/[\s,]+/)
      .map(s => s.trim())
      .filter(Boolean);
    await callCC('POST /redeem/estimate', '/redeem/estimate', {
      method: 'POST',
      body: JSON.stringify({ nftAddresses, shippingAddressId }),
    });
  }, [callCC, nftAddressesInput, shippingAddressId]);

  const prepareRedemption = useCallback(async () => {
    setPreparedRedemption(null);
    const nftAddresses = nftAddressesInput
      .split(/[\s,]+/)
      .map(s => s.trim())
      .filter(Boolean);
    const res = await callCC('POST /redeem/prepare', '/redeem/prepare', {
      method: 'POST',
      body: JSON.stringify({
        nftAddresses,
        shippingAddressId,
        paymentMethod: 'crypto',
        coin: 'USDC',
      }),
    });
    if (res?.ok && typeof res.body === 'object' && res.body) {
      setPreparedRedemption(res.body as PreparedRedemption);
    }
  }, [callCC, nftAddressesInput, shippingAddressId]);

  const signAndSubmitRedemption = useCallback(async () => {
    if (!preparedRedemption) return;
    const { outboundShipmentId, transactions, evmTransactions } =
      preparedRedemption;
    if (evmTransactions && evmTransactions.length > 0) {
      setResult({
        status: 'error',
        label: 'sign-and-submit',
        message:
          'EVM transactions detected — this SIWS demo only signs Solana. Add an EVM signer for the evmTransactions array if your partner supports it.',
      });
      return;
    }
    if (!transactions || transactions.length === 0) {
      setResult({
        status: 'error',
        label: 'sign-and-submit',
        message: 'No transactions to sign in the prepare response.',
      });
      return;
    }
    const p = getPhantom();
    if (!p) {
      setResult({
        status: 'error',
        label: 'sign-and-submit',
        message: 'No wallet provider available.',
      });
      return;
    }
    setSigningSubmit(true);
    setResult({
      status: 'pending',
      label: `sign ${transactions.length} tx + submit`,
    });
    try {
      const signedB64: string[] = [];
      for (const tx of transactions) {
        const unsigned = deserializeUnsignedTx(tx);
        const signed = await p.signTransaction(unsigned);
        signedB64.push(bytesToBase64(serializeSignedTx(signed)));
      }
      const submitRes = await fetch(
        `${apiUrl}/blockchain/${outboundShipmentId}/burn`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokens!.accessToken}`,
          },
          body: JSON.stringify({ transactions: signedB64 }),
        },
      );
      const submitBody = await parseBody(submitRes);
      setResult({
        status: 'done',
        label: 'POST /blockchain/:id/burn',
        httpStatus: submitRes.status,
        ok: submitRes.ok,
        body: submitBody,
      });
      if (submitRes.ok) setPreparedRedemption(null);
    } catch (err) {
      setResult({
        status: 'error',
        label: 'sign-and-submit',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSigningSubmit(false);
    }
  }, [preparedRedemption, tokens]);

  // Auto-fetch USDC balance once authenticated.
  useEffect(() => {
    if (tokens && wallet) loadUsdcBalance();
  }, [tokens, wallet, loadUsdcBalance]);

  return (
    <Shell>
      <h1 style={{ marginTop: 0 }}>CC Partner Test — Native SIWS</h1>
      <p style={{ color: '#9ca3af' }}>
        Sign-in-with-Solana reference for the wallet-vendor integration path.
        No Privy on this page — this is the bare flow Phantom (or any{' '}
        <code>window.solana</code> provider) will use from inside the wallet
        UI. Connects via <code>window.solana</code>, calls{' '}
        <code>POST /auth/wallet/nonce</code> → signs the returned message →{' '}
        <code>POST /auth/wallet/verify</code> for a pair of opaque,
        server-stored access + refresh tokens. The access token is scoped to
        the routes the backend annotates with <code>@WalletAuthAllowed()</code>.
      </p>
      <p style={{ color: '#9ca3af' }}>
        Target backend: <code>{apiUrl}</code>
      </p>
      <p style={{ color: '#9ca3af' }}>
        <a href='/' style={{ color: '#a5f3fc' }}>
          ← back to Track A (Privy identity tokens)
        </a>
      </p>

      <Section title='1. Wallet'>
        <Row
          label='Provider'
          value={
            providerDetected === null
              ? '…'
              : providerDetected
                ? 'detected'
                : 'window.solana not found'
          }
        />
        <Row label='Connected wallet' value={wallet ?? '—'} />
        <Row
          label={`USDC balance (${solanaNetwork})`}
          value={
            usdcError
              ? `error: ${usdcError}`
              : usdcBalance === null
                ? '—'
                : `${usdcBalance.toFixed(6)} USDC`
          }
        />
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          {!wallet && (
            <Button onClick={connectPhantom}>
              {connecting ? 'Connecting…' : 'Connect wallet'}
            </Button>
          )}
          {wallet && (
            <Button variant='secondary' onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </div>
      </Section>

      <Section title='2. SIWS exchange'>
        <Field
          label='Partner slug or privyAppId'
          value={partnerSlug}
          onChange={setPartnerSlug}
        />
        <Field
          label='Domain (must be in allowedSiwsDomains)'
          value={domain}
          onChange={setDomain}
        />
        <Field
          label='URI (shown in the SIWS message)'
          value={uri}
          onChange={setUri}
        />
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            marginTop: 12,
          }}
        >
          <Button onClick={mintNonce}>1. Mint nonce</Button>
          <Button onClick={signAndVerify}>2. Sign &amp; verify</Button>
        </div>
        {siwsErr && (
          <div
            style={{
              color: '#f87171',
              marginTop: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            {siwsErr}
          </div>
        )}
        {nonceData && (
          <div style={{ marginTop: 16 }}>
            <Row label='Nonce' value={nonceData.nonce} />
            <Row
              label='Expires at'
              value={new Date(nonceData.expiresAt).toISOString()}
            />
            <details style={{ marginTop: 8 }} open>
              <summary style={{ color: '#9ca3af', cursor: 'pointer' }}>
                Canonical SIWS message (this is exactly what your user signs)
              </summary>
              <pre style={preStyle}>{nonceData.message}</pre>
            </details>
          </div>
        )}
      </Section>

      <Section
        title='3. Session'
        right={
          tokens && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant='secondary' onClick={refreshSession}>
                Refresh
              </Button>
              <Button variant='secondary' onClick={logoutSession}>
                Logout
              </Button>
            </div>
          )
        }
      >
        {!tokens && <div style={{ color: '#6b7280' }}>No session yet.</div>}
        {tokens && (
          <>
            <Row
              label='Access expires at'
              value={new Date(tokens.expiresAt).toISOString()}
            />
            <Row
              label='Access token'
              value={`${tokens.accessToken.slice(0, 16)}…`}
            />
            <Row
              label='Refresh token'
              value={`${tokens.refreshToken.slice(0, 16)}…`}
            />
            <details style={{ marginTop: 8 }}>
              <summary style={{ color: '#9ca3af', cursor: 'pointer' }}>
                Raw access token (copy for curl)
              </summary>
              <pre style={preStyle}>{tokens.accessToken}</pre>
            </details>
            <p
              style={{
                color: '#6b7280',
                fontSize: 12,
                marginBottom: 0,
                marginTop: 8,
              }}
            >
              Tokens are opaque (random ids prefixed <code>cca_</code> /{' '}
              <code>ccr_</code>). The server holds the trusted claims; the
              token is just the lookup key. Treat it like a session cookie —
              don&apos;t parse it client-side.
            </p>
          </>
        )}
      </Section>

      <Section title='4. User-self API'>
        {!tokens && <div style={{ color: '#6b7280' }}>Sign in first.</div>}
        {tokens && (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              Endpoints a wallet-auth user can call with their CC-issued
              token. These are the ones the backend annotates with{' '}
              <code>@WalletAuthAllowed()</code>.
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
                onClick={() =>
                  callCC('GET /auth/wallet/me', '/auth/wallet/me')
                }
              >
                My session
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
              <Button
                onClick={() =>
                  callCC(
                    'POST /shipping-address/create',
                    '/shipping-address/create',
                    {
                      method: 'POST',
                      body: JSON.stringify({
                        fullName: 'SIWS Test User',
                        country: 'United States of America',
                        streetAddress: '123 Example St',
                        apartment: '',
                        city: 'San Francisco',
                        state: 'California',
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
        {!tokens && <div style={{ color: '#6b7280' }}>Sign in first.</div>}
        {tokens && (
          <>
            <p style={{ color: '#9ca3af', marginTop: 0 }}>
              Two endpoints back this flow:{' '}
              <code>POST /redeem/estimate</code> is a pure-read cost preview
              (validates ownership + redeemable status, returns the
              shipping/fees breakdown, no shipment created) — call it as
              often as you want to keep a live cost UI for the user. Then{' '}
              <code>POST /redeem/prepare</code> is the one-shot composite
              that creates the <code>outboundShipment</code> in{' '}
              <code>Created</code> status and returns unsigned burn
              transactions for the user to sign. The wallet must own each
              NFT and hold enough USDC to cover <code>totalCost</code>; the
              burn transactions atomically transfer shipping payment
              alongside the burn.
            </p>
            <div
              style={{
                background: '#0b0b0f',
                border: '1px solid #27272e',
                borderRadius: 8,
                marginBottom: 16,
                padding: 12,
              }}
            >
              <div
                style={{
                  alignItems: 'center',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 12,
                  marginBottom: 8,
                }}
              >
                <strong style={{ color: '#e5e7eb', fontSize: 14 }}>
                  Find your CC NFTs (Helius DAS)
                </strong>
                <Button
                  onClick={loadAssets}
                  variant='secondary'
                  style={{ fontSize: 13, padding: '6px 12px' }}
                >
                  {assetsLoading ? 'Loading…' : assets ? 'Refresh' : 'Load'}
                </Button>
                {selectedAssetIds.size > 0 && (
                  <Button
                    onClick={useSelectedForRedemption}
                    style={{ fontSize: 13, padding: '6px 12px' }}
                  >
                    Use {selectedAssetIds.size} selected ↓
                  </Button>
                )}
              </div>
              <div
                style={{ color: '#6b7280', fontSize: 12, marginBottom: 8 }}
              >
                Filters by CC&apos;s collection groupings (
                <code>CCryptWBYkt…</code> for Metaplex,{' '}
                <code>CCryptUfeFSZ…</code> for Core). Includes both standard
                NFTs and cNFTs.
              </div>
              {assetsError && (
                <div style={{ color: '#f87171', fontSize: 13 }}>
                  {assetsError}
                </div>
              )}
              {assets && assets.length === 0 && !assetsError && (
                <div style={{ color: '#9ca3af', fontSize: 13 }}>
                  No CC NFTs in this wallet.
                </div>
              )}
              {assets && assets.length > 0 && (
                <div
                  style={{
                    display: 'grid',
                    gap: 8,
                    gridTemplateColumns:
                      'repeat(auto-fill, minmax(220px, 1fr))',
                    maxHeight: 320,
                    overflowY: 'auto',
                  }}
                >
                  {assets.map(asset => {
                    const checked = selectedAssetIds.has(asset.id);
                    return (
                      <label
                        key={asset.id}
                        style={{
                          alignItems: 'center',
                          background: checked ? '#1e1b4b' : '#14141a',
                          border: `1px solid ${checked ? '#676FFF' : '#27272e'}`,
                          borderRadius: 6,
                          cursor: 'pointer',
                          display: 'flex',
                          gap: 8,
                          padding: 8,
                        }}
                      >
                        <input
                          type='checkbox'
                          checked={checked}
                          onChange={() => toggleAssetSelected(asset.id)}
                        />
                        {asset.imageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={asset.imageUrl}
                            alt=''
                            style={{
                              borderRadius: 4,
                              flexShrink: 0,
                              height: 48,
                              objectFit: 'cover',
                              width: 48,
                            }}
                          />
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              color: '#e5e7eb',
                              fontSize: 13,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {asset.name}
                          </div>
                          <div style={{ color: '#9ca3af', fontSize: 11 }}>
                            {asset.compressed ? 'cNFT' : 'NFT'} ·{' '}
                            {asset.collection}
                          </div>
                          <div
                            style={{
                              color: '#6b7280',
                              fontFamily: 'ui-monospace, monospace',
                              fontSize: 11,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {asset.id}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
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
                NFT addresses (comma-separated) — auto-filled by &quot;Use
                selected&quot; above, or paste manually
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
                Shipping address ID (run &quot;My shipping addresses&quot;
                above to find one)
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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <Button onClick={estimateRedemption} variant='secondary'>
                Estimate cost
              </Button>
              <Button onClick={prepareRedemption}>Prepare redemption</Button>
              {preparedRedemption && (
                <Button
                  onClick={signAndSubmitRedemption}
                  variant='secondary'
                >
                  {signingSubmit
                    ? 'Signing & submitting…'
                    : `Sign & submit (${
                        preparedRedemption.transactions?.length ?? 0
                      } tx → /blockchain/${preparedRedemption.outboundShipmentId.slice(
                        0,
                        8,
                      )}…/burn)`}
                </Button>
              )}
            </div>
            {preparedRedemption && (
              <p
                style={{
                  color: '#9ca3af',
                  fontSize: 12,
                  marginBottom: 0,
                  marginTop: 8,
                }}
              >
                Prepared shipment{' '}
                <code>{preparedRedemption.outboundShipmentId}</code> · cost{' '}
                <code>{preparedRedemption.totalCost ?? '—'} USDC</code>. The
                Sign &amp; submit button deserializes each unsigned tx, signs
                via <code>window.solana.signTransaction</code>, and POSTs the
                signed payload to <code>/blockchain/:id/burn</code> — the
                same path CC&apos;s web checkout takes after signing.
              </p>
            )}
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

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label
        style={{
          color: '#9ca3af',
          display: 'block',
          fontSize: 13,
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
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
