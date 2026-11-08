/** Next calls this once when the server starts. It starts the research queue. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("./lib/queue");
    startWorker();
  }
}
