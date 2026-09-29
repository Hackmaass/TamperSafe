import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

export default defineConfig({
  base: "/",
  plugins: [
    react(),
    {
      name: "copy-landing-page",
      closeBundle() {
        const landingDir = path.resolve(__dirname, "..", "landing-page");
        const distDir = path.resolve(__dirname, "dist");

        // Copy landing-page/index.html to dist/index.html
        fs.copyFileSync(
          path.join(landingDir, "index.html"),
          path.join(distDir, "index.html")
        );

        // Copy landing-page/assets to dist/assets
        fs.cpSync(
          path.join(landingDir, "assets"),
          path.join(distDir, "assets"),
          { recursive: true }
        );
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        dashboard: path.resolve(__dirname, "dashboard.html"),
      },
    },
  },
  server: {
    fs: {
      allow: [".."],
    },
    proxy: {
      "/api": {
        target: process.env.RELAYER_URL ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
