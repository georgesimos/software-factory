# Split tooling

`move.ts` moves named top-level declarations out of a module into another, unchanged. It fixes up the imports on both sides. See [docs/plans/split.md](../../docs/plans/split.md), rule 5: regenerate a move PR rather than rebasing it.

```bash
node scripts/split/move.ts <from.mjs> <to.ts> <name,name,...>
```

After each step, check that:

- `node packages/factory/factory.mjs test` passes;
- `F state` of every `F demo` run is unchanged;
- the lines removed from `factory.mjs` equal the lines added under `packages/core/src`, ignoring `import`, `export {…}` and `export ` prefixes.

## Steps

**S2** (#38), on top of S1:

```bash
M="node scripts/split/move.ts packages/factory/factory.mjs"
$M packages/core/src/constants.ts CAP,MAX_DIFF,COST_CAP,TOKEN_CAP,PROJECT_BUDGET_USD,MAX_ISSUES_PER_SESSION,PRICES,costOf,USAGE_KEYS,TRUSTED,OUTCOMES,TERMINAL,STAGES,STATUSES,BLOCKING,SENSITIVE,sensitive,UI,SEO,DOCS,SOURCE,TEST,SEVERITIES,REVIEW_KEYS,VERIFIER_KEYS,FINDING_KEYS,blocking,isSensitive
$M packages/core/src/log.ts io,REAL_DIR,stateDir,log,factoryDir,runDir,read,record,archive
$M packages/core/src/derive.ts validateUsage,cell,burnOf,addBurn,finishBurn,INVALID,assertReviewOpen,validateReview,derive,allRuns,getRun,budget,budgetWhy
```

`packages/core/package.json`, `tsconfig.json` and `src/index.ts` are written by hand.

**S3** (#39):

```bash
$M packages/core/src/burn.ts projectsRoot,usageFile,SUB_AXIS,scanFile,measure,withMeasured
$M packages/core/src/gate.ts axesFor,reviewAxes,gate,decide,risk,metrics
```

Each step also appends its new modules to `packages/core/src/index.ts`. To verify a step against the branch below it, run `scripts/split/check.sh <base-ref> packages/core/src`.

**S4** (#40):

```bash
$M packages/core/src/skills.ts BUILTIN_AXES,REQUIRED_AXES,STEP_KEYS,harnessIds,NAME,skillsFile,checkRunner,checkStep,checkSkills,readSkills,skills,writeSkills,setSkill,front,tilde,dirs,pluginItems,globalCatalog,scanGlobal,scanProject,catalog,skillsData
$M packages/core/src/rules.ts setAutoMerge,RULES,RULE_FIELDS,LOGIN,isDay,dayOf,isGuideKey,checkRules,checkGuide,rules,whoami,audit,checkScope,setRule,unsetRule
$M packages/core/src/review.ts MIN_SHARE_USD,headlessArgs,runnerStamp,reviewFromText
```

**S5** (#41) is a folder move, not a `move.ts` run:

```bash
mkdir -p packages/adapters
for d in harnesses hosts trackers registry.mjs HARNESSES.md; do git mv packages/factory/$d packages/adapters/$d; done
```

After the move, re-point the imports in `factory.mjs`, `project.mjs`, `test/project.mjs` and `core/src/*.ts`. The self-test's three `path.join(HERE, 'harnesses'…)` lines become `path.join(HERE, '..', 'adapters', 'harnesses'…)`. They are file paths, the same kind of change as an import path, and they are the only edits to the oracle.

**S6** (#42):

```bash
$M packages/core/src/workspace.ts git,ls,projectsFile,projects,saveProject,wtFile,wtInfo,worktree,cleanup,gc,deps,localChecks
```

**S7** (#43). `SHIP`, `loadShip` and `shipTrack` stay in `factory.mjs` because the command switch assigns `SHIP`; they move in S10:

```bash
$M packages/core/src/github.ts gh,parseRun,intake,intakeFixture,adapterCtx,openPRs,facts,merge,approval,postmerge,revert
$M packages/core/src/sync.ts sessionsByBranch,SKIP_DIRS,DISCOVER_ROOTS,discover,sync
$M packages/core/src/log.ts archiveFile,sessionsFile,readArchive
$M packages/core/src/eval.ts evals
```

**S8** (#44). `project.mjs` moves whole, by `git mv`, to `packages/core/src/project.ts`. Then add `// @ts-nocheck` and re-point its imports to the core modules (and `dashboard` to `../../factory/factory.mjs`). Its templates path becomes `path.join(HERE, '..', '..', 'factory', 'templates')`. `factory.mjs` and `derive.ts` import from `./project.ts`. `hooks`, `SHIP_FILE`, `SHIP_LIST` and `shipConnectors` stay for S10:

```bash
git mv packages/factory/project.mjs packages/core/src/project.ts
$M packages/core/src/onboard.ts F_CMD,shq,onboardFile,SHIP_KINDS,readOnboard,setShip,onboardConfig,onboardState,onboardText
$M packages/core/src/demo.ts demo,demoTranscripts
```

**S9** (#45). Create `packages/server/package.json` (no dependencies) and run `pnpm install` for its lockfile entry. `hooks` stays in `factory.mjs` until S10 because it reads `factory.mjs`'s own source. After the move, the one hand edit is the dashboard path in `page()`: `path.join(HERE, 'dashboard.html')` becomes `path.join(import.meta.dirname, '..', '..', 'factory', 'dashboard.html')`, so the server no longer imports `HERE`:

```bash
$M packages/server/src/server.ts same,uiHandle,UI_ROUTES,ui,runRepos,render,runsData,page
```

**S10 seams** (#46, part 1; hand edits like S1, so fold them into S1 when regenerating). Done when `grep -rn "factory/factory.mjs" packages/core/src packages/server/src` finds no import:
- `let SHIP`, `let SHIP_LIST`, `loadShip`, `shipTrack`, `hooks`, `shipConnectors` and `SHIP_FILE` become `packages/core/src/ship.ts`, with one `ship = { mod, list }` object that the CLI assigns. `SHIP_FILE` uses `import.meta.dirname`.
- `hooks().create` is `true`. It used to regex `factory.mjs` for `case 'new':`, which would silently turn false once the switch moved; its own `shortcut:` comment said to drop that once idea-to-app landed.
- `dashboard` is defined in `core/src/log.ts` as a no-op; `server.ts` assigns `dashboard.render = render` when it loads.
- `workspace.ts` drops an unused `same` import; `eval.ts` reads `evals/golden` through `import.meta.dirname` instead of `HERE`.
- The CLI block `if (isMain) { … }` becomes `export async function main(argv) { … }` plus `if (isMain) await main(process.argv.slice(2));`, so `move.ts` can move it by name.

`check.sh` now also compares the dashboard data `F render` embeds after the demo (hooks, runs, rules…), not only `F state`.

**S10 move** (#46, part 2). Create `packages/cli/package.json` (no dependencies) and run `pnpm install`. `main.ts` imports `test` back from `factory.mjs` until S11; it is used at call time, so the cycle is safe. The one hand edit after the move: `headless-args --review` reads `references/review.schema.json` through `import.meta.dirname` instead of `HERE`:

```bash
$M packages/cli/src/main.ts main
```
