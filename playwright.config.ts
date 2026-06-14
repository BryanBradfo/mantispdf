import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against the PRODUCTION build (`vite preview`), not the dev server.
 * This is deliberate: the pdf.js worker setup, module eval order, and asset URLs
 * differ between dev and prod, and a real prod-only bug (react-pdf falling back to
 * a "fake worker") was invisible in dev. `npm run build:wasm` must have run first
 * (pkg/ is gitignored); `npm run build` copies the pdf.js worker via prebuild.
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
    command: "npm run build && npm run preview -- --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
