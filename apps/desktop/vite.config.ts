import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// The Electron main, the server and core as plain JS (#56). A packaged app's code sits under node_modules, where Node
// won't strip types. preserveModules keeps the repo layout under dist/, so every import.meta.dirname path still lands
// (server → factory/app.html, project → factory/templates, ship → ship/ship.mjs). The plugin folders are read with
// readdir + import(), so each plugin is an entry of its own, and every output is .mjs to pass the loaders' filters.
const root = path.resolve(import.meta.dirname, '../..');
const plugins = (dir: string) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).map((f) => path.join(root, dir, f));
const COPY = ['packages/factory/app.html', 'packages/factory/templates']; // data the code reads at run time

export default defineConfig({
  build: {
    ssr: true,
    target: 'esnext',
    minify: false,
    emptyOutDir: true,
    rollupOptions: {
      input: [
        path.join(import.meta.dirname, 'src/main.ts'),
        path.join(root, 'packages/ship/ship.mjs'),
        ...['packages/adapters/harnesses', 'packages/adapters/hosts', 'packages/adapters/trackers', 'packages/ship/connectors'].flatMap(plugins),
      ],
      external: ['electron', 'node-pty', '@anthropic-ai/claude-agent-sdk'], // native, or spawns files of its own: shipped in node_modules
      output: { format: 'es', preserveModules: true, preserveModulesRoot: root, entryFileNames: '[name].mjs' },
    },
  },
  ssr: { noExternal: true, external: ['electron'] },
  plugins: [{
    name: 'copy-data',
    writeBundle({ dir }) { for (const p of COPY) fs.cpSync(path.join(root, p), path.join(dir!, p), { recursive: true }); },
  }],
});
