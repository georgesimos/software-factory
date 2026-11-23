import { app, BrowserWindow, session, shell } from 'electron';
import type { Server } from 'node:http';
import { serve } from '@software-factory/server';

// F ui in this process, in one window (#56). The page is the same app.html F ui serves, loaded from the loopback server
// with its token, so it can save settings and start sessions. Sandboxed, no preload, no Node in the page; nothing loads
// from anywhere but that origin. The server lives as long as the window: closing it quits, and quitting closes the server.
let server: Server | undefined;

// Off-origin links (GitHub PRs, issues) open in the browser; claude-cli://open opens a Claude Code terminal. Nothing else.
const external = (url: string) => {
  if (url.startsWith('https://') || url.startsWith('claude-cli://open?')) void shell.openExternal(url);
};

async function start() {
  const s = await serve(0); // listen first: the window has nothing to load before this
  server = s.server;
  const origin = new URL(s.url).origin;
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !(d.url.startsWith(`${origin}/`) || d.url.startsWith('data:')) }));
  const win = new BrowserWindow({
    width: 1280, height: 860, title: 'Software Factory',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${origin}/`)) { e.preventDefault(); external(url); } });
  win.webContents.on('will-redirect', (e, url) => { if (!url.startsWith(`${origin}/`)) e.preventDefault(); });
  await win.loadURL(s.url);
}

app.enableSandbox();
app.on('window-all-closed', () => app.quit()); // on macOS too: the server goes with the window
app.on('will-quit', () => { server?.closeAllConnections(); server?.close(); }); // SSE streams included
app.whenReady().then(start).catch((e) => { console.error(`factory desktop: ${e?.message ?? e}`); app.exit(1); });
