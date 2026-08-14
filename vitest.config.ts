import { defineConfig } from "vitest/config";
import path from "path";
import { testWorkerCount } from "./vitest.workers";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Clones one database per worker before anything runs.
    globalSetup: ["./vitest.globalsetup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    pool: "forks",
    // Integration tests no longer share a database: each worker connects to its
    // own clone, so a resetDb() truncate cannot reach another worker's rows.
    fileParallelism: true,
    // Must not exceed the number of databases global setup created, or a worker
    // connects to one that does not exist. Vitest 4 removed poolOptions; this is
    // top-level now, and setting the old shape fails silently.
    maxWorkers: testWorkerCount(),
  },
});
