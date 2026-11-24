# Pipelines editor

A Pipelines page shows each project's pipeline: the steps an issue goes through. The owner can edit it in four ways:
- change who runs a step;
- turn optional steps off;
- add custom steps and reorder them within their slot;
- see all of it as a graph.

Code review, security review, the gate and the merge checks are locked.

Scope decisions:
- **One pipeline per project, edited in place.** There are no copies, and no label matching ("first match wins"). The owner chose direct editing.
- **The page names the project's real host and tracker.** It takes them from the adapter registry (`hostOf`, `trackerOf`: github, git, local…) and never hard-codes "GitHub".

This note fixes what is stored, how F checks it, who may write it, and how the run reads it. The page itself comes in four slices (see [Slices](#slices)). Each slice is one PR.

## 1. What is stored today

Everything here is user-local in `~/.claude/factory/skills.json`, so a repo, and so a PR, can never choose its own pipeline. The file has a `"default"` scope and one scope per `owner/repo`. A project scope wins key by key.

| Key in a scope | Shape | Written by | Read by |
|---|---|---|---|
| `intake`, `spec`, `build`, `review.<axis>`, `verifier`, `postmerge` (`STEP_KEYS`) | a runner: `{use: default\|skill\|brief\|provider, name?, path?, harness?, model?, effort?, fallback?}` (`checkRunner`) | `F skills set\|unset`, `POST /api/skills`; `F skills preset`, `POST /api/skills/preset` | `skills()`: `plan`, with unset fields filled from the global step, then the All-Claude preset |
| `axes.extra` | `[{axis, when: [glob…], …runner}]`: a new lowercase name, never a built-in axis, never `use: default` | `F skills set <scope> axes.extra` | `skills().extra`. `axesFor` adds an extra axis when a changed file matches its `when` |
| `rules` | `{<key>: {value, reason, setBy, via?, setAt, until?}}` for `ci`, `checks.commands`, `diffCap`, `project.budgetUsd`, `project.maxIssuesPerSession`, `deploy.preview` and `artifact` (`RULES`) | `F rules set\|unset`, `POST /api/onboard/rule`. Both call `setRule`/`unsetRule`, which run `whoami`, the `guard`/`guardShadow` check (a local user can't loosen what a verified login set) and an audit event | `rules()`: `policy`, `expired` and `warnings` |
| `guide` | `{'*'\|<step>\|review.<extra>: text ≤ 1000}` | `F rules set <scope> guide.<step>` | `rules().guide`, at the top of each step's brief |

Other stores and constants:
- **`projects.json`:** `host`, `ci`, `base`, `tracker`, `autoMerge` and `path`. `host`, `ci` and `base` are written only by `F project set`, which is `humanOnly`, audited, and needs a reason when it relaxes a check.
- **Fixed in code, never configurable:**
  - `REQUIRED_AXES` (`code`, `security`);
  - `CAP` = 3 loops, and the per-run `COST_CAP` ($5) and `TOKEN_CAP`;
  - `TRUSTED`, `SENSITIVE` and `MAX_DIFF`;
  - `axesFor`'s built-in globs: UI files select `ux` and `ui`, SEO files select `seo`, docs files select `docs`.

**Not stored anywhere today:**
- turning a step off;
- a custom step outside the review slot (which `axes.extra` covers) and the after-merge slot (which `postmerge` covers);
- an order.

## 2. Locked and optional steps

The locked list is exported once from `skills.ts`, and nothing else defines it: not the page, not SKILL.md, not the tests.

```ts
export const LOCKED_STEPS = ['intake', 'spec', 'build', ...REQUIRED_AXES.map((a) => `review.${a}`), 'verifier', 'gate', 'merge', 'watch'] as const;
export const OPTIONAL_STEPS = BUILTIN_AXES.filter((a) => !REQUIRED_AXES.includes(a)).map((a) => `review.${a}`); // ux, ui, seo, docs
```

- **Not runners:** `gate`, `merge` and `watch` (`F postmerge`'s CI check) are F's own decisions. They appear on the graph and are never configurable.
- **A built-in step can be:**
  - **Run by someone else:** its runner changes, and the step stays in place. This is how "edit the built-in pipeline directly" works.
  - **Turned off:** optional steps only.
- **Extra axes:** a user's extra axis (`review.<extra>`) can also be turned off. It is the user's own addition, so it can also simply be removed (§5).

## 3. The stored shape of the new parts

There are two new keys, one per kind of change.

### Turning steps off: the rule `steps.off`

```json
"acme/app": { "rules": { "steps.off": { "value": ["review.seo", "review.docs"], "reason": "a CLI tool with no pages", "setBy": "acme", "setAt": "2026-11-24T10:00:00Z", "until": "2027-01-31" } } }
```

Turning a step off is a loosening, so it is a rule. That gives it, with no new machinery:
- the required reason;
- `setBy` and `via`;
- expiry and its warnings;
- the audit event;
- the local-user guards.

`asStrict('steps.off', next, old)` is true when `next ⊆ old`: turning fewer steps off is stricter.

**Project scopes only, as `artifact` is.** A `default` entry is refused on write, and ignored with a warning on read.
- **Why:** `rules()` lets a project win key by key. If `default` could hold a list, `F rules unset <project> steps.off` would fall back to that list. Unsetting would then turn steps off with no human-only check.
- **What it gives:** with this rule, unsetting always means "nothing off", which only tightens. It also matches "one pipeline per project".

### Custom steps: the skills key `steps.custom`

```json
"acme/app": { "steps.custom": [
  { "id": "spec-lint", "slot": "spec.after",  "use": "skill", "name": "spec-lint" },
  { "id": "e2e",       "slot": "build.after", "use": "brief", "path": "~/.claude/factory/briefs/e2e.md", "when": ["apps/web/**"] }
] }
```

**Slots** are fixed points between locked steps. A custom step only adds a failure, never clears one, and never moves the gate.

| Slot | Runs | On failure |
|---|---|---|
| `spec.after` | after the spec is written, before the approval wait or build | back to spec, counted as a loop like a gate loop-back (`CAP` still bounds it) |
| `build.after` | after build's checks pass, before `F axes` | back to build, as a gate loop-back |
| review (existing) | in parallel with the review axes | the gate fails that axis. This slot is `axes.extra`, unchanged, so there is no second store |
| after merge (existing) | after `F postmerge` passes | `F revert`. This slot is the `postmerge` runner, unchanged |

Rules for custom steps:
- **Order** is the array order within one slot. Built-in steps never reorder.
- **Across scopes,** default's custom steps run first, then the project's. A project entry with the same `id` replaces default's in place, as `axes.extra` does per axis.
- **`when`** (optional globs, `build.after` only) makes the step run only when a changed file matches. With no `when`, it runs every time. A `spec.after` step runs before there is a diff, so it is always due.

**Core enforces that custom steps run, as it does for the review axes.** The UI and SKILL.md don't.
- **What's due:** `F steps RUN <slot>` works out which custom steps are due this iteration. That is the slot's list, with `when` matched against the same diff `F axes` uses. It records them on a `custom started {slot, ids, iteration}` event, which it owns as `F axes` owns `review started`.
- **Results:** `F step RUN <id> passed|failed -` records one step's result, keyed by its `id`, so two steps in one slot are never confused. `F event` refuses these stages, as it refuses axis verdicts.
- **Missing records:**
  - **Before build:** `F event RUN build started` refuses while a due `spec.after` step has no result. It also refuses when that slot was never recorded this iteration but the resolved list isn't empty.
  - **Before review:** `F axes` refuses in the same cases for `build.after`.
  - **At the gate:** `gate()` fails on a custom failure and routes it by slot (`spec.after` to spec, `build.after` to build). On a due step with no result it doesn't refuse: it fails with `next: approve`, as the loop cap does.
- **Due stays due:** once `F steps` has recorded a step as due, it stays due for that iteration even if it is removed from config. Otherwise removing a failing step would clear its failure.
- **A missing result escalates, never strands the run.** The session runs `F gate`, then `F merge` as for any gate result with `next: approve`. `decide()` then escalates with the reason "custom step <id> has no result". So a broken runner never leaves a run stuck. Slice 4 tests this.
  - **Why the earlier refusals don't strand it:** `F event RUN build started` and `F axes` refuse only until something is recorded, and output outside the contract records a failure. So a broken runner's step is always recordable.
- **`F step` has `F review`'s contract.** Output outside the contract records a failure, never a pass, and a runner never fixes up its own JSON.
- **What a custom step can't do:** nothing it reports can mark a locked step passed.

## 4. Validation

**Strict on write, lenient on read**, the way `dropUnknownModels` already treats models.

**On write,** `setRule` and `setSkill` call `checkSkills`, which refuses:
- **`steps.off`** unless all of these hold:
  - it is set on a project scope;
  - it is an array of 1 to 10 distinct keys;
  - each key is in `OPTIONAL_STEPS`, or is `review.<name>` with an extra-axis name.

  A locked key is refused with a message that names F's locked list. An empty array is refused: `F rules unset` turns everything back on.
- **`steps.custom`** unless it is an array of at most 10 entries, each with:
  - an `id` that is a new lowercase name (`/^[a-z][a-z0-9-]{0,30}$/`), unique in the scope, and not a step key, built-in axis or slot name;
  - a `slot` of `spec.after` or `build.after`;
  - a runner that passes `checkRunner`, never `use: default` (there is no built-in brief for it);
  - an optional `when` that is a non-empty array of globs.

**On read,** a new `pipelinePass(cfg)` runs before `checkSkills`. It never throws, so a hand-edited file can't crash core:
- **A broken `steps.off`:** an invalid or locked entry is dropped from it, with a warning. A whole `steps.off` that isn't a valid rule is dropped too. Turning fewer steps off only ever makes the pipeline stricter.
- **A broken `steps.custom`:** the whole list is dropped with a warning, and that scope runs the built-in pipeline. Running some of the steps in a broken order could be worse.
- **An entry naming an extra axis that doesn't exist** is ignored with a warning. Turning off a step that doesn't exist is harmless.
- **Where warnings go:** `rules().warnings` carries them, so `F rules` prints them and SKILL.md step 0.3 already tells the user every line.

**A dropped custom step never merges silently.** While `pipelinePass` reports a dropped `steps.custom`, `decide()` escalates, with the warning as its reason, the way `trustBroken` and `ciBroken` fail closed. The fallback keeps the run going, and the escalation keeps a check the owner asked for from being skipped on the way to an automatic merge.

## 5. The write paths and their guards

| Change | Path | Guard |
|---|---|---|
| Change a step's runner | `F skills set <scope> <step> <runner>`, `POST /api/skills` | none new. The graph calls the same route the Skills sheet calls, so there is no second code path |
| Turn steps off | `F rules set <project> steps.off '[…]' --reason "…" [--until]`; over HTTP, `POST /api/onboard/rule` only with the desktop app's confirmation | `setRule`, plus `humanOnly('turning a pipeline step off')` for this key, plus the confirmation over HTTP (below) |
| Turn every step back on | `F rules unset <project> steps.off`, also over HTTP | the existing `guard`; no `humanOnly` and no confirmation, since it only tightens. A `set` with a smaller list is still a `set`, so the turning-off guards apply to it |
| Add or reorder custom steps | `F skills set <scope> steps.custom '[…]'`, `POST /api/skills` | none new: it only adds checks |
| Remove a custom step | the same paths | `humanOnly('removing a custom step')` on any `steps.custom` write that drops an existing `id` |

**Turning a step off.** `setRule` calls `humanOnly`, so the CLI refuses inside an agent session. The audit event is the ordinary rule event: `{stage: "rules", status: "set", key: "steps.off", value, reason, setBy}`.
- **A cycle to break:** `projectset.ts` imports `rules.ts`, so `humanOnly` moves to `rules.ts`, or to a small module of its own, to avoid a circular import.
- **Over HTTP, the token isn't enough.** `humanOnly` checks the F process, and the per-launch token lives in a URL. The owner opens the dashboard in browser panes that agents can drive and read URLs from. So a `steps.off` set over HTTP needs a person's confirmation outside the page:
  - **In the desktop app:** the route needs the 5c confirmation dialog in the Electron main process, the same mechanism as approvals.
  - **With no dialog** (plain `F ui` in a browser): the route refuses, and its error gives the exact `F rules set <project> steps.off '[…]' --reason "…"` command to run in a terminal.
  - **In the F process:** `humanOnly` applies as well.
  - **Unsetting** `steps.off` tightens, so it stays allowed everywhere.

  So slice 3 waits for 5c.

**Removing a custom step.** The floor F guarantees is the built-in pipeline. Adding a custom step or reordering custom steps stays unguarded, since it only adds checks above that floor. Removing one is guarded, because `pipelinePass` escalates on a dropped step, and an agent session's `F skills set` would otherwise get the same effect silently.
- **Known gap, not fixed here:** removing an `axes.extra` entry has the same problem today. Any `F skills set` can drop an extra axis with no `humanOnly`.

**A local user's rule doesn't count toward an automatic merge.** A `steps.off` set by a local (unverified) user is recorded and shown. On a GitHub project, `decide()` escalates any run whose recorded axes it shaped, with the reason "a rule that removes a review needs a verified login before the factory merges on its own". This mirrors the existing rule for CI-relaxing rules.

**API.md: one deliberate exception.** The existing rules never loosen the merge gate. They tighten it, or they swap one check for another: `ci=skip` with no `checks.commands` still escalates, because `localResult` is `none`. `steps.off` is the first rule that removes a check. Slice 3 adds one sentence after "No route … loosens rules, trust or the merge gate":

> One route does, deliberately: `POST /api/onboard/rule` with `steps.off` turns optional review steps off for one project. It needs the desktop app's confirmation dialog, and without one it refuses and names the CLI command. Like `F rules set`, it needs a reason and is audited, a local user can't undo a verified login's choice, and it is refused when F runs inside an agent session.

## 6. How the run reads it

**`F skills OWNER/REPO`** gains a `pipeline` field, built by one read-only helper, `pipeline(repo)` in `skills.ts`:

```json
{ "locked": [...LOCKED_STEPS], "optional": [...OPTIONAL_STEPS], "off": [{ "step": "review.seo", "scope": "acme/app", "reason": "…", "by": "acme", "until": "…" }],
  "custom": { "spec.after": [ {id, …runner} ], "build.after": [ … ] }, "warnings": [ … ] }
```

The page draws its graph from this field, from `rules` and from `GET /api/state`, so the graph is never drawn statically. `GET /api/state` already embeds `skills` and `rules`, so the page needs no new route.

**No local user name on the page.** `off[].by` is the GitHub login, or `"a local user (unverified)"` when the rule's `via` is `local`, so the OS user name (which can be `DOMAIN\user`) never reaches the page. Today's decide reasons do show it, through `byText`'s "(local, unverified)". The `steps.off` reason uses the same wording as the page, and changing `byText` itself is outside this note.

**`F axes RUN`.** `axesFor` drops the axes in `off` after selecting them, and it never drops a required axis: the locked list is checked again here, not only on write.
- **Snapshot per run, which can only shrink:** `F axes` records the `off` list on the run's first `review started` event. Each later iteration turns off the snapshot intersected with the live rule.
  - **Turning a step off mid-run** can't clear a failure the step already found. It applies from the next run.
  - **Unsetting the rule, or its expiry, mid-run** turns the step back on for this run.
- **Failed axes:** `reviewAxes` still re-reviews every axis that failed last time.

**`F decide`.** It lists each turned-off axis in its reasons, with the rule's reason and `setBy` ("review.seo off by rule steps.off, set by …: …"), as it does today for `ci`. A turned-off axis therefore shows on every decision it shaped.

**SKILL.md, rewritten in PR 6:**
- **Setup:** step 0.3 keeps `pipeline` with `plan`.
- **Custom steps:** after §2's spec is written, run `F steps RUN spec.after`; after §3's checks, run `F steps RUN build.after`. Run each step it returns. Each one gets `F notes` and its guidance like any step, and its result is recorded with `F step RUN <id> passed|failed -`.
- **Review:** §4 is unchanged. `F axes` already returns the axes minus the turned-off ones, and the gate checks only recorded axes.
- **Ground rule:** "Run `F rules set … steps.off` only when the user asks in chat, with their reason". It is the existing rules ground rule, naming the new key.

Slice 4 makes these changes, after PR 6 merges.

## Slices

1. **This note, then a read-only page.**
   - The core part is `pipeline(repo)`, `LOCKED_STEPS` and `OPTIONAL_STEPS`, read-only, with `off` and `custom` always empty until slices 3 and 4.
   - The page part is `apps/web` and the desktop bundle.
2. **Change a step's runner from the graph,** through `POST /api/skills`.
3. **Turn steps off** (waits for 5c's confirmation dialog):
   - the `steps.off` rule and its `asStrict` case;
   - `humanOnly` in `setRule`;
   - `pipelinePass` for `steps.off`;
   - the `axesFor` drop, the snapshot, and the `decide` reason;
   - the HTTP confirmation, or the refusal that names the CLI command;
   - the API.md line.
4. **Custom steps:**
   - `steps.custom` with its validation and `pipelinePass`;
   - `decide` escalating on a dropped list, and on a due step with no result;
   - `humanOnly` on a write that removes a custom step;
   - `F steps` and `F step`, with the refusals in `F event build started`, `F axes` and `gate()`;
   - the loop-backs routed by slot;
   - the SKILL.md wording.

   This slice waits for PR 6.

Every slice has a failing-first test for each behaviour change.
