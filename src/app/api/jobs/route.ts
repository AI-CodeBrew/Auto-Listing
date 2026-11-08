import { ok } from "@/lib/http";
import * as repo from "@/lib/repo";

export async function GET() {
  return ok({ jobs: repo.listRecentJobs() });
}
