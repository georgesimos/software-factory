import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// One self-contained index.html (#55): F render writes it with the run data filled in, the claude.ai Artifact publishes it,
// and F ui serves it, so it can load nothing from anywhere. Fonts become data URIs; the CSS and the one JS chunk are inlined.
// The script goes last in <body>, after the #data tag and every tag artifact() strips, so no match can land inside it.
function singleFile(): Plugin {
  return {
    name: 'single-file',
    enforce: 'post',
    generateBundle(_, bundle) {
      const html = Object.values(bundle).find((x) => x.fileName === 'index.html');
      if (html?.type !== 'asset') throw new Error('single-file: no index.html');
      let page = String(html.source);
      for (const [name, x] of Object.entries(bundle)) {
        if (x.type === 'chunk' && x.isEntry) {
          const js = x.code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--'); // nothing in it may end or comment the tag
          page = page.replace(new RegExp(`\\s*<script type="module" crossorigin src="\\./${name}"></script>`), '');
          page = page.replace('</body>', () => `<script type="module">${js}</script>\n</body>`);
        } else if (x.type === 'asset' && name.endsWith('.css')) {
          page = page.replace(new RegExp(`<link rel="stylesheet" crossorigin href="\\./${name}">`), () => `<style>${String(x.source)}</style>`);
        } else if (name !== 'index.html') continue;
        if (name !== 'index.html') delete bundle[name];
      }
      if (/\s(?:src|href)="\.\//.test(page) || Object.keys(bundle).length !== 1) throw new Error(`single-file: something is still external: ${Object.keys(bundle).join(', ')}`);
      html.source = page;
    },
  };
}

// base './' so the build also loads from file:// (F render, Electron) and under any path F ui serves it from.
export default defineConfig({
  base: './',
  plugins: [react(), singleFile()],
  build: { assetsInlineLimit: () => true, cssCodeSplit: false, rollupOptions: { output: { inlineDynamicImports: true } } },
  server: { port: 5200, strictPort: true },
  preview: { port: 5200, strictPort: true },
});
