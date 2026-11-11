import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { BACKEND_DIR, PYTHON } from "./helpers";
import { MOCK_URL } from "./mock/server";

/**
 * The backend's unit tests (backend/tests, pytest). They run here because the Shopify and theme
 * tests need the mock server this suite starts. Only mock keys are used.
 */
test("backend unit tests (pytest)", () => {
  const result = spawnSync(PYTHON, ["-m", "pytest", "tests", "-q", "-p", "no:cacheprovider"], {
    cwd: BACKEND_DIR,
    env: { ...process.env, MOCK_URL, PLA_SKIP_ENV_FILES: "1", PYTHONUNBUFFERED: "1" },
    encoding: "utf8",
    timeout: 300_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  console.log(output.split("\n").slice(-30).join("\n"));
  expect(result.status, output).toBe(0);
  expect(output).not.toMatch(/\bskipped\b/);
});
