/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { webpack }) => {
    // Privy v3 pulls in optional peer deps we don't use — Farcaster
    // (mini-app) and Stripe's fiat-onramp SDK. Suppress the unresolved
    // imports so Next doesn't fail the production build.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^(@farcaster\/mini-app-solana|@stripe\/crypto)$/,
      }),
    );
    return config;
  },
};

export default nextConfig;
