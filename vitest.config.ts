import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["apps/*/src/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.ts"],
    environment: "node",
    // Integration tests render and analyse ~270 real images end to end.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
