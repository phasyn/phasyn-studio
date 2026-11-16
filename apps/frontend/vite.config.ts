import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";
import { precompress } from "./scripts/precompress.mjs";
import { thirdPartyLicenses } from "./scripts/third-party-licenses.mjs";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const contractsDir = fileURLToPath(new URL("../../contracts", import.meta.url));
// Notices of the first-party files adapted from third-party code, which the bundle contains as well.
const adaptedNotices = {
  file: fileURLToPath(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url)),
  sections: ["### 1.4 shadcn/ui", "### 1.5 CPython `fnmatch`"],
};

/** Long-lived vendor chunks (they change only with a dependency update, so browsers keep them cached across releases). */
const VENDOR_GROUPS = [
  { name: "vendor-react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|cookie|set-cookie-parser)[\\/]/, priority: 30 },
  { name: "vendor-query", test: /[\\/]node_modules[\\/]@tanstack[\\/]/, priority: 20 },
  {
    name: "vendor-radix",
    test: /[\\/]node_modules[\\/](@radix-ui[\\/][^\\/]+|react-remove-scroll[^\\/]*|react-style-singleton|use-callback-ref|use-sidecar|aria-hidden|get-nonce|detect-node-es|tslib)[\\/]/,
    priority: 20,
  },
  { name: "vendor-icons", test: /[\\/]node_modules[\\/]lucide-react[\\/]/, priority: 20 },
  // The lazy editor GPU pipeline and brand scenes share three.js; keep it outside the shell.
  {
    name: "vendor-three",
    test: /[\\/]node_modules[\\/](three|@react-three[\\/][^\\/]+|its-fine|suspend-react|react-use-measure|zustand|use-sync-external-store|react-reconciler)[\\/]/,
    priority: 25,
  },
  { name: "vendor", test: /[\\/]node_modules[\\/]/, priority: 10 },
];

// Development: 127.0.0.1:5173, /api proxied to the local Controller (PHASYN_CONTROLLER_URL, default :8080).
// Production: `dist/` is served by the Controller from the same origin, so the app always calls relative /api.
// The build also writes dist/THIRD_PARTY_LICENSES.txt for the packages bundled into it, and a gzip copy (<file>.gz) of
// each text file, which the Controller sends to clients that accept gzip.
export default defineConfig({
  plugins: [react(), tailwindcss(), thirdPartyLicenses({ adapted: adaptedNotices }), precompress()],
  resolve: {
    alias: {
      "@": srcDir,
      "@contracts": contractsDir,
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.PHASYN_CONTROLLER_URL ?? "http://127.0.0.1:8080",
        changeOrigin: false,
        ws: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rolldownOptions: { output: { codeSplitting: { groups: VENDOR_GROUPS.map((group) => ({ ...group, maxSize: 450_000 })) } } },
  },
  test: {
    pool: "threads",
    projects: [
      {
        // Pure logic (models, reducers, parsers): `*.test.ts` in Node.
        extends: true,
        test: { name: "unit", environment: "node", include: ["src/**/*.test.ts", "scripts/**/*.test.ts"], exclude: [...configDefaults.exclude, "src/**/*.dom.test.ts"] },
      },
      {
        // Components and hooks: `*.dom.test.tsx` (any `*.test.tsx`, or `*.dom.test.ts`) in jsdom with Testing Library.
        extends: true,
        test: { name: "dom", environment: "jsdom", include: ["src/**/*.test.tsx", "src/**/*.dom.test.ts"], setupFiles: ["./src/test/setup.dom.ts"] },
      },
    ],
  },
});
