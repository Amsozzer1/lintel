import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      { test: { name: "e2e", include: ["test/e2e/**/*.test.ts"], testTimeout: 30_000 } },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          testTimeout: 240_000,
          hookTimeout: 240_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
