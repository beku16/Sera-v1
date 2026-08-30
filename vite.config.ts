import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Emit modern syntax that targets evergreen browsers (Chrome/Edge/
      // Firefox/Safari latest 2 versions). Previously no target was set so
      // Vite defaulted to 'modules' (similar to 'esnext'), which emits the
      // most modern syntax but is fine for evergreen browsers; pinning it
      // here makes the intent explicit and protects against silent default
      // changes in future Vite versions.
      target: 'es2022',
      rollupOptions: {
        output: {
          // Split the heavy client deps into their own chunks. Previously
          // the entire client bundle collapsed into a single 889kB index
          // chunk (mostly three.js from SeraOrb). Splitting three.js /
          // react / lucide-react out lets the browser cache them
          // independently, and lets us lazy-load SeraOrb (the only three.js
          // consumer) so initial paint doesn't pay the three.js cost.
          manualChunks: {
            three: ['three'],
            'react-vendor': ['react', 'react-dom'],
            'icons': ['lucide-react'],
          },
        },
      },
      // The split chunks are intentionally larger than the default 500kB
      // warning threshold (three.js alone is ~600kB). Raise the limit so
      // the build doesn't emit noise warnings about chunks we've already
      // explicitly split out.
      chunkSizeWarningLimit: 1024,
    },
    test: {
      environment: 'jsdom',
      exclude: ['**/node_modules/**', '**/backups/**', '**/dist/**'],
      // The deep-scan diagnostic tests run ~45 checks (several spawn
      // child processes or do network probes). 5s default is too tight.
      testTimeout: 60000,
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: [
          '**/sera_memories*.json',
          '**/.data/**',
          '**/*.bak.*',
          '**/*.bak',
          '**/backups/**',
          '**/tmp/**',
          '**/.scratch/**',
          '**/*.tmp',
          '**/*.log',
        ],
      },
    },
  };
});
