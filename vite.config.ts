import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    // Must match API_PORT (server/env.ts). 8787 is taken by another local tool.
    // Trailing slashes: "/api" alone would also catch web/api.ts.
    proxy: { "/api/": "http://127.0.0.1:8791", "/media/": "http://127.0.0.1:8791" },
  },
});
