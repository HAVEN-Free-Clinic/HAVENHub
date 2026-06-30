import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Limit concurrency so the Next.js dev server is not overwhelmed.
  // The dev server compiles on demand and cannot handle many parallel requests.
  workers: 2,
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://localhost:3100/api/health",
    reuseExistingServer: true,
    // CI cold-starts the dev server and compiles on first request, so allow headroom.
    timeout: 120_000,
  },
});
