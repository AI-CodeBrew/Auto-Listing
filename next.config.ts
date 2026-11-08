import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These load native binaries or locate files relative to themselves, so they
  // must stay out of the server bundle.
  serverExternalPackages: [
    "better-sqlite3",
    "sharp",
    "playwright",
    "playwright-core",
    "ffmpeg-static",
    "sanitize-html",
  ],
  // Next infers the root from the nearest lockfile otherwise, and may pick a
  // parent folder.
  outputFileTracingRoot: process.cwd(),
  // The tests run a separate build so they never disturb your own.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
