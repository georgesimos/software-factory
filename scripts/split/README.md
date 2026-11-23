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
