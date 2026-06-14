import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against the Vite dev server, which serves the React app, the
 * Web Worker, and the WASM module. `npm run build:wasm` must have been run first
 * (pkg/ is gitignored). Specs live in e2e/.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
