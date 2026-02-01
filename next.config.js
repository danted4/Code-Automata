/** @type {import('next').NextConfig} */
const path = require('path');

const packageJson = require(path.join(__dirname, 'package.json'));

const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@sourcegraph/amp-sdk'],
  outputFileTracingIncludes: {
    '/api/**': ['node_modules/@sourcegraph/amp-sdk/**/*'],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  productionBrowserSourceMaps: false,
  images: { unoptimized: true },
};

module.exports = nextConfig;
