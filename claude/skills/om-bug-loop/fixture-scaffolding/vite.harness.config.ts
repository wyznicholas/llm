import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: dirname,
  base: "/",
  // Keep vite's dep cache INSIDE this fixture dir. The default
  // (<root>/../node_modules/.vite) resolves through this fork's node_modules
  // symlink and writes into openmarket-chat/node_modules.
  cacheDir: path.resolve(dirname, ".vite-cache"),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(dirname, "../src") } },
  server: { fs: { allow: [path.resolve(dirname, "..")] } },
});
