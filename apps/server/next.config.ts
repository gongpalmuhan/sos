import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@sos/shared'],
  poweredByHeader: false,
};

export default nextConfig;
