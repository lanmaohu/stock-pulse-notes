import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    exclude: ["server/**", "dist-server/**", "node_modules/**"],
    setupFiles: ["./src/test-setup.ts"],
    restoreMocks: true
  }
});
