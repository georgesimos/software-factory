import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './' so the build also loads from file:// (Electron) and under any path `F ui` serves it from.
export default defineConfig({ base: './', plugins: [react()], server: { port: 5200, strictPort: true }, preview: { port: 5200, strictPort: true } });
