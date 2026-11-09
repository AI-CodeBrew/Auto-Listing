import { priceUsage } from "@/lib/costs";
import { ok } from "@/lib/http";
import * as repo from "@/lib/repo";
import { whenReady } from "@/lib/supabase";

export async function GET() {
  await whenReady();
  return ok({
    jobs: repo.listRecentJobs().map((job) => ({ ...job, cost: priceUsage(job.usage) })),
  });
}
