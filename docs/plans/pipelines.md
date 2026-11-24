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

There are two new keys, one per kind of change. Both sit in the same scopes as everything else, and a project wins over `default` key by key.

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
- **`when`** (optional globs) makes the step run only when a changed file matches. With no `when`, it runs every time.
- **Recording:** a custom step's result is recorded with `F event RUN <slot> failed|passed -`. A `failed` routes as the table says. Nothing a custom step reports can mark a locked step passed.

## 4. Validation

**Strict on write, lenient on read**, the way `dropUnknownModels` already treats models.

**On write,** `setRule` and `setSkill` call `checkSkills`, which refuses:
- **`steps.off`** unless it is an array of 1 to 10 distinct keys. Each key must be in `OPTIONAL_STEPS`, or be `review.<name>` with an extra-axis name. A locked key is refused with a message that names F's locked list. An empty array is refused: `F rules unset` turns everything back on.
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
| Turn steps off | `F rules set <scope> steps.off '[…]' --reason "…" [--until]`, `POST /api/onboard/rule` | `setRule`, plus `humanOnly('turning a pipeline step off')` for this key |
| Turn steps back on | `F rules unset <scope> steps.off`, or `set` with a subset | the existing `guard`; no `humanOnly`, since it only tightens |
| Add, remove or reorder custom steps | `F skills set <scope> steps.custom '[…]'`, `POST /api/skills` | none new, as for `axes.extra` |

**Turning a step off.** `setRule` calls `humanOnly`, so the CLI and `POST /api/onboard/rule` refuse in exactly the same cases. Both run the same function in a process that has the same environment check. The audit event is the ordinary rule event: `{stage: "rules", status: "set", key: "steps.off", value, reason, setBy}`.
- **A cycle to break:** `projectset.ts` imports `rules.ts`, so `humanOnly` moves to `rules.ts`, or to a small module of its own, to avoid a circular import.
- **A known limit:** `humanOnly` checks the F process, not whoever sent the HTTP request. When the app runs `F ui` outside an agent session, the boundary is the per-launch token, exactly as for every other write route. Moving this choice behind a per-request confirmation is a later upgrade.

**Why removing a custom step needs no guard.** The floor F guarantees is the built-in pipeline. Anything above it (`steps.custom`, `axes.extra`, a stricter rule) is the user's own addition, and taking it away returns to that floor. Going below the floor is the one thing that is guarded, and only `steps.off` does it.

**API.md.** Its line "No route approves, merges, or loosens rules, trust or the merge gate" is already inaccurate today. `POST /api/onboard/rule` sets any rule, including `ci skip`, `deploy.preview off` and a shorter `checks.commands`. Slice 3 rewrites the line to say what holds:
- No route approves or merges.
- Rules change only through `setRule`/`unsetRule`, with a reason and an audit event, and a local user can't loosen what a verified login set.
- `steps.off`, the one rule that removes a review step, is also refused inside an agent session.

Whether the other loosening rules should also be `humanOnly` is a separate question, outside this note.

## 6. How the run reads it

**`F skills OWNER/REPO`** gains a `pipeline` field, built by one read-only helper, `pipeline(repo)` in `skills.ts`:

```json
{ "locked": [...LOCKED_STEPS], "optional": [...OPTIONAL_STEPS], "off": [{ "step": "review.seo", "scope": "acme/app", "reason": "…", "by": "acme", "until": "…" }],
  "custom": { "spec.after": [ {id, …runner} ], "build.after": [ … ] }, "warnings": [ … ] }
```

The page draws its graph from this field, from `rules` and from `GET /api/state`, so the graph is never drawn statically. `GET /api/state` already embeds `skills` and `rules`, so the page needs no new route.

**`F axes RUN`.** `axesFor` drops the axes in `off` after selecting them, and it never drops a required axis: the locked list is checked again here, not only on write.
- **Snapshot per run:** `F axes` records the `off` list on the run's first `review started` event, and every later iteration uses that list. So turning a step off mid-run can't clear a failure the step already found. The change applies from the next run.
- **Failed axes:** `reviewAxes` still re-reviews every axis that failed last time.

**`F decide`.** It lists each turned-off axis in its reasons, with the rule's reason and `setBy` ("review.seo off by rule steps.off, set by …: …"), as it does today for `ci`. A turned-off axis therefore shows on every decision it shaped.

**SKILL.md, rewritten in PR 6:**
- **Setup:** step 0.3 keeps `pipeline` with `plan`.
- **Custom steps:** `spec.after` steps run after §2's spec is written, and `build.after` steps run after §3's checks. Each one gets `F notes` and its guidance like any step, and is recorded with `F event RUN <slot> …`.
- **Review:** §4 is unchanged. `F axes` already returns the axes minus the turned-off ones, and the gate checks only recorded axes.
- **Ground rule:** "Run `F rules set … steps.off` only when the user asks in chat, with their reason". It is the existing rules ground rule, naming the new key.

Slice 4 makes these changes, after PR 6 merges.

## Slices

1. **This note, then a read-only page.**
   - The core part is `pipeline(repo)`, `LOCKED_STEPS` and `OPTIONAL_STEPS`, read-only, with `off` and `custom` always empty until slices 3 and 4.
   - The page part is `apps/web` and the desktop bundle.
2. **Change a step's runner from the graph,** through `POST /api/skills`.
3. **Turn steps off:**
   - the `steps.off` rule and its `asStrict` case;
   - `humanOnly` in `setRule`;
   - `pipelinePass` for `steps.off`;
   - the `axesFor` drop, the snapshot, and the `decide` reason;
   - the API.md line.
4. **Custom steps:**
   - `steps.custom` with its validation and `pipelinePass`;
   - `decide` escalating on a dropped list;
   - the `spec.after` and `build.after` loop-backs in `F event`;
   - the SKILL.md wording.

   This slice waits for PR 6.

Every slice has a failing-first test for each behaviour change.
