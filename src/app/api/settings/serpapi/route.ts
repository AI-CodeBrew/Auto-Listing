import { fail, ok, rejectForeignRequest } from "@/lib/http";
import { clearSerpKeySticky, serpOverview } from "@/lib/search/serpapi";
import { saveSerpPreference } from "@/lib/settings";
import { config } from "@/lib/config";
import { whenReady } from "@/lib/supabase";

/** Allowance for both SerpAPI keys. The keys themselves are never included. */
export async function GET() {
  await whenReady();
  return ok(await serpOverview());
}

/** Chooses which .env key is active, and whether a used-up key switches by itself. */
export async function PUT(request: Request) {
  await whenReady();
  const refused = rejectForeignRequest(request);
  if (refused) return refused;

  const body = (await request.json().catch(() => null)) as { active?: unknown; auto?: unknown } | null;
  const active = body?.active === 1 || body?.active === 2 ? body.active : undefined;
  const auto = typeof body?.auto === "boolean" ? body.auto : undefined;
  if (active === undefined && auto === undefined) return fail("Choose a key or the automatic switch.");

  const keys = config.serpApiKeys();
  if (active && !keys[active - 1]) return fail(`Key ${active} is not set. Add it in .env and restart the app.`);

  saveSerpPreference({ active, auto });
  clearSerpKeySticky();
  return ok(await serpOverview());
}
