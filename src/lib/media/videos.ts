import { execFile } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { aiLimits, LIMITS } from "../config";
import { commitFile, removeQuietly, tempPath } from "../storage";
import { downloadToFile, TooLargeError } from "../web/net";
import { videoExtension } from "../web/urls";

function ffmpeg(): string {
  if (!ffmpegPath) throw new Error("The ffmpeg binary is missing. Run: npm rebuild ffmpeg-static");
  return ffmpegPath as unknown as string;
}

function run(args: string[], timeoutMs: number): Promise<{ stdout: Buffer; stderr: string; failed: boolean }> {
  return new Promise((resolve) => {
    execFile(
      ffmpeg(),
      args,
      { encoding: "buffer", maxBuffer: 40 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ stdout: stdout as Buffer, stderr: (stderr as Buffer)?.toString("utf8") ?? "", failed: Boolean(error) });
      },
    );
  });
}

async function durationSeconds(file: string): Promise<number | null> {
  // With no output file ffmpeg exits with an error, but it still prints the duration.
  const { stderr } = await run(["-hide_banner", "-i", file], 30_000);
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

/** Extracts a few evenly spaced JPEG frames. Returns an empty array if none decode. */
export async function extractFrames(file: string, count = aiLimits().framesPerVideo): Promise<Buffer[]> {
  const duration = await durationSeconds(file);
  const times = duration
    ? Array.from({ length: count }, (_, i) => (duration * (i + 1)) / (count + 1))
    : Array.from({ length: count }, (_, i) => i);
  const frames: Buffer[] = [];
  for (const time of times) {
    const { stdout, failed } = await run(
      [
        "-hide_banner", "-loglevel", "error",
        "-ss", time.toFixed(2),
        "-i", file,
        "-frames:v", "1",
        "-vf", "scale='min(1280,iw)':-2",
        "-q:v", "3",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "pipe:1",
      ],
      60_000,
    );
    if (!failed && stdout.length > 0) frames.push(stdout);
  }
  return frames;
}

export type DownloadedVideo =
  | { status: "ok"; fileName: string; bytes: number }
  | { status: "failed"; reason: string };

/** Downloads a direct MP4, MOV or WEBM file. Callers must classify the URL first. */
export async function downloadVideo(productId: string, url: string): Promise<DownloadedVideo> {
  const tmp = tempPath(productId, "videos");
  try {
    const { bytes, contentType, finalUrl } = await downloadToFile(url, tmp, LIMITS.videoMaxBytes, 30 * 60_000);
    const ext = videoExtension(contentType, finalUrl);
    if (!ext) {
      removeQuietly(tmp);
      return { status: "failed", reason: `Not a direct video file (server sent "${contentType || "no type"}")` };
    }
    return { status: "ok", fileName: commitFile(productId, "videos", tmp, ext), bytes };
  } catch (error) {
    removeQuietly(tmp);
    if (error instanceof TooLargeError) return { status: "failed", reason: "Video is larger than the 1 GB limit" };
    return { status: "failed", reason: `Download failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
