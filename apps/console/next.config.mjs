/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship compiled CJS; Next transpiles them for the client.
  transpilePackages: ['@serviceloop/shared', '@serviceloop/config'],
};

export default nextConfig;
