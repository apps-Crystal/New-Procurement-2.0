import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Business documents and photos are served through /api/documents, never statically.
  poweredByHeader: false,
};

export default nextConfig;
