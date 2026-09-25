// vite.config.js — minimal Vite config. No plugins, no asset pipeline: every
// texture and mesh in this project is generated procedurally at runtime, so
// there is nothing to transform at build time.
//
// The one piece of real configuration is the `three` alias. The renderer is
// three's WebGPURenderer, which lives in the `three/webgpu` build — a complete
// copy of the core plus the node system. Addons under three/examples (for
// example BufferGeometryUtils) still `import 'three'`; without the alias they
// would pull in a *second* copy of the core, and `instanceof` checks
// (BufferGeometry, Texture, Material) would fail across the two copies. The
// regex only matches the bare specifier, so `three/webgpu` and `three/tsl`
// resolve normally.
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: { port: 5173, open: false },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4000 },
});
