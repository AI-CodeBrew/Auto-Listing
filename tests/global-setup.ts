import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { APP_PORT, IMAGE_FILE, ROOT, TEST_DIR, VIDEO_FILE, appEnv, killApp, startApp } from "./helpers";
import { startMockServer } from "./mock/server";

export default async function globalSetup() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // A 3-second test video, made with the same ffmpeg the app uses.
  execFileSync(ffmpegPath as unknown as string, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=640x360:rate=10",
    "-c:v", "mpeg4", "-pix_fmt", "yuv420p", VIDEO_FILE,
  ]);
  await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 200, g: 60, b: 40 } } })
    .composite([{ input: Buffer.from('<svg width="1000" height="1000"><circle cx="300" cy="500" r="200" fill="#123"/><rect x="600" y="100" width="200" height="700" fill="#eee"/></svg>') }])
    .jpeg()
    .toFile(IMAGE_FILE);

  // A separate build folder, so running tests never touches your own build.
  execFileSync(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "build"], { cwd: ROOT, env: appEnv("build"), stdio: "inherit" });

  const mock: http.Server = await startMockServer(VIDEO_FILE);
  const app: ChildProcess = await startApp("main", APP_PORT);

  return async () => {
    killApp(app);
    await new Promise((resolve) => mock.close(resolve));
  };
}
