import { AiError } from "./ai";
import { LIMITS } from "./config";
import * as repo from "./repo";

/**
 * Background research queue. Jobs are rows in SQLite, so they survive a restart.
 * A single loop runs in the server process and handles one job at a time.
 */
const holder = globalThis as unknown as { __plaWorkerStarted?: boolean };
const POLL_MS = 500;

export function startWorker(): void {
  if (holder.__plaWorkerStarted) return;
  holder.__plaWorkerStarted = true;
  repo.recoverJobs(LIMITS.jobMaxAttempts);
  repo.recoverSends();
  void loop();
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      const job = repo.claimNextJob();
      if (job) {
        await runOne(job);
        continue;
      }
    } catch (error) {
      console.error("[queue] unexpected error", error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function runOne(job: NonNullable<ReturnType<typeof repo.claimNextJob>>): Promise<void> {
  const { JobBlocked, runResearch } = await import("./pipeline/research");
  try {
    await runResearch(job);
    repo.finishJob(job.id, "DONE", "Ready for review", null);
  } catch (error) {
    if (error instanceof JobBlocked) {
      const product = repo.getProduct(job.product_id);
      repo.updateProduct(job.product_id, {
        stage: "blocked",
        ...(product ? { blocked_urls: [...new Set([...product.blocked_urls, ...error.blockedUrls])] } : {}),
      });
      repo.finishJob(job.id, "BLOCKED", "Blocked", error.message);
    } else {
      const message = error instanceof AiError || error instanceof Error ? error.message : String(error);
      console.error(`[queue] job ${job.id} failed:`, error);
      repo.updateProduct(job.product_id, { stage: "failed" });
      repo.finishJob(job.id, "FAILED", "Failed", message.split("\n")[0].slice(0, 500));
    }
  } finally {
    // Do not keep a browser around while the queue is idle. Loaded only after a job,
    // so opening the site does not require the browser package.
    try {
      const { closeBrowser } = await import("./web/browser");
      await closeBrowser();
    } catch {
      // A deployment without the browser has nothing to close.
    }
  }
}
