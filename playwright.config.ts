import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against the PRODUCTION build (`vite preview`), not the dev server.
 * This is deliberate: the pdf.js worker setup, module eval order, and asset URLs
 * differ between dev and prod, and a real prod-only bug (react-pdf falling back to
 * a "fake worker") was invisible in dev. `npm run build:wasm` must have run first
 * (pkg/ is gitignored); `npm run build` copies the pdf.js worker via prebuild.
 */
// Port is overridable so a Vite dev server from another project sitting on the
// default 5173 does not get silently reused (reuseExistingServer would then run
// the whole suite against the wrong app): E2E_PORT=5174 npm run test:e2e
const PORT = Number(process.env.E2E_PORT ?? 5173);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
