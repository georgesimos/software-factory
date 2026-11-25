// Copied into the packaged app's folder by scripts/smoke.mjs and run there by the app's own binary as Node: its runtime
// dependencies resolve from that folder's node_modules, under Electron's Node. Prints one JSON line.
import pty from 'node-pty';
import { query } from '@anthropic-ai/claude-agent-sdk';

const t0 = Date.now(), say = (...a) => process.stderr.write(`[${Date.now() - t0}ms] ${a.join(' ')}\n`); // DIAG
setTimeout(() => { say('watchdog: still alive'); process.exit(3); }, 25_000).unref(); // DIAG
const probe = (file, args) => new Promise((resolve) => {
  let data = '';
  say('spawn', file, JSON.stringify(args));
  const p = pty.spawn(file, args, { cols: 80, rows: 24, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  say('pid', p.pid);
  p.onData((d) => { data += d; say('data', JSON.stringify(d)); });
  p.onExit((e) => { say('exit', JSON.stringify(e)); resolve({ data, exitCode: e.exitCode }); });
});
if (process.platform === 'win32') say('cmd probe', JSON.stringify(await probe(process.env.ComSpec ?? 'cmd.exe', ['/c', 'echo pty ok']))); // DIAG
const out = await probe(process.execPath, ['-e', 'console.log("pty ok")']);
say('done', JSON.stringify(out));
console.log(JSON.stringify({ pty: out.data.includes('pty ok') && out.exitCode === 0, sdk: typeof query === 'function' }));
say('printed');
