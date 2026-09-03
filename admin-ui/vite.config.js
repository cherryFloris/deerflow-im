import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The vendored dsh-im React tree is consumed verbatim; only the RPC transport is
// swapped (admin-ui/src/rpc.js -> im-bridge /api/admin/rpc). The build output goes
// to ../public so the admin server can serve it as static assets.
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react()],
  resolve: {
    // dsh-im sources use bare ".mjs" sibling imports and JSON import assertions;
    // keep extensions explicit so Vite resolves them.
    extensions: [".mjs", ".js", ".jsx", ".json"],
  },
  build: {
    outDir: path.resolve(__dirname, "../public"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:10010",
    },
  },
});
