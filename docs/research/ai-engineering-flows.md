# AI engineering flows: survey and gap list

As of 2026-11-22. This is a survey of what teams automate with coding agents beyond issue → PR, the practices that recur across those setups, and how the `software-factory` skill compares.

**About the sources:** most of these come from vendor docs and vendor engineering blogs, so adoption and accuracy numbers are self-reported unless a line says otherwise. I read the primary pages behind the hard numbers in full: Airbnb, Stripe, Sentry, Meta, Google, Claude Code Review, the two arXiv performance studies and Anthropic's two sandboxing posts. The other sources I checked only through search summaries, so verify their details on the linked page before quoting them.

Maturity key:

- **Widely used:** GA in a major product, or reported at scale by more than one company.
- **Emerging:** GA from one or two vendors, or in preview.
- **Experimental:** research, preview-only, or practitioner DIY.

---

## 1. Catalogue of flows

### 1.1 Summary table

| # | Flow | Trigger | Human checkpoint | Maturity |
|---|---|---|---|---|
| 1 | PR review bots | PR opened or updated | Human reads comments; bot never approves | Widely used |
| 2 | CI failure auto-fix | CI job fails on a PR | Review the fix commit or PR (auto-apply is opt-in per task) | Widely used |
| 3 | Flaky-test triage and fix | Flaky-test detector flags a test | Review a draft "attempt to fix" PR | Emerging |
| 4 | Dependency upgrades and migrations | Renovate/Dependabot PR fails CI; Dependabot alert; planned migration | PR review; humans clean up the long tail | Widely used (migrations at big companies); Emerging (agent-fixed bumps) |
| 5 | Incident / on-call triage | Alert or PagerDuty incident | On-call reviews the diagnosis and approves any action | Emerging |
| 6 | Error tracker → fix | New Sentry issue | Review the draft PR; Seer never merges | Widely used |
| 7 | Test generation / coverage raising | Cron, new code, coverage gap | Engineer accepts or rejects each test | Emerging |
| 8 | Docs and changelog generation | PR merged, push to main, cron | Review the docs PR, or nothing happens | Emerging |
| 9 | Tech-debt sweeps / dead code | Continuous scan (stale feature flags) | Diff routed to the owning engineer | Widely used (Uber) |
| 10 | Backlog triage and dedupe | Issue opened | Maintainer confirms labels and duplicates | Emerging |
| 11 | Spec/PRD → tasks | Developer starts a feature | Approve requirements, design and tasks in turn | Emerging |
| 12 | Design (Figma) → code | Developer pastes a Figma link | Normal code review | Emerging |
| 13 | QA / E2E exploratory testing | On demand or after a deploy | Review the plan and the generated tests | Emerging |
| 14 | Performance regression hunting | Perf alert or benchmark regression | Adversarial reviewer, then human | Experimental |
| 15 | Security scanning + auto-remediation | Code-scanning alert, Dependabot alert, scheduled scan | Human reviews every patch | Widely used (Autofix); Emerging (agentic) |
| 16 | Codebase onboarding / Q&A | Repo connected; question asked | None (read-only) | Widely used |
| 17 | Large-scale refactor fan-out | Developer request | Each unit's PR reviewed | Emerging |
| 18 | Scheduled maintenance agents | Cron | Output is an issue or PR for review | Emerging |
| 19 | Slack/ticket → PR ("one-shot" agents) | Slack thread, bug report | Human reviews every PR | Widely used (Stripe) |
| 20 | Cross-source digest / status agents | Cron | None (report only) | Emerging |

### 1.2 Flow details

#### 1. PR review bots

- **Trigger:** a PR is opened or updated (`opened`, `synchronize`).
- **Steps:**
  1. Fetch the diff and the surrounding code.
  2. Run several reviewers in parallel.
  3. Verify each finding to drop false positives.
  4. Rank the findings by severity.
  5. Post inline comments.
- **Human checkpoint:** findings don't approve or block the PR; a human decides.
- **Tooling:** Claude Code Review (multi-agent, about $15–25 a review; it won't approve PRs), `anthropics/claude-code-action`, Cursor Bugbot.
- **Maturity:** widely used.
- **Sources:** [Claude Code Review launch](https://claude.com/blog/code-review), [Cursor Automations docs (Bugbot)](https://cursor.com/docs/cloud-agent/automations)

#### 2. CI failure auto-fix ("self-healing CI")

- **Trigger:** a CI task fails on a PR, via `workflow_run` with `conclusion == failure` or a vendor hook.
- **Steps:**
  1. Collect the failed tasks and their logs.
  2. The agent drafts a fix.
  3. Re-run only the failed tasks against the fix.
  4. Propose the fix on the PR.
- **Loop guard:** skip branches the bot itself made (for example `claude-fix/*`).
- **Human checkpoint:** approve the suggested fix. Nx can auto-apply verified fixes only for tasks you allow-list, and never for tasks on its "never-fix" list.
- **Tooling:** Nx Cloud Self-Healing CI (custom instructions in `.nx/SELF_HEALING.md`), claude-code-action on `workflow_run`.
- **Maturity:** widely used.
- **Sources:** [Nx Self-Healing CI docs](https://nx.dev/docs/features/ci-features/self-healing-ci), [Nx auto-apply](https://nx.dev/blog/self-healing-ci-auto-apply-suggestions)

#### 3. Flaky-test triage and fix

- **Trigger:** the flaky-test manager flags a test, after early flake detection.
- **Steps:**
  1. Categorize the flake by cause: timing, ordering, shared state, and so on.
  2. Attempt only the categories where a code fix is likely.
  3. Verify the fix.
  4. Open a draft PR labelled "Attempt to Fix" that includes the diagnosis and the verification results.
- **Human checkpoint:** review the draft; the agent never merges. Cypress describes also teaching the agent when *not* to attempt a fix ([dev.to/cypress](https://dev.to/cypress/teaching-an-agent-to-triage-flaky-tests-and-to-know-when-not-to-jnh)).
- **Tooling:** Datadog Bits Dev Agent with Test Optimization, Atlassian Bitbucket, Aviator, Kong (homegrown).
- **Maturity:** emerging.
- **Sources:** [Datadog Bits AI test optimization](https://datadoghq.com/blog/bits-ai-test-optimization), [Kong: agentic AI for flaky tests](https://konghq.com/blog/engineering/how-we-used-agentic-ai-to-fix-kong-gateways-flakiest-tests)

#### 4. Dependency upgrades, framework bumps and codemod migrations

- **Triggers:**
  - a Renovate or Dependabot PR fails CI;
  - a Dependabot alert is assigned to an agent;
  - a planned migration (framework, test library, or type widening).
- **Steps:**
  1. Read the changelogs and release notes to find the breaking changes.
  2. Apply the change file by file, through a pipeline of validation gates: tests pass, lint passes, types check.
  3. Retry each step with the error output as feedback.
  4. Humans finish the long tail.
- **Human checkpoint:** PR review.
- **Reported results:**
  - Airbnb migrated about 3.5K Enzyme→RTL test files in 6 weeks, against an estimated 1.5 engineering-years by hand. 75% were done in the first four hours, 97% after four days of tuning, and the last 3% by hand.
  - Google reports about 74% of migration changes were LLM-generated and about 50% of the time saved.
- **Tooling:** Dependabot → Copilot/Claude/Codex assignment, GitLab agentic breaking-change resolution, Renovate with an agent on failure (Elastic), deterministic codemods with an LLM for the leftovers.
- **Maturity:** widely used for migrations at large companies; agent-fixed version bumps are emerging.
- **Sources:**
  - [Airbnb: Accelerating large-scale test migration with LLMs](https://airbnb.tech/?p=366)
  - [Google: Migrating Code at Scale with LLMs](https://arxiv.org/abs/2504.09691)
  - [Dependabot alerts assignable to agents](https://github.blog/changelog/2026-04-07-dependabot-alerts-are-now-assignable-to-ai-agents-for-remediation)
  - [Elastic: Renovate + Claude self-correcting monorepo](https://www.elastic.co/search-labs/jp/blog/ci-pipelines-claude-ai-agent)

#### 5. Incident response / on-call triage

- **Trigger:** an alert fires, or a PagerDuty incident is triggered, acknowledged or resolved.
- **Steps:**
  1. Analyze the alert payload against past incidents, recent deploys and changes.
  2. Pull logs and metrics (for example through Datadog MCP).
  3. Post a root-cause hypothesis to the on-call channel.
  4. Optionally open a fix PR and draft the post-mortem.
- **Human checkpoint:** on-call accepts the diagnosis and approves any remediation.
- **Tooling:** incident.io AI SRE, PagerDuty SRE Agent, Cursor Automations with a PagerDuty trigger.
- **Maturity:** emerging. Vendor accuracy claims have not been independently benchmarked.
- **Sources:** [incident.io AI SRE](https://incident.io/blog/introducing-ai-sre), [PagerDuty SRE agent](https://www.pagerduty.com/blog/ai/new-enhancements-to-pagerdutys-sre-agent-triage-faster-without-waking-a-human/)

#### 6. Error tracker (Sentry) → fix

- **Trigger:** a new or high-impact Sentry issue, or a manual or API start.
- **Steps:**
  1. Root-cause analysis grounded in the stack trace and the repo.
  2. Propose a solution.
  3. Write the code change.
  4. Open a PR, or hand off to Claude Code, Cursor or Copilot.
- **Stop points:** automation settings choose where the run stops: after root cause, after the plan, or after the PR is drafted. CI auto-iteration is capped to prevent endless loops.
- **Human checkpoint:** the PR; "nothing gets merged without your approval" (Sentry blog).
- **Tooling:** Sentry Seer Issue Fix (formerly Autofix), with webhooks for each stage.
- **Maturity:** widely used.
- **Sources:** [Seer Issue Fix docs](https://docs.sentry.io/product/ai-in-sentry/seer/issue-fix), [Seer GA blog](https://blog.sentry.io/seer-sentrys-ai-debugger-is-generally-available/)

#### 7. Test generation / coverage raising

- **Trigger:** a coverage gap, new code, a cron job, or a "test-a-thon".
- **Steps:**
  1. Extend existing test classes.
  2. Filter the results: each test must build, pass reliably on repeated runs, and *increase coverage*.
  3. Discard everything else.
  4. Propose the survivors.
- **Human checkpoint:** an engineer accepts each test. At Meta, 73% of recommendations were accepted.
- **Tooling:** Meta TestGen-LLM, Qodo Cover-Agent (open source), Playwright generator agent.
- **Maturity:** emerging.
- **Source:** [Meta: Automated Unit Test Improvement using LLMs](https://arxiv.org/abs/2402.09171)

#### 8. Docs, changelog and release-notes generation

- **Trigger:** a PR is merged, a push to main touches `src/`, or a cron job.
- **Steps:**
  1. Diff the code against the docs.
  2. Detect drift.
  3. Open a docs PR, *or a no-op when nothing user-facing changed*.
  4. Optionally add CHANGELOG entries grouped Added / Changed / Fixed.
- **Human checkpoint:** docs PR review; drafts never go straight to live docs.
- **Tooling:** gh-aw `daily-doc-updater`, Cursor and Augment workflow templates, homegrown Actions jobs.
- **Maturity:** emerging.
- **Sources:** [gh-aw docs-automation gallery](https://github.github.com/gh-aw/gallery/docs-automation/), [Red Hat: diff → docs PR](https://developers.redhat.com/articles/2026/04/21/ai-powered-documentation-updates-code-diff-docs-pr-one-comment)

#### 9. Tech-debt sweeps / dead-code removal

- **Trigger:** a continuous scan of the feature-flag system for stale flags.
- **Steps:**
  1. Pick flags that are safe to remove.
  2. A deterministic AST rewrite (Piranha) removes the flag and the unreachable code.
  3. The LLM decides what else to propagate.
  4. Extra validation runs, because CI misses incomplete cleanups.
  5. The diff goes to the owner.
- **Human checkpoint:** the owning engineer reviews the diff.
- **Tooling:** Uber AutoClean with PolyglotPiranha, Claude Code and Codex for ad-hoc sweeps.
- **Maturity:** widely used at Uber.
- **Sources:** [Uber AutoClean](https://www.uber.com/us/en/blog/ai-code-cleanup/), [Uber Piranha](https://www.uber.com/blog/piranha/)

#### 10. Backlog / issue triage and dedupe

- **Trigger:** an issue is opened.
- **Steps:**
  1. Summarize the issue.
  2. Run several parallel searches for duplicates.
  3. Filter out weak matches.
  4. Comment with candidate duplicates, and add labels and routing.
  5. Optionally auto-close confirmed duplicates (the claude-code repo has an `auto-close-duplicates` script).
- **Human checkpoint:** a maintainer confirms. Known failure: duplicate chains, where issues get marked as duplicates of each other.
- **Tooling:** the claude-code repo's `/dedupe` command in Actions, gh-aw Issue Triage.
- **Maturity:** emerging. The pattern is copied across many repos (Zed, Graphiti, Rocket.Chat), but each team runs it DIY.
- **Sources:** [gh-aw: Meet the Workflows, Issue Triage](https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows/), [anthropics/claude-code workflows](https://github.com/anthropics/claude-code/tree/main/.github/workflows) (the primary dedupe workflow and the `/dedupe` command)

#### 11. Spec/PRD → tasks breakdown

- **Trigger:** a developer starts a feature.
- **Steps:** constitution or requirements (EARS notation) → design → `tasks.md`. Kiro also builds a task dependency graph and runs independent tasks in waves.
- **Human checkpoint:** approval at each phase (Kiro's default; Quick Spec skips the gates).
- **Tooling:** GitHub Spec Kit (`/specify` → `/plan` → `/tasks` → `/implement`), Kiro specs.
- **Maturity:** emerging.
- **Sources:** [GitHub Spec Kit blog](https://github.blog/news-insights/product-news/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/), [Kiro specs docs](https://kiro.dev/docs/specs/)

#### 12. Design (Figma) → code

- **Trigger:** a Figma frame link is given to the agent.
- **Steps:**
  1. The MCP server returns the layer hierarchy, layout, tokens and component properties.
  2. Code Connect maps Figma components to real repo components, so the agent reuses them instead of generating lookalikes.
  3. The agent generates code.
  4. Optionally push the rendered UI back to Figma.
- **Human checkpoint:** normal code and design review.
- **Tooling:** Figma Dev Mode MCP server with Code Connect, Builder.io.
- **Maturity:** emerging.
- **Sources:** [Figma MCP server guide](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Dev-Mode-MCP-Server), [figma/mcp-server-guide](https://github.com/figma/mcp-server-guide)

#### 13. QA / E2E exploratory testing with browser agents

- **Trigger:** on demand, or after a deploy or preview build.
- **Steps:**
  1. The *planner* explores the live app and writes a Markdown test plan.
  2. The *generator* turns the plan into Playwright tests.
  3. The *healer* re-runs failing tests and repairs them. Practitioners limit the healer to locators, never assertions.
- **Human checkpoint:** review the plan and the tests.
- **Tooling:** Playwright Test Agents (v1.56+, `npx playwright init-agents`), Playwright MCP.
- **Maturity:** emerging.
- **Source:** [Playwright Test Agents docs](https://playwright.dev/docs/test-agents)

#### 14. Performance regression hunting

- **Trigger:** a perf alert fires, or a benchmark regresses on a PR.
- **Steps:**
  1. Investigate the regression.
  2. An adversarial reviewer agent checks the diagnosis and sends weak ones back.
  3. Mitigate.
  4. After deploy, an agent checks the fix worked, and loops back if it didn't.
- **Human checkpoint:** the reviewer agent first, then human PR review.
- **Caution:** agent perf PRs include explicit perf validation less often than human ones (45.7% vs 63.6%). In another study only 11% of agent perf fixes carry a benchmark, and "a merge does not show that the fix delivers what it claims".
- **Tooling:** OpenAI "Performance Factory" (internal), CodSpeed Wizard.
- **Maturity:** experimental.
- **Sources:**
  - [VentureBeat on OpenAI Performance Factory](https://venturebeat.com/orchestration/exclusive-openai-reveals-performance-factory-a-codex-powered-software-optimization-system-that-keeps-chatgpt-fast)
  - [How do agents perform code optimization? (45.7% vs 63.6%)](https://arxiv.org/html/2512.21757v1)
  - [Merged, Not Measured](https://arxiv.org/abs/2609.37985)

#### 15. Security scanning + auto-remediation

- **Trigger:** a CodeQL alert, a Dependabot alert, or a scheduled repository scan.
- **Steps:**
  1. Build a threat model of the repo (Aardvark / Codex Security).
  2. Find the vulnerability.
  3. Validate it, for example in a sandbox.
  4. Generate a patch.
  5. Re-scan the patch: CodeQL re-runs its standard suite.
  6. Open a PR.
- **Human checkpoint:** a human reviews every patch. CodeMender's patches are all reviewed before they go upstream.
- **Tooling:** Copilot Autofix and agentic autofix ("Assign to Copilot"), OpenAI Codex Security, Google DeepMind CodeMender.
- **Maturity:** Autofix is widely used; agentic remediation is emerging.
- **Sources:**
  - [Copilot Autofix docs](https://docs.github.com/en/code-security/concepts/code-scanning/copilot-autofix-for-code-scanning)
  - [Agentic autofix preview](https://github.blog/changelog/2026-07-10-agentic-autofix-for-code-scanning-alerts-in-public-preview/)
  - [Introducing Aardvark](https://openai.com/index/introducing-aardvark)
  - [CodeMender](https://deepmind.google/discover/blog/introducing-codemender-an-ai-agent-for-code-security/)

#### 16. Codebase onboarding / Q&A

- **Trigger:** a repo is connected, or someone asks a question.
- **Steps:**
  1. Index the repo.
  2. Generate a wiki with architecture diagrams and source links.
  3. Answer questions grounded in the wiki and code search.
  4. Steer the output with `.devin/wiki.json`.
- **Human checkpoint:** none (read-only).
- **Tooling:** Devin DeepWiki (public version and MCP), Claude Code or Codex used interactively.
- **Maturity:** widely used.
- **Source:** [Devin DeepWiki docs](https://docs.devin.ai/work-with-devin/deepwiki)

#### 17. Large-scale refactor fanned out across many agents

- **Trigger:** a developer requests one large change.
- **Steps:**
  1. Plan in the main session.
  2. Split the change into 5–30 independent units.
  3. Give each unit its own agent in its own git worktree.
  4. Each agent opens its own PR.
  5. A summary table reports results, for example "22/24 landed".
- **Human checkpoint:** each PR is reviewed. Review bandwidth is the real limit.
- **Tooling:** Claude Code `/batch` and worktrees; at company scale, Google's and Airbnb's per-file migration pipelines (flow 4).
- **Maturity:** emerging.
- **Sources:** [Claude Code worktrees docs](https://code.claude.com/docs/en/worktrees), [agentpatterns: /batch with worktrees](https://www.agentpatterns.ai/tools/claude/batch-worktrees/)

#### 18. Scheduled maintenance agents

- **Trigger:** cron, an API call, or a GitHub event.
- **Steps:** a saved prompt, repos and connectors run unattended. Examples: a daily repo status issue, dependency hygiene, doc drift, triage sweeps. Write permissions are limited by "safe outputs", such as only creating an issue with a given prefix.
- **Human checkpoint:** the output is an issue or PR.
- **Tooling:** Claude Code routines / cloud scheduled tasks, GitHub Agentic Workflows (Markdown compiled to Actions), Cursor Automations.
- **Maturity:** emerging.
- **Sources:** [Claude Code routines docs](https://code.claude.com/docs/en/routines), [GitHub Agentic Workflows](https://github.github.com/gh-aw/), [Cursor Automations](https://cursor.com/docs/cloud-agent/automations)

#### 19. Slack thread / bug report → PR ("one-shot" agents)

- **Trigger:** a Slack thread, a bug report, or a feature request.
- **Steps:**
  1. An unattended agent runs on a pre-warmed devbox (ready in about 10 s).
  2. It runs local lint and tests.
  3. It pushes to CI.
  4. It opens a PR.
- **Human checkpoint:** every PR is human-reviewed, though no human writes the code. Stripe reports over 1,000 merged PRs a week in Part 1 and over 1,300 in [Part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2).
- **Tooling:** Stripe Minions (a fork of goose), Copilot coding agent (assign an issue), Codex cloud.
- **Maturity:** widely used.
- **Sources:** [Stripe Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents), [Copilot coding agent docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-a-pr)

#### 20. Cross-source digest / status agents

- **Trigger:** cron, for example every 2 hours.
- **Steps:**
  1. Read PRs, Jira issues and Slack mentions.
  2. Deduplicate across sources.
  3. Post a dashboard or digest.
- **Human checkpoint:** none (report only).
- **Tooling:** Cursor Automations, gh-aw daily-repo-status.
- **Maturity:** emerging.
- **Source:** [Cursor Automations launch post](https://cursor.com/blog/automations)

---

## 2. Cross-cutting best practices

| Practice | Why (one line) | Source |
|---|---|---|
| **Spec-first / plan-then-execute** | Jumping straight to code solves the wrong problem; a reviewed plan is cheap to fix and expensive code isn't. | [Claude Code best practices](https://code.claude.com/docs/en/best-practices), [Spec Kit](https://github.blog/news-insights/product-news/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/) |
| **Small PRs / small batches** | AI amplifies existing practice; small batches keep review effective as AI raises volume. | [DORA 2025 report](https://research.google/pubs/dora-2025-state-of-ai-assisted-software-development-report/) |
| **Independent reviewers + finding verification** | A second pass that only *verifies* findings cuts false positives. Adversarial reviewers sent back many of OpenAI's perf diagnoses. | [Claude Code Review](https://claude.com/blog/code-review), [OpenAI Performance Factory](https://venturebeat.com/orchestration/exclusive-openai-reveals-performance-factory-a-codex-powered-software-optimization-system-that-keeps-chatgpt-fast) |
| **Mechanical validation gates before an LLM judges** | Hard filters (builds, passes N times, raises coverage) removed hallucinated tests at Meta; Airbnb gated each step the same way. | [TestGen-LLM](https://arxiv.org/abs/2402.09171), [Airbnb](https://www.infoq.com/news/2025/03/airbnb-llm-test-migration/) |
| **Evals and regression suites for the agent itself** | Regression evals catch the agent getting worse after a prompt or model change; use pass^k for consistency. | [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) |
| **Sandboxing + least-privilege tokens** | Environment limits on filesystem and network, not per-action prompts, are the hard boundary. Sandboxing cut prompts by 84%, and users approved roughly 93% of prompts anyway. | [Anthropic: Claude Code sandboxing](https://anthropic.com/engineering/claude-code-sandboxing), [Anthropic: How we contain Claude](https://anthropic.com/engineering/how-we-contain-claude) |
| **Prompt-injection defence for untrusted text** | Private data, untrusted input and an exfiltration channel together make the "lethal trifecta"; remove one leg. | [Willison: The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), [Fowler: Agentic AI and security](https://martinfowler.com/articles/agentic-ai-security.html) |
| **Constrained write surface ("safe outputs")** | The agent proposes outputs (an issue or PR with a given prefix); a separate, permissioned step writes them. | [GitHub Agentic Workflows](https://github.github.com/gh-aw/) |
| **Human-in-the-loop merge policies** | Every vendor flow above stops at a draft PR: Seer, Datadog, Copilot and CodeMender all do. Auto-merge is the exception and is allow-listed per task (Nx). | [Seer GA blog](https://blog.sentry.io/seer-sentrys-ai-debugger-is-generally-available/), [Nx auto-apply](https://nx.dev/blog/self-healing-ci-auto-apply-suggestions) |
| **Loop / iteration caps and cost budgets** | Unattended runs need hard stops: `--max-turns`, job `timeout-minutes`, and a budget. Claude Code Review averages $15–25 per PR. | [claude-code-action docs](https://code.claude.com/docs/en/github-actions), [CI budget guide](https://dev.to/kalemi/how-to-set-a-ci-budget-for-coding-agents-1eoc) |
| **Loop guards on self-triggering flows** | Fix bots must skip their own branches, or CI-fix → CI-fail → CI-fix loops form. | [claude-code-playbook: GitHub Actions](https://ao92265.github.io/claude-code-playbook/docs/github-actions/) |
| **Observability of agent runs** | Export cost, tokens and sessions over OpenTelemetry so spend and failure rates per flow are visible. | [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage) |
| **CLAUDE.md / AGENTS.md as a map, not a manual** | A short (about 100-line) AGENTS.md pointing to structured `docs/` beat one huge file. AGENTS.md is now an AAIF open format. | [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/), [Agentic AI Foundation](https://openai.com/index/agentic-ai-foundation/) |
| **Parallel agents in worktrees** | Worktrees isolate file edits so agents don't collide. Review bandwidth, not agent count, becomes the limit. | [Claude Code worktrees](https://code.claude.com/docs/en/worktrees), [practitioner write-up](https://dev.to/sahil_kat/how-to-keep-parallel-coding-agents-from-stepping-on-each-other-e5g) |
| **Hybrid deterministic + LLM** | Codemods or AST tools do the safe rewrite and the LLM handles judgement calls. Uber found CI alone misses incomplete cleanups. | [Uber AutoClean](https://www.uber.com/us/en/blog/ai-code-cleanup/) |
| **Measure outcomes (merge rate, revert/churn, cycle time)** | Agent PR acceptance varies widely: 61.6–77.9% by agent in one study, and averages of 0.45–0.83 by agent across task types in another. Acceptance hides maintenance cost, so track churn and reverts too. | [Pinna et al., MSR '26](https://arxiv.org/html/2602.08915), [Task-level evaluation](https://arxiv.org/html/2602.02345), [GitClear: maintainability gap](https://gitclear.com/the_ai_code_quality_maintainability_gap) |

---

## 3. Gap list vs `software-factory`

### 3.1 What the skill already does well

I read `SKILL.md`, `factory.mjs` and `references/reviewers.md`.

| Practice | How the skill covers it |
|---|---|
| Spec-first | A Spec stage writes `spec.md` with testable acceptance criteria. |
| Independent reviewers | Fresh subagents get no build notes. |
| Mechanical gate and merge decision | `F gate` and `F decide` make the calls, and `decide` reads CI and diff facts from GitHub rather than from typed-in values. |
| Small PRs | Auto-merge requires a diff of 300 lines or fewer. |
| Loop cap | The cap is 3 iterations. |
| Human merge policy | Escalation is the default. Sensitive paths and untrusted authors always escalate. |
| Untrusted issue text | Comments are filtered by author association. |
| Append-only event log | Every state change goes into a log that feeds the live dashboard. |

### 3.2 Flows that can reuse the pipeline as new triggers or stages

The pipeline is intake → spec → build → review → gate → approve. The main blocker is that the run id is hard-wired to `owner/repo#N` in `parseRun`, and `intake()` only fetches GitHub issues. Generalizing intake to `<source>/<key>`, the way the "Other trackers" note already suggests, unlocks most rows below.

Rows are sorted by value against effort, best first.

| Flow | How it plugs in | Value | Effort |
|---|---|---|---|
| **Backlog triage / dedupe** (10) | Already half-built: Intake searches for duplicates and can reject or ask for info. Run intake alone on `issues: opened` as a cheap front door. | High | Low |
| **Scheduled runner** (18) | Wrap the skill in a Claude Code routine or a gh-aw workflow that picks up `factory:ready` issues on cron. | High | Low |
| **CI failure auto-fix** (2) | New trigger: a failed check on a `factory/*` PR or any PR. Intake reads the failed job logs; spec = "make check X green without changing its intent"; reuse build, review and gate. Needs a loop guard. | High | Low–Med |
| **Sentry / error → fix** (6) | Intake source `sentry/<issue>`: stack trace and breadcrumbs become the issue body. Spec must include a regression test that reproduces the error. | High | Med |
| **Security alert → fix** (15) | Intake source `codeql/<alert>` or `dependabot/<alert>`. The existing security axis already reviews. Dependency manifests are SENSITIVE today, so Dependabot fixes always escalate, which is correct. | High | Med |
| **Docs / changelog** (8) | Add a `docs` review axis that flags drift, or a post-merge step that writes the CHANGELOG entry from `spec.md`. | Med | Low |
| **Tech-debt / dead-code sweep** (9) | Cron source producing one run per stale flag or dead export. The diffs are small and fit the 300-line cap well. | Med | Med |
| **Flaky-test fix** (3) | Intake source `flaky/<test-id>`. Add a gate that runs the test N times and requires every run to pass. Quarantine is a valid "reject" outcome. | Med | Med |
| **Test-coverage raise** (7) | Cron source: pick a file below coverage X. The gate requires coverage to rise and the new tests to pass N times (Meta's filters). | Med | Med |
| **E2E / QA axis** (13) | The UX reviewer already says "run the app if you can". Give it Playwright Test Agents and require a recorded run or a test for UI changes. | Med | Med |
| **Dependency bump fix** (4) | Trigger on a failing Renovate or Dependabot PR. Build works on *their* branch instead of `factory/issue-N`. Always escalates. | Med | Med |
| **Spec → tasks fan-out** (11, 17) | When intake judges "doesn't fit one PR", split it into child issues, each a separate factory run in its own worktree, instead of rejecting. | High | High |
| **Perf regression** (14) | Intake from a benchmark alert. Add a `perf` axis that must show before and after numbers, since agents often skip perf validation. | Low | High |
| **Incident triage** (5) | Read-only diagnosis plus a hotfix run. High stakes; keep it escalate-only. | Low | High |

### 3.3 Best practices the skill is missing

Rows are sorted by value against effort, best first.

| # | Gap | Evidence in the skill | Fix | Value | Effort |
|---|---|---|---|---|---|
| 1 | **The orchestrating agent holds merge rights** | The same session that read untrusted issue text runs `gh pr merge`. `F` refuses to *record* `approve merged` without a merge decision, but nothing stops the model from calling `gh` directly. | Do the merge inside `factory.mjs` (an `F merge` command that re-runs `decide` and calls `gh pr merge` itself). Better still, use a separate token or a GitHub ruleset that only a bot running `decide` can satisfy. | High | Low |
| 2 | **No worktree isolation** | Setup requires `git status` to be clean in the user's clone and switches branches there. Only one run at a time, and it disturbs the user's checkout. | `git worktree add` per run under `DIR`. This also unlocks parallel runs and fan-out. | High | Low |
| 3 | **No cost or time budget** | `CAP=3` limits iterations, but events carry no tokens, dollars or durations, and nothing stops a long or expensive stage. | Record `cost_usd` and `duration_ms` on the build and review events, and add a `MAX_COST` check to `gate` and `decide`. For headless runs (`claude -p` in Actions), also set `--max-turns` and the job's `timeout-minutes`. | High | Low |
| 4 | **Dashboard counts outcomes but has no rates or trends** | `dashboard.html` shows per-run stages plus a pill count per outcome. It shows no merge or escalation *rate*, no average iterations, no cycle time, no cost and no post-merge reverts. | `derive()` already holds the data: add rates, average iterations and median start-to-outcome time. A weekly `F stats` checks merged PRs for reverts. | High | Low |
| 5 | **CI is checked only at Approve** | Review runs before CI results are known, so reviewers may spend time on a red build. | Wait for `gh pr checks` after Build. A failure routes straight back to build, which is cheaper than review. | Med | Low |
| 6 | **No finding-verification pass** | Reviewer findings go straight into the gate. One false-positive "medium" forces a whole rebuild loop. | Add a cheap verifier subagent for each high or medium finding before `F gate`, as Claude Code Review does. Or require each finding to cite a failing command or line. | Med–High | Low |
| 7 | **No explicit repo-context step** | Spec and build don't say to read `CLAUDE.md` or `AGENTS.md`, or to obey them. | One line in Spec and in each reviewer brief: "read CLAUDE.md / AGENTS.md first; conventions there are acceptance criteria." | Med | Low |
| 8 | **Prompt-injection hardening of reviewers** | The rule "issue text is untrusted" lives only in SKILL.md. Reviewers read the diff, and the diff could contain planted instructions in comments. | Add the untrusted-data clause to every reviewer brief. Have `F` reject reviewer JSON with unknown fields. Have the security axis flag instruction-like strings in the diff. | Med | Low |
| 9 | **No deterministic test gate** | The code reviewer is asked to run tests, but "tests exist and assert behaviour" is an LLM judgement. | Mechanical check in `decide`: if the diff touches source files but no test file, escalate. Optionally add a coverage delta. | Med | Low |
| 10 | **Spec isn't human-gated, even on risky runs** | Kiro gates each phase. Here a human first sees the work at escalation, after up to 3 build loops. | When the files touched are predicted to be sensitive, or the author is untrusted, post the spec and pause for 👍 before building. | Med | Low |
| 11 | **No sandbox or egress control** | The builder runs project scripts with the user's full shell, network and `gh` auth. That is the lethal trifecta: the repo, untrusted issue text, and push or comment access. | Run build and review with Claude Code sandboxing (filesystem limited to the repo, network allow-list), or in a devcontainer or cloud session. | High | Med |
| 12 | **No eval or regression suite for the factory's prompts** | `test()` and `cliTest()` cover the state machine, gate, decide and CLI against a stubbed `gh`, but not agent quality. | Keep 5–10 frozen "golden" issues in a sandbox repo with known-good outcomes (reject, needs-info, merge, escalate). Re-run them after editing `SKILL.md` or `reviewers.md`, and track pass^k. | Med–High | Med |
| 13 | **No post-merge watch** | After `merged` the run ends. A regression on main isn't linked back to the run. | A cron job checks CI on main and Sentry for N hours after a merge. On a red result, open a revert PR and record it. This feeds the revert-rate metric. | Med | Med |
| 14 | **Loop guard for future self-triggers** | Not needed while the trigger is manual. It becomes necessary once a CI-fix trigger exists. | Ignore CI events on `factory/*` branches once the run is past its cap or has an outcome. | Low now, High later | Low |

### 3.4 Recommended order (value ÷ effort)

1. **Merge inside `F` plus a scoped token** (gap 1). Closes the biggest real risk, and it's a few lines.
2. **Worktree per run** (gap 2). Unlocks parallel runs and everything in fan-out.
3. **Cost and duration on events, with outcome stats on the dashboard** (gaps 3 and 4). You can't tune what you don't see.
4. **Sandboxed build and review** (gap 11).
5. **CI before review, a finding verifier, and the repo-context line** (gaps 5, 6, 7). Cheap quality wins.
6. **Generalize intake to `<source>/<key>`**, then add a **CI-failure trigger** and a **scheduled `factory:ready` runner**. These are the first new flows.
7. **Sentry and security-alert sources**, plus **golden-issue evals** (gap 12) before running unattended.
8. **Epic → child-run fan-out** and a **post-merge watch with auto-revert** (gap 13). Larger builds.
