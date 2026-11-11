import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next infers the root from the nearest lockfile otherwise, and may pick a parent folder.
  outputFileTracingRoot: process.cwd(),
  // The tests run a separate build so they never disturb your own.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    // proxy.ts runs on every request, so Next keeps a copy of each request body. Uploads can be a
    // 1 GB video, so the copy must not cut them short before they reach the backend.
    proxyClientMaxBodySize: "1100mb",
  },
};

export default nextConfig;
