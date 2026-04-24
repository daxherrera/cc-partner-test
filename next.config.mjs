/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { webpack }) => {
    // Privy v3 has an optional Farcaster peer dep we don't use. Suppress the
    // unresolved import so Next doesn't fail the build.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^@farcaster\/mini-app-solana$/,
      }),
    );
    return config;
  },
};

export default nextConfig;
