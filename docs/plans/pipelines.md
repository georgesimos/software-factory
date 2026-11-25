# Pipelines editor

A Pipelines page shows each project's pipelines: the steps an issue goes through. The owner can edit them in four ways:
- change who runs a step;
- turn optional steps off;
- add custom steps and reorder them within their slot;
- see all of it as a graph.

Code review, security review, the gate and the merge checks are locked.

Scope decisions:
- **Several named pipelines per project, picked by structured match conditions** (§7). The first match wins. The project's own pipeline, the **default pipeline**, catches every other issue and is edited in place.
- **Matching only chooses among configurations the owner has already approved, and a run can only get stricter** (§7.0).
- **Caps only go down** (§7.5).
- **The page names the project's real host and tracker.** It takes them from the adapter registry (`hostOf`, `trackerOf`: github, git, local…) and never hard-codes "GitHub".

This note fixes what is stored, how F checks it, who may write it, and how the run reads it. §1 to §6 describe one pipeline, the default; §7 adds the named ones and §8 the page. The work comes in slices (see [Slices](#slices)). Each slice is one PR.

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

**Project scopes and pipeline (`owner/repo@id`, §7.1) scopes only, as `artifact` is project-only.** A `default` entry is refused on write, and ignored with a warning on read.
- **Why:** `rules()` lets a project win key by key. If `default` could hold a list, `F rules unset <project> steps.off` would fall back to that list. Unsetting would then turn steps off with no human-only check.
- **What it gives:** with this rule, unsetting always means "nothing off", which only tightens. A named pipeline's list is its own and is never inherited either (§7.1).

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
- **A missing result escalates, never strands the run.** The session runs `F gate`, then `F merge` as for any gate result with `next: approve`. `decide()` then escalates with the reason "custom step <id> has no result". So a broken runner never leaves a run stuck. Slice 5 tests this.
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
  - an `id` that is a new lowercase name (`/^[a-z][a-z0-9-]{0,30}$/`), unique in the scope (and, with pipelines, across the project and all its pipelines, §7.1), and not a step key, built-in axis or slot name;
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
| Turn steps off | `F rules set <project> steps.off '[…]' --reason "…" [--until]`; over HTTP, `POST /api/onboard/rule` only with the desktop app's confirmation | `setRule`, plus `humanOnly('turning a pipeline step off')` for this key, plus the desktop confirmation over HTTP (below) |
| Turn every step back on | `F rules unset <project> steps.off`, also over HTTP | the existing `guard`; no `humanOnly` and no confirmation, since it only tightens. A `set` with a smaller list is still a `set`, so the turning-off guards apply to it |
| Add or reorder custom steps | `F skills set <scope> steps.custom '[…]'`, `POST /api/skills` | none new: it only adds checks |
| Remove a custom step | the same paths | `humanOnly('removing a custom step')` on any `steps.custom` write that drops an existing `id` |

**Turning a step off.** `setRule` calls `humanOnly`, so the CLI refuses inside an agent session. The audit event is the ordinary rule event: `{stage: "rules", status: "set", key: "steps.off", value, reason, setBy}`.
- **A cycle to break:** `projectset.ts` imports `rules.ts`, so `humanOnly` moves to `rules.ts`, or to a small module of its own, to avoid a circular import.
- **Over HTTP, the token isn't enough.** `humanOnly` checks the F process, and the per-launch token lives in a URL. The owner opens the dashboard in browser panes that agents can drive and read URLs from. So a `steps.off` set over HTTP needs a person's confirmation outside the page. **The rule for every guarded write made from the page:**
  - **The page may only request it.** A request writes nothing.
  - **In the desktop app:** the Electron main process shows its own native confirmation, built from F's own reading of the change (the scope, the key, the stored value and the new one, read by F, never text the page sent), and only on confirm does it write, through `setRule` as the CLI does. Cancel is the default.
  - **With no desktop app** (plain `F ui` in a browser): the route refuses, and its error gives the exact `F rules set <project> steps.off '[…]' --reason "…"` command to run in a terminal.
  - **5c's invariants stay:** no approve function in IPC or preload, and `/api/approve` is a 404. 5c's dialog opens only from the app menu. Slice 3 builds its own request channel, scoped to guarded rule writes, and doesn't loosen those.
  - **In the F process:** `humanOnly` applies as well.
  - **Unsetting** `steps.off` tightens, so it stays allowed everywhere.

  So slice 3 waits for 5c, and builds that request path.

**Removing a custom step.** The floor F guarantees is the built-in pipeline. Adding a custom step or reordering custom steps stays unguarded, since it only adds checks above that floor. Removing one is guarded, because `pipelinePass` escalates on a dropped step, and an agent session's `F skills set` would otherwise get the same effect silently.
- **Known gap, not fixed here:** removing an `axes.extra` entry has the same problem today. Any `F skills set` can drop an extra axis with no `humanOnly`.

**A local user's rule doesn't count toward an automatic merge.** A `steps.off` set by a local (unverified) user is recorded and shown. On a GitHub project, `decide()` escalates any run whose recorded axes it shaped, with the reason "a rule that removes a review needs a verified login before the factory merges on its own". This mirrors the existing rule for CI-relaxing rules.

**API.md: one deliberate exception.** The existing rules never loosen the merge gate. They tighten it, or they swap one check for another: `ci=skip` with no `checks.commands` still escalates, because `localResult` is `none`. `steps.off` is the first rule that removes a check. Slice 3 adds one sentence after "No route … loosens rules, trust or the merge gate":

> One route does, deliberately: `POST /api/onboard/rule` with `steps.off` turns optional review steps off for one project. It only requests the change: the desktop app's main process confirms it in its own dialog, built from F's reading of the change, and writes it. Without the desktop app it refuses and names the CLI command. Like `F rules set`, it needs a reason and is audited, a local user can't undo a verified login's choice, and it is refused when F runs inside an agent session.

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

Slice 5 makes these changes, after PR 6 merges.

## 7. Several pipelines per project

§1 to §6 carry over unless this section says otherwise: what is stored today, the locked list, custom steps' slots, `F steps`/`F step`, and `pipelinePass`.

### 7.0 The idea under it

The owner chose:
- several named pipelines per project, each picked by structured match conditions;
- the first match wins, and the default pipeline (the project scope) catches the rest and stays editable in place;
- caps that only go down.

**Matching only chooses among configurations the owner has already approved, and a run can only get stricter.** Labels, changed files and diff size are agent-influenced: the build agent shapes the files and the diff, and a local item's labels are a file anyone can edit. So nothing a match can do may loosen anything the owner didn't approve through the guarded, audited path, and a run never goes back to a looser pipeline once it has seen a stricter one.

### 7.1 What a pipeline is, and where it's stored

A named pipeline is **one more scope in skills.json**, addressed `owner/repo@id`, next to `default` and `owner/repo`. Same file, same per-scope shape, same `setRule`/`unsetRule`, the same audit event. There's no second store.

```json
"acme/shop": {
  "rules": {
    "pipelines": { "value": ["hotfix", "ui-first", "spike"], "reason": "…", "setBy": "acme", "setAt": "…" },
    "steps.off": { "value": ["review.seo"], "reason": "…", "setBy": "acme", "setAt": "…" },
    "run.loops": { "value": 2, "reason": "…", "setBy": "acme", "setAt": "…" }
  }
},
"acme/shop@hotfix": {
  "name": "Hotfix",
  "rules": {
    "match":     { "value": [{ "labels": ["hotfix"] }], "reason": "…", "setBy": "acme", "setAt": "…" },
    "steps.off": { "value": ["review.ux", "review.ui", "review.seo", "review.docs"], "reason": "…", "setBy": "acme", "setAt": "…" },
    "run.loops": { "value": 1, "reason": "…", "setBy": "acme", "setAt": "…" }
  },
  "steps.custom": [{ "id": "smoke", "slot": "build.after", "use": "brief", "path": "…" }]
},
"acme/shop@ui-first": {
  "name": "UI first",
  "rules": { "match": { "value": [{ "files": ["src/components/**", "*.css"] }], "reason": "…", "setBy": "acme", "setAt": "…" } },
  "axes.on": ["review.ux", "review.ui"],
  "axes.extra": [{ "axis": "a11y", "when": ["src/components/**"], "use": "skill", "name": "a11y-review" }]
}
```

- **The order is a rule on the project scope:** `pipelines`, the ids in match order. The default pipeline is the project scope itself and is never listed: it is always last. A `@id` scope that isn't listed is ignored, with a warning, and never matches. Removing a pipeline means removing it from the list.
- **What a pipeline scope may hold:**
  - `name` (cosmetic);
  - the rules `match`, `steps.off`, `run.loops` and `run.budgetUsd`;
  - `steps.custom`;
  - **added review steps:** `axes.on`, a list of optional built-in axes (`OPTIONAL_STEPS`) the pipeline always reviews, whatever the files; and `axes.extra`, extra axes of its own, in the existing `axes.extra` shape, each with its own runner.

  Anything else is refused on write and dropped with a warning on read.
- **Built-in steps' runners stay per project.** A pipeline changes which steps run and the caps, never who runs a built-in step. The `STEP_KEYS` runner keys and `guide` are refused in a `@id` scope. Only a pipeline's own extra axes carry a runner, because they are its own steps. "A cheaper model for hotfixes" can be a later key without changing anything here.
- **How each part combines with the project scope:**
  - `steps.off` is the pipeline's own list and is never inherited. The project's `steps.off` belongs to the default pipeline only. Unsetting a pipeline's `steps.off` therefore means "nothing off", which only tightens. This is the same reason `steps.off` is refused on `default` (§3).
  - `steps.custom` is additive: a pipeline runs the project's custom steps, then its own. A pipeline can't drop a check the default runs.
  - Added review steps are additive too. `axes.on` forces its axes on, and the pipeline's `axes.extra` runs next to the project's.
  - **Ids are unique across the project and all its pipelines.** The meet unions custom steps and extra axes over every pipeline a run has matched, so one run can meet two pipelines' definitions. A custom-step `id` or an extra-axis name already used by the project or by any of its pipelines is refused on write; a pipeline can't replace the project's step or axis either. On read, a duplicate is dropped with a warning, keeping the project's, then the first pipeline's in `pipelines` order.
  - `run.loops` and `run.budgetUsd` take the lowest of the pipeline, the project and the built-in value (§7.5).
  - Built-in runners and `guide` come from the project scope, as today.
- **Consequence:** compared with the default pipeline, a named pipeline can be looser **only through `steps.off`**. Its custom steps and its review steps are a superset, and its caps are at most the project's. Between two pipelines, though, everything a run gets can differ: `steps.off`, caps (Hotfix at 1 loop, another at 3), custom steps and added review steps. Routing a run away from a pipeline drops what that pipeline adds, so §7.3 guards a routing write whenever any of those differ.
- **What the design system shows:** `pipeline(repo)` returns `{ pipelines: [{id, name, match, …pipeline}], default: {…pipeline} }`, the same per-pipeline shape the graph already draws (`PipelineGraph`, PR A). Each named entry adds `match`.

### 7.2 Match conditions: structured data

`match` is a list of **condition sets**. A set matches when every term in it holds (AND). The pipeline matches when any set matches (OR). There are no parsed expression strings and no negation.

```json
[{ "labels": ["hotfix"] }, { "files": ["docs/**", "*.md"], "maxDiffLines": 40 }]
```

| Term | Holds when | Read from |
|---|---|---|
| `labels: [l…]` | the item has every listed label | the labels F intake read and recorded on `intake started` (below) |
| `files: [glob…]` | **every** changed file matches at least one glob | the same diff `F axes` uses |
| `maxDiffLines: n` | additions + deletions ≤ n | the same numstat `facts()` uses |

- `files` means "every changed file", not "any file", on purpose (the owner's choice): a looser pipeline applies only when the whole change is in its scope. A change that touches `src/components/` and the payment code doesn't count as a UI change.
- **Validation on write:**
  - 1 to 5 sets;
  - each set non-empty (an empty set would match everything);
  - 1 to 10 labels, never a `factory:*` label (F writes those itself);
  - 1 to 20 globs, checked with the same glob code `axes.extra` uses;
  - `maxDiffLines` an integer from 1 to `MAX_DIFF`.

  On read, an invalid `match` makes that pipeline never match, with a warning, so its runs fall through to a later pipeline or the default.
- **Labels:** `TrackerItem` gains `labels`. F intake records the labels it read on `intake started`, the event it already writes itself with the author and association, so they are never typed by the agent. A label added later, even by the run's own session, doesn't count.
- **Diff size on git projects:** until the #137 item is fixed, `maxDiffLines` is refused on write for a project whose host is `git`. On read, a set containing it is treated as no match, with a warning. That item is `.git/info/attributes` with `* -diff`, which makes numstat report `- -`, so the count reads zero and would match every change.

### 7.3 Agent-influenced inputs, and which writes are guarded

The inputs are not trusted, so the guard sits on the **configurations**, not on the match:
- Every pipeline keeps the locked steps. `steps.off` refuses a locked key on write, and `axesFor` checks the locked list again on read. That is unchanged.
- A pipeline's `steps.off` is the guarded, audited write: `humanOnly`, a reason, the rule audit event, the local-user guards, and over HTTP a request the desktop app confirms (§5). This is the same path as the default pipeline's `steps.off`.
- **Routing is the same loosening.** Changing `match`, the `pipelines` order, or which pipelines exist decides what a run gets: its `steps.off` list, its caps, its custom steps and its added review steps. De-listing a pipeline, or rewriting its `match` so it never matches, drops that pipeline's custom steps, `axes.on` and extra axes from every later run, just as removing them would. F doesn't compare glob sets, so it can't tell "this narrows" from "this widens".
  - **Guarded:** every routing write, while any two pipelines of the project (the default included) differ in anything a run gets: `steps.off`, effective caps, custom steps, `axes.on` or extra axes. That is `humanOnly`, a reason and the audit event, and over HTTP a request the desktop app confirms (§5).
  - **Unguarded:** a routing write only when all the pipelines are identical in all of those. Routing then can't change anything a run gets.
  - In practice almost every real routing change is guarded. That's intended: it's an owner's decision, made in a terminal or the desktop app.
- **Unguarded writes:**
  - `name`;
  - adding or reordering custom steps;
  - adding review steps: an `axes.on` entry or a pipeline's own extra axis;
  - lowering a cap;
  - shrinking a `steps.off` list, or unsetting it.
- **Guarded removals:** removing a custom step (§5) or an added review step (an `axes.on` entry, or a pipeline's extra axis) is `humanOnly`, as removing a custom step is.

### 7.4 When the pipeline is picked, and how a run only tightens

**One pick point per iteration: after build, before review.** That is the first of `F steps RUN build.after` and `F axes RUN` in an iteration. Only there do all three inputs exist: the labels (from intake), the changed files and the diff size.

**Where labels come from.** On GitHub, labels come from the issue; setting one needs triage access to the repository. On a local item, labels are the item file's front matter, which anyone who can edit the file can change. Both are fine: matching only picks among configurations the owner already approved (§7.0), so a label can at most choose one of those.

**Before the first pick** the run is under the default pipeline for everything that comes before review:
- the project's `spec.after` custom steps;
- the project's caps.

A named pipeline can therefore add `build.after` custom steps and review steps, but never `spec.after` ones, which are project-level only. A `spec.after` entry in a `@id` scope is refused on write.

**At each pick,** F evaluates the pipelines in order and takes the first match, or the default if none matches.

**Within a run, the effective pipeline is the meet of every pipeline it has matched so far and the live config.** The meet is the strictest combination:
- `off` is the intersection of every matched pipeline's `off`, intersected again with the current pipeline's live `steps.off` (so unsetting it mid-run turns steps back on, as in §6);
- custom steps are the union (a step that has been due stays due, as before);
- added review steps (`axes.on` and the pipelines' extra axes) are the union too: once due, they stay due;
- caps are the minimum (§7.5).

What this gives:
- **A loop-back that changes the match** can only tighten. Say iteration 1 matched UI-first (SEO off), and iteration 2's diff also touches payment code, so it matches the default (nothing off). From then on SEO is reviewed again, and re-matching UI-first in iteration 3 can't turn it back off.
- **A run never returns to a looser pipeline** once it has left it. This is §6's `steps.off` snapshot, extended across pipelines: the run's first `routed` event fixes its starting point, and each later one can only remove things from `off`.
- **Labels can't move a run mid-way.** They are read once, at intake. A resume after needs-info re-reads them, and the meet still only tightens.

### 7.5 Caps

There are two new rule keys, `run.loops` and `run.budgetUsd`, on a project scope or a `@id` scope. `TOKEN_CAP` stays fixed.

- **Validate on write:**
  - `run.loops` is an integer, at least 1 and at most `CAP` (3);
  - `run.budgetUsd` is a number above 0 and at most `COST_CAP` ($5).
- **Clamp on read:** `min(stored, built-in)`, so a hand edit can't raise a cap. A value that isn't valid is dropped with a warning, and the built-in value applies.
- **What a pipeline gets:** the minimum of the pipeline's, the project's and the built-in value.
- **In a run:** the minimum of the run's snapshot (the lowest value any pick has seen, per §7.4) and the live value. Spend before the pick counts against the picked pipeline's budget: a run already over it at the pick escalates at the next gate, as the over-budget check does today.
- **Raising is a loosening:**
  - Setting a cap higher than the stored value, or unsetting a cap rule (which falls back to a higher value), is `humanOnly`, needs a reason, and is audited, and over HTTP is a request the desktop app confirms (§5).
  - Lowering is free: `asStrict` already treats a smaller number as stricter.
  - Note the asymmetry with `steps.off`. Unsetting `steps.off` tightens. Unsetting a cap loosens.

### 7.6 F owns the choice

- **The `routed` record.** At each pick F records `{stage: 'review', status: 'routed', pipeline, set, iteration, facts: {labels, files, diffLines}}`, where `set` is the index of the condition set that matched. It is written by whichever of `F steps` and `F axes` runs first.
  - `F event` refuses it: the owned map gains `'review:routed': 'axes'`.
  - `derive` keeps `r.pipeline` (the current id) and `r.route` (the meet's `off`, added review steps and caps). It doesn't let `routed` change the run's stage or status.
- **`decide()` names it.** It names the pipeline and the set in its reasons, for example: "pipeline hotfix (set 1: labels hotfix): review.ux, review.ui off by rule steps.off on acme/shop@hotfix, set by …: …". Every turned-off axis therefore shows on the decision it shaped, as in §6.
- **A local user's rule doesn't count toward an automatic merge.** On a GitHub project, §5's rule still holds: a `steps.off`, `match` or `pipelines` rule set by a local (unverified) user escalates any run it shaped.
- **The run detail** shows the pipeline's name, the set that matched, and the facts it matched on, beside the stage track.

## 8. The page

- **Left column:**
  - a project picker;
  - that project's pipelines in match order, with the default last as "every other issue";
  - each row shows its name, its match summary ("label hotfix", "files docs/** · ≤ 40 lines"), its run count and the step strip (PR A's `PipelineList`).
- **Centre:** the graph for the selected pipeline (`PipelineGraph`), with the footer showing that pipeline's effective caps. Turned-off steps stay on the graph, greyed and struck through, and are toggled in place.
- **Right panel:** its conditions as structured rows, its caps next to the built-in values, its `steps.off` with who set it and why, and its custom and added review steps.
- **Editing:** what a slice allows. A guarded write is only requested from the page: the desktop app confirms it in its own dialog and writes it, and plain `F ui` shows the exact `F rules set …` command instead (§5).

**Editor patterns borrowed from n8n.** These are the patterns only, not n8n's look or names:

| Pattern | Slice |
|---|---|
| A **step panel**: a step's settings, and with "Show a run…" that step's input and output from a past run, read-only | 2 |
| A **run overlay** on the graph: each step's status, the path the run took lit, loop counts, and spend against the cap | 2 |
| **Turned-off steps** greyed and struck through, toggled in place on the graph | 3 |
| **Templates** to start a pipeline from, its **history** from the rules audit trail, and a **match editor** | 4 |
| An **insert "+"** on each valid slot of a connection, opening a searchable step picker | 5 |

Not taken from n8n: re-running a single step, and pinned test data. Both would let a step's result come from somewhere other than a real run.

## Slices

1. **This note, then a read-only page** (#139).
   - The core part is `pipeline(repo)`, `LOCKED_STEPS` and `OPTIONAL_STEPS`, read-only, with `off` and `custom` always empty until slices 3 and 5.
   - The page part is `apps/web` and the desktop bundle.
2. **A: the design-system move** (#141): `PipelineGraph`, `PipelineList` and `pipelineModel` in the design system, with playground fixtures.
3. **5c: the desktop approval dialog** (local-first PR 5c, #142). Slices 3 to 5 confirm guarded writes in the desktop app the same way: native, in main, never opened with page text.
4. **Slice 2: change a step's runner** from the graph, through `POST /api/skills`. No guard is needed, and nothing waits.
   - The step panel and the run overlay (§8).
   - Fixture fixes: the Hotfix fixture must not change `loops`, the graph's loop-backs to spec and build (locked structure; its lower loop cap is fine), and the Research spike fixture must not have a `spec.after` step (§7.4).
5. **Slice 3: steps off**, for the default pipeline only:
   - the `steps.off` rule and its `asStrict` case;
   - `humanOnly` in `setRule`;
   - `pipelinePass` for `steps.off`;
   - the `axesFor` drop, the snapshot, and the `decide` reason;
   - the request path (§5): the page requests a guarded write, the desktop main process confirms it in a native dialog built from F's own reading of the change and writes it; plain `F ui` refuses and names the CLI command. 5c's invariants stay (no approve IPC or preload, `/api/approve` a 404);
   - the API.md line;
   - the caps rules (§7.5), since raising one uses the same guard;
   - turned-off steps greyed in place on the graph (§8).
6. **Slice 4: matching.**
   - The `@id` scopes, `match` and `pipelines`, and labels on `TrackerItem` and `intake started`.
   - The routing guard (§7.3), comparing everything a run gets, and id uniqueness across the project and its pipelines (§7.1).
   - The pick and the `routed` record, the meet, `decide` naming the pipeline, and the run detail.
   - The page's pipelines list with editing: templates, history from the rules audit trail, and the match editor (§8).
   - This waits for slice 3, since a named pipeline's only looseness is `steps.off` and caps.
7. **Slice 5: custom steps and added review steps**, after PR 6:
   - `steps.custom` with its validation and `pipelinePass`;
   - `decide` escalating on a dropped list, and on a due step with no result;
   - `humanOnly` on a write that removes a custom step or an added review step;
   - `F steps` and `F step`, with the refusals in `F event build started`, `F axes` and `gate()`;
   - the loop-backs routed by slot;
   - a pipeline's `axes.on` and its own `axes.extra` (§7.1), unioned in the meet (§7.4);
   - the insert "+" with its searchable step picker (§8);
   - the SKILL.md wording.

Every slice has a failing-first test for each behaviour change. Slice 4's tests include:
- a loop-back whose match changes and only tightens;
- `F event` refusing `routed`;
- `maxDiffLines` refused on a git project;
- a routing write refused inside an agent session while two pipelines differ;
- a routing write that would drop a pipeline's added review step, refused inside an agent session. Pipelines hold added review steps only from slice 5, so slice 4's guard already compares them and this test lands with slice 5.

Slice 5's include:
- a removed `axes.on` entry refused inside an agent session;
- an added axis that stays due after the run re-matches a pipeline without it;
- a custom-step id or extra-axis name used by two pipelines (or a pipeline and the project), refused on write, and on read the later one dropped with a warning.
