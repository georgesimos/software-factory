import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './' so the built files also load from file:// (how Electron will serve the renderer).
export default defineConfig({ base: './', plugins: [react()], server: { port: 5199, strictPort: true } });
