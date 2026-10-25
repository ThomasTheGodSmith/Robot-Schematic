import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
  worker: { format: "es" },
  optimizeDeps: { include: ["@dimforge/rapier3d-compat", "three", "zod"] },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
  },
} as any);
