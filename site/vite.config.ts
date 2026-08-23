import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base` decides whether the built page can find its own assets. A project site
// lives at `https://<owner>.github.io/<repo>/`, so the asset paths have to carry
// that prefix; a user site or a custom domain lives at the root and must not.
// The Pages workflow passes the right one in `VITE_BASE` — it knows the repo
// name, and hardcoding it here would break the first fork.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
  },
});
