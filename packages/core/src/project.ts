// Idea to app. One project run per new repo, `owner/repo:project`. Claude writes PLAN.md and issues.json (SKILL.md I0-I5);
// F validates them and executes: repo + scaffold through a host adapter, the issue batch through a tracker adapter, then a
// dependency-aware loop over the unchanged per-issue pipeline. Hosts and trackers are one file each; stacks are data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from './platform.ts';
import { fileURLToPath } from 'node:url';
import { read, runDir, factoryDir } from './log.ts';
import { rules, setRule } from './rules.ts';
import { adapterCtx } from './github.ts';
import { requireGithub } from './workspace.ts';
import { allRuns, budget } from './derive.ts';
import { isSensitive, PROJECT_BUDGET_USD, MAX_ISSUES_PER_SESSION } from './constants.ts';
import { claimedElsewhere, unclaimCmd, type Claim } from './claim.ts';
import { dashboard } from './log.ts';
import * as hosts from '../../adapters/hosts/index.ts';
import * as trackers from '../../adapters/trackers/index.ts';
import type { Ctx } from '../../adapters/hosts/index.ts';
import type { Item, OpenIssue } from '../../adapters/trackers/index.ts';
import type { FactoryEvent, Rule, Run } from './types.ts';

// The issue list a plan holds, and the issues a tracker created (with their ids).
type PlanIssue = { key: string; title: string; milestone?: string; dependsOn?: string[] };
type CreatedIssue = PlanIssue & { id: string; url: string | null; kind?: string };
export interface ProjectState {
  repo: string; id: string; started: string; updated?: string;
  idea?: string; stack?: string; visibility?: string; host?: string; tracker?: string; dryRun?: boolean;
  plan?: { vision: string; milestones: string[]; epic: string | null; issues: PlanIssue[]; hash: string };
  remote?: { url: string; path: string; visibility: string; host: string };
  created?: CreatedIssue[];
  loop: { state: string; picked: number; last?: string; reason?: string };
}
// The fields emit() writes on project events (FactoryEvent types `issues` as a split's issue numbers, not these).
type ProjectEvent = { ts: string; run: string; stage: string; status: string; idea: string; stack: string; visibility: string; host: string; tracker: string;
  dryRun?: boolean; vision: string; milestones: string[]; epic: string | null; issues: PlanIssue[] & CreatedIssue[]; hash: string; url: string; path: string; next: string; reason: string };
// Validated issues.json, and a stack template (factory/templates/<id>.json).
type Issue = { key: string; title: string; body: string; acceptance: string[]; dependsOn: string[]; milestone: string; files?: string[] };
export type Template = { id: string; name: string; description: string; notes?: string; init: string[][]; checks: string[]; files: Record<string, string> };

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Every project event, by stage. All are owned: `F event` refuses them, only new / issues create / loop record them.
export const PROJECT_EVENTS: Record<string, string[]> = { idea: ['started', 'retired'], plan: ['passed'], repo: ['created'], issues: ['created'], loop: ['running', 'stopped'] };
export const projectId = (repo: string) => `${repo}:project`;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,40}$/;
// true: a string that fits (false says nothing about the type: a long string is false too)
const oneLine = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\0-\x1f\x7f]/.test(s);
const checkRepo = (repo: string) => { if (!REPO.test(repo || '') || repo.endsWith('.git')) throw new Error(`repo must look like owner/name, got "${repo}"`); return repo; };

function emit(repo: string, stage: string, status: string, payload: Record<string, unknown> = {}) {
  if (!PROJECT_EVENTS[stage]?.includes(status)) throw new Error(`unknown project event "${stage} ${status}"`);
  const sid = process.env.CLAUDE_CODE_SESSION_ID; // as record(): lets measured burn close its windows
  const ev = { ts: new Date().toISOString(), ...payload, ...(sid ? { harness: 'claude-code', sessionId: sid, cwd: process.cwd() } : {}), run: projectId(repo), stage, status };
  fs.mkdirSync(factoryDir(), { recursive: true });
  fs.appendFileSync(path.join(factoryDir(), 'events.jsonl'), JSON.stringify(ev) + '\n');
  dashboard.render();
  return ev;
}

export function projectState(repo: string, events: FactoryEvent[] = read()): ProjectState | null {
  const id = projectId(repo);
  let p: ProjectState | null = null;
  for (const e of events as unknown as ProjectEvent[]) {
    if (e.run !== id || !PROJECT_EVENTS[e.stage]) continue;
    if (e.status === 'retired') { p = null; continue; } // read-time skip: a retired idea is gone; a later "idea started" begins afresh
    p ??= { repo, id, started: e.ts, loop: { state: 'idle', picked: 0 } };
    p.updated = e.ts;
    if (e.stage === 'idea') Object.assign(p, { idea: e.idea, stack: e.stack, visibility: e.visibility, host: e.host, tracker: e.tracker, dryRun: !!e.dryRun });
    if (e.stage === 'plan') p.plan = { vision: e.vision, milestones: e.milestones, epic: e.epic, issues: e.issues, hash: e.hash };
    if (e.stage === 'repo') p.remote = { url: e.url, path: e.path, visibility: e.visibility, host: e.host };
    if (e.stage === 'issues') p.created = e.issues;
    if (e.status === 'running') p.loop = { state: 'running', picked: (p.loop.state === 'running' ? p.loop.picked : 0) + 1, last: e.next };
    if (e.status === 'stopped') p.loop = { ...p.loop, state: 'stopped', reason: e.reason };
  }
  return p;
}

// ---------- validation: what Claude wrote is untrusted until it passes ----------
const PLAN_SECTIONS = ['Vision', 'MVP scope', 'Non-goals', 'Stack', 'Milestones'];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function validatePlan(text: unknown) {
  if (typeof text !== 'string' || text.length > 30000) throw new Error('PLAN.md must be text, at most 30000 characters');
  const sec: Record<string, string> = {};
  let cur: string | null = null;
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cur = norm(h[1]!); sec[cur] = ''; } else if (cur) sec[cur] += line + '\n';
  }
  const missing = PLAN_SECTIONS.filter((s) => !sec[norm(s)]?.trim());
  if (missing.length) throw new Error(`PLAN.md needs non-empty "## ${PLAN_SECTIONS.join('", "## ')}" sections; missing or empty: ${missing.join(', ')}`);
  // both sections are there: missing would have thrown
  const vision = sec.vision!.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, ' ').slice(0, 400);
  return { vision, milestonesText: sec.milestones! };
}

/** A planted "<!-- factory-key: … -->" would let a re-run adopt the wrong item: F writes the markers itself. */
export const NO_MARK = 'no "<!--" in the title, body or acceptance: F writes the item\'s markers itself';
export const marked = (texts: unknown[]) => texts.some((t) => typeof t === 'string' && t.includes('<!--'));
const ISSUE_FIELDS = ['key', 'title', 'body', 'acceptance', 'dependsOn', 'milestone', 'files'];
const relPath = (f: unknown) => typeof f === 'string' && f.length <= 200 && !f.startsWith('/') && !f.includes('\\') && !/^[A-Za-z]:/.test(f) && !f.split('/').includes('..') && !/[\0-\x1f]/.test(f);

// -> { epic, issues } with issues in dependency order (stable: the file's order wherever the dependencies allow).
// doc: parsed JSON, untrusted, so `any` until each field is checked.
export function validateIssues(doc: any, milestonesText?: string): { epic?: { title: string; body?: string }; issues: Issue[] } {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('issues.json must be an object: {"epic"?: {title, body}, "issues": [...]}');
  const top = Object.keys(doc).filter((k) => !['epic', 'issues'].includes(k));
  if (top.length) throw new Error(`issues.json has unknown fields: ${top.join(', ')}`);
  if (doc.epic !== undefined) {
    const bad = Object.keys(doc.epic || {}).filter((k) => !['title', 'body'].includes(k));
    if (!doc.epic || bad.length || !oneLine(doc.epic.title, 120) || (doc.epic.body !== undefined && (typeof doc.epic.body !== 'string' || doc.epic.body.length > 4000))) throw new Error('epic must be {title: one line, at most 120 characters, body?: text}');
    if (marked([doc.epic.title, doc.epic.body])) throw new Error(`epic: ${NO_MARK}`);
  }
  if (!Array.isArray(doc.issues) || !doc.issues.length || doc.issues.length > 40) throw new Error('issues must be an array of 1-40 issues');
  const keys = new Set<string>();
  for (const [n, i] of doc.issues.entries()) {
    const at = `issues[${n}]${i?.key ? ` "${i.key}"` : ''}`;
    if (!i || typeof i !== 'object' || Array.isArray(i)) throw new Error(`${at}: must be an object`);
    const bad = Object.keys(i).filter((k) => !ISSUE_FIELDS.includes(k));
    if (bad.length) throw new Error(`${at}: unknown fields ${bad.join(', ')} (${ISSUE_FIELDS.join('|')})`);
    if (!KEY.test(i.key || '') || i.key === 'epic') throw new Error(`${at}: key must be lowercase-with-dashes, at most 41 characters, and not "epic"`);
    if (keys.has(i.key)) throw new Error(`${at}: duplicate key`);
    if (i.key.startsWith('split-')) throw new Error(`${at}: key "${i.key}": split-N-M keys are F split's`);
    keys.add(i.key);
    if (!oneLine(i.title, 120)) throw new Error(`${at}: title must be one line, at most 120 characters`);
    if (typeof i.body !== 'string' || i.body.length > 4000) throw new Error(`${at}: body must be text, at most 4000 characters`);
    if (!Array.isArray(i.acceptance) || !i.acceptance.length || i.acceptance.length > 10 || !i.acceptance.every((a: unknown) => oneLine(a, 300))) throw new Error(`${at}: acceptance must be 1-10 one-line criteria`);
    if (marked([i.title, i.body, ...i.acceptance])) throw new Error(`${at}: ${NO_MARK}`);
    if (i.dependsOn !== undefined && !(Array.isArray(i.dependsOn) && i.dependsOn.every((k: unknown) => typeof k === 'string'))) throw new Error(`${at}: dependsOn must be an array of keys`);
    if (!oneLine(i.milestone, 80)) throw new Error(`${at}: milestone must be one line`);
    if (milestonesText !== undefined && !milestonesText.toLowerCase().includes(i.milestone.toLowerCase())) throw new Error(`${at}: milestone "${i.milestone}" is not in PLAN.md's Milestones section`);
    if (i.files !== undefined && !(Array.isArray(i.files) && i.files.length <= 30 && i.files.every(relPath))) throw new Error(`${at}: files must be up to 30 relative paths`);
  }
  for (const i of doc.issues) for (const d of i.dependsOn || []) {
    if (!keys.has(d)) throw new Error(`"${i.key}" depends on unknown key "${d}"`);
    if (d === i.key) throw new Error(`"${i.key}" depends on itself`);
  }
  const done = new Set<string>(), order: Issue[] = [];
  let left: Issue[] = doc.issues.map((i: Issue) => ({ ...i, dependsOn: [...new Set(i.dependsOn || [])] }));
  while (left.length) { // each step takes the first issue, in file order, whose dependencies are all placed
    const next = left.find((i) => i.dependsOn.every((d) => done.has(d)));
    if (!next) throw new Error(`dependency cycle between: ${left.map((i) => i.key).join(', ')}`);
    done.add(next.key); order.push(next);
    left = left.filter((i) => i !== next);
  }
  return { epic: doc.epic, issues: order };
}

// Issues whose planned files are sensitive: they will escalate to a human however well they go. Shown at the batch approval.
export const willEscalate = (issues: Issue[]) => issues.map((i) => ({ key: i.key, paths: (i.files || []).filter(isSensitive) })).filter((x) => x.paths.length);

// ---------- stack templates: data files ----------
const TPL_FIELDS = ['id', 'name', 'description', 'notes', 'init', 'checks', 'files'];
// t: parsed JSON, untrusted, so `any` until each field is checked.
export function checkTemplate(t: any, id: string): Template {
  const at = `templates/${id}.json`;
  const bad = Object.keys(t || {}).filter((k) => !TPL_FIELDS.includes(k));
  if (bad.length) throw new Error(`${at}: unknown fields ${bad.join(', ')}`);
  if (t.id !== id) throw new Error(`${at}: id must be "${id}"`);
  if (!oneLine(t.name, 60) || !oneLine(t.description, 300)) throw new Error(`${at}: needs a one-line name and description`);
  if (!Array.isArray(t.init) || t.init.length > 10 || !t.init.every((a: unknown) => Array.isArray(a) && a.length >= 1 && a.length <= 40 && /^[\w.-]+$/.test(a[0]) && a.every((x) => typeof x === 'string' && !/[\0\r\n]/.test(x)))) throw new Error(`${at}: init must be up to 10 argv lists (no shell), each starting with a program name`);
  if (!Array.isArray(t.checks) || !t.checks.length || t.checks.length > 10 || !t.checks.every((c: unknown) => oneLine(c, 300))) throw new Error(`${at}: checks must be 1-10 one-line commands (they become the checks.commands rule)`);
  const files = Object.entries(t.files || {});
  if (!files.length || files.length > 40 || !files.every(([f, s]) => relPath(f) && !/^\.git(\/|$)/.test(f) && typeof s === 'string')) throw new Error(`${at}: files must map 1-40 relative paths (not .git/) to text`);
  return t;
}

export function loadTemplates(dir = process.env.FACTORY_TEMPLATES || path.join(HERE, '..', '..', 'factory', 'templates')) {
  const out: Record<string, Template> = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) out[f.slice(0, -5)] = checkTemplate(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), f.slice(0, -5));
  return out;
}

const fill = (text: string, vars: Record<string, string | undefined>) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(v), text);
const varsFor = (repo: string, idea: string | undefined, t: Template) => ({ repo, name: repo.split('/')[1], idea, stack: t.id, checks: t.checks.map((c) => `- \`${c}\``).join('\n') });
export const goalFor = (checks: string[]) => `${checks.map((c) => `\`${c}\``).join(', ')} exit 0, only files listed in the spec changed, or stop after 20 turns`;

// ---------- idea started: shared by `F new` and the `F ui` wizard endpoint ----------
type IdeaOpts = { repo: string; idea: unknown; stack?: string; visibility?: string; host?: string; tracker?: string; dryRun?: boolean };
export function startIdea({ repo, idea, stack = 'next-web', visibility = 'private', host = 'github', tracker = 'github-issues', dryRun = false }: IdeaOpts): ProjectState {
  checkRepo(repo);
  if (!oneLine(idea, 500) || idea.trim().length < 3) throw new Error('idea must be one line, 3-500 characters');
  idea = idea.trim();
  if (!loadTemplates()[stack]) throw new Error(`unknown stack "${stack}" (${Object.keys(loadTemplates()).join('|')})`);
  if (!['private', 'public'].includes(visibility)) throw new Error('visibility must be private|public');
  const p = projectState(repo);
  if (p && p.idea !== idea) throw new Error(`${repo} already holds the idea "${p.idea}"; pick another --name`);
  if (!p) emit(repo, 'idea', 'started', { idea, stack, visibility, host, tracker, ...(dryRun && { dryRun }) });
  return projectState(repo)!; // there now: it was there or was just recorded
}

// `F retire`: hides an idea that never got a repo (e.g. a test fixture leaked into the real log) with an appended event,
// never by rewriting the log. The idea fields are repeated so an older F, which re-reads them on every "idea" event, sees no change.
export function retireIdea(repo: string, reason: unknown) {
  checkRepo(repo);
  if (!oneLine(reason, 500)) throw new Error('usage: retire <owner/repo> --reason "<why>"');
  const p = projectState(repo);
  if (!p) throw new Error(`no project ${repo}`);
  if (p.remote) throw new Error(`${repo} already has a repo (${p.remote.url}); only an idea that never got one can be retired`);
  return emit(repo, 'idea', 'retired', { idea: p.idea, stack: p.stack, visibility: p.visibility, host: p.host, tracker: p.tracker, reason: reason.trim() });
}

const slug = (s: string) => s.toLowerCase().replace(/^(an?|the)\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'new-app';
const sh = (argv: string[], cwd: string, log: string) => {
  const fd = fs.openSync(log, 'a');
  try { fs.writeSync(fd, `$ ${argv.join(' ')}\n`); exec(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, CI: '1' }, timeout: 20 * 60e3 }); }
  catch (e) { const x = e as { status?: number; signal?: string }; throw new Error(`${argv.join(' ')} failed (exit ${x.status ?? x.signal}); see ${log}:\n${fs.readFileSync(log, 'utf8').split('\n').slice(-20).join('\n')}`); }
  finally { fs.closeSync(fd); }
};
// Done only when F's own commit (the one that adds PLAN.md) is there: init tools such as create-next-app commit on their own,
// so a HEAD alone would let a re-run push a half-made scaffold.
const scaffolded = (git: Ctx['git'], dir: string) => { try { git('-C', dir, 'cat-file', '-e', 'HEAD:PLAN.md'); return true; } catch { return false; } };

// `F new`: a re-runnable state machine. Each call does the next step it can and says what it needs:
// needs-plan -> (dry-run) -> needs-confirmation -> created. Nothing remote happens under --dry-run or without --yes.
type NewOpts = { idea: unknown; name?: string; stack?: string; dryRun?: boolean; yes?: boolean; out?: string; dest?: string; visibility?: string; host?: string; tracker?: string };
export async function newProject({ idea, name, stack = 'next-web', dryRun = false, yes = false, out, dest, visibility = 'private', host: hostId = 'github', tracker = 'github-issues' }: NewOpts) {
  const H = await hosts.load(), T = await trackers.load(), ctx = adapterCtx();
  const host = H[hostId];
  if (!host) throw new Error(`unknown host "${hostId}" (${Object.keys(H).join('|')})`);
  if (!T[tracker]) throw new Error(`unknown tracker "${tracker}" (${Object.keys(T).join('|')})`);
  let login: string | null | undefined = null;
  if (!dryRun) { // first, and records nothing when it fails
    const a = host.authStatus(ctx);
    if (!a.ok) throw new Error(`${hostId} is not logged in (${a.detail || 'no details'}). Log in yourself (for GitHub: gh auth login), then run this again. The factory never creates accounts.`);
    login = a.login;
  }
  const repo = checkRepo(name || `${login || 'you'}/${slug(String(idea || ''))}`);
  const t = loadTemplates()[stack]!; // startIdea() below refuses an unknown stack before t is used
  let p = startIdea({ repo, idea, stack, visibility, host: hostId, tracker, dryRun });
  if (p.stack !== stack || p.visibility !== visibility) throw new Error(`${repo} was started with --stack ${p.stack} and ${p.visibility} visibility; keep them, or pick another --name`);
  const dir = runDir(projectId(repo)), planFile = path.join(dir, 'PLAN.md'), issuesFile = path.join(dir, 'issues.json');
  fs.mkdirSync(dir, { recursive: true });
  const base = { run: p.id, repo, stack, visibility, dir };
  if (!fs.existsSync(planFile) || !fs.existsSync(issuesFile)) return { ...base, status: 'needs-plan', write: [planFile, issuesFile], next: 'Write both files (SKILL.md I1), then run the same command again.' };
  const planText = fs.readFileSync(planFile, 'utf8'), issuesText = fs.readFileSync(issuesFile, 'utf8');
  const plan = validatePlan(planText);
  let doc;
  try { doc = JSON.parse(issuesText); } catch (e) { throw new Error(`issues.json is not JSON: ${(e as Error).message}`); }
  doc = validateIssues(doc, plan.milestonesText);
  const hash = crypto.createHash('sha256').update(planText + '\0' + issuesText).digest('hex').slice(0, 12);
  const summary = doc.issues.map((i) => ({ key: i.key, title: i.title, milestone: i.milestone, dependsOn: i.dependsOn }));
  const milestones = [...new Set(doc.issues.map((i) => i.milestone))];
  if (p.plan?.hash !== hash) p = (emit(repo, 'plan', 'passed', { vision: plan.vision, milestones, epic: doc.epic?.title || null, issues: summary, hash }), projectState(repo)!);
  dest = path.resolve(dest || p.remote?.path || repo.split('/')[1]!); // checkRepo(): owner/name
  const vars = varsFor(repo, p.idea, t), escalate = willEscalate(doc.issues);
  const wouldRun = [
    `${hostId}: create ${visibility} repo ${repo}`,
    ...t.init.map((a) => `in ${dest}: ${a.map((x) => (/[\s'"*$]/.test(x) ? JSON.stringify(x) : x)).join(' ')}`),
    `write ${[...Object.keys(t.files), 'PLAN.md'].join(', ')}; git commit; push to ${repo} main`,
    `F rules set ${repo} checks.commands '${JSON.stringify(t.checks)}'`,
  ];
  const preview = { ...base, plan: { vision: plan.vision, milestones }, order: summary.map((i) => i.key), willEscalate: escalate, checks: t.checks, wouldRun };
  if (dryRun) {
    const o = path.resolve(out || path.join(dir, 'dry-run'));
    for (const [f, text] of [...Object.entries(t.files).map(([f, s]) => [path.join('scaffold', f), fill(s, vars)] as const), ['PLAN.md', planText] as const, ['issues.json', issuesText] as const]) {
      fs.mkdirSync(path.dirname(path.join(o, f)), { recursive: true });
      fs.writeFileSync(path.join(o, f), text);
    }
    const { dir: _d, ...portable } = preview; // no machine paths in a file that may be committed
    fs.writeFileSync(path.join(o, 'dry-run.json'), JSON.stringify({ ...portable, wouldRun: wouldRun.map((w) => w.split(dest).join(`<path>/${repo.split('/')[1]}`)), issues: summary }, null, 2) + '\n');
    return { ...preview, status: 'dry-run', out: o, next: 'Nothing was created. Without --dry-run: confirm name and visibility with the user, then add --yes.' };
  }
  if (!yes) return { ...preview, status: 'needs-confirmation', next: `Checkpoint: show the user the plan, "${repo}" (${visibility}) and the stack, and get one yes. Then run again with --yes.` };
  const ok = (d: string) => !fs.existsSync(d) || !fs.readdirSync(d).length || scaffolded(ctx.git, d);
  if (!ok(dest)) throw new Error(`${dest} exists and is not empty; pass --path <empty folder>`);
  if (!p.remote) {
    const r = host.createRepo(ctx, { repo, visibility, description: p.idea });
    if (!r.created) throw new Error(`${repo} already exists on ${hostId} and this project did not create it; pick another --name`);
    emit(repo, 'repo', 'created', { url: r.url, host: hostId, visibility, path: dest });
  }
  if (!scaffolded(ctx.git, dest)) {
    fs.mkdirSync(dest, { recursive: true });
    const log = path.join(dir, 'scaffold.log');
    for (const argv of t.init) sh(argv, dest, log);
    for (const [f, s] of [...Object.entries(t.files), ['PLAN.md', planText] as const]) {
      fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
      fs.writeFileSync(path.join(dest, f), f === 'PLAN.md' ? s : fill(s, vars));
    }
    if (!fs.existsSync(path.join(dest, '.git'))) ctx.git('-C', dest, 'init', '-q', '-b', 'main');
    ctx.git('-C', dest, 'add', '-A');
    ctx.git('-C', dest, 'commit', '-q', '-m', `chore: scaffold from the ${t.id} stack template`);
  }
  host.pushInitial(ctx, { repo, path: dest }); // the one push to a default branch, into the repo this project just created
  if (JSON.stringify(rules(repo).policy['checks.commands']?.value) !== JSON.stringify(t.checks)) setRule(repo, 'checks.commands', JSON.stringify(t.checks), { reason: `from the ${t.id} stack template` });
  return { ...preview, status: 'created', url: projectState(repo)!.remote!.url, path: dest,
    next: [`F sync ${repo} ${dest}`, `Checkpoint: show the user the issue batch (F issues create ${repo} ${issuesFile}), get one yes, then add --yes`] };
}

// `F issues create`: validated, in dependency order, idempotent by key (local map written after every issue, plus the tracker's own lookup).
export async function issuesCreate(repo: string, file: string | undefined, { yes = false }: { yes?: boolean } = {}) {
  checkRepo(repo);
  if (!file) throw new Error('usage: issues create <owner/repo> <issues.json> [--yes]');
  const p = projectState(repo), dir = runDir(projectId(repo)), planFile = path.join(dir, 'PLAN.md');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: ${(e as Error).message}`); }
  doc = validateIssues(doc, fs.existsSync(planFile) ? validatePlan(fs.readFileSync(planFile, 'utf8')).milestonesText : undefined);
  const trackerId = p?.tracker || 'github-issues', tracker = (await trackers.load())[trackerId];
  if (trackerId === 'github-issues') requireGithub(repo, 'creating issues');
  if (!tracker) throw new Error(`unknown tracker "${trackerId}"`);
  const items: Item[] = [...doc.issues, ...(doc.epic ? [{ key: 'epic', kind: 'epic', title: doc.epic.title, body: doc.epic.body || '', children: doc.issues.map((i) => i.key) }] : [])];
  const list = items.map((i) => ({ key: i.key, title: i.title, ...(i.kind ? { kind: i.kind } : { milestone: i.milestone, dependsOn: i.dependsOn }) }));
  if (!yes) return { repo, tracker: trackerId, status: 'needs-approval', issues: list, willEscalate: willEscalate(doc.issues), next: 'Checkpoint: show the user this batch and get one yes, then run again with --yes.' };
  fs.mkdirSync(dir, { recursive: true });
  const mapFile = path.join(dir, 'issues-map.json');
  let map: Record<string, { id: string; url?: string | undefined }> = {};
  try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch { /* first run */ }
  const save = () => { fs.writeFileSync(mapFile + '.tmp', JSON.stringify(map, null, 2)); fs.renameSync(mapFile + '.tmp', mapFile); };
  const res = items.every((i) => map[i.key]) ? items.map((i) => ({ key: i.key, ...map[i.key]!, created: false })) // all known: no tracker calls
    : tracker.createIssues(adapterCtx(), { repo, items, existing: map, onCreated: (r) => { map[r.key] = { id: r.id, url: r.url }; save(); } });
  for (const r of res) map[r.key] = { id: r.id, url: r.url };
  save();
  const issues = list.map((i, n) => ({ ...i, id: res[n]!.id, url: res[n]!.url || null })); // res: one per item, in item order
  const created = res.filter((r) => r.created).length;
  if (created || JSON.stringify(p?.created) !== JSON.stringify(issues)) emit(repo, 'issues', 'created', { tracker: trackerId, created, issues });
  return { repo, tracker: trackerId, status: 'created', created, issues, next: `F sync ${repo} <clone path>, then F loop ${repo}` };
}

// ---------- queue: dependency-aware, from the tracker ----------
// An issue is ready when it is labelled factory:ready, not yet in the log, and every dependency is merged by the factory
// or no longer open (a human merged or closed it), and was not reverted after merge (it then blocks its dependents).
// shortcut: a closed dependency counts as done even if it was closed unbuilt.
async function scan(repo: string) {
  const trackerId = projectState(repo)?.tracker || 'github-issues', t = (await trackers.load())[trackerId];
  if (trackerId === 'github-issues') requireGithub(repo, 'reading the issue queue');
  if (!t) throw new Error(`unknown tracker "${trackerId}"`);
  const open = t.listOpen(adapterCtx(), { repo }), runs = allRuns(), ids = new Set(open.map((i) => i.id));
  const done = (id: string) => { const r = runs[`${repo}#${id}`]; return !r?.reverted && (r?.outcome === 'merged' || !ids.has(id)); };
  const fresh = (i: OpenIssue) => !runs[`${repo}#${i.id}`];
  const item = (i: OpenIssue) => ({ run: `${repo}#${i.id}`, title: i.title, ...(i.key && { key: i.key }) });
  const waits = (i: OpenIssue) => t.dependencies(i).filter((d) => !done(d));
  // A run another launcher holds (an F start before its first event) is never picked, and is listed with its way out.
  const held = new Map(open.filter(fresh).map((i) => [i.id, claimedElsewhere(`${repo}#${i.id}`)] as const).filter((x): x is readonly [string, Claim | null] => x[1] !== undefined));
  const ready = open.filter((i) => i.labels.includes('factory:ready') && fresh(i) && !held.has(i.id));
  return {
    open: [...ids],
    ready: ready.filter((i) => !waits(i).length).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map(item),
    blocked: ready.filter((i) => waits(i).length).map((i) => ({ ...item(i), waitingOn: waits(i).map((d) => `${repo}#${d}`) })),
    untriaged: open.filter((i) => fresh(i) && !held.has(i.id) && !i.labels.some((l) => l.startsWith('factory:'))).map(item),
    claimed: [...held].map(([id, c]) => ({ run: `${repo}#${id}`, ...(c ? { launcher: c.launcher, pid: c.pid } : { unreadable: true }), unclaim: unclaimCmd(`${repo}#${id}`, c) })),
  };
}
export const queue = async (repo: string) => { const { open: _o, ...q } = await scan(repo); return q; };

// ---------- status, burn and the loop ----------
const policyOf = (repo: string): Record<string, Rule | undefined> => { try { return rules(repo).policy; } catch { return {}; } }; // a broken config must not break the dashboard
// rules.ts validates both values as numbers when they are set
const limits = (repo: string) => { const pol = policyOf(repo); return { budgetUsd: (pol['project.budgetUsd']?.value ?? PROJECT_BUDGET_USD) as number, maxIssuesPerSession: (pol['project.maxIssuesPerSession']?.value ?? MAX_ISSUES_PER_SESSION) as number }; };
const issueRuns = (p: ProjectState) => (p.created || []).filter((i) => i.kind !== 'epic').map((i) => `${p.repo}#${i.id}`);

// shortcut: only the issue runs count; the planning session's own tokens are not in the project burn.
export function projectBurn(p: ProjectState, runs: Record<string, Run>) {
  let usd = 0, tokens = 0;
  for (const id of issueRuns(p)) if (runs[id]) { const b = budget(runs[id]!); usd += b.usd; tokens += b.tokens; }
  return { usd: +usd.toFixed(2), tokens };
}

// Offline status from the log: "ready" here means every dependency merged through the factory. F loop asks the tracker.
export function projectStatus(repo: string, { events = read(), runs }: { events?: FactoryEvent[]; runs?: Record<string, Run> } = {}) {
  const p = projectState(repo, events);
  if (!p) return null;
  runs ??= allRuns(events);
  const ids = Object.fromEntries((p.created || []).map((i) => [i.key, i]));
  const runOf = (k: string) => ids[k] && `${repo}#${ids[k].id}`;
  const merged = (k: string) => runs[runOf(k) as string]?.outcome === 'merged'; // undefined finds no run, as before
  const issues = (p.created ? p.created.filter((i) => i.kind !== 'epic') : (p.plan?.issues || []) as PlanIssue[]).map((i) => {
    const run = runOf(i.key), r = run && runs[run];
    const state = !run ? 'planned' : r ? (r.reverted ? 'reverted' : waits(r) ? 'awaiting-approval' : r.outcome) : (i.dependsOn || []).every(merged) ? 'ready' : 'blocked';
    return { key: i.key, title: i.title, milestone: i.milestone, dependsOn: i.dependsOn || [], run: run || null, url: ids[i.key]?.url || null, state };
  });
  const milestones = [...new Set(issues.map((i) => i.milestone))].map((name) => {
    const of = issues.filter((i) => i.milestone === name);
    return { name, merged: of.filter((i) => i.state === 'merged').length, total: of.length };
  });
  const lim = limits(repo), burn = projectBurn(p, runs);
  const working = p.loop.state === 'running' && issues.find((i) => i.run === p.loop.last && (!runs[i.run] || runs[i.run]!.outcome === 'in-progress' && !waits(runs[i.run])));
  const t = loadTemplates()[p.stack as string], checks = (policyOf(repo)['checks.commands']?.value || t?.checks || []) as string[]; // rules.ts checks it is a list of commands
  return {
    run: p.id, repo, idea: p.idea, stack: p.stack, visibility: p.visibility, dryRun: p.dryRun, host: p.host, tracker: p.tracker, started: p.started, updated: p.updated,
    phase: p.loop.state !== 'idle' ? p.loop.state : p.created ? 'issues' : p.remote ? 'repo' : p.plan ? 'planned' : 'idea',
    plan: p.plan ? { vision: p.plan.vision, milestones: p.plan.milestones, epic: p.plan.epic } : null,
    remote: p.remote || null, epic: ids.epic ? { id: ids.epic.id, url: ids.epic.url } : null,
    issues, milestones, next: working || issues.find((i) => i.state === 'ready') || null,
    burn: { ...burn, budgetUsd: lim.budgetUsd, over: burn.usd >= lim.budgetUsd },
    loop: { ...p.loop, maxIssuesPerSession: lim.maxIssuesPerSession }, checks, goal: goalFor(checks),
  };
}

/** A run whose merge waits for F approve RUN --merge (a git project, local-first PR 7): no agent resumes it. */
const waits = (r?: Run) => r?.outcome === 'in-progress' && r.decision?.action === 'await-approval';

export function ideas(events: FactoryEvent[] = read(), runs?: Record<string, Run>) {
  const repos = [...new Set(events.filter((e) => PROJECT_EVENTS[e.stage] && String(e.run).endsWith(':project')).map((e) => e.run.slice(0, -':project'.length)))];
  return Object.fromEntries(repos.map((r) => [r, projectStatus(r, { events, runs })]).filter(([, s]) => s)); // retired: gone
}

// `F loop`: one mechanical step between issues. Stops on the first escalation (or any outcome a human must resolve),
// the project budget, the per-session cap, or an empty queue; otherwise records which issue to build next.
export async function loop(repo: string) {
  checkRepo(repo);
  const p = projectState(repo);
  if (!p?.created) throw new Error(`no issues created for ${repo} yet (F issues create)`);
  const runs = allRuns(), lim = limits(repo), last = p.loop.last;
  const status = () => projectStatus(repo);
  const stop = (reason: string) => { emit(repo, 'loop', 'stopped', { reason }); return { state: 'stopped', reason, project: status() }; };
  if (last && waits(runs[last])) return stop(`${last} awaits F approve ${last} --merge`); // a git project's merge: only the user goes on
  if (p.loop.state === 'running' && last && (!runs[last] || runs[last].outcome === 'in-progress')) {
    const c = claimedElsewhere(last);
    if (c !== undefined) return stop(`${last} is held by another launcher${c ? ` (${c.launcher}, pid ${c.pid})` : ''}; if that is stuck: ${unclaimCmd(last, c)}`);
    return { state: 'running', next: last, resume: true, goal: status()!.goal }; // p exists, so its status does
  }
  const q = await scan(repo), open = new Set(q.open);
  const idOf = (run: string) => run.slice(repo.length + 1);
  if (last && runs[last] && runs[last].outcome !== 'merged' && open.has(idOf(last))) return stop(`${last} is ${runs[last].outcome}: a human needs to resolve it (merge or close the issue), then continue`);
  if (p.loop.state === 'running' && runs[last as string]?.reverted) return stop(`${last} was reverted after merge (${runs[last as string]!.reverted!.reason || 'see the revert PR'}); its dependents stay blocked. Continue to build the rest`);
  const burn = projectBurn(p, runs);
  if (burn.usd >= lim.budgetUsd) return stop(`project budget reached: $${burn.usd} of $${lim.budgetUsd} (project.budgetUsd)`);
  if (p.loop.state === 'running' && p.loop.picked >= lim.maxIssuesPerSession) return stop(`${p.loop.picked} issue(s) this session (project.maxIssuesPerSession ${lim.maxIssuesPerSession})`);
  const order = issueRuns(p), ready = new Set(q.ready.map((x) => x.run));
  const next = order.find((r) => ready.has(r));
  if (!next) {
    const held = q.claimed.filter((c) => order.includes(c.run));
    if (held.length) return stop(`nothing ready: ${held.map((c) => `${c.run} is held by another launcher (if that is stuck: ${c.unclaim})`).join('; ')}`);
    const left = order.filter((r) => open.has(idOf(r)) && runs[r]?.outcome !== 'merged');
    return stop(left.length ? `nothing ready: ${left.length} open issue(s) wait on dependencies or a human` : `all ${order.length} issues done`);
  }
  emit(repo, 'loop', 'running', { next });
  return { state: 'running', next, title: p.created.find((i) => `${repo}#${i.id}` === next)!.title, goal: status()!.goal }; // next is one of p.created's runs
}
