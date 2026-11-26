// Copied into the packaged app's folder by scripts/smoke.mjs and run there by the app's own binary as Node: its runtime
// dependencies resolve from that folder's node_modules, under Electron's Node. Prints one JSON line.
import pty from 'node-pty';
import { query } from '@anthropic-ai/claude-agent-sdk';

const t0 = Date.now(), say = (...a) => process.stderr.write(`[${Date.now() - t0}ms] ${a.join(' ')}\n`); // DIAG
const live = () => JSON.stringify(process.getActiveResourcesInfo()); // DIAG
setTimeout(() => { say('watchdog: still alive', live()); process.exit(3); }, 25_000).unref(); // DIAG
// a real pseudo-terminal (ConPTY on Windows). On Windows the app's binary is a windowed program, which a pseudo-console
// never hears, so the child there is the console's own shell
const [file, args] = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo pty ok']] : [process.execPath, ['-e', 'console.log("pty ok")']];
let p;
const out = await new Promise((resolve) => {
  let data = '';
  p = pty.spawn(file, args, { cols: 80, rows: 24, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  p.onData((d) => { data += d; });
  p.onExit(({ exitCode }) => resolve({ data, exitCode }));
});
say('exit', JSON.stringify(out), live());
console.log(JSON.stringify({ pty: out.data.includes('pty ok') && out.exitCode === 0, sdk: typeof query === 'function' }));
setTimeout(() => { say('1s after print', live()); if (process.env.DIAG_KILL !== '0') { try { p.kill(); say('killed'); } catch (e) { say('kill threw', e.message); } setTimeout(() => say('1s after kill', live()), 1000).unref(); } }, 1000).unref(); // DIAG
