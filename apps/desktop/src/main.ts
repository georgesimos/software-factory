import { app, BrowserWindow, session, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { APP_HTML, serve } from '@software-factory/server';

// F ui in this process, in one window (#56). The page is the same app.html F ui serves, loaded from the loopback server
// with its token, so it can save settings and start sessions. Sandboxed, no preload, no Node in the page; nothing loads
// from anywhere but that origin. The server lives as long as the window: closing it quits, and quitting stops the
// sessions it started and closes the server. One instance: a second server on the same FACTORY_DIR could start a
// second session on the same run and worktree.
let win: BrowserWindow | undefined;
let close: (() => void) | undefined;

// Off-origin links (GitHub PRs, issues) open in the browser; claude-cli://open opens a Claude Code terminal. Nothing else.
const external = (url: string) => {
  if (url.startsWith('https://') || url.startsWith('claude-cli://open?')) void shell.openExternal(url);
};
const originOf = (url: string) => { try { return new URL(url).origin; } catch { return ''; } };

// app.html's own inline scripts by hash; the #data JSON block is not a script. Inline styles: React's style attributes.
function csp() {
  const hashes = [...fs.readFileSync(APP_HTML, 'utf8').matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]!).digest('base64')}'`);
  return `default-src 'self'; script-src ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

async function start() {
  const s = await serve(0); // listen first: the window has nothing to load before this
  close = s.close;
  const origin = new URL(s.url).origin, policy = csp();
  const ses = session.defaultSession;
  const allowed = (permission: string, from: string) => permission === 'clipboard-sanitized-write' && originOf(from) === origin; // the Copy buttons
  ses.setPermissionRequestHandler((_wc, permission, done, details) => done(allowed(permission, details.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed(permission, requestingOrigin));
  ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !(d.url.startsWith(`${origin}/`) || d.url.startsWith('data:')) }));
  ses.webRequest.onHeadersReceived((d, done) => done({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': [policy] } }));
  win = new BrowserWindow({
    width: 1280, height: 860, title: 'Software Factory',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${origin}/`)) { e.preventDefault(); external(url); } });
  win.webContents.on('will-redirect', (e, url) => { if (!url.startsWith(`${origin}/`)) e.preventDefault(); });
  await win.loadURL(s.url);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.enableSandbox();
  app.on('window-all-closed', () => app.quit()); // on macOS too: the server goes with the window
  app.on('before-quit', () => { close?.(); close = undefined; }); // detached harness sessions (Windows: taskkill /T), then SSE and the server
  app.whenReady().then(start).catch((e) => { console.error(`factory desktop: ${e?.message ?? e}`); close?.(); app.exit(1); });
}
