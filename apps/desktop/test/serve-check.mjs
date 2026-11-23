// Run by build.test.mjs under plain node and under Electron-as-node: imports the built tree from wherever it was copied
// (argv[2], inside a node_modules folder) and prints what the server found there.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const at = (p) => pathToFileURL(path.join(process.argv[2], p)).href;
const { serve } = await import(at('packages/server/src/server.mjs'));
const { loadTemplates } = await import(at('packages/core/src/project.mjs'));
const { server, url } = await serve(0);
const u = new URL(url), t = u.searchParams.get('t');
try {
  const page = await (await fetch(url)).text();
  const onboard = await (await fetch(`${u.origin}/api/onboard`, { method: 'POST', headers: { 'x-factory-token': t, origin: u.origin, 'content-type': 'application/json' }, body: '{}' })).json();
  console.log(JSON.stringify({
    node: process.versions.node,
    page: /<script type="application\/json" id="data">/.test(page),
    noToken: (await fetch(`${u.origin}/api/state`)).status,
    harnesses: onboard.harnesses?.map((h) => h.id),
    connectors: onboard.hooks?.connectors?.map((c) => c.id),
    templates: Object.keys(loadTemplates()),
  }));
} finally { server.closeAllConnections(); server.close(); }
