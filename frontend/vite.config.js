import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: process.env.VITE_DEV_HOST || "127.0.0.1",
    port: Number(process.env.VITE_DEV_PORT || 5173),
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:4317",
        // Keep the browser's Host aligned with Origin for backend write checks.
        changeOrigin: false,
      },
    },
  },
});
