import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Run serially. The Next.js dev server compiles routes on demand in a single
  // process; running specs concurrently makes the heavy recruitment specs (build a
  // form, publish, apply) contend for it and time out. Serial is slower but reliable.
  workers: 1,
  // Safety net for any residual cold-compile slowness on the first hit of a route.
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://localhost:3100/api/health",
    reuseExistingServer: true,
    // CI cold-starts the dev server and compiles on first request, so allow headroom.
    timeout: 120_000,
  },
});
