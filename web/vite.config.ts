import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    outDir: "../internal/server/dist",
    emptyOutDir: true,
    target: "es2020",
  },
  worker: {
    format: "iife",
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        ws: true,
      },
      "/healthz": "http://127.0.0.1:8080",
    },
  },
  test: {
    environment: "jsdom",
  },
});
