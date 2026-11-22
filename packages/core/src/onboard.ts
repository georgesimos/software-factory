// @ts-nocheck
import fs from 'node:fs';
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
export const F_CMD = 'node ~/.claude/skills/software-factory/factory.mjs';
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
export function onboardText(s) {
  const mark = (b) => (b ? '✓' : b === null || b === undefined ? '?' : '✗'), L = [], scopes = ['default', ...Object.keys(s.projects)];
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
  L.push('', '6. Start', '   In Claude Code: /software-factory <owner/repo>#<issue>', `   What's ready: ${F_CMD} queue <owner/repo>   ·   Live setup: ${F_CMD} ui`);
  return L.join('\n');
}
