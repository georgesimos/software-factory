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
