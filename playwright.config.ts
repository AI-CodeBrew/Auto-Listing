import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  globalSetup: "./tests/global-setup.ts",
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    screenshot: "only-on-failure",
  },
});
