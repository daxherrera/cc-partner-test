'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { ReactNode } from 'react';

const appId = process.env.NEXT_PUBLIC_PARTNER_PRIVY_APP_ID ?? '';

// Collector Crypt's Privy app (the global-wallet provider). Declaring it as a
// `privy:${appId}` login method registers it as a cross-app provider — without
// this, loginWithCrossAppAccount never invokes CC's email login and the flow
// falls through to a blank partner-app embedded wallet.
const ccProviderAppId =
  process.env.NEXT_PUBLIC_CC_PRIVY_APP_ID ?? 'cmdgt21w400lgky0mkn069jui';

export function Providers({ children }: { children: ReactNode }) {
  if (!appId) {
    return (
      <div style={{ padding: 40, fontFamily: 'system-ui', color: '#f87171' }}>
        <h2>Missing NEXT_PUBLIC_PARTNER_PRIVY_APP_ID</h2>
        <p>Set it in .env.local or your Vercel env vars, then reload.</p>
      </div>
    );
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          accentColor: '#676FFF',
          theme: 'dark',
          walletChainType: 'ethereum-and-solana',
          walletList: [
            'detected_solana_wallets',
            'detected_ethereum_wallets',
            'wallet_connect',
          ],
        },
        embeddedWallets: {
          showWalletUIs: false,
          solana: {
            createOnLogin: 'users-without-wallets',
          },
        },
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors({ shouldAutoConnect: false }),
          },
        },
        loginMethodsAndOrder: {
          primary: [
            `privy:${ccProviderAppId}`,
            'email',
            'google',
            'detected_solana_wallets',
          ],
        },
        solana: {
          rpcs: {
            'solana:mainnet': {
              rpc: createSolanaRpc('https://api.mainnet-beta.solana.com'),
              rpcSubscriptions: createSolanaRpcSubscriptions(
                'wss://api.mainnet-beta.solana.com',
              ),
            },
          },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
