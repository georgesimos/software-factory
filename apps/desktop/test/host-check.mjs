// Copied into the packaged app's folder by scripts/smoke.mjs and run there by the app's own binary as Node: its runtime
// dependencies resolve from that folder's node_modules, under Electron's Node. Prints one JSON line.
import pty from 'node-pty';
import { query } from '@anthropic-ai/claude-agent-sdk';
const { closePty } = await import(new URL('./dist/packages/adapters/sessions.mjs', import.meta.url).href); // the app's own close

// A real pseudo-terminal (ConPTY on Windows). The child echoes as Node, except on Windows: the app's binary is a windowed
// program there, and a pseudo-console never hears one, so the child is the console's own shell.
const win = process.platform === 'win32';
const [file, args] = win ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo pty ok']] : [process.execPath, ['-e', 'console.log("pty ok")']];
const out = await new Promise((resolve) => {
  let data = '';
  const p = pty.spawn(file, args, { cols: 80, rows: 24, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  p.onData((d) => { data += d; });
  p.onExit(({ exitCode }) => {
    if (win) closePty(p, 'win32'); // ConPTY's pipes and output worker stay open until closed, and keep this process alive
    resolve({ data, exitCode });
  });
});
console.log(JSON.stringify({ pty: out.data.includes('pty ok') && out.exitCode === 0, sdk: typeof query === 'function' }));
