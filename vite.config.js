// vite.config.js — minimal Vite config. No plugins, no asset pipeline: every
// texture and mesh in this project is generated procedurally at runtime, so
// there is nothing to transform at build time.
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, open: false },
  build: { target: 'es2020', sourcemap: true },
});
