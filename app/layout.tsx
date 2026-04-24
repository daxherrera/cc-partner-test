import type { Metadata } from 'next';
import { Providers } from './providers';

// PrivyProvider rejects placeholder app IDs at module init, which breaks
// Next's static prerender step. Skip prerender entirely — this is a dev tool.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'CC Partner Test',
  description:
    'Cross-app Privy auth test harness for the CollectorCrypt native-auth migration',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang='en'>
      <body
        style={{
          background: '#0b0b0f',
          color: '#e5e7eb',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          margin: 0,
          minHeight: '100vh',
        }}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
