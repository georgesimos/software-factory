// Copied into the packaged app's folder by scripts/smoke.mjs and run there by the app's own binary as Node: its runtime
// dependencies resolve from that folder's node_modules, under Electron's Node. Prints one JSON line.
import pty from 'node-pty';
import { query } from '@anthropic-ai/claude-agent-sdk';

const out = await new Promise((resolve) => { // a real pseudo-terminal (ConPTY on Windows): the binary echoes as Node
  let data = '';
  const p = pty.spawn(process.execPath, ['-e', 'console.log("pty ok")'], { cols: 80, rows: 24, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  p.onData((d) => { data += d; });
  p.onExit(({ exitCode }) => resolve({ data, exitCode }));
});
console.log(JSON.stringify({ pty: out.data.includes('pty ok') && out.exitCode === 0, sdk: typeof query === 'function' }));
