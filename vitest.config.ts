import react from "@vitejs/plugin-react";
import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["apps/*/src/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.ts"],
    environment: "node",
    // Integration tests render and analyse ~270 real images end to end.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Each integration file runs real PGlite + sharp (which has its own thread pool), and the
    // evaluation test runs the pipeline twice. One file per CPU oversubscribes the machine
    // and turns timing (job leases, hook timeouts) flaky, so use about half the cores.
    maxWorkers: Math.max(2, Math.floor(availableParallelism() / 2)),
  },
});
