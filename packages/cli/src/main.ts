import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { COST_CAP } from '../../core/src/constants.ts';
import { adapterCtx, approval, facts, intake, merge, postmerge, revert } from '../../core/src/github.ts';
import { approveSpec } from '../../core/src/approve.ts';
import { newItem } from '../../adapters/trackers/local.ts';
import { closeMerged, setProject } from '../../core/src/projectset.ts';
import { archive, io, read, record, runDir } from '../../core/src/log.ts';
import { budget, budgetWhy, derive, getRun } from '../../core/src/derive.ts';
import { DEFAULT_PRESET, PRESETS, applyPreset, availablePlan, catalog, setSkill, skills } from '../../core/src/skills.ts';
import { decide, gate, reviewAxes, risk } from '../../core/src/gate.ts';
import { demo } from '../../core/src/demo.ts';
import { baseRef, deps, gc, git, localChecks, projects, trackerOf, worktree, wtInfo } from '../../core/src/workspace.ts';
import { discover, sync } from '../../core/src/sync.ts';
import { evals } from '../../core/src/eval.ts';
import { headlessArgs, reviewFromText, stepModel } from '../../core/src/review.ts';
import { issuesCreate, loop, newProject, projectStatus, queue, retireIdea } from '../../core/src/project.ts';
import { loadShip, loadShipList, ship } from '../../core/src/ship.ts';
import { claudeDir, onboardState, onboardText, setShip } from '../../core/src/onboard.ts';
import { artifact, openSession, parseRun, render, startRun, ui } from '../../server/src/server.ts';
import { refuseClaimed, unclaim } from '../../core/src/claim.ts';
import { rules, setAutoMerge, setRule, unsetRule } from '../../core/src/rules.ts';
import { note, takeNotes } from '../../core/src/notes.ts';
import { withMeasured } from '../../core/src/burn.ts';
import { installCli, linkSkill, open } from '../../core/src/platform.ts';
import { pathToFileURL } from 'node:url';

const GATED = new Set(['event', 'review', 'checks', 'notes', 'axes', 'worktree', 'deps', 'gate', 'intake', 'decide', 'merge', 'approval', 'postmerge', 'revert', 'close']);
export async function main(argv: string[]) {
  // shortcut: the words are typed as present; a missing one is undefined at run time, and the command's own check (or its
  // callee's) reports it, as before typing. Index into rest the same way (rest[i]!).
  const [cmd, run, ...rest] = argv as [string, string, ...string[]];
  const fb = rest.indexOf('--fallback'), fallback = fb < 0 ? undefined : rest.splice(fb, 2)[1] || 'configured runner unavailable'; // the configured runner couldn't run; the built-in did
  // "-" reads the JSON payload from stdin (use a quoted heredoc) so untrusted text never touches shell quoting.
  const json = (s: string | undefined) => (s === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : s ? JSON.parse(s) : {});
  const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  try {
    if (['sync', 'postmerge', 'revert', 'decide', 'merge', 'ship', 'onboard', 'ui'].includes(cmd)) ship.mod = await loadShip();
    if (cmd === 'onboard') await loadShipList(); // ui: serve() loads it
    // Every command that changes a run waits while another launcher holds it (#105); its own harness passes (FACTORY_CLAIM).
    // Not note: a person steers a running run with it. A missing or malformed run falls through to the command's own check.
    if (GATED.has(cmd) && typeof run === 'string' && run.includes('#')) refuseClaimed(run);
    switch (cmd) {
      case 'event': {
        const [stage, status] = rest as [string, string], p = json(rest[2]); // as argv above: record() checks them
        const owned: Record<string, string> = { 'intake:started': 'intake', 'review:started': 'axes', 'approve:decided': 'merge', 'spec:decided': 'approve', 'approve:merged': 'merge', 'approve:reverted': 'revert', 'approve:closed': 'sync', 'idea:retired': 'retire' };
        const owner = owned[`${stage}:${status}`] || ({ gate: 'gate', rules: 'rules', idea: 'new', plan: 'new', repo: 'new', issues: 'issues create', loop: 'loop', ship: 'ship' } as Record<string, string>)[stage];
        if (owner) throw new Error(`"${stage} ${status}" is recorded by "${owner}", not by hand`);
        if (stage === 'review' && p.role !== 'verifier') throw new Error('axis verdicts are recorded by "review", not by hand; "event" only takes the verifier usage record ({"role":"verifier",…})');
        if (stage === 'note') throw new Error('"note" is recorded by "note" and "notes", not by hand');
        const typed = ['association', 'originAssociation', 'origin', 'author', 'sha', 'imported', 'source', 'action', 'harness', 'sessionId', 'hostSessionId', 'cwd', 'runner', 'localChecks', 'mergedBy',
          'connector', 'kind', 'env', 'state', 'url', 'detail', 'creator', 'at'].filter((k) => k in p); // the last row: set by ship connectors only
        if (typed.length) throw new Error(`these fields come from GitHub, git, the environment or a ship connector, not from a payload: ${typed.join(', ')}`);
        record(run, stage, status, p, { fallback }); break;
      }
      case 'review': { // raw reviewer output on stdin, from any runner; invalid output is recorded as a failed review
        const { status, payload } = reviewFromText(run, rest[0]!, fs.readFileSync(0, 'utf8'));
        for (const k of ['tokens', 'costUsd', 'usage', 'model']) delete payload[k]; // usage comes from the orchestrator's flags, never the reviewer's own text
        for (const [flag, k] of [['--tokens', 'tokens'], ['--cost-usd', 'costUsd']] as const) { // the orchestrator's usage numbers, kept even when the reply is invalid
          const i = rest.indexOf(flag), v = i < 0 ? undefined : Number(rest[i + 1]);
          if (i >= 0 && !(v! >= 0)) throw new Error(`${flag} needs a number`);
          if (i >= 0) payload[k] = v;
        }
        const mi = rest.indexOf('--model'), ui = rest.indexOf('--usage'); // record() validates both, as for "F event"; usage replaces --tokens with its sum
        if (mi >= 0) payload.model = rest[mi + 1];
        if (ui >= 0) { try { payload.usage = JSON.parse(rest[ui + 1]!); } catch { throw new Error('--usage needs JSON like {"input":1,"output":2,"cacheRead":3,"cacheWrite":4}'); } }
        record(run, 'review', status, payload, { fallback });
        out({ status, findings: payload.findings }); break;
      }
      case 'skills': { // skills <owner/repo> | skills set|unset <owner/repo|default> <step> [json] | skills preset <name> [scope] | skills catalog [owner/repo]
        if (run === 'catalog') { out(catalog(rest)); break; }
        if (run === 'unset') { out(setSkill(rest[0] as string, rest[1] as string, undefined)); break; } // argv boundary: setSkill's scope check refuses a missing scope
        if (run === 'preset') { out(applyPreset(rest[0], rest[1])); break; }
        if (run !== 'set') { const k = skills(run || ''); out({ ...k, plan: availablePlan(k.plan), extra: Object.values(availablePlan(k.extra)) }); break; }
        const [scope, key, spec] = rest;
        if (!scope || !key || !spec) throw new Error('usage: skills set <owner/repo|default> <step> <json runner>');
        out(setSkill(scope, key, json(spec))); break;
      }
      case 'rules': { // rules <owner/repo> | rules set <scope> <key> <value> --reason "…" [--until YYYY-MM-DD] | rules unset <scope> <key> [--reason "…"]
        const flag = (f: string) => { const i = rest.indexOf(f); return i < 0 ? undefined : rest.splice(i, 2)[1] ?? ''; };
        const reason = flag('--reason'), until = flag('--until');
        const [scope, key, value] = rest;
        if (run === 'set' && scope && key && value !== undefined) out(setRule(scope, key, value, { reason, until }));
        else if (run === 'unset' && scope && key) out(unsetRule(scope, key, { reason }));
        else if (run && run !== 'set' && run !== 'unset') out(rules(run));
        else throw new Error('usage: rules <owner/repo|default> | rules set <owner/repo|default> <ci|checks.commands|diffCap|deploy.preview|artifact|project.budgetUsd|project.maxIssuesPerSession|guide.<step>> <value> --reason "…" [--until YYYY-MM-DD] | rules unset <owner/repo|default> <key> [--reason "…"]');
        break;
      }
      case 'checks': out(localChecks(run)); break;
      case 'note': { // note <run> <step|next> - : the user's note on stdin (quoted heredoc); only from the user's own chat message
        if (!rest[0] || rest[1] !== '-') throw new Error('usage: note <run> <step|next> -   (the note text on stdin)');
        out(note(run, rest[0]!, fs.readFileSync(0, 'utf8'))); break;
      }
      case 'notes': out(takeNotes(run, rest)); break; // notes <run> <step…>: pending notes for the steps starting now, handed out once
      case 'automerge': { // per-project switch; decide() escalates everything when off
        if (!['on', 'off'].includes(rest[0]!)) throw new Error('usage: automerge <owner/repo> on|off');
        out(setAutoMerge(run, rest[0] === 'on')); break;
      }
      case 'axes': { // no files: diff the run's worktree since the last reviewed commit (or the base branch)
        const r = getRun(run), w = wtInfo(run);
        let files = rest, range = null;
        if (!files.length) {
          if (!w) throw new Error(`no worktree for ${run}; pass changed files or run "worktree" first`);
          range = `${r.reviewedSha || baseRef(w.repoPath, w.base as string)}...HEAD`; // a full ref: a planted tag or branch can't empty the diff
          files = git('-C', w.path, 'diff', '--name-only', range).split('\n').filter(Boolean);
        }
        const sha = w && fs.existsSync(w.path) ? git('-C', w.path, 'rev-parse', 'HEAD').trim() : undefined;
        const axes = reviewAxes(r, files, skills(run.split(/[#:]/)[0] as string).extra); // split always has a first part
        record(run, 'review', 'started', { axes, sha, range });
        out({ axes, range, files }); break;
      }
      case 'worktree': out(worktree(run, rest[0])); break;
      case 'deps': console.log(deps(run)); break;
      case 'gc': out(gc()); break;
      case 'gate': { const { status, ...p } = gate(getRun(run)); record(run, 'gate', status, p, { fallback }); out({ status, ...p }); break; }
      case 'intake': out(intake(run)); break;
      case 'sync': { // `sync` alone re-syncs every attached project
        const list: [string, string | undefined][] = run ? [[run, rest[0]]] : Object.entries(projects()).map(([k, v]) => [k, v.path]);
        out(list.map(([k, p]) => sync(k, p))); break;
      }
      case 'projects': out(projects()); break;
      case 'onboard': { // onboard [--json] | onboard ship <owner/repo|default> web,mobile,desktop
        if (run === 'ship') { out(setShip(rest[0]!, (rest[1] || '').split(',').map((k) => k.trim()).filter(Boolean))); break; }
        const st = onboardState();
        if (run === '--json') out(st); else console.log(onboardText(st));
        break;
      }
      case 'ship': { // thin alias: ship.mjs connectors | detect <owner/repo> | status <owner/repo> [sha]  (reads only)
        if (!ship.mod) throw new Error('the ship harness (packages/ship) is not installed next to the factory');
        out(await ship.mod.main([run, ...rest].filter(Boolean), { path: projects()[rest[0]!]?.path })); break;
      }
      case 'discover': out(discover([run, ...rest].filter(Boolean))); break;
      case 'decide': { const r = getRun(run); const f = r.imported ? {} : facts(r); const d = decide(r, f); record(run, 'approve', 'decided', { ...d, facts: f }); out({ ...d, facts: f }); break; }
      case 'merge': out(merge(run)); break;
      case 'risk': out(risk(getRun(run), rest)); break;
      case 'approval': out(approval(run)); break;
      case 'approve': // approve <owner/repo#N>: you approve a local item's spec at your own terminal; never an agent, the page or HTTP
        if (!run || rest.length) throw new Error('usage: approve <owner/repo#N>');
        out(approveSpec(run)); break;
      case 'item': { // item new <owner/repo> "<title>" [-]: a local item in the clone's untracked .factory/issues (- reads its body from stdin)
        if (run !== 'new' || !rest[0] || !rest[1] || rest.length > 3 || (rest[2] !== undefined && rest[2] !== '-')) throw new Error('usage: item new <owner/repo> "<title>" [-]');
        const [repo, title] = rest as [string, string], t = trackerOf(repo), at = projects()[repo]?.path;
        if (t !== 'local') throw new Error(`${repo}'s tracker is ${t}: F item new writes local items only`);
        const it = newItem(adapterCtx(), { ...(at && { path: at }), title, body: rest[2] ? fs.readFileSync(0, 'utf8') : '' });
        out({ run: `${repo}#${it.id}`, id: it.id, file: it.file }); break;
      }
      case 'postmerge': out(postmerge(run)); break;
      case 'revert': out(revert(run, rest.join(' ') || 'CI failed on the base branch after merge')); break;
      case 'queue': out(await queue(run)); break;
      case 'new': { // new "<idea>" [--name owner/repo] [--stack id] [--dry-run] [--yes] [--out dir] [--path dir] [--public] [--host id] [--tracker id]
        const has = (f: string) => { const i = rest.indexOf(f); return i >= 0 && !!rest.splice(i, 1); };
        const opt = (f: string) => { const i = rest.indexOf(f); return i < 0 ? undefined : rest.splice(i, 2)[1]; };
        const o = { idea: run, name: opt('--name'), stack: opt('--stack'), out: opt('--out'), dest: opt('--path'), host: opt('--host'), tracker: opt('--tracker'), dryRun: has('--dry-run'), yes: has('--yes'), visibility: has('--public') ? 'public' : undefined };
        if (rest.length) throw new Error(`unknown arguments: ${rest.join(' ')}`);
        out(await newProject(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Parameters<typeof newProject>[0])); break; // o has idea; only unset options are dropped
      }
      case 'issues': { // issues create <owner/repo> <file.json> [--yes]
        if (run !== 'create' || !rest[0] || !rest[1]) throw new Error('usage: issues create <owner/repo> <issues.json> [--yes]');
        out(await issuesCreate(rest[0], rest[1], { yes: rest.includes('--yes') })); break;
      }
      case 'close': { // close RUN --merged <sha>: a git project's change request merged outside the factory; yours only
        if (rest[0] !== '--merged' || !rest[1] || rest.length !== 2) throw new Error('usage: close <owner/repo#N> --merged <sha>');
        out(closeMerged(run, rest[1])); break;
      }
      case 'project': {
        if (run === 'set') { // project set <owner/repo> host|ci|base <value>|--unset [--reason "…"]: only from your own terminal
          const i = rest.indexOf('--reason'), reason = i < 0 ? undefined : rest.splice(i, 2)[1] ?? '';
          const unset = rest.includes('--unset'), a = rest.filter((x) => x !== '--unset'); // base --unset: back to the host's own
          if (a.length !== (unset ? 2 : 3)) throw new Error('usage: project set <owner/repo> host|ci|base <value>|--unset [--reason "…"]');
          out(setProject(a[0]!, a[1]!, unset ? null : a[2]!, { reason })); break;
        }
        const s = projectStatus(run || ''); if (!s) throw new Error(`no project ${run}; start one with "new"`); out(s); break;
      }
      case 'loop': out(await loop(run)); break;
      case 'retire': { const ri = rest.indexOf('--reason'); out(retireIdea(run, ri < 0 ? '' : rest[ri + 1])); break; }
      case 'archive': out(archive(run ? Number(run) : 14)); break;
      case 'eval': out(evals(run)); break;
      case 'state': out(getRun(run)); break;
      case 'usage': { // measured (transcripts) or reported (payload) burn; no run: one line per run
        if (run) { const r = getRun(run); out({ run: r.id, ...(r.burn || { measured: false, total: null }), budget: budget(r) }); break; }
        const events = read();
        out(Object.fromEntries(Object.values(withMeasured(derive(events), events)).filter((r) => r.burn).map((r) => [r.id, { measured: r.burn!.measured, ...r.burn!.total }])));
        break;
      }
      case 'headless-args': { // the run's remaining budget; an imported checkout is someone else's code, so never -p there
        const r = getRun(run), b = budget(r);
        if (r.imported) throw new Error(`${run} is imported: never run claude -p in its checkout`);
        if (b.over) throw new Error(`run budget exceeded ${budgetWhy(b)}`);
        const si = rest.indexOf('--share'), share = si < 0 ? 1 : Number(rest[si + 1]), st = rest.indexOf('--step');
        out(headlessArgs({ ...(st >= 0 && stepModel(run, rest[st + 1]!)), schema: rest.includes('--review') ? JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'factory', 'references', 'review.schema.json'), 'utf8')) : undefined, budget: COST_CAP - b.usd, write: rest.includes('--write'), share }));
        break;
      }
      case 'dir': console.log(runDir(run)); break;
      case 'render': { // render [--artifact <out>]: the local dashboard, or the claude.ai Artifact page (never touches dashboard.html)
        if (run !== '--artifact') { console.log(render()); break; }
        if (!rest[0]) throw new Error('usage: render --artifact <out.html>');
        const html = artifact();
        fs.writeFileSync(rest[0], html);
        console.log(`${rest[0]}: ${Buffer.byteLength(html)} bytes, ${JSON.parse(html.match(/<script type="application\/json" id="data">([^<]*)<\/script>/)![1]!).runs.length} runs`);
        break;
      }
      case 'open': { // open [dashboard|<https:|file:|claude-cli: URL>|<session id>]: the OS opener, never a shell
        if (run && run !== 'dashboard' && !run.includes(':')) { out(openSession({ id: run, ...(rest[0] && { harness: rest[0] }) })); break; } // a session: the desktop app, or how to resume it
        const target = !run || run === 'dashboard' ? pathToFileURL(render()).href : run;
        out({ opened: open(target) }); break;
      }
      case 'install-skill': // link this checkout's packages/factory as a personal skill; --codex: Codex's ~/.agents/skills instead
        if (run && run !== '--codex') throw new Error('usage: install-skill [--codex]');
        if (/[\\/]plugins[\\/]cache[\\/]/.test(import.meta.dirname)) throw new Error('this F runs from the Claude Code plugin cache, which an update replaces; the plugin already provides the skill. Link a clone instead.');
        out(linkSkill(path.join(import.meta.dirname, '..', '..', 'factory'), path.join(run === '--codex' ? path.join(os.homedir(), '.agents') : claudeDir(), 'skills', 'software-factory'))); break;
      case 'install-cli': // a `factory` shim in ~/.local/bin (or ~/bin) for this copy; prints the PATH line when that dir is not on PATH
        if (run) throw new Error('usage: install-cli');
        out(installCli(path.join(import.meta.dirname, '..', '..', 'factory', 'factory.mjs'), { home: os.homedir() })); break;
      case 'ui': await ui(Number(run) || 0); break;
      case 'start': if (!run || rest.length) throw new Error('usage: start <owner/repo#N>'); out(startRun(run)); break; // start owner/repo#N: a detached headless run in the attached clone, as POST /api/runs
      case 'unclaim': // a person clears a run's claim (#25); CLI only, never an API route or a button
        if (!run || rest.some((x) => x !== '--force')) throw new Error('usage: unclaim <owner/repo#N> [--force]');
        out(unclaim(parseRun(run).id, rest.includes('--force'))); break;
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
        console.log(`usage: factory <command>        (F in SKILL.md; without install-cli: node packages/factory/factory.mjs <command>)
  help | --help | -h                      print this list
  discover [roots...]                     find local git clones for onboarding (default: ~/Development, ~/code, ...)
  sync   [owner/repo] [local clone path]  attach a project and import open PRs + agent sessions (no args: all)
  projects                                list attached projects
  onboard [--json]                        setup state, step by step, with the command for each fix (the wizard: F ui)
  onboard ship <owner/repo|default> <web,mobile,desktop>  store what the project ships
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
  skills preset <name> [owner/repo|default]  set every Claude-run step's model, effort and fallback from a preset; a project only on steps it sets (${Object.keys(PRESETS).join(', ')}; built-in: ${DEFAULT_PRESET})
  skills catalog [owner/repo...]          every runner on this machine: built-in, harness tools, global, project, your briefs
  ui     [port]                           serve the dashboard on 127.0.0.1 with a token, so the Skills sheet and setup wizard can save
  start  <owner/repo#N>                   start the factory on an issue: a detached headless claude in the attached clone, logging to the run's folder; prints {pid, log}
  unclaim <owner/repo#N> [--force]        clear a run's claim.json when the process it names is gone (refused while it may live, unless --force)
  rules  <owner/repo>                     print the policy rules, warnings and per-step guidance that apply
  rules set <owner/repo|default> <key> <value> --reason "…" [--until YYYY-MM-DD]  ci required|advisory|skip, checks.commands '[…]', diffCap n, deploy.preview required|advisory|off, artifact https://claude.ai/artifact/<id> (owner/repo only), project.budgetUsd x, project.maxIssuesPerSession n, guide.<step> "text"
  rules unset <owner/repo|default> <key> [--reason "…"]  remove one (back to the global rule, or the built-in)
  checks <run>                            run the checks.commands rule in the worktree on its HEAD commit (the CI stand-in)
  note   <run> <step|next> -              record the user's one-shot note for a step (text on stdin; only from the user's own chat message)
  notes  <run> <step...>                  hand out pending notes for the steps starting now, once (put under "User instructions" after guide)
  gc                                      remove worktrees of finished runs
  gate   <run>                            compute + record gate verdict
  decide <run>                            fetch CI + diff, compute + record merge/escalate
  merge  <run>                            re-decide, then merge the reviewed commit (the only merge path)
  risk   <run> <planned files...>         does the spec need human approval before building?
  approval <run>                          spec approved since waiting? (GitHub: a trusted "/factory approve|reject" comment; local items: F approve)
  approve <run>                           approve a local item's spec at your own terminal (type the code it shows); meant for you, refused inside agent sessions
  item new <owner/repo> "<title>" [-]     write a local item in the clone's untracked .factory/issues (- reads its body from stdin)
  postmerge <run>                         CI state of the merge commit on the base branch
  revert <run> [reason]                   open a revert PR (never merged by the factory)
  queue  <owner/repo>                     factory:ready issues whose dependencies are merged (ready), the rest (blocked), untriaged open issues
  new    "<idea>" [--name owner/repo] [--stack next-web] [--dry-run] [--yes] [--path dir] [--out dir]
                                          idea-to-app: record the idea, validate PLAN.md + issues.json, then (with --yes) create the private repo + scaffold
  issues create <owner/repo> <file.json> [--yes]  validate and preview an issue batch; with --yes create it (idempotent by key)
  project <owner/repo>                    idea-to-app status: plan, milestones, next issue, dependency order, burn, loop
  close <owner/repo#N> --merged <sha>  a git project's escalated run you merged yourself (at the remote's UI): records the merge; the sha must be the base's commit that brought in the reviewed change; yours only, never an agent's
  project set <owner/repo> host|ci|base <value>|--unset [--reason "…"]  a project's host (github|git), CI provider (github-actions|local|none) or base branch (git hosts; on origin when it has one; --unset: the host's own); yours only, never an agent's; a relaxing change needs --reason, and a verified login on a GitHub project
  retire <owner/repo> --reason "<why>"     hide an idea that never got a repo (a leaked fixture) with a recorded event; the log is never rewritten
  loop   <owner/repo>                     next issue to build, or stop (first escalation, project budget, session cap, empty queue)
  automerge <owner/repo> on|off           allow or forbid auto-merge for a project
  archive [days=14]                       compact finished runs older than N days
  eval   [fixture]                        score intake on evals/golden with headless claude (costs tokens)
  state  <run>                            print derived run state
  usage  [run]                            token burn by stage, iteration and axis: measured from transcripts, else reported
  headless-args <run> [--review|--write] [--share N] [--step <step>]  pinned claude -p flags (read-only unless --write) for a provider runner, with the run's remaining budget split N ways and the step's model, effort and fallback (JSON array)
  dir    <run>                            print the run's artifact folder
  open   [dashboard|url]                  open the dashboard (default) or an https:, file: or claude-cli: URL with the OS opener
  open   <session id> [harness]           open a session in the Claude desktop app (its local_ id, or the one recorded with its events); else print how to resume it
  install-cli                             put a \`factory\` command for this copy in ~/.local/bin (or ~/bin); prints the PATH line if needed
  install-skill [--codex]                link ~/.claude/skills/software-factory ($CLAUDE_CONFIG_DIR/skills when set; Codex: ~/.agents/skills) to this checkout (a junction on Windows)
  render [--artifact <out>]              rewrite dashboard.html, or write the claude.ai Artifact page to <out>
  demo | test`);
        process.exitCode = !cmd || ['help', '--help', '-h'].includes(cmd) ? 0 : 1;
    }
  } catch (e) {
    console.error(`factory: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
