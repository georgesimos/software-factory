// An unsigned build of the desktop app for this OS and arch (#56): never signed, notarized, published or auto-updated.
// It packages a prepared folder, not this one: dist/ (the plain-JS build: main, server, core, plugins, app.html,
// templates) plus a flat npm install of the runtime dependencies the build leaves external (node-pty, the Agent SDK).
// No asar: node-pty's .node file and spawn-helper and the SDK's CLI must be real files. Out: out/<name>-<platform>-<arch>/.
// Run: pnpm --filter @software-factory/desktop package (after build)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { packager } from '@electron/packager';
import { chmodHelpers } from './pty-helper.mjs';

const HERE = path.join(import.meta.dirname, '..'), OUT = path.join(HERE, 'out'), APP = path.join(OUT, 'app');
const own = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
if (!fs.existsSync(path.join(HERE, own.main))) throw new Error('no build: run pnpm --filter @software-factory/desktop build first');
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(HERE, 'dist'), path.join(APP, 'dist'), { recursive: true });
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({
  name: 'software-factory', productName: 'Software Factory', version: '0.1.0', private: true, license: own.license,
  type: 'module', main: own.main, dependencies: own.dependencies, // exact versions, pinned in apps/desktop/package.json
}, null, 2));
// shortcut: npm resolves the transitive versions afresh (no lockfile for this folder); pin them if a release depends on it.
const npm = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: APP, stdio: 'inherit', shell: process.platform === 'win32' }); // npm.cmd
if (npm.status !== 0) throw new Error(`npm install failed (${npm.status ?? npm.error?.message})`);
chmodHelpers(path.join(APP, 'node_modules', 'node-pty'));
const [dir] = await packager({
  dir: APP, out: OUT, overwrite: true, asar: false, prune: false, // the folder holds runtime dependencies only
  name: 'Software Factory', executableName: 'software-factory', appBundleId: 'dev.software-factory.desktop',
  electronVersion: createRequire(import.meta.url)('electron/package.json').version, platform: process.platform, arch: process.arch,
});
console.log(`packaged: ${dir}`);
