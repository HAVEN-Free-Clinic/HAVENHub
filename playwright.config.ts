import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://localhost:3100/api/health",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
