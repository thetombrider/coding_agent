import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // OpenTUI's native test renderer requires Bun; package.json test:tui runs it.
    exclude: ["src/tui/approval-bar.test.tsx"],
  },
});
