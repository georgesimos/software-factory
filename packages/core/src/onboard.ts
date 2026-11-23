// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkScope, rules } from './rules.ts';
import { dashboard } from './log.ts';
import { hooks, shipConnectors } from './ship.ts';
import { discover } from './sync.ts';
import { harnesses } from '../../adapters/harnesses/index.mjs';
import { projects } from './workspace.ts';
import { readSkills, skillsData } from './skills.ts';
import { stateDir } from './log.ts';

// ---- Onboarding: the wizard (dashboard, via `F ui`) and `F onboard`. What spawns CLIs or walks the disk runs only
// when asked for, never in page(), which runs on every record().
// The command for this copy of F: the short ~ form when ~/.claude/skills/software-factory links here, else this file's real
// path (a plugin install lives in Claude Code's plugin cache). cmd.exe and PowerShell don't expand ~, so Windows always gets the real path.
// No bundled copy and no linked skill: a plugin-only install (#91), found through Claude Code's plugin registry.
// Claude Code's config dir: CLAUDE_CONFIG_DIR when set (a relative one resolves from the current folder), else ~/.claude.
export const claudeDir = (home = os.homedir(), env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude'));
// { cmd, via }: via is 'skill' (the linked skill), 'plugin' (found in the plugin registry) or 'self' (this file); null when there is no F.
export function fFound(platform = process.platform, home = os.homedir(), entry = path.join(import.meta.dirname, '..', '..', 'factory', 'factory.mjs'), env = process.env) {
  const linked = path.join(claudeDir(home, env), 'skills', 'software-factory', 'factory.mjs');
  let here = entry, viaLink = false;
  try { here = fs.realpathSync(entry); viaLink = fs.realpathSync(linked) === here; } catch { viaLink = !fs.existsSync(entry) && fs.existsSync(linked); } // the desktop build ships no factory.mjs: the installed skill's
  const via = viaLink ? 'skill' : fs.existsSync(entry) ? 'self' : 'plugin';
  if (via === 'plugin') here = pluginEntry(home, env);
  if (!viaLink && !here) return null; // no F on this machine at all: the page says to install it (fMissing)
  if (platform === 'win32') return { cmd: `node "${viaLink ? linked : here}"`, via };
  return { cmd: viaLink ? (env.CLAUDE_CONFIG_DIR ? `node ${shq(linked)}` : 'node ~/.claude/skills/software-factory/factory.mjs') : `node ${shq(here)}`, via };
}
export const fCmd = (...a) => fFound(...a)?.cmd ?? null;
// The software-factory plugin's factory.mjs from <config>/plugins/installed_plugins.json, which Claude Code writes as
// {"version":2,"plugins":{"<name>@<marketplace>":[{"scope","installPath","lastUpdated",…}]}}. Read as untrusted: only a string,
// absolute installPath whose factory.mjs really resolves inside <config>/plugins counts. User scope only (a project or local
// entry belongs to some other folder's project), the most recently updated first.
// shortcut: a disabled plugin (settings enabledPlugins) still counts; read the settings if that ever matters.
// shortcut: a local-marketplace install whose installPath is outside <config>/plugins is refused; use the linked skill there.
export function pluginEntry(home = os.homedir(), env = process.env) {
  try { return pluginEntryOrThrow(home, env); } catch { return null; } // a registry shape nobody foresaw must not break every page build
}
function pluginEntryOrThrow(home, env) {
  const dir = path.join(claudeDir(home, env), 'plugins');
  let reg, root;
  try { reg = JSON.parse(fs.readFileSync(path.join(dir, 'installed_plugins.json'), 'utf8')); root = fs.realpathSync(dir); } catch { return null; }
  const plugins = reg && typeof reg.plugins === 'object' && !Array.isArray(reg.plugins) ? reg.plugins : {};
  const found = Object.entries(plugins).filter(([k, v]) => k.startsWith('software-factory@') && Array.isArray(v)).flatMap(([, v]) => v).map((e) => {
    if (!e || e.scope !== 'user' || typeof e.installPath !== 'string' || !path.isAbsolute(e.installPath)) return null;
    let f;
    try { f = fs.realpathSync(path.join(e.installPath, 'packages', 'factory', 'factory.mjs')); } catch { return null; }
    const rel = path.relative(root, f);
    return rel && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel) ? { f, at: typeof e.lastUpdated === 'string' ? Date.parse(e.lastUpdated) || 0 : 0 } : null; // not a date: oldest
  }).filter(Boolean).sort((a, b) => b.at - a.at);
  return found[0]?.f ?? null;
}
export const shq = (x) => (/^[\w@%+=:,./~-]+$/.test(String(x)) ? String(x) : "'" + String(x).replace(/'/g, "'\\''") + "'");
export const onboardFile = () => path.join(stateDir(), 'onboard.json');
export const SHIP_KINDS = ['web', 'mobile', 'database'];
export const readOnboard = () => { try { return JSON.parse(fs.readFileSync(onboardFile(), 'utf8')); } catch { return {}; } };
// "What you ship" is only stored for now; packages/ship reads it once it exists.
export function setShip(scope, kinds) {
  checkScope(scope);
  if (!Array.isArray(kinds) || !kinds.every((k) => SHIP_KINDS.includes(k))) throw new Error(`ship must be a list of ${SHIP_KINDS.join('|')}`);
  const o = readOnboard();
  o[scope] = { ...o[scope], ship: SHIP_KINDS.filter((k) => kinds.includes(k)) }; // canonical order, so a re-run writes the same file
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(onboardFile() + '.tmp', JSON.stringify(o, null, 2));
  fs.renameSync(onboardFile() + '.tmp', onboardFile());
  dashboard.render();
  return o[scope];
}
// The cheap part, returned after every wizard write.
export function onboardConfig() {
  const ps = projects(), scopes = ['default', ...Object.keys(ps)];
  let ruleMap = {}, rulesError;
  try { const cfg = readSkills(); ruleMap = Object.fromEntries(scopes.map((s) => [s, rules(s, cfg)])); } catch (e) { rulesError = e.message; }
  return { projects: ps, ship: readOnboard(), skills: skillsData(Object.keys(ps)), rules: ruleMap, ...(rulesError && { rulesError }) };
}
export function onboardState() {
  const hs = harnesses.map((h) => {
    const d = h.detect() || {};
    return { id: h.id, label: h.label, install: h.install, installed: !!d.installed, version: d.version || null,
      login: d.installed ? h.login() : null, notes: d.installed ? h.notes?.() || [] : [], headless: h.headless?.() || null };
  });
  return { harnesses: hs, repos: discover(), hooks: { ...hooks(), connectors: shipConnectors() }, ...onboardConfig() };
}
export function onboardText(s, platform = process.platform) {
  const f = fFound(platform), F_CMD = f?.cmd ?? null; // now, not at import: a plugin installed while the app runs counts
  const mark = (b) => (b ? '✓' : b === null || b === undefined ? '?' : '✗'), L = [], scopes = ['default', ...Object.keys(s.projects)];
  if (platform === 'win32') L.push('The commands below quote for a POSIX shell: run them in Git Bash (cmd.exe and PowerShell read \'…\' differently).', '');
  L.push('1. Local AI');
  for (const h of s.harnesses) {
    L.push(`   ${mark(h.installed)} ${h.label}${h.version ? ' ' + h.version : ''}${h.installed ? '' : `   install: ${h.install}`}`);
    if (h.login) L.push(`     ${mark(h.login.ok)} login: ${h.login.hint}`);
    for (const n of h.notes) L.push(`     ${mark(n.ok)} ${n.label}: ${n.hint}`);
  }
  L.push('', '2. Repo');
  for (const [r, p] of Object.entries(s.projects)) L.push(`   ✓ ${r}  ${p.path}`);
  for (const r of s.repos.filter((r) => !r.attached)) L.push(`   · ${r.repo}   ${F_CMD} sync ${r.repo} ${shq(r.path)}`);
  if (!s.repos.length && !Object.keys(s.projects).length) L.push(`   no GitHub clones found: ${F_CMD} discover <folder>`);
  L.push(`   ${s.hooks.create ? '·' : '-'} Create from an idea: ${s.hooks.create ? `/software-factory new: <idea>  (or ${F_CMD} new "<idea>" --dry-run)` : 'coming soon'}`);
  L.push('', '3. What you ship');
  for (const sc of scopes) L.push(`   ${sc}: ${(s.ship[sc]?.ship || []).join(', ') || 'not chosen'}   ${F_CMD} onboard ship ${sc} web,mobile,database`);
  const c = s.hooks.connectors;
  L.push(`   connectors: ${Array.isArray(c) ? c.map((x) => `${x.label} (${x.kind})`).join(', ') || 'none yet' : c?.error ? 'error: ' + c.error : 'coming soon'}`);
  L.push('', '4. Workflow');
  for (const sc of scopes) {
    const plan = s.skills.plans?.[sc]?.plan || {}, set = Object.entries(plan).filter(([, r]) => r.use !== 'default');
    L.push(`   ${sc}: ${set.map(([k, r]) => `${k}=${r.name || r.harness || r.path}`).join(', ') || 'factory defaults'}`);
  }
  L.push(`   ${F_CMD} skills set <scope> <step> '{"use":"provider","harness":"${s.harnesses[0]?.id || '<harness>'}"}'   (catalog: ${F_CMD} skills catalog)`);
  L.push('', '5. Rules');
  for (const sc of scopes) {
    const pol = Object.entries(s.rules[sc]?.policy || {}).filter(([, x]) => x.scope === sc);
    const am = sc === 'default' ? '' : `   auto-merge ${s.projects[sc]?.autoMerge === false ? 'off' : 'on'}`;
    L.push(`   ${sc}: ${pol.map(([k, x]) => `${k}=${JSON.stringify(x.value)}`).join(', ') || 'built-in'}${am}`);
  }
  L.push(`   ${F_CMD} rules set <scope> ci required|advisory|skip --reason "…"   ·   ${F_CMD} automerge <owner/repo> on|off`);
  L.push('', '6. Start', `   In Claude Code: ${f?.via === 'skill' ? '/software-factory' : f?.via === 'plugin' ? '/software-factory:software-factory' : '/software-factory:software-factory (plugin) or /software-factory'} <owner/repo>#<issue>`, `   What's ready: ${F_CMD} queue <owner/repo>   ·   Live setup: ${F_CMD} ui`);
  return L.join('\n');
}
