import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      reporter: ["text", "html"],
      thresholds: {
        statements: 85,
        lines: 85,
        functions: 80,
        branches: 70
      },
      exclude: [
        "dist/**",
        "eslint.config.js",
        "vite.config.ts",
        "vitest.config.ts",
        "src/main.tsx",
        "src/types.ts",
        "src/vite-env.d.ts",
      ]
    }
  }
});
