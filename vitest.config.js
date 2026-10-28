import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/globalSetup.js"],
    setupFiles: ["./tests/setup.js"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 120_000, // first run downloads a MongoDB binary
  },
});
