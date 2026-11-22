# Model routing for the Software Factory

As of 2026-11-22. Scope: should each pipeline step run on its own harness and model, which ones, and how to build it into `F` without weakening the trust model.

**Evidence labels used throughout**

- **[V]** verified on a primary page (vendor docs, the paper's own abstract page, or this machine's own CLI output), with the link.
- **[R]** reported by a secondary source (aggregator, news, search snippet). Treat as directional.
- **[J]** my judgement.

Most [V] web pages reached me through a fetch tool that summarises the page, so a [V] quote is a faithful summary of the primary page, not always a byte-exact copy. Lines marked "checked locally" come from this machine's own command output.

---

## 0. Summary and recommendation

**Yes to per-step models. Per-step providers stay optional.**

1. **Route models per step inside Claude by default (the "All-Claude" preset).** It needs no new tool, keeps one billing relationship, and the vendor-reported evidence ranks the Claude line at or near the top for agentic coding [R]. The cost lever is real: Haiku 5.5 costs 1/40 of Opus 5.5 per input token [V].
2. **Put Fable 5.2 on the small, high-leverage steps:** intake, spec, the verifier, and the always-on `code` and `security` reviews. These steps read little but decide a lot, so the most capable model costs cents more per issue there [J, priced in §6].
3. **Keep Opus 5.5 for build, the one step that is long and token-heavy.** Fable is the "max quality" upgrade for build.
4. **Make the reviewer at least as capable as the builder, and a different model or context.** This is an extrapolation [J]. Both cross-review studies found that a *weaker* reviewer didn't help or hurt, and a same-session re-review was the worst condition [V, §5]. But the weak reviewers in those studies were other vendors' models (Codex, Gemini 2.5 Flash). **Neither study tested a one-tier-down sibling** such as Sonnet reviewing Opus.
   - On that extrapolation, All-Claude puts `code` and `security` on Fable. That departs from the sketched mapping (Sonnet for code; Opus or Sonnet for security).
   - The sketched mapping is kept as **"All-Claude lean"**: $1.86 per issue against $2.40, and it stays under the cap with two loop-backs (§2). Which one wins is the first thing the eval harness (§9.8) should settle.
5. **Cross-vendor review is an opt-in extra axis, not a replacement.** The one direct study found Codex reviewing Claude's drafts *lowered* the pass rate [V]. A second-vendor opinion behind the verifier adds coverage at low risk, and `axes.extra` can do it today with no new code (§9.3).
6. **Local models are not worth it on this machine.** It is an Intel i7-9750H with 16 GB of RAM and no Apple Silicon (checked locally). CPU-only 7–8B models run at roughly 3–8 tokens/s [R], so a 40k-token review would take tens of minutes to prefill [J]. Use local models only for embeddings and duplicate search (`embeddinggemma` via Ollama's `/api/embed` [V]). Revisit local-first on an Apple Silicon Mac with 32 GB or more.
7. **Fix one trust gap first** (reproduced locally). A second `F review` for the same axis and iteration replaces the first, because `derive()` keeps the last one (factory.mjs:174).
   - Reproduction in a throwaway `FACTORY_DIR`: a failed `security` review gave `F gate` → `next: build`. A second, passing `F review` for the same axis and iteration then gave `F gate` → `next: approve`.
   - `F event … review passed` is a second path to the same overwrite.
   - Any retry or cascade design needs `F` to allow a replacement only for an *invalid* review, and never after that iteration's gate (§9.4).
8. **Update Claude Code before the Fable preset.** This machine has 2.1.304 (checked locally), and Fable 5.2 needs 2.1.321 or later [V].
9. **Pin the driving session's model too.** Under the default runner, the session that runs SKILL.md does build itself, and `F` counts its measured burn against the cap. Run it as `claude --model opus`, or the `build: opus` row can't be honoured. Everything else runs as subagents with their own model (§9.1).

**Rough cost per issue at list price, one iteration and six axes, including about $0.38 of orchestration in the driving session:**

| Preset | Cost |
|---|---|
| All-Claude | $2.40 |
| All-Claude lean | $1.86 |
| Max quality | $3.56 |
| Lowest cost | $0.84 |
| Today's SKILL.md routing | $2.00 |

**The cap.** With two loop-backs, All-Claude reaches about $5.40, past the existing `$5` cap.

- Over the cap, `F gate` stops looping, and `decide()` refuses to auto-merge ("the run is within budget" is a merge condition) **even when every axis passed**.
- `F` also overprices Fable cache reads 4× (§6.1), which adds about $0.06 here.
- The split is assumed, so treat "a third iteration usually escalates on All-Claude" as likely, not certain. See §6 and open question 3.

---

## 1. Default preset: "All-Claude" (listed first; the user's default)

The tokens column is the assumed per-step total (§6.2). Costs are list-price USD per execution.

| Step | Harness | Model (alias → id) | Effort | Why | Tokens (assumed) | Cost |
|---|---|---|---|---|---|---|
| driving session (orchestrator; runs SKILL.md, and build under the default runner) | interactive or `claude -p` | `opus` → `claude-opus-5-5`, started as `claude --model opus` | `high` | It does the build when no build runner is set, so its model *is* the build model. Its measured burn counts toward the cap. | ~150k per run | $0.38 |
| intake | Claude Code subagent | `fable` → `claude-fable-5-2` | `medium` | Small input (one issue plus trusted comments, repo rules). It decides build, ask, reject or split, which is the highest-leverage call. It is also the first reader of untrusted text. | ~15k | $0.15 |
| spec | Claude Code subagent | `fable` → `claude-fable-5-2` | `high` | A loop-back to spec redoes build and review. Spending $0.15 more than Opus here is cheap insurance [J]. | ~30k | $0.29 |
| build | headless `claude -p` or the driving session | `opus` → `claude-opus-5-5` | `high` | The long agentic step. Anthropic positions Opus 5.5 "for long-running agentic coding" [V]. | ~300k | $0.77 |
| review.code | subagent, fresh context | `fable` | `high` | Always runs. A different model from the builder and at least as capable. This is an extrapolation (§5.3); "lean" uses `sonnet`. | ~40k | $0.25 |
| review.security | subagent, fresh context | `fable` | `high` | Always runs, high stakes. On refusal or invalid output, escalate to `opus` (Fable has cyber safeguards [R]). | ~40k | $0.25 |
| review.ux | subagent | `sonnet` → `claude-sonnet-5-5` | `high` | Judgement about behaviour against the spec. Sonnet is "the best combination of speed and intelligence" [V]. | ~40k | $0.06 |
| review.ui | subagent | `sonnet` | `high` | Needs vision; all current models support it [V]. I found no UI-review evidence that separates the models. | ~40k | $0.06 |
| review.seo | subagent | `haiku` → `claude-haiku-5-5` | `medium` | Checklist-style review. Haiku is positioned for classification and extraction [V]. Keep its prompts under 100k tokens (5× price above that [V]). | ~40k | <$0.01 |
| review.docs | subagent | `haiku` | `medium` | Same as seo. | ~40k | <$0.01 |
| verifier | subagent, fresh context | `fable` | `medium` | Its dismissals are the only thing that *removes* a block, so every error it makes pushes toward merge. It should be the strongest model and not the builder's (§5). | ~20k | $0.16 |
| postmerge | `F` (mechanical) | none | none | No model needed. | 0 | $0 |

**Fallbacks stay inside Claude:**

| Step | Fallback chain (overload or unavailable) | Escalation on invalid output or refusal |
|---|---|---|
| intake, spec, verifier | `fable` → `opus` | `opus` |
| build | `opus` → `sonnet` | none |
| code, security | `fable` → `opus` | `opus` |
| ux, ui | `sonnet` → `opus` | `opus` |
| seo, docs | `haiku` → `sonnet` | `sonnet` |

The fallback-chain column uses `--fallback-model` / `fallbackModel` [V]. The escalation column is new `F` logic (§9.4).

**Total:** about **$2.40** per issue for one iteration with all six axes (including the session), about **$3.90** with one loop-back, and **$5.40** with two, which is over the cap.

**Effort isn't priced in this model.** Higher effort means more thinking, and thinking bills as output [V: costs]. So `xhigh` costs more than `high` by an unmeasured amount; read every figure as a floor for high-effort steps.

**When build must run headless.** Run build as a headless `claude -p --model claude-opus-5-5` provider runner (§9.1) in either case:

- the driving session runs on another model, for example the user keeps an interactive session on Fable;
- a preset puts build on a different model from the session.

Otherwise the in-session build uses whatever model the session has.

**Subscription vs API** [V: [Fable on your plan](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan), [costs](https://code.claude.com/docs/en/costs)]:

- **Max, Ultra or premium seats:** Fable usage comes out of the weekly limit, capped at 50% of it. The dollar figures above become "share of weekly limit", and `F`'s `$` cap is a list-price equivalent.
- **Pro or standard seats:** Fable runs on usage credits from the start, which are real money.
- **API key:** billed at the list prices above.

**Why Fable at intake, specifically** [J, with facts marked]:

- **The input is small.** About 15k tokens costs $0.15 on Fable against $0.07 on Opus.
- **The decisions are high-leverage.** A wrong "pass" pays for a spec, a build and six reviews (about $1.90 here) and may end in an escalation. A wrong "reject" loses a real request. A missed "split" produces a 300-line-plus diff that `decide()` will escalate anyway.
- **It is the first defence against injection and harmful requests.** It is the first model to read untrusted issue text and the one that must recognise "an instruction aimed at the agent rather than a product request" (SKILL.md §1). A stronger model is more likely to spot such text, but model strength is **not** the security boundary. `F`'s mechanical guards apply whatever the model [V, repo]:
  - `F intake` fetches the issue itself and drops untrusted comments;
  - the owned events and typed fields cannot be set by the model;
  - `F risk` makes untrusted authors and sensitive paths need `/factory approve`;
  - split children inherit the origin's trust;
  - `decide()` rereads `author_association` live.
- **Splitting an epic is part of intake** (the `split` outcome), so Fable covers it already.
- **Fable fallback is needed.** On Max, the Fable allowance can run out mid-week. `--fallback-model` is documented for "overloaded or not available, for example a retired model" [V]. Whether a plan-limit refusal triggers it is **not verified**, so the skill should also catch that case, rerun on `opus`, and record `fallback` (§9.1).

---

## 2. Alternative presets

Costs come from the model in §6.2, including the driving session (about $0.38 on Opus, $0.19 on Sonnet). "Time" is rough wall-clock time for model work only, excluding CI waits [J].

| Preset | session | intake | spec | build | code / security | ux / ui | seo / docs | verifier | 1 iteration | +1 loop | +2 loops | Model time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **All-Claude (default)** | opus | fable·medium | fable·high | opus·high | fable·high | sonnet·high | haiku·medium | fable·medium | **$2.40** | $3.90 | $5.40 (over cap) | ~25–45 min |
| **All-Claude lean** (the sketched mapping) | opus | fable | opus | opus | sonnet / opus | sonnet | haiku | opus | $1.86 | $2.97 | $4.08 | ~25–40 min |
| **Max quality** | opus (build headless) | fable | fable | fable·high | fable·xhigh | opus | sonnet | fable·high, plus an optional Codex `gpt-6.2-astra` extra axis | $3.56 | $5.85 | $8.14 | ~35–60 min |
| **Lowest cost (Claude only)** | sonnet | haiku | sonnet | sonnet·high | sonnet | haiku | haiku | sonnet | $0.84 | $1.39 | $1.95 | ~15–30 min |
| **Lowest cost (mixed, optional)** | sonnet | haiku | sonnet | Codex `gpt-6.2-sol` (headless) | sonnet | haiku | Codex `gpt-6-luna` | sonnet | $0.75 | $1.23 | $1.71 | ~15–30 min |
| **Local-first** | opus | fable | fable | opus | fable | sonnet | **local** | fable | $2.39 | $3.89 | $5.40 | this Mac: +20–60 min per local review [J]; Apple Silicon 32 GB+: +2–5 min |
| *Today's SKILL.md (for reference)* | opus (does intake, spec, build) | session | session | session | opus | opus / sonnet | sonnet | sonnet | $2.00 | $3.20 | $4.40 | ~25–40 min |

**All-Claude lean** is the mapping sketched in the brief: Fable intake, Opus spec, build and security, Sonnet code/ux/ui, Haiku seo/docs.

- For its verifier I chose Opus rather than Sonnet, because the verifier's errors push toward merge (§5.5). Today's SKILL.md runs the verifier on **Sonnet**, which I'd change in any preset [J].
- It is the safer choice on the cap. It is the weaker choice if the "reviewer at least as capable as the builder" extrapolation (§5.3) holds.

**Max quality:**

- It passes the $5 cap from the first loop-back, so any looped run escalates. That is safe, but it means the cap, not quality, decides those runs.
- The Codex axis is an *added* `axes.extra` reviewer, never a replacement, so the verifier filters it (§5).

**Lowest cost:**

- Sonnet reviewing Sonnet's own build breaks rule 4 of the summary (reviewer at least as capable as the builder), so expect more escaped bugs [J].
- Haiku at intake is the riskiest choice in this preset.
- Use it for low-stakes repos, sweeps, and `triage`.

**Local-first:**

- It saves only cents (seo and docs on Haiku cost under $0.01 each), so its value is **privacy**, not money.
- **Concrete picks for this 16 GB Intel Mac** [J, sizes from [R] sources]:
  - `embeddinggemma` for duplicate-issue search (§7.1);
  - a 2–4B general model at Q4 (mlx.app's 16 GB pick is MiniCPM5 2B [R]) for short summaries only;
  - nothing for review.
- None of these is pulled yet (`ollama list` is empty). Pulling one is a download that needs the user's yes, so **local JSON failure rates could not be measured here**.
- On this Intel Mac it costs a lot of time.
- Its real use is a private repo whose code must never leave the machine. That needs **every** step local, which current laptop-size models cannot do well for build or security (§7) [J].
- Honest conclusion: "local-first" fits embeddings and duplicate search today, and seo/docs/summaries on Apple Silicon. It is not yet a whole-pipeline option.

---

## 3. Selecting models per harness (exact syntax)

### 3.1 Claude Code [V: [model-config](https://code.claude.com/docs/en/model-config), [cli-reference](https://code.claude.com/docs/en/cli-reference), [sub-agents](https://code.claude.com/docs/en/sub-agents), [fast-mode](https://code.claude.com/docs/en/fast-mode)]

**Aliases** (Anthropic API):

| Alias | Resolves to |
|---|---|
| `fable` | Fable 5.2 (unless `ANTHROPIC_DEFAULT_FABLE_MODEL` is set) |
| `opus`, `best` | Opus 5.5 |
| `sonnet` | Sonnet 5.5 |
| `haiku` | Haiku 5.5 |
| `opusplan` | Opus in plan mode, Sonnet for execution |
| `default` | clears the override (Opus 5.5 on the API) |

Suffix `[1m]` selects a 1M context window. Fable models, Sonnet 5+ and Haiku 5.5 have 1M by default.

**Setting the model**, highest priority first:

1. `/model <alias|id>`
2. `claude --model <alias|id>`
3. `ANTHROPIC_MODEL=…`
4. settings `"model": "opus"`
5. `ANTHROPIC_DEFAULT_MODEL` (v2.1.236+)

To **pin what an alias means**, set `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`. This is the reproducibility lever for alias-based subagent calls.

**Subagents:**

- Frontmatter `model: sonnet | opus | haiku | fable | <full id> | inherit`, plus `effort: low | medium | high | xhigh | max`.
- Resolution order:
  1. the per-invocation `model` parameter on the Agent tool, which takes **an alias only, not a full id**;
  2. the frontmatter;
  3. `CLAUDE_CODE_SUBAGENT_MODEL`;
  4. the parent's model.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` forces one model everywhere.
- A per-invocation `effort` overrides the frontmatter, and **`CLAUDE_CODE_EFFORT_LEVEL` overrides both**.

**Effort:**

- `claude --effort low|medium|high|xhigh|max|ultracode`, `/effort <level>`, settings `"effortLevel"` (no `max`), or env `CLAUDE_CODE_EFFORT_LEVEL`.
- Defaults in Claude Code: `medium` on Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5.
- **The API's defaults differ:** `high` on Fable 5.2 and Sonnet 5.5 [V: [models overview](https://platform.claude.com/docs/en/about-claude/models/overview)]. So always set effort explicitly and record it.
- Thinking can't be turned off on the 5.5 models or Fable [V: [costs](https://code.claude.com/docs/en/costs)].

**Fallback:**

- `claude --fallback-model sonnet,haiku`, or settings `"fallbackModel": ["claude-sonnet-5", "claude-haiku-5-5"]`.
- At most 3 models. Used when the primary is overloaded or unavailable, or retired.

**Fast mode:**

- Fable 5.2 and Opus 5.5 at 2× price ($16/$80 and $8/$40). Also Opus 5 (research preview) and Opus 4.8 (fast mode deprecated, removed 2026-11-30) at $10/$50. Not on Sonnet or Haiku.
- Headless form: `claude -p --settings '{"fastMode": true}'`.
- On subscription plans it is **always billed to usage credits**.
- Not worth it for an unattended factory [J].

**Headless example for one factory step:**

`F headless-args RUN --review` prints a **JSON array**, so splice its elements in as separate single-quoted words (as SKILL.md says). `$(…)` would not split it correctly. The resulting command looks like:

```bash
(cd "$WT" && claude -p "/x" --model claude-fable-5-2 --effort medium --fallback-model claude-opus-5-5 \
  '--output-format' 'json' '--setting-sources' 'user' '--strict-mcp-config' '--permission-mode' 'manual' \
  '--permission-prompts' 'none' '--max-budget-usd' '<remaining>' '--json-schema' '<schema>' '--allowedTools' …)
```

### 3.2 Codex CLI

Sources:

- this machine's `codex exec --help` (codex-cli 0.141.0) [V];
- [config-advanced](https://learn.chatgpt.com/docs/config-file/config-advanced.md), [config-reference](https://learn.chatgpt.com/docs/config-file/config-reference), [models](https://learn.chatgpt.com/docs/models) [V].

**Flags** (from the local help):

- `-m, --model <MODEL>`, `-c, --config <key=value>`, `-p, --profile <CONFIG_PROFILE_V2>`, `-s, --sandbox`, `--oss`, `--local-provider <lmstudio|ollama>`, `--output-schema <FILE>`, `-o, --output-last-message <FILE>`, `--json`, `--ephemeral`.
- Careful: **`-p` is `--profile` in Codex but `--print` in Claude Code.**

**Models** [V]:

| Model | Best for |
|---|---|
| `gpt-6.2-astra` | hardest work |
| `gpt-6.2-sol` | everyday coding; 500k context in Codex |
| `gpt-6.1-terra` | fast |
| `gpt-6-luna` | high-volume, focused tasks |

The CLI's default is "a recommended model", not named on the page.

**Effort:**

- Config key `model_reasoning_effort`. The values "depend on the model": `low`, `medium`, `high`, `xhigh`, `max`, `ultra` [V].
- One-off form: `-c model_reasoning_effort='"high"'`. Values parse as TOML, so strings need inner quotes, but invalid TOML is treated as a string, so `-c model_reasoning_effort=high` also works [V].
- In a session: `/model --reasoning=high` [V].

**Profiles** [V]:

- Since Codex 0.134.0, a profile is a **separate file**, `~/.codex/<name>.config.toml`, with top-level keys.
- `[profiles.x]` tables and the top-level `profile =` key are no longer supported.

```toml
# ~/.codex/factory-review.config.toml
model = "gpt-6.2-sol"
model_reasoning_effort = "high"
```

```bash
codex exec --profile factory-review -C "$WT" -s read-only --output-schema review.schema.json -o "$DIR/code.json" "<brief>"
```

**ChatGPT plan vs API key** [V partial]:

- Under ChatGPT sign-in, which models are available depends on the plan.
- Under an API key, it follows the API organization.
- Credit accounting per plan was **not checked**.

### 3.3 Gemini CLI (optional; not installed here)

[V: [model routing](https://geminicli.com/docs/cli/model-routing.md)]

- Precedence: `--model` flag, then `GEMINI_MODEL`, then `model.name` in `~/.gemini/settings.json`, then `auto`.
- On quota errors it asks before falling back, except for internal utility calls.
- `/model` and the flag don't change sub-agent models.
- **Not verified:** the `-m` short flag, aliases, and the headless `-p` / `--output-format json` flags.
- Current models and prices: §6.1.
- No adapter is recommended until there is a concrete need [J].

### 3.4 Local runtimes

**This machine** (checked locally):

- Intel Core i7-9750H, 16 GB RAM, Intel UHD 630 plus AMD Radeon Pro 5300M with 4 GB.
- `ollama` is installed with **no models pulled**.
- `lms`, `llama-server`, `mlx_lm` and `gemini` are not installed.
- MLX needs Apple Silicon, so it doesn't apply.
- Ollama documents GPU acceleration on macOS through Metal on Apple devices, and AMD/Vulkan only on Linux and Windows [R: [docs.ollama.com/gpu](https://docs.ollama.com/gpu) via search snippet]. Expect CPU-only inference here.

| Runtime | Use from the factory | Exact config |
|---|---|---|
| **Ollama** | native schema-constrained chat; OpenAI- and Anthropic-compatible endpoints | **Structured output** [V: [structured-outputs](https://docs.ollama.com/capabilities/structured-outputs)]: put the JSON Schema in `format` on `POST /api/chat`, or use `response_format` on the OpenAI-compatible API. Not on Ollama Cloud. **Anthropic endpoint** [V: [anthropic-compatibility](https://docs.ollama.com/api/anthropic-compatibility)]: `/v1/messages`, with tools, streaming, thinking and base64 vision. No `tool_choice`, no prompt caching, no count_tokens, and structured output isn't documented. Token counts are approximate. List models with `ollama list` or `GET /api/tags`. |
| **Claude Code → Ollama** | tolerated, **not supported by Anthropic** | Ollama documents it [V: [integrations/claude-code](https://docs.ollama.com/integrations/claude-code.md)]: `ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY="" ANTHROPIC_BASE_URL=http://localhost:11434 claude --model qwen3.5`, or `ollama launch claude --model <m> --yes -- -p "…"`. It needs a tool-capable model and a 64k+ context. Anthropic: it "doesn't support routing Claude Code to non-Claude models through any gateway" [V: [llm-gateway](https://code.claude.com/docs/en/llm-gateway.md)]. With only `ANTHROPIC_BASE_URL` set, a saved claude.ai login stays the active credential [V]. |
| **Codex → Ollama / LM Studio** | supported by both sides | `codex --oss -m gpt-oss:120b`, or `--local-provider ollama|lmstudio`, or `oss_provider = "ollama"` in config.toml [V: local help; [config-reference](https://learn.chatgpt.com/docs/config-file/config-reference)]. Or `ollama launch codex`, which writes `~/.codex/ollama-launch.config.toml` (shown below) [V: [integrations/codex](https://docs.ollama.com/integrations/codex.md)]. `ollama` and `lmstudio` are reserved provider ids [V]. Codex needs a 64k+ context [V]. |
| **LM Studio** | OpenAI-compatible server | `lms ls --json` lists downloaded models; `lms ls --embedding` lists embedding models [R: [lmstudio.ai/docs/cli/local-models/ls](https://lmstudio.ai/docs/cli/local-models/ls) via search snippet]. |
| **llama.cpp `llama-server`** | grammar- and schema-constrained decoding | Flags `-j, --json-schema SCHEMA`, `-jf, --json-schema-file FILE`, `--grammar`, `--grammar-file` [V: [server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)]. Per request: `json_schema` on `/completion`; `response_format: {type: "json_schema", json_schema: {schema, strict}}` on `/v1/chat/completions` [V]. It lists "Anthropic Messages API compatible chat completions", but the route wasn't verified. |
| **vLLM** | Linux/NVIDIA server | **Not checked.** Not relevant on this Mac [J]. |
| **MLX / mlx-lm** | Apple Silicon only | Not applicable here. Reported to give the highest sustained throughput on Apple Silicon [R: [arXiv 2511.05502](https://arxiv.org/pdf/2511.05502)]. Ollama adopted MLX on Apple Silicon in March 2026 [R: MacRumors, 2026-03-31]. |
| **Aider** | agent harness with local models | `OLLAMA_API_BASE=http://127.0.0.1:11434 aider --model ollama_chat/<model>`. Use `ollama_chat/`, not `ollama/`, so it hits the chat endpoint [R: [aider.chat/docs/llms/ollama](https://aider.chat/docs/llms/ollama.html) (page didn't render) and secondary guides]. The config-file route is reported broken in [issue 3017](https://github.com/Aider-AI/aider/issues/3017) [R]. |
| **OpenCode** | agent harness | `ollama launch opencode --config`, or `~/.config/opencode/opencode.json` with an `@ai-sdk/openai-compatible` provider and `options.baseURL: "http://localhost:11434/v1"` [R: [docs.ollama.com/integrations/opencode](https://docs.ollama.com/integrations/opencode)]. Tool-calling issues are reported; raise `num_ctx` [R]. |
| **Goose** | agent harness | `goose configure` → Configure Providers → Ollama, host `http://localhost:11434` [R: [Goose providers](https://block.github.io/goose/docs/getting-started/providers), [docs.ollama.com/integrations/goose](https://docs.ollama.com/integrations/goose)]. `GOOSE_PROVIDER=ollama GOOSE_MODEL=<m>` is reported by mirrors only [R]. Needs a tool-capable model. |
| **Continue** | IDE assistant | `~/.continue/config.yaml`: `models: [{name, provider: ollama, model: <tag>}]`; `apiBase` for a remote host; `AUTODETECT` supported [R: [docs.continue.dev Ollama guide](https://docs.continue.dev/guides/ollama-guide)]. It is an IDE tool, not a headless runner, so it doesn't fit the factory [J]. |

The Ollama-written Codex profile:

```toml
# ~/.codex/ollama-launch.config.toml
model = "gpt-oss:120b"
model_provider = "ollama-launch"
[model_providers.ollama-launch]
name = "Ollama"
base_url = "http://localhost:11434/v1/"
wire_api = "responses"
```

### 3.5 Gateways (OpenRouter, LiteLLM): later, optional, off by default

- Gateways that speak the Anthropic Messages format work technically, but Anthropic doesn't support non-Claude models through them [V].
- They are a third-party dependency and a credential-routing point.
- They also change billing: a gateway credential replaces the subscription login [V].
- Not recommended for the default, local-first, no-integrations posture [J].

---

## 4. Evidence: which model families are strongest at what

Short version: **the evidence is weak and contested.** Most top-line numbers are vendor-reported on vendor scaffolds. The one standardized board scores everyone far lower, and one key benchmark is partly broken.

| Task | Best evidence found | Date | Strength |
|---|---|---|---|
| **Agentic coding** | **SWE-bench Pro, vendor-reported:** Fable 5.2 93%, Opus 5.5 89.9%, Sonnet 5.5 81.3%; best open-weight about 66–69% (Ling 3.1 Flash, Qwen3.8 Max, Beam 501B), all huge models [R: [BenchLM](https://benchlm.ai/benchmarks/swe-bench-pro), updated 2026-11-21]. **Scale's standardized scaffold:** Muse Spark 1.1 61.5%, GPT-5.4 xHigh 59.1%; newer Claude and GPT-6 models not listed in what I found [R: [Morph](https://www.morphllm.com/swe-bench-pro), 2026-09]. An OpenAI audit (July 2026) estimated about 30% of the 731-task public split is broken [R, via BenchLM]. | Sep–Nov 2026 | Weak. Vendor numbers aren't comparable to the standardized board. |
| **Agentic coding (terminal)** | **Terminal-Bench 2.1:** Vals.ai has Opus 5.5 87.64%, GPT-6 Astra 87.27%, GPT-5.6 Sol 85.77% (Terminus 2 harness) [R: [vals.ai](https://vals.ai/benchmarks/terminal-bench-2-1), 2026-10-01]. Snorkel has GPT-6 (Codex CLI) 87.4% and Fable 5 (Claude Code) 83.8% [R: [snorkel.ai](https://snorkel.ai/leaderboard/terminal-bench-2-1/)]. The official tbench.ai table didn't render [checked]. | Oct 2026 | Weak to moderate. The top entries are within noise, and the harness matters. |
| **Planning / hard reasoning** | Anthropic positions Fable 5.2 "for demanding reasoning and long-horizon agentic work" [V: [overview](https://platform.claude.com/docs/en/about-claude/models/overview)]. Reported results: FrontierCode 2.0 has Fable 5.2 49.1, Opus 5.5 45.5, GPT-6 Astra 42.8; Epoch Capabilities Index has Fable 5.2 174 vs GPT-6 Astra 169. Coverage calls Fable 5.2's results against Opus 5.5 "mixed" [R: [cryptobriefing](https://cryptobriefing.com/claude-fable-5-2-epoch-record-174/), [DataCamp](https://www.datacamp.com/blog/claude-fable-5-2-and-mythos-5-2), 2026-11]. | Nov 2026 | Weak. No spec-writing benchmark exists that I found. |
| **Code review / bug-finding precision** | No standard benchmark. GitHub's ReviewBench (219 PRs; Copilot leads at 40.1% grounded F1; co-developed by GitHub) [R: [github.blog](https://github.blog/2026-01-14-reviewbench-an-open-benchmark-for-ai-code-review/), 2026-01]. Martian Code Review Bench ranks tools differently [R]. SWE-PRBench: 8 frontier models detect only 15–31% of human-flagged issues from the diff alone [R: [arXiv 2603.26130](https://arxiv.org/abs/2603.26130), 2026-03]. These benchmarks rank *tools*, not model families. | 2026 | Very weak for model choice. Strong for "reviewers miss most issues", so keep the mechanical gates. |
| **Security review** | Nothing model-comparative found. Fable 5.2 keeps cyber safeguards; Mythos 5.2 (no safeguards) is limited to vetted organisations [R: [SD Times](https://sdtimes.com/ai/anthropic-introduces-claude-fable-5-2-mythos-5-2/), 2026-11]. | Nov 2026 | None. Risk: a safeguard refusal reads as an invalid review, so escalate to Opus (§9.4) [J]. |
| **UI / visual review (vision)** | All current Claude models support image input [V]. No UI-review benchmark found. | n/a | **Not checked further.** |
| **Cheap classification / triage** | Anthropic positions Haiku 5.5 for "classification, extraction, and routing" [V]. Artificial Analysis Intelligence Index: 43, 13th [R: [officechai](https://officechai.com/ai/claude-5-5-haiku-benchmarks/), 2026-10]. | Oct 2026 | Weak. Fine for checklist axes; the user prefers Fable for intake. |

---

## 5. Routing, cascades, cross-model review and self-preference

### 5.1 Cheap first, escalate on failure (cascades)

- **FrugalGPT** (Chen, Zaharia, Zou): a learned cascade matched GPT-4 with up to 98% cost reduction, or beat it by 4% at the same cost [R: [arXiv 2305.05176](https://arxiv.org/pdf/2305.05176) abstract].
- **RouteLLM** (ICLR 2025): routers trained on preference data saved over 2× cost with little quality loss, and transferred to new model pairs [R: [arXiv 2406.18665](https://arxiv.org/html/2406.18665v4), [project page](https://sky.cs.berkeley.edu/project/routellm/)].
- **Against, for this pipeline** [J]:
  - Both papers study single-shot Q&A with a cheap scorer. The factory's steps are agentic and have no reliable confidence signal.
  - The factory does have one **free, reliable failure signal**: `validateReview` / `--json-schema` rejecting output. Cascade on *that*, and on refusals, not on self-reported confidence.

### 5.2 Self-preference bias (LLM-as-judge)

- **Panickssery, Bowman, Feng (2024):** evaluators recognise and favour their own generations, and self-recognition drives the bias [R: [arXiv 2404.13076](https://arxiv.org/abs/2404.13076v1)].
- **Wataoka et al.:** the bias tracks perplexity; models prefer text familiar to them [R: [arXiv 2410.21819](https://arxiv.org/abs/2410.21819v1)].
- **Critique (2026):** with a better baseline (wrong answers from other models), the measured bias drops substantially [R: [arXiv 2601.22548](https://arxiv.org/pdf/2601.22548)].
- **Correlated errors (Kim et al., ICML 2025):** across 350+ models, two models that both err agree on the same wrong answer about 60% of the time. Correlation is higher for the same provider and the same architecture, *and* for more accurate models even across providers [R: [arXiv 2506.07962](https://arxiv.org/abs/2506.07962v1)].
  - For the factory: a sibling Claude reviewer shares more blind spots than a cross-vendor one would. Frontier models from different vendors are converging anyway [J].

### 5.3 Cross-model code review: direct evidence

**Xiang et al., "Cross-Model LLM Code Review"** (Agentic SE @ KDD'26, 2026-07-22) [V: [arXiv 2607.21656](https://arxiv.org/abs/2607.21656)]. 116 LiveCodeBench-style tasks; the reviewer can't run tests.

| Draft by → reviewed by | Before | After |
|---|---|---|
| Codex → Claude | 71.6% | **89.7%** |
| Codex → Codex | 71.6% | 84.5% |
| Claude → Codex | 91.4% | **82.8% (worse)** |
| Claude → Claude | 91.4% | unchanged |

The authors' conclusion: "use Claude to review Codex, not the other way around."

**Song, "When Does a Second Model Help?"** (single author, not peer-reviewed, 2026-10-06) [V: [arXiv 2610.01471](https://arxiv.org/html/2610.01471v2)]. 150 planted errors; all artifacts generated by Opus 4.6.

| Condition | F1 |
|---|---|
| Top-tier cross-model reviewer | 32.3% |
| Fresh-context same model (CCR) | 28.6% |
| Same-context self-review | 27.1% |
| Lightweight cross-model reviewer | 24.0% |
| **Repeated same-session review** | **21.7%, the only significantly worse condition** |

- The cross-model vs fresh-context gap is "not significantly different".
- **Complementarity:** one CCR plus one cross-model review covered 56.7% of errors, against 42.7% for two CCR reviews.
- On **code**, the fresh-context reviewer led (40.7% vs 37.2%).

**What this means here** [J]:

- **Reviewer capability seems to matter most.** The weaker reviewer hurt or didn't help in both papers, but those weak reviewers were other vendors' models. Extending that to "don't let Sonnet review Opus" is my extrapolation [J]; no study tested sibling tiers. On that basis All-Claude puts code and security on Fable, and All-Claude lean doesn't.
- **Never review in the builder's session.** Repeated same-session review was the worst condition. The factory already spawns fresh subagents, so keep it that way.
- **Cross-vendor adds *coverage*, not accuracy.** The one direct test found a non-Claude reviewer *hurt* Claude's drafts. So cross-vendor belongs as an *extra* axis whose findings the verifier filters, never as the sole `code` reviewer.
- **Is cross-vendor review meaningfully better than an all-Claude setup? Not on current evidence.** The complementarity result suggests a modest coverage gain, from one small, unreviewed study.

### 5.4 Diversity inside Claude (what to do instead of cross-vendor)

| Lever | Evidence | Use in All-Claude |
|---|---|---|
| Different model for review than for build (Fable reviews Opus) | Not found for sibling sizes. The capability finding supports a *stronger* reviewer, not a smaller one [J from §5.3]. | Yes: code, security and verifier on Fable. |
| Different effort level | **Not found.** | Reviewers on `high`; the verifier on `medium` to save cost [J]. |
| Fresh context, no shared transcript | Fresh context beat same-session re-review [V, 2610.01471]. Fresh context vs same-context self-review was not significant [V]. | Already done: one fresh subagent per axis. Keep the builder's reasoning out of the brief. |
| Adversarial reviewer prompt ("assume there is a bug; find it") | Practitioner write-ups only [R: [Augment](https://www.augmentcode.com/guides/adversarial-code-review)]. No controlled study found. | Optional wording in reviewers.md, evaluated on fixtures first. |
| Restrict information (reviewer sees the artifact without the requirements) | Helped lower-tier reviewers by 2–3 pp, not the top tier [V, 2610.01471, untested point estimates]. | No. Reviewers need the spec. |
| Verifier on a different model from the builder | Self-preference [R] suggests a judge favours its family's text. **For the verifier, bias toward its own family's findings is the *safe* direction** (it keeps blocks) [J]. | Verifier = Fable, not the builder's Opus. |

### 5.5 Ensembles and majority votes for the verifier

- No study specific to finding-verification was found. The complementarity result argues that a second *different* reviewer adds coverage. It says nothing about voting on dismissals [J].
- **Asymmetry rule** [J]: a dismissal unlocks merge, a keep doesn't. If you ensemble, **require agreement to dismiss** (any one "keep" keeps the finding). Don't take a majority vote.
- A cheap first-pass verifier is safe only if it can **keep** findings but not dismiss them; anything it would dismiss goes to the strong verifier.

---

## 6. Costs

### 6.1 Prices per million tokens (USD)

**Claude** [V: [pricing](https://platform.claude.com/docs/en/about-claude/pricing)]. Columns: input / 5-minute cache write / 1-hour cache write / cache read / output.

| Model | Input | Write 5m | Write 1h | Read | Output |
|---|---|---|---|---|---|
| Fable 5.2 | 8 | 10 | 16 | **0.20** (0.025×) | 40 |
| Opus 5.5 | 4 | 5 | 8 | 0.20 (0.05×) | 20 |
| Sonnet 5.5 | 2 | 2.50 | 4 | 0.10 (0.05×) | 10 |
| Haiku 5.5, prompt ≤100k | 0.10 | 0.125 | 0.20 | 0.01 | 0.50 |
| Haiku 5.5, prompt >100k | 0.50 | 0.625 | 1 | 0.05 | 2.50 |

- Fast mode is 2× on Fable 5.2 and Opus 5.5.
- Batch is −50%, but batch doesn't fit the interactive pipeline.
- **A pricing bug in `F`:** `PRICES['claude-fable-5-2']` has cache read **0.8**, but the page says **0.20** (factory.mjs:30). It overstates Fable's cache reads 4×. Everything else for the 5.5 line matches. Not edited (read-only task).
- **Tokenizer:** Claude 4.7 and later produce about 30% more tokens for the same text [V]. Token budgets copied from older runs undercount.

**OpenAI**, short context ≤272k [V: [pricing](https://developers.openai.com/api/docs/pricing)]. Columns: input / cached / output.

| Model | Input | Cached | Output |
|---|---|---|---|
| gpt-6.2-astra | 8 | 0.40 | 40 |
| gpt-6.2-sol | 2 | 0.10 | 10 |
| gpt-6.1-terra | 1 | 0.05 | 5 |
| gpt-6-luna | 0.10 | 0.01 | 0.50 |

- Long context is roughly 2×. "Fast" (formerly Priority) is 2×.

**Gemini**, paid tier [V: [pricing](https://aistudio.google.com/docs/pricing)]:

| Model | Input / output / cache |
|---|---|
| Gemini 4 Argon | $2 / $10 / $0.10 **until 2026-11-30**, then $4 / $20 / $0.20 |
| Gemini 4 Neon | $3 / $15 / $0.15 |
| Gemini 3.8 Flash | $0.75 / $3.75 until 2026-12-31, then $1.50 / $7.50 |

- Gemini 4 models have implicit caching only.

### 6.2 Cost model: assumptions (all [J])

Per execution: cache-write / cache-read / output tokens, with no uncached fresh input, since Claude Code caches nearly everything and `F` prices reported cache writes at the 1-hour rate (factory.mjs:166).

| Step | Total | Cache write | Cache read | Output |
|---|---|---|---|---|
| intake | 15k | 4k | 9k | 2k |
| spec | 30k | 8k | 18k | 4k |
| build | 300k | 40k | 240k | 20k |
| each reviewer | 40k | 8k | 29k | 3k |
| verifier | 20k | 5k | 13k | 2k |
| driving session (orchestration, excluding in-session build) | 150k | 20k | 120k | 10k |

- OpenAI has no write premium, so writes are priced as input there.
- A loop-back iteration = build + code + security + one more axis + the verifier.

Per step and model (USD):

| Model | intake | spec | build | review | verifier |
|---|---|---|---|---|---|
| fable | 0.146 | 0.292 | 1.488 | 0.254 | 0.163 |
| opus | 0.074 | 0.148 | 0.768 | 0.130 | 0.083 |
| sonnet | 0.037 | 0.074 | 0.384 | 0.065 | 0.041 |
| haiku | 0.002 | 0.004 | 0.020 | 0.003 | 0.002 |
| gpt-6.2-sol | 0.029 | 0.058 | 0.304 | 0.049 | 0.031 |
| gpt-6.2-astra | 0.116 | 0.231 | 1.216 | 0.196 | 0.125 |
| gpt-6-luna | 0.002 | 0.003 | 0.016 | 0.003 | 0.002 |

Preset totals are in §2. The script is `scratchpad/cost.mjs` next to this file.

- **Output dominates.** Build output (20k at $20) is about half of build's cost, so a cheaper build model saves more than a cheaper reviewer.
- **Fable's cost at intake, spec and verifier** is about $0.60 per issue, against $0.30 on Opus.

### 6.3 Prompt caching in the review fan-out

- **Parallel requests don't share a cache write.** "A cache entry only becomes available after the first response starts" [V: [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)]. Six reviewers launched in one message each pay their own write of any shared prefix. Options:
  - accept it (it's cents on Sonnet and Haiku);
  - stagger: start `code`, wait for its first token, then launch the rest [J]. The latency cost is a few seconds.
- **Mixed models don't share prefixes.** The page doesn't say so explicitly, but a cache hit needs a 100% identical prompt on a model, so a Fable reviewer can't reuse a Sonnet reviewer's prefix [J].
- **Same-model reviewers on later iterations do benefit** within the TTL, which is 5 minutes by default, or 1 hour at 2× the write cost [V].
- The minimum cacheable prompt is 512 tokens on the current models [V].

### 6.4 Subscription vs API billing

- **Subscription login (Pro/Max/Ultra/Team/Enterprise):**
  - Claude Code usage draws on rolling 5-hour and weekly windows [V: [costs](https://code.claude.com/docs/en/costs)].
  - `F`'s dollar figures are list-price estimates. The real constraint is the window.
  - Fable on Max, Ultra or premium seats may use up to 50% of the weekly limit, with credits beyond that. On Pro and standard seats, Fable is credits only [V].
  - Fast mode is always credits [V].
  - `--bare` needs an API key, which is why `F headless-args` never passes it [V, repo].
- **API key:** per-token at list price. Workspace rate limits apply. The suggested per-user TPM for 1–5 users is 200k–300k [V: costs].
- **Codex with a ChatGPT plan:** models per plan [V]. Credit mechanics **not checked**.

---

## 7. Local models

### 7.1 What fits, by machine

**This Mac** (Intel i7-9750H, 16 GB, CPU-only in practice):

- 3–8B models at Q4 run at roughly **3–8 tokens/s** generation [R: [llmhardware.io](https://llmhardware.io/guides/how-to-run-llms-on-mac), [llmconfigurator](https://llmconfigurator.com/en/guides/troubleshooting/intel-mac-local-llm-limits), search snippets].
- Prefill on CPU is also slow. I estimate tens of tokens/s for 8B [J, not measured], so a 40k-token review prompt takes **tens of minutes** before the first output token.
- 30B-class MoE models (about 17 GB at 4-bit) don't fit in 16 GB alongside the OS [J, from the mlx.app rule of thumb].
- **Realistic local uses here:**
  - **embeddings for duplicate-issue search.** `ollama pull embeddinggemma`, then `POST http://localhost:11434/api/embed` with `{"model":"embeddinggemma","input":["<title + body>", …]}`. It returns L2-normalised vectors, typically 384–1024 dimensions [V: [embeddings](https://docs.ollama.com/capabilities/embeddings)]. Cosine against past issue titles is a dot product. The result goes to intake as *data*, a "possible duplicates" list, never as a decision [J].
  - short summaries under about 4k tokens.

**Apple Silicon** [R: [mlx.app, 2026-11-01](https://mlx.app/learn/best-local-llm-for-coding-on-mac)]:

| Mac memory | Models |
|---|---|
| 32–64 GB | Qwen3 Coder 30B-A3B or Devstral Small 2 (24B dense) at 4-bit |
| 96 GB+ | Qwen3 Coder Next (80B, 3B active) |
| 128 GB+ | Devstral 2 (123B) |

- Rule of thumb: about 0.56 GB per billion parameters at 4-bit, plus context.
- Theoretical ceilings on an M5 Pro: about 165 tok/s (30B-A3B) and about 23 tok/s (Devstral Small 2). Real runs reach about 45–80% of those [R, same page].
- Community figures conflict: 55–230 tok/s for the same MoE model across M4 and M5 chips [R: [Medium](https://medium.com/@_lukasz_/local-coding-models-in-2026-why-mlx-beat-ollama-on-apple-silicon-68118d806c40), [LLMCheck](https://llmcheck.net/blog/best-local-llm-for-coding-mac/)].

**Fit by step** [J]:

| Step | Local fit | Why |
|---|---|---|
| Duplicate search, embeddings | **Good** on any Mac | Short inputs; deterministic retrieval; output feeds intake as data. |
| docs / seo review | **OK on Apple Silicon 32 GB+**; poor here | Checklist-style; schema-constrained output (§7.2). |
| Summaries (PR body, changelog) | OK | No gate depends on them. |
| First-pass verifier | **Only as "keep-only"** | Its dismissals unlock merge, so a weak model may only keep findings (§5.5). |
| Intake | No (user wants Fable) | High-leverage, and the injection front line. |
| Build | **No** | Laptop-size models have no strong agentic-coding evidence. The open-weight SWE-bench Pro leaders are 400B+ models [R]. No laptop-size coding benchmark was found. |
| Security review | **No** | No evidence; recall-critical. |

### 7.2 Tool calling and JSON-schema reliability

- **Measured failure rates for local models on a schema like the factory's: not found.**
  - BFCL V4 was last updated 2025-12-16 and doesn't cover current local models [R: [gorilla leaderboard](https://gorilla.cs.berkeley.edu/leaderboard)].
  - Epoch rates BFCL v4 "flawed" [R: [Epoch](https://epoch.ai/benchmarks/berkeley-function-calling-leaderboard/review)].
- **JSONSchemaBench** (ICML 2025; about 10k real schemas; tests Guidance, Outlines, llama.cpp, XGrammar, OpenAI and Gemini): constrained-decoding engines differ in schema coverage and compliance. Results are sensitive to engine and schema complexity [R: [arXiv 2501.10868](https://arxiv.org/html/2501.10868v3)]. Per-engine numbers weren't extracted.
- **Constrained decoding is available:** Ollama `format` (native) and `response_format` (OpenAI-compatible) [V]; llama.cpp `--json-schema` and `response_format` [V].
- **It guarantees syntax and shape, not the contract** [J]. `review.schema.json` is simple (enums, nullable fields, `additionalProperties: false`), so grammar engines handle it. But these `validateReview` rules aren't expressible in the schema:
  - `failed` needs at least one blocking finding;
  - the axis must match this iteration's selection;
  - a non-empty `issue`.
  
  Keep `F`'s validator as the authority.
- **Use native `/api/chat` with `format`** for local reviewers, not Ollama's Anthropic endpoint. That endpoint documents neither structured output nor `tool_choice` [V].

---

## 8. Risks

| Risk | Detail | Mitigation |
|---|---|---|
| **Tool-use reliability differs by harness** | Claude Code `--json-schema` omits `structured_output` on failure [V, repo]. Codex has an `--output-schema <FILE>` flag [V, help]; how strictly it is enforced was **not checked**. Local models vary and are unmeasured. | Every reply goes through `F review`. Invalid = failed; with a cascade, retry once upward (§9.4). |
| **Review overwrite (existing gap)** | `derive()` keeps the *last* `review` event per axis and iteration (factory.mjs:174). **Reproduced locally:** failed `security` → `F gate` said `build`; a second passing `F review` in the same iteration → `F gate` said `approve`. `F event RUN review passed` is a second path. The self-test re-records axes only across iterations (factory.mjs:1700–1718), so it doesn't depend on this. | `F review` / `F event review` refuse a second record for the same axis and iteration unless the first is an invalid-output failure and the new one carries `--escalated-from`. Nothing may be recorded for an iteration after its `gate` event. A crash before recording just reruns the reviewer; a recorded review stands (§9.4). |
| **Configured model ≠ model that ran** | Aliases drift (`opus` changed meaning across releases [V]). `--fallback-model` switches silently. The Agent tool's `model` is chosen by the orchestrating model. | Stamp the model **measured** from transcripts (`F usage` already reads `message.model`, factory.mjs:229–237). Flag a mismatch with the plan on the dashboard. Pin aliases with `ANTHROPIC_DEFAULT_*_MODEL`. |
| **Effort overridden** | `CLAUDE_CODE_EFFORT_LEVEL` beats per-subagent `effort` [V]. | `F` warns when that env var is set and a preset sets per-step effort. |
| **Context windows** | All current Claude models have 1M [V]. Codex Sol 500k, Astra 272k in Codex [V]. Local ≥64k recommended [V]. Haiku 5.5 bills 5× over 100k [V]. | Per-adapter `maxPrompt`. The axis brief plus diff must fit, or escalate to the next model. |
| **Rate limits** | Six parallel reviewers, three of them on Fable. On Max: the 5-hour window and the 50% weekly Fable cap [V]. On the API: tier limits; fast mode has separate limits [V]. | Fallback chains within Claude. A preset can cap concurrent Fable reviewers (stagger them). |
| **Subscription vs API** | Different meanings for `$`. Fast mode is always credits [V]. A gateway credential replaces the subscription [V]. | Record `billing: subscription|api|local` per event, from the harness, not the model. |
| **Reproducibility** | Sampling parameters (`temperature`, `top_p`, `top_k`) were **removed** in API version 2026-10-21 [V: [deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)], so runs can't be pinned to temperature 0. vLLM batching isn't deterministic either [R]. | Pin ids, record model and effort per event, and evaluate with repeats (pass^k), not single runs. |
| **Deprecations** | Anthropic gives at least 60 days' notice [V]. `claude-sonnet-4-5` retires 2026-11-30. `claude-opus-4-5-20251101` and `claude-haiku-4-5` are near their "not sooner than" dates [V]. Gemini 4 Argon's price doubles 2026-12-01 [V]. | Presets use aliases or ids validated against the adapter's model list. A retired id fails loudly, and the fallback chain kicks in [V]. |
| **Fable safeguards on security review** | Fable 5.2 keeps cyber safeguards [R]. A defensive review could be refused. | Treat a refusal as invalid and escalate to `opus`. |
| **Unpriced models bypass the $5 cap** | Non-Claude and local models have no `PRICES` entry, so only the 3M-token cap applies [V, code]. Local is $0 with unbounded time. | Each adapter ships its price table. Add a wall-clock cap per local step. |
| **The $5 cap vs Fable-heavy presets** | All-Claude with 2 loop-backs ≈ $5.40; Max quality ≈ $5.85 after one loop-back (§2). Over budget, `decide()` won't auto-merge even when all axes pass. | Keep the cap (it only makes escalation more likely). Revisit `COST_CAP` deliberately; it is not configurable by design. |
| **Local runtime is a new attack surface** | The `ANTHROPIC_BASE_URL` route is unsupported by Anthropic [V]. The local server validates no keys [V]. | Loopback-only URLs, validated by `F`. Never set `ANTHROPIC_BASE_URL` for the driving session. |
| **Trust model** | No change. `gate`, `decide`, `merge`, the caps, `TRUSTED` and `SENSITIVE` don't read the model. `validateReview` and the recomputed verdict apply to every runner [V, repo]. | Model and effort are *config* (user-local `skills.json`), never payload fields. |

---

## 9. Design proposal for the factory

The aim is the smallest change that fits the existing runner system. **Nothing here needs a non-Claude tool.** Codex, Gemini and local runtimes stay optional adapters.

### 9.1 Runner config: `model`, `effort`, `fallback`, `escalate`

Extend `checkRunner()` (factory.mjs:426) to accept four optional fields on **every** `use` kind, including `default`. The built-in brief then gets a model too.

```json
{"default": {
  "intake":          {"use": "default", "model": "fable",  "effort": "medium", "fallback": ["opus"]},
  "spec":            {"use": "default", "model": "fable",  "effort": "high",   "fallback": ["opus"]},
  "build":           {"use": "default", "model": "opus",   "effort": "high",   "fallback": ["sonnet"]},
  "review.code":     {"use": "default", "model": "fable",  "effort": "high",   "fallback": ["opus"], "escalate": "opus"},
  "review.security": {"use": "default", "model": "fable",  "effort": "high",   "fallback": ["opus"], "escalate": "opus"},
  "review.ux":       {"use": "default", "model": "sonnet", "effort": "high",   "escalate": "opus"},
  "review.ui":       {"use": "default", "model": "sonnet", "effort": "high",   "escalate": "opus"},
  "review.seo":      {"use": "default", "model": "haiku",  "effort": "medium", "escalate": "sonnet"},
  "review.docs":     {"use": "default", "model": "haiku",  "effort": "medium", "escalate": "sonnet"},
  "verifier":        {"use": "default", "model": "fable",  "effort": "medium", "fallback": ["opus"]}
}}
```

The driving session's own model isn't a step key. A preset records it as a recommendation (`"session": "opus"`). `F` warns when the measured main-transcript model differs from it and build has no headless runner, because then build ran on the session's model.

**Validation:**

- `model` is checked against the harness adapter's list (aliases or ids; same regex as `record()`'s `model`).
- `effort` is checked against that harness's enum. For Claude: `low|medium|high|xhigh|max`.
- `fallback` is at most 3 entries, same harness (the Claude Code chain limit [V]).
- `escalate` is a single model, same harness by default, and must rank at or above `model` in the adapter's ordering. **Escalation is upward only.**

**Three distinct mechanisms, named apart so they aren't confused:**

1. **`fallback`** (new field): the harness's own overload or unavailable chain. It maps to `--fallback-model a,b` for headless runs. For subagents, the skill retries on the next alias when the Agent call errors with overload or a limit. It is recorded as `runner.modelFallback: {from, to, reason}`.
2. **`--fallback "<why>"`** (existing flag): the configured *runner* could not run, so `F` downgrades to the built-in brief.
3. **`escalate`** (new field): the step ran but its output was invalid or refused, so it is retried once on a stronger model (§9.4).

**How the skill applies it** [V on mechanisms]:

- **Subagent steps** (intake, spec, review, verifier): spawn with the Agent tool's `model: "<alias>"` and `effort: "<level>"` parameters. The Agent tool takes aliases only, so presets use aliases. Pin what an alias means with `ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5-2` etc. in `~/.claude/settings.json` `env`.
- **Intake and spec become subagent steps** under a non-inherit model. Today the driving session does them itself (SKILL.md §1–2), so a per-step model needs a subagent or a headless run.
- **Headless steps** (build as a provider runner, and `F eval`): `F headless-args` gains `--model <id> --effort <lvl> [--fallback-model …]` from the plan, so the pinned flag set stays in one place.

### 9.2 Named presets

- A `PRESETS` constant in `factory.mjs` holds pure data: the tables in §1–2.
- New command `F skills preset <owner/repo|default> <name>`:
  - writes each step through the existing `setSkill()` validator;
  - appends one audit event;
  - takes `--dry-run` to print the diff.
- Preset names:

  | Name | Notes |
  |---|---|
  | `all-claude` | the default |
  | `all-claude-lean` | the sketched mapping; under the cap with two loop-backs |
  | `max-quality` | |
  | `lowest-cost` | Claude-only |
  | `lowest-cost-mixed` | needs codex |
  | `local-first` | needs a local runtime |
  | `today` | exactly the current SKILL.md routing |

- A preset that needs an adapter that isn't detected (§9.7) is refused with the reason. Nothing falls back silently to another vendor.
- Events carry `preset` (stamped by `F` from config, like `runner`), so metrics can group by it.

### 9.3 Cross-family review as an option (no new code)

It already works through `axes.extra`, which only *adds* reviewers:

```bash
F skills set acme/app axes.extra '[{"axis":"code-x","when":["**/*"],"use":"provider","harness":"codex"}]'
```

- Add `model` to that runner (e.g. `"gpt-6.2-astra"`) once §9.1 lands.
- Its findings go through the same verifier. Per §5.3 it is a coverage add-on and never replaces `code`.
- The `max-quality` preset includes it only if `codex` is detected and logged in.

### 9.4 Cascades: retry an invalid review once, upward, without laundering

The flow inside the skill, before recording:

1. Run the axis on `model`.
2. If the reply fails `--json-schema` / `--output-schema`, or `F review --check` (a new dry-run of `reviewFromText` that records nothing) returns invalid, or the reply is a refusal, rerun **once** on `escalate`.
3. Record with `F review RUN <axis> --escalated-from <model> -`, carrying both attempts' usage.

`F` enforces the rules:

- **One record per axis per iteration, frozen at the gate.**
  - A second `F review` (or `F event … review`) for the same axis and iteration is refused, *unless* the existing record is a "reviewer output invalid" failure and the new one carries `--escalated-from`.
  - Once that iteration has a `gate` event, nothing more is recorded for it.
  - This closes the overwrite gap reproduced in §8.
  - The self-test only re-records across iterations, so it keeps passing. Resume after a crash is unaffected: an unrecorded reviewer is simply rerun.
- **Upward only.** `escalate` must rank above the recorded model, so a cascade can't move to a weaker model to get a pass.
- **The verifier's asymmetry.** A cheaper first-pass verifier (e.g. `local-first`) may only *keep* findings. Any finding it would dismiss is re-sent to the configured strong verifier, and only that verifier's `dismissed` marks are applied [J, §5.5].
- **Cost.** Both attempts count toward the budget. The escalation costs real money, but only on failure.

No confidence-based cascade: the factory has no calibrated confidence signal, and FrugalGPT/RouteLLM rely on trained scorers [J].

### 9.5 Recording the model per event (finishing the roadmap item)

Already present: `model` and `usage` on payloads, and measured per-message `model` from transcripts (factory.mjs:213–239). Add:

- **The `runner` stamp gains `model`, `effort` and `preset`** from the resolved plan. This is what was *asked for*.
- **Measured attribution adds `byModel`** to `burnOf()` cells (next to `byStage`, `byAxis`). This is what *ran*.
- **The dashboard shows a mismatch chip** when they differ, e.g. "configured fable, ran opus (fallback)".
- **`metrics()` gains per-model and per-preset rows.** Merge rate, cost per merge, loop-backs, reverts, plus three quality signals per reviewer model:
  - **invalid-review rate**;
  - **verifier dismissal rate** (high means noisy reviewers);
  - **escaped-defect proxy**: post-merge revert rate per build model and per code-reviewer model.
- **Local steps record `ms`** (wall time) and `billing: "local"`, with $0.

### 9.6 A local harness kind

Lazy option first: **`harness: "codex"` with `--oss`** covers agentic local runs today:

```json
{"use":"provider","harness":"codex","model":"qwen3-coder","local":"ollama"}
```

This maps to `codex exec --oss --local-provider ollama -m qwen3-coder …`.

For reviewers, an agentic loop is overkill. Add a small **`harness: "ollama"` chat adapter** [J]:

1. `F` builds the prompt itself: the axis brief + `F rules` guidance + `git diff reviewedSha...HEAD`, truncated to the adapter's `maxPrompt`.
2. It calls `POST http://127.0.0.1:11434/api/chat` with `format: <review.schema.json>` and `stream: false`. Only a loopback URL is allowed, and `F` validates it. Node's built-in `fetch` is enough, so there is no new dependency.
3. It passes the reply to `reviewFromText`.

The rest of the local harness:

- **Cost:** $0, with `ms` recorded.
- **A wall-clock cap** per local step (e.g. 10 min). Over it, escalate to `escalate`, or record a failed review.
- **Privacy upside:** the diff never leaves the machine, which suits private repos. A repo-level rule could later *require* local or none for given axes. That would be a stricter-only rule in the existing rules system [J].
- **Code-only diffs** are safe on this path: `F` reads `git diff` itself and never runs repo hooks or MCP.

### 9.7 Onboarding: detect runtimes; "Claude only" is one click

New `F harnesses`, read-only and cached per process like `scanGlobal()`. It reports:

- `claude --version`, with a warning when below the version a preset's model needs (Fable 5.2: 2.1.321 [V]; **this machine has 2.1.304**);
- `codex --version` (this machine: 0.141.0);
- `gemini --version`;
- `ollama list` or `GET /api/tags`;
- `lms ls --json`;
- `os.totalmem()` and `process.arch`, with a warning on `x64` macOS: "local models will run CPU-only and slowly".

The dashboard's Skills sheet (`F ui`) shows a **Presets** row first:

- **"Claude only (recommended)"** runs `F skills preset default all-claude` via the existing `POST /skills` path.
- The other presets are greyed out with a reason when their adapter is missing.

The skill's attach flow asks once: "Use Claude only for every step? (recommended)".

### 9.8 Eval harness: compare presets

**What exists:**

- `F eval` runs **intake only** on 8 golden fixtures.
- `claude -p` is hard-coded with **no model flag** (factory.mjs:1218–1238).

**Steps:**

1. **`F eval --preset <name> --repeat k`.** Pass the preset's intake `--model` and `--effort` to the headless call. Report accuracy, pass^k (all k runs right), mean tokens and cost per fixture, and the invalid-output rate.
   - **n=8 is too small** to separate presets. Grow it to 30+ fixtures, with injection and harmful-request cases, before trusting a difference [J].
2. **Review fixtures** (new `evals/review/*.json`): a diff, the spec, and planted findings with an expected axis and severity. This copies the planted-error method of [2610.01471]. Score per reviewer model: recall, precision, and the invalid-JSON rate. This is where Haiku vs Sonnet for seo/docs, or local vs Haiku, gets decided cheaply.
3. **Whole-run metrics** (merge rate, loop-backs, cost per merge): fixtures can't give these. Use real runs grouped by `preset` through `metrics()`, e.g. alternate presets per issue on one repo for a month.
   - Or build a small set of sandbox repos with known-good issues. That is more work and **not proposed yet**.
4. **Gate model changes on evals:** a preset change or a new model id runs `F eval --repeat 3` first. This is the "regression evals" practice in `ai-engineering-flows.md` §2.

### 9.9 Adding a provider or model = one file plus one fixture

Reuse the **`packages/ship/connectors` pattern** (an auto-loaded registry, a contract and a shared contract test over `fixtures/<id>.json`):

- `packages/factory/harnesses/<id>.mjs` exports:
  - `id`;
  - `detect()`;
  - `models()` → `[{id, alias?, rank, maxPrompt, efforts[], price?:[in,write,read,out]}]`;
  - `args(step, runner)` for an agentic CLI, **or** `run(step, prompt, schema)` for a chat API;
  - `parseUsage(output)` → `{model, usage, ms}`.
- `packages/factory/harnesses/test/fixtures/<id>.json` holds a recorded reply (valid, invalid, refusal) that the shared test runs through `reviewFromText` and the usage parser.
- **`claude-code` stays built into `factory.mjs`**, so the zero-dependency, all-Claude path never needs the folder. Codex, Gemini and Ollama move to adapters. The cost is a small conflict with "one file" for `F`; the ship harness already accepted it [J].
- **A new *model* on an existing harness** is a one-line change in that adapter's `models()` plus its price. Claude prices stay in `PRICES` (fix Fable's cache read when touching it).

### 9.10 What doesn't change

- Runner config, model and effort are user-local `skills.json`, never repo or payload text.
- `code` and `security` are always reviewed.
- Every reply goes through `F review`; the verdict is recomputed from the findings.
- `gate`, `decide`, `merge`, `--match-head-commit`, caps, `TRUSTED` and `SENSITIVE` are model-blind.
- Headless runs keep `--setting-sources user --strict-mcp-config`, never `--bare`, and `--max-budget-usd`.
- `.claude/**`, `.codex/` and `.mcp.json` stay sensitive.

---

## 10. Open questions for the user

1. **Which Claude plan drives the factory: Pro, Max/Ultra, or an API key?** On Pro, Fable at intake, spec, verifier, code and security is real money (usage credits). On Max it shares the 50% weekly Fable allowance. This decides whether All-Claude stays as specified, or drops `code` to Opus.
2. **Update Claude Code to 2.1.321 or later** (this machine has 2.1.304)? Fable 5.2 needs it.
3. **The $5 cap.** All-Claude with two loop-backs reaches about $5.40, and Max quality goes past it from the first loop-back. Over budget, `decide()` refuses auto-merge even when every axis passed. Options:
   - keep the cap (more escalations);
   - use All-Claude lean ($4.08 with two loop-backs);
   - raise it deliberately for Fable-heavy presets.
   
   It is a hard-coded trust constant, not a rule.
4. **All-Claude or All-Claude lean as the default?** It hinges on the untested "reviewer at least as capable as the builder" extrapolation. Run the review-fixture eval (§9.8) before deciding, or start lean.
5. **Spec on Fable or Opus?** The difference is about $0.15 per issue. I put Fable as the default; the eval harness can settle it.
6. **Enable an optional cross-vendor `code-x` axis** in `max-quality` only, or never? Codex is already installed.
7. **Is a local-first path wanted on this Intel Mac at all** (embeddings and duplicate search only), or only after a move to Apple Silicon?
8. **Fix the review-overwrite gap first** (§8), as a small separate change, before any cascade work?
9. **Should the pricing fix for Fable cache reads (0.8 → 0.20)** go in with the model-per-event change?

---

## 11. Not checked

- Aider, OpenCode, Goose and Continue: only secondary sources and Ollama's pages; nothing run here.
- vLLM.
- Gemini CLI headless flags and aliases.
- Codex ChatGPT-plan credit accounting.
- Whether `--fallback-model` fires on a plan-limit (rather than overload) refusal.
- The tbench.ai live table (didn't render).
- Scale's live SWE-bench Pro board.
- Per-engine JSONSchemaBench numbers.
- Laptop-size model coding benchmarks.
- Measured local JSON failure rates. These need a model pulled first, which is a download the user must approve.
- UI/vision and security model comparisons.
- Measured CPU prefill speed on this Mac.
- Fable 5.2's system-card benchmark table.
