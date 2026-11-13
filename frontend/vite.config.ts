import { defineConfig, type Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";

// The marketing landing page is the site root; the clinical app lives at /monitor.
// Production serves dist/landing.html for "/" (backend/app/factory.py); this keeps
// `vite` and `vite preview` identical instead of showing the app on "/".
function landingAtRoot(): Plugin {
  const rewrite = (req: IncomingMessage, _res: ServerResponse, next: (err?: unknown) => void) => {
    const url = req.url ?? "/";
    if (url.split("?")[0] === "/") req.url = "/landing.html" + url.slice(1);
    next();
  };
  return {
    name: "vitaltwin-landing-root",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

// In development the API runs on :8000; Vite proxies REST and WebSocket calls
// so the frontend can always use same-origin relative URLs.
const backend = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), landingAtRoot()],
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/docs": backend,
      "/openapi.json": backend,
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three", "@react-three/fiber", "@react-three/drei"],
          charts: ["recharts"],
        },
      },
    },
  },
  test: {
    environment: "node",
  },
});
