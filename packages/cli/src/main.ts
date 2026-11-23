// @ts-nocheck
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { COST_CAP } from '../../core/src/constants.ts';
import { approval, facts, intake, merge, postmerge, revert } from '../../core/src/github.ts';
import { archive, io, read, record, runDir } from '../../core/src/log.ts';
import { budget, budgetWhy, derive, getRun } from '../../core/src/derive.ts';
import { catalog, setSkill, skills } from '../../core/src/skills.ts';
import { decide, gate, reviewAxes, risk } from '../../core/src/gate.ts';
import { demo } from '../../core/src/demo.ts';
import { deps, gc, git, localChecks, projects, worktree, wtInfo } from '../../core/src/workspace.ts';
import { discover, sync } from '../../core/src/sync.ts';
import { evals } from '../../core/src/eval.ts';
import { headlessArgs, reviewFromText } from '../../core/src/review.ts';
import { issuesCreate, loop, newProject, projectStatus, queue, retireIdea } from '../../core/src/project.ts';
import { loadShip, ship } from '../../core/src/ship.ts';
import { onboardState, onboardText, setShip } from '../../core/src/onboard.ts';
import { artifact, render, ui } from '../../server/src/server.ts';
import { rules, setAutoMerge, setRule, unsetRule } from '../../core/src/rules.ts';
import { withMeasured } from '../../core/src/burn.ts';
import { linkSkill, open } from '../../core/src/platform.ts';
import { pathToFileURL } from 'node:url';

export async function main(argv) {
  const [cmd, run, ...rest] = argv;
  const fb = rest.indexOf('--fallback'), fallback = fb < 0 ? undefined : rest.splice(fb, 2)[1] || 'configured runner unavailable'; // the configured runner couldn't run; the built-in did
  // "-" reads the JSON payload from stdin (use a quoted heredoc) so untrusted text never touches shell quoting.
  const json = (s) => (s === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : s ? JSON.parse(s) : {});
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  try {
    if (['sync', 'postmerge', 'revert', 'decide', 'merge', 'ship', 'onboard', 'ui'].includes(cmd)) ship.mod = await loadShip();
    if (ship.mod && ['onboard', 'ui'].includes(cmd)) ship.list = (await ship.mod.ready()).connectors.map((c) => ({ id: c.id, kind: c.kind, label: c.label || c.id }));
    switch (cmd) {
      case 'event': {
        const [stage, status] = rest, p = json(rest[2]);
        const owned = { 'intake:started': 'intake', 'review:started': 'axes', 'approve:decided': 'merge', 'approve:merged': 'merge', 'approve:reverted': 'revert', 'approve:closed': 'sync', 'idea:retired': 'retire' };
        const owner = owned[`${stage}:${status}`] || { gate: 'gate', rules: 'rules', idea: 'new', plan: 'new', repo: 'new', issues: 'issues create', loop: 'loop', ship: 'ship' }[stage];
        if (owner) throw new Error(`"${stage} ${status}" is recorded by "${owner}", not by hand`);
        if (stage === 'review' && p.role !== 'verifier') throw new Error('axis verdicts are recorded by "review", not by hand; "event" only takes the verifier usage record ({"role":"verifier",…})');
        const typed = ['association', 'originAssociation', 'origin', 'author', 'sha', 'imported', 'source', 'action', 'harness', 'sessionId', 'cwd', 'runner', 'localChecks',
          'connector', 'kind', 'env', 'state', 'url', 'detail', 'creator', 'at'].filter((k) => k in p); // the last row: set by ship connectors only
        if (typed.length) throw new Error(`these fields come from GitHub, git or a ship connector, not from a payload: ${typed.join(', ')}`);
        record(run, stage, status, p, { fallback }); break;
      }
      case 'review': { // raw reviewer output on stdin, from any runner; invalid output is recorded as a failed review
        const { status, payload } = reviewFromText(run, rest[0], fs.readFileSync(0, 'utf8'));
        for (const k of ['tokens', 'costUsd', 'usage', 'model']) delete payload[k]; // usage comes from the orchestrator's flags, never the reviewer's own text
        for (const [flag, k] of [['--tokens', 'tokens'], ['--cost-usd', 'costUsd']]) { // the orchestrator's usage numbers, kept even when the reply is invalid
          const i = rest.indexOf(flag), v = i < 0 ? undefined : Number(rest[i + 1]);
          if (i >= 0 && !(v >= 0)) throw new Error(`${flag} needs a number`);
          if (i >= 0) payload[k] = v;
        }
        const mi = rest.indexOf('--model'), ui = rest.indexOf('--usage'); // record() validates both, as for "F event"; usage replaces --tokens with its sum
        if (mi >= 0) payload.model = rest[mi + 1];
        if (ui >= 0) { try { payload.usage = JSON.parse(rest[ui + 1]); } catch { throw new Error('--usage needs JSON like {"input":1,"output":2,"cacheRead":3,"cacheWrite":4}'); } }
        record(run, 'review', status, payload, { fallback });
        out({ status, findings: payload.findings }); break;
      }
      case 'skills': { // skills <owner/repo> | skills set|unset <owner/repo|default> <step> [json] | skills catalog [owner/repo]
        if (run === 'catalog') { out(catalog(rest)); break; }
        if (run === 'unset') { out(setSkill(rest[0], rest[1], undefined)); break; }
        if (run !== 'set') { out(skills(run || '')); break; }
        const [scope, key, spec] = rest;
        if (!scope || !key || !spec) throw new Error('usage: skills set <owner/repo|default> <step> <json runner>');
        out(setSkill(scope, key, json(spec))); break;
      }
      case 'rules': { // rules <owner/repo> | rules set <scope> <key> <value> --reason "…" [--until YYYY-MM-DD] | rules unset <scope> <key> [--reason "…"]
        const flag = (f) => { const i = rest.indexOf(f); return i < 0 ? undefined : rest.splice(i, 2)[1] ?? ''; };
        const reason = flag('--reason'), until = flag('--until');
        const [scope, key, value] = rest;
        if (run === 'set' && scope && key && value !== undefined) out(setRule(scope, key, value, { reason, until }));
        else if (run === 'unset' && scope && key) out(unsetRule(scope, key, { reason }));
        else if (run && run !== 'set' && run !== 'unset') out(rules(run));
        else throw new Error('usage: rules <owner/repo|default> | rules set <owner/repo|default> <ci|checks.commands|diffCap|deploy.preview|artifact|project.budgetUsd|project.maxIssuesPerSession|guide.<step>> <value> --reason "…" [--until YYYY-MM-DD] | rules unset <owner/repo|default> <key> [--reason "…"]');
        break;
      }
      case 'checks': out(localChecks(run)); break;
      case 'automerge': { // per-project switch; decide() escalates everything when off
        if (!['on', 'off'].includes(rest[0])) throw new Error('usage: automerge <owner/repo> on|off');
        out(setAutoMerge(run, rest[0] === 'on')); break;
      }
      case 'axes': { // no files: diff the run's worktree since the last reviewed commit (or the base branch)
        const r = getRun(run), w = wtInfo(run);
        let files = rest, range = null;
        if (!files.length) {
          if (!w) throw new Error(`no worktree for ${run}; pass changed files or run "worktree" first`);
          range = `${r.reviewedSha || `origin/${w.base}`}...HEAD`;
          files = git('-C', w.path, 'diff', '--name-only', range).split('\n').filter(Boolean);
        }
        const sha = w && fs.existsSync(w.path) ? git('-C', w.path, 'rev-parse', 'HEAD').trim() : undefined;
        const axes = reviewAxes(r, files, skills(run.split(/[#:]/)[0]).extra);
        record(run, 'review', 'started', { axes, sha, range });
        out({ axes, range, files }); break;
      }
      case 'worktree': out(worktree(run, rest[0])); break;
      case 'deps': console.log(deps(run)); break;
      case 'gc': out(gc()); break;
      case 'gate': { const { status, ...p } = gate(getRun(run)); record(run, 'gate', status, p, { fallback }); out({ status, ...p }); break; }
      case 'intake': out(intake(run)); break;
      case 'sync': { // `sync` alone re-syncs every attached project
        const list = run ? [[run, rest[0]]] : Object.entries(projects()).map(([k, v]) => [k, v.path]);
        out(list.map(([k, p]) => sync(k, p))); break;
      }
      case 'projects': out(projects()); break;
      case 'onboard': { // onboard [--json] | onboard ship <owner/repo|default> web,mobile,database
        if (run === 'ship') { out(setShip(rest[0], (rest[1] || '').split(',').map((k) => k.trim()).filter(Boolean))); break; }
        const st = onboardState();
        if (run === '--json') out(st); else console.log(onboardText(st));
        break;
      }
      case 'ship': { // thin alias: ship.mjs connectors | detect <owner/repo> | status <owner/repo> [sha]  (reads only)
        if (!ship.mod) throw new Error('the ship harness (packages/ship) is not installed next to the factory');
        out(await ship.mod.main([run, ...rest].filter(Boolean), { path: projects()[rest[0]]?.path })); break;
      }
      case 'discover': out(discover([run, ...rest].filter(Boolean))); break;
      case 'decide': { const r = getRun(run); const f = r.imported ? {} : facts(r); const d = decide(r, f); record(run, 'approve', 'decided', { ...d, facts: f }); out({ ...d, facts: f }); break; }
      case 'merge': out(merge(run)); break;
      case 'risk': out(risk(getRun(run), rest)); break;
      case 'approval': out(approval(run)); break;
      case 'postmerge': out(postmerge(run)); break;
      case 'revert': out(revert(run, rest.join(' ') || 'CI failed on the base branch after merge')); break;
      case 'queue': out(await queue(run)); break;
      case 'new': { // new "<idea>" [--name owner/repo] [--stack id] [--dry-run] [--yes] [--out dir] [--path dir] [--public] [--host id] [--tracker id]
        const has = (f) => { const i = rest.indexOf(f); return i >= 0 && !!rest.splice(i, 1); };
        const opt = (f) => { const i = rest.indexOf(f); return i < 0 ? undefined : rest.splice(i, 2)[1]; };
        const o = { idea: run, name: opt('--name'), stack: opt('--stack'), out: opt('--out'), dest: opt('--path'), host: opt('--host'), tracker: opt('--tracker'), dryRun: has('--dry-run'), yes: has('--yes'), visibility: has('--public') ? 'public' : undefined };
        if (rest.length) throw new Error(`unknown arguments: ${rest.join(' ')}`);
        out(await newProject(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)))); break;
      }
      case 'issues': { // issues create <owner/repo> <file.json> [--yes]
        if (run !== 'create' || !rest[0] || !rest[1]) throw new Error('usage: issues create <owner/repo> <issues.json> [--yes]');
        out(await issuesCreate(rest[0], rest[1], { yes: rest.includes('--yes') })); break;
      }
      case 'project': { const s = projectStatus(run || ''); if (!s) throw new Error(`no project ${run}; start one with "new"`); out(s); break; }
      case 'loop': out(await loop(run)); break;
      case 'retire': { const ri = rest.indexOf('--reason'); out(retireIdea(run, ri < 0 ? '' : rest[ri + 1])); break; }
      case 'archive': out(archive(run ? Number(run) : 14)); break;
      case 'eval': out(evals(run)); break;
      case 'state': out(getRun(run)); break;
      case 'usage': { // measured (transcripts) or reported (payload) burn; no run: one line per run
        if (run) { const r = getRun(run); out({ run: r.id, ...(r.burn || { measured: false, total: null }), budget: budget(r) }); break; }
        const events = read();
        out(Object.fromEntries(Object.values(withMeasured(derive(events), events)).filter((r) => r.burn).map((r) => [r.id, { measured: r.burn.measured, ...r.burn.total }])));
        break;
      }
      case 'headless-args': { // the run's remaining budget; an imported checkout is someone else's code, so never -p there
        const r = getRun(run), b = budget(r);
        if (r.imported) throw new Error(`${run} is imported: never run claude -p in its checkout`);
        if (b.over) throw new Error(`run budget exceeded ${budgetWhy(b)}`);
        const si = rest.indexOf('--share'), share = si < 0 ? 1 : Number(rest[si + 1]);
        out(headlessArgs({ schema: rest.includes('--review') ? JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'factory', 'references', 'review.schema.json'), 'utf8')) : undefined, budget: COST_CAP - b.usd, write: rest.includes('--write'), share }));
        break;
      }
      case 'dir': console.log(runDir(run)); break;
      case 'render': { // render [--artifact <out>]: the local dashboard, or the claude.ai Artifact page (never touches dashboard.html)
        if (run !== '--artifact') { console.log(render()); break; }
        if (!rest[0]) throw new Error('usage: render --artifact <out.html>');
        const html = artifact();
        fs.writeFileSync(rest[0], html);
        console.log(`${rest[0]}: ${html.length} bytes, ${JSON.parse(html.match(/<script type="application\/json" id="data">([^<]*)<\/script>/)[1]).runs.length} runs`);
        break;
      }
      case 'open': { // open [dashboard|<https:|file:|claude-cli: URL>]: the OS opener, never a shell
        const target = !run || run === 'dashboard' ? pathToFileURL(render()).href : run;
        out({ opened: open(target) }); break;
      }
      case 'install-skill': // the one install step: ~/.claude/skills/software-factory -> this checkout's packages/factory
        out(linkSkill(path.join(import.meta.dirname, '..', '..', 'factory'), path.join(os.homedir(), '.claude', 'skills', 'software-factory'))); break;
      case 'ui': ui(Number(run) || 0); break;
      case 'demo': // never pollute the real log with fixtures
        if (!process.env.FACTORY_DIR) io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-demo-'));
        console.log(demo()); break;
      case 'test': { // node:test, one process per file under packages/factory/test; plain node, since the skill may have no pnpm
        const dir = path.join(import.meta.dirname, '..', '..', 'factory', 'test');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f));
        process.exitCode = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status ?? 1;
        break;
      }
      default:
        console.log(`usage: factory.mjs <command>
  discover [roots...]                     find local GitHub clones for onboarding (default: ~/Development, ~/code, ...)
  sync   [owner/repo] [local clone path]  attach a project and import open PRs + agent sessions (no args: all)
  projects                                list attached projects
  onboard [--json]                        setup state, step by step, with the command for each fix (the wizard: F ui)
  onboard ship <owner/repo|default> <web,mobile,database>  store what the project ships
  ship   connectors | detect <owner/repo> | status <owner/repo> [sha]   deploy state from packages/ship connectors (read only)
  intake <run>                            fetch issue, record intake start, print issue + trusted comments
  event  <run> <stage> <status> [json|-] [--fallback why]  record an event ("-" = JSON on stdin)
  worktree <run> [clone path]            create/reuse the run's git worktree (prints its path)
  deps   <run>                            cheapest node_modules for the worktree
  axes   <run> [changed files...]         pick + record review axes (default: worktree diff since last review)
  review <run> <axis> [--tokens n] [--cost-usd x] [--model id] [--usage json] [--fallback why]  record a reviewer's raw reply from stdin (invalid = failed review)
  skills <owner/repo>                     print who runs each step (default, skill, brief or provider)
  skills set <owner/repo|default> <step> <json>  configure one step (intake, spec, build, review.<axis>, verifier, postmerge, axes.extra)
  skills unset <owner/repo|default> <step>       drop a step's choice (a project then inherits the global one)
  skills catalog [owner/repo...]          every runner on this machine: built-in, harness tools, global, project, your briefs
  ui     [port]                           serve the dashboard on 127.0.0.1 with a token, so the Skills sheet and setup wizard can save
  rules  <owner/repo>                     print the policy rules, warnings and per-step guidance that apply
  rules set <owner/repo|default> <key> <value> --reason "…" [--until YYYY-MM-DD]  ci required|advisory|skip, checks.commands '[…]', diffCap n, deploy.preview required|advisory|off, artifact https://claude.ai/artifact/<id>, project.budgetUsd x, project.maxIssuesPerSession n, guide.<step> "text"
  rules unset <owner/repo|default> <key> [--reason "…"]  remove one (back to the global rule, or the built-in)
  checks <run>                            run the checks.commands rule in the worktree on its HEAD commit (the CI stand-in)
  gc                                      remove worktrees of finished runs
  gate   <run>                            compute + record gate verdict
  decide <run>                            fetch CI + diff, compute + record merge/escalate
  merge  <run>                            re-decide, then merge the reviewed commit (the only merge path)
  risk   <run> <planned files...>         does the spec need human approval before building?
  approval <run>                          trusted "/factory approve|reject" comment since waiting?
  postmerge <run>                         CI state of the merge commit on the base branch
  revert <run> [reason]                   open a revert PR (never merged by the factory)
  queue  <owner/repo>                     factory:ready issues whose dependencies are merged (ready), the rest (blocked), untriaged open issues
  new    "<idea>" [--name owner/repo] [--stack next-web] [--dry-run] [--yes] [--path dir] [--out dir]
                                          idea-to-app: record the idea, validate PLAN.md + issues.json, then (with --yes) create the private repo + scaffold
  issues create <owner/repo> <file.json> [--yes]  validate and preview an issue batch; with --yes create it (idempotent by key)
  project <owner/repo>                    idea-to-app status: plan, milestones, next issue, dependency order, burn, loop
  retire <owner/repo> --reason "<why>"     hide an idea that never got a repo (a leaked fixture) with a recorded event; the log is never rewritten
  loop   <owner/repo>                     next issue to build, or stop (first escalation, project budget, session cap, empty queue)
  automerge <owner/repo> on|off           allow or forbid auto-merge for a project
  archive [days=14]                       compact finished runs older than N days
  eval   [fixture]                        score intake on evals/golden with headless claude (costs tokens)
  state  <run>                            print derived run state
  usage  [run]                            token burn by stage, iteration and axis: measured from transcripts, else reported
  headless-args <run> [--review|--write] [--share N]  pinned claude -p flags (read-only unless --write) for a provider runner, with the run's remaining budget split N ways (JSON array)
  dir    <run>                            print the run's artifact folder
  open   [dashboard|url]                  open the dashboard (default) or an https:, file: or claude-cli: URL with the OS opener
  install-skill                          link ~/.claude/skills/software-factory to this checkout (a junction on Windows)
  render [--artifact <out>]              rewrite dashboard.html, or write the claude.ai Artifact page to <out>
  demo | test`);
        process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    console.error(`factory: ${e.message}`);
    process.exitCode = 1;
  }
}
