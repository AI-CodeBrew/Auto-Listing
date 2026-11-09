/** Next calls this once when the server starts. It starts the research queue. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { whenReady } = await import("./lib/supabase");
    const { startWorker } = await import("./lib/queue");
    // Do not hold the server open while the saved records load.
    // The restart updates are local bookkeeping and must not replace the saved copy.
    void whenReady().finally(async () => {
      // On the deployed site each search runs with the request that started it.
      if (process.env["VERCEL"]) return;
      const { isSyncPaused, setSyncPaused } = await import("./lib/db");
      const paused = isSyncPaused();
      setSyncPaused(true);
      try {
        startWorker();
      } finally {
        setSyncPaused(paused);
      }
    });
  }
}
