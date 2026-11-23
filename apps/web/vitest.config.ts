import { defineConfig } from 'vitest/config';

// The design system's setup: cleanup plus the <dialog> polyfill the run sheet needs under jsdom.
export default defineConfig({ test: { environment: 'jsdom', setupFiles: ['../../packages/design-system/test/setup.ts'], css: false, testTimeout: 15_000 } });
