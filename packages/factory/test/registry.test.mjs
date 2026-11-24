// Provider folders load <id>.mjs and <id>.ts alike (#52): one filter, the id is the file name, a compiled twin is refused,
// and an import failure names its file. A .ts file never gains an id or a slot a .mjs one couldn't have.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { importPlugin, loadDir, pluginFiles } from '../../adapters/registry.mjs';
import { load as loadHarnesses } from '../../adapters/harnesses/index.mjs';
import { REQUIRED as HOST_FNS } from '../../adapters/hosts/index.mjs';

const ADAPTERS = path.join(import.meta.dirname, '..', '..', 'adapters');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-registry-')));
const put = (dir, files) => { for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); } return dir; };
const HOST = (id) => `export const id: string = '${id}';\nexport const authStatus = (): { ok: boolean } => ({ ok: true });\nexport const createRepo = () => ({ created: true, url: 'x' });\nexport const pushInitial = () => ({ pushed: true });\n`;

test('pluginFiles: .mjs and .ts; never index.*, _* or declaration files; sorted by file name', () => {
  const d = put(tmp(), Object.fromEntries(['b.ts', 'a.mjs', 'a-b.mjs', 'index.mjs', 'index.ts', '_template.mjs', '_x.ts', 'c.d.ts', 'c.d.mts', 'index.d.mts', 'notes.md', 'x.js', 'y.mts', 'z.cjs'].map((f) => [f, ''])));
  assert.deepEqual(pluginFiles(d), ['a-b.mjs', 'a.mjs', 'b.ts']); // a-b before a, as an .mjs-only folder always sorted
});

test('a .ts beside its .mjs twin is one provider twice: refused, saying to remove one', async () => {
  const d = put(tmp(), { 'fake.mjs': HOST('fake').replaceAll(': string', '').replace(': { ok: boolean }', ''), 'fake.ts': HOST('fake') });
  assert.throws(() => pluginFiles(d), /fake\.mjs and fake\.ts are both provider "fake": remove one/);
  await assert.rejects(loadDir(d, HOST_FNS), /remove one/);
  const h = put(tmp(), { 'codex.mjs': fs.readFileSync(path.join(ADAPTERS, 'harnesses', 'codex.mjs'), 'utf8'), 'codex.ts': fs.readFileSync(path.join(ADAPTERS, 'harnesses', 'codex.mjs'), 'utf8') });
  await assert.rejects(loadHarnesses(h), /codex\.mjs and codex\.ts are both provider "codex": remove one/);
});

test('a .ts host or tracker must export its file name as id, exactly as a .mjs must', async () => {
  for (const ext of ['mjs', 'ts']) {
    const src = ext === 'ts' ? HOST('github') : HOST('github').replaceAll(': string', '').replace(': { ok: boolean }', '');
    await assert.rejects(loadDir(put(tmp(), { [`mine.${ext}`]: src }), HOST_FNS), new RegExp(`^Error: mine\\.${ext}: must export id = "mine"$`));
  }
  assert.deepEqual(Object.keys(await loadDir(put(tmp(), { 'mine.ts': HOST('mine') }), HOST_FNS)), ['mine']);
});

// FACTORY_HARNESSES replaces the harness folder (the self-test's registry). launchGate (host) and the codex sandbox
// allow-list key on the ids, so a .ts copy must load as the very same harness, and a .ts can't claim another's id.
test('FACTORY_HARNESSES: claude-code.ts and codex.ts load exactly as the .mjs files do; a mismatched id is refused alike', async () => {
  const src = (f) => fs.readFileSync(path.join(ADAPTERS, 'harnesses', f), 'utf8');
  const asMjs = await loadHarnesses(put(tmp(), { 'claude-code.mjs': src('claude-code.mjs'), 'codex.mjs': src('codex.mjs') }));
  const asTs = await loadHarnesses(put(tmp(), { 'claude-code.ts': src('claude-code.mjs'), 'codex.ts': src('codex.mjs') }));
  const shape = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, typeof v === 'function' ? String(v) : v]));
  assert.deepEqual(asTs.map(shape), asMjs.map(shape));
  assert.deepEqual(asTs.map((h) => [h.id, !!h.host]), [['claude-code', true], ['codex', false]]); // launchGate: only claude-code drives a run
  for (const [i, h] of asTs.entries()) for (const opts of [{ mode: 'headless', prompt: 'p' }, { mode: 'headless', prompt: 'p', write: true, resume: 'abc-1' }, { mode: 'terminal' }]) {
    assert.deepEqual(h.launch(opts), asMjs[i].launch(opts), `${h.id} ${JSON.stringify(opts)}`); // codex: the same sandbox argv
  }
  for (const ext of ['mjs', 'ts']) { // a file claiming the host's id under another name
    await assert.rejects(loadHarnesses(put(tmp(), { [`mine.${ext}`]: src('claude-code.mjs') })), new RegExp(`harnesses/mine\\.${ext}: id must be lowercase and equal the file name`));
  }
});

test('an import failure names its file, for .mjs and .ts alike; a .ts under node_modules says so', async () => {
  for (const ext of ['mjs', 'ts']) await assert.rejects(loadDir(put(tmp(), { [`broken.${ext}`]: 'export const = ;\n' }), HOST_FNS), new RegExp(`^Error: broken\\.${ext}: `));
  const nm = put(tmp(), { 'node_modules/p/x.ts': HOST('x') });
  await assert.rejects(loadDir(path.join(nm, 'node_modules', 'p'), HOST_FNS), { message: /^x\.ts: .*node_modules/, code: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING' }); // Node's code kept
  await assert.rejects(loadDir(put(tmp(), { 'kind.ts': `enum K { A }\n${HOST('kind')}` }), HOST_FNS), { message: /^kind\.ts: .*enum/i, code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' }); // strip-only: no enum
  await assert.rejects(loadHarnesses(put(tmp(), { 'x.ts': 'export default {;\n' })), /^Error: harnesses\/x\.ts: /);
});

test('where Node strips no types, a .ts provider is refused up front, naming the file and the .mjs to use; .mjs still loads', async () => {
  const d = put(tmp(), { 'mine.ts': HOST('mine') });
  await assert.rejects(importPlugin(d, 'mine.ts', 'mine.ts', false), /^Error: mine\.ts: this Node doesn't strip TypeScript types .*: use mine\.mjs$/);
  const m = put(tmp(), { 'mine.mjs': HOST('mine').replaceAll(': string', '').replace(': { ok: boolean }', '') });
  assert.equal((await importPlugin(m, 'mine.mjs', 'mine.mjs', false)).id, 'mine');
  // a real runtime with stripping off: the registry is plain JS, so it loads and refuses the .ts with its own message
  const out = execFileSync(process.execPath, ['--no-experimental-strip-types', '--input-type=module', '-e',
    `import { loadDir } from ${JSON.stringify(new URL('../../adapters/registry.mjs', import.meta.url).href)};
     console.log(process.features.typescript); await loadDir(${JSON.stringify(d)}, []).catch((e) => console.log(e.message));`], { encoding: 'utf8' });
  assert.match(out, /^false\nmine\.ts: this Node doesn't strip TypeScript types .*: use mine\.mjs\n$/);
});
