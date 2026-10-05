import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately; the dev server proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.ALVIP_API_URL ?? "http://127.0.0.1:3000", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: true },
});
