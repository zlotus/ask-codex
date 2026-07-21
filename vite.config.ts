import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/ws": {
        target: "ws://127.0.0.1:4173",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
