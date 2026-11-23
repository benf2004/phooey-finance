import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({
  plugins: [react(), cloudflare(process.env.SELF_HOSTED === "true" ? { configPath: "wrangler.self-hosted.jsonc" } : {})],
  build: { chunkSizeWarningLimit: 600 },
  server: { host: "127.0.0.1" },
});
