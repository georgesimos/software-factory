# Plan: the Ship harness (deploys, app stores, databases) and onboarding

Status: phase 0 built in `packages/ship` (2026-11-22); phases 1–5 are still a proposal.

This changes an earlier decision. "No third-party integrations yet" was right while the core loop was being built. This plan adds integrations behind one adapter contract, read-only first, so the core loop stays safe.

## 1. Why a separate harness

The **build harness** (`packages/factory`) turns an issue into a reviewed, merged commit. Everything it does is reversible inside git.

Shipping is a different job:
- it talks to outside platforms (Vercel, Expo/EAS, App Store Connect, Google Play, Neon);
- it uses long-lived credentials;
- some actions are public and hard to undo, such as a production deploy, a store submission or a database migration.

Keeping it separate means:
- **Different trust.** The build harness never holds platform credentials. Ship reads status with the provider's own CLI login, and asks a human before anything public.
- **A different view.** Build is about runs (issue → PR). Ship is about **environments and releases** per project: preview, staging, production, TestFlight, store, database branches.
- **It's optional.** A library repo never needs it.

Ship still writes through `factory.mjs`'s `record()` (imported as a library), so there is still one writer, one event log and one dashboard data feed.

```
packages/
  factory/        build harness (unchanged contract)
  ship/           NEW: @software-factory/ship
    ship.mjs      CLI "S": detect, connect, status, watch, preview-url, promote
    connectors/
      github-deployments.mjs   zero-credential baseline
      vercel.mjs
      neon.mjs
      expo.mjs                 EAS build / update / submit
      appstore.mjs             App Store Connect (via EAS submit or an ASC API key)
      play.mjs                 Google Play (later)
  design-system/  + EnvironmentCard, DeploymentRow, ReleaseTrack, DbBranchList, ConnectorCard, Stepper
apps/
  desktop/        (planned Electron app) gets a "Ship" view next to "Build"
```

## 2. The connector contract

Each connector is a small module with the same shape:

```js
export default {
  id: 'vercel',
  kind: 'web-deploy' | 'mobile-build' | 'store' | 'database',
  detect(repoPath),       // true if the project uses it: vercel.json/.vercel, app.json+eas.json, NEON in .env.example, ...
  auth(),                 // { ok, how }: checks the provider CLI login (vercel whoami, eas whoami, neonctl me); never stores secrets
  status(project, ref),   // normalized: [{ env, state, url, sha, at, detail }]
  actions: { ... },       // e.g. createBranch, promote, submit. Each one is tagged read | write | public
}
```

**Normalized states:**

| kind | states |
|---|---|
| web-deploy | `queued`, `building`, `ready`, `error`, `canceled`, plus `promoted` for production |
| mobile-build | `queued`, `building`, `finished`, `errored` |
| store | `processing`, `testflight`, `in-review`, `rejected`, `approved`, `released` |
| database | `branch-created`, `migrated`, `migration-failed`, `deleted` |

These are recorded as `ship` events, for example `{run|project, stage:'ship', status:'ready', connector:'vercel', env:'preview', url, sha}`. `connector`, `env`, `url` and `sha` are **typed fields set by the connector**, never taken from a payload, the same rule as `association`/`sessionId` today.

**Credentials:**
1. The provider's own CLI login comes first: `vercel login`, `eas login`, `neonctl auth`. The factory never sees the token.
2. If an API key is unavoidable (an App Store Connect `.p8` key), it goes in the macOS Keychain (`security add-generic-password`) and is referenced by name in `connections.json`.
3. Secrets never go in `events.jsonl`, the dashboard, or a repo.
4. The factory never creates accounts. Creating a project on a platform (a Vercel project, a Neon project, an EAS project) is an outward action that needs one confirmation during onboarding.

## 3. What each connector does

### 3.0 GitHub Deployments (phase 0, no new credentials)
Vercel, Netlify, Render and others post **GitHub Deployments and deployment statuses** for every preview and production build.

- **Read:** `gh api repos/{o}/{r}/deployments?sha=...` plus `/statuses`. This gives the preview URL and ready/error state per PR head SHA, and the production state per merge SHA.
- This alone gives the dashboard a deploy column and the gate a "preview ready" signal.

### 3.1 Vercel (web)
- **Detect:** `vercel.json`, `.vercel/project.json`, or a Next.js app plus a GitHub deployment from `vercel[bot]`.
- **Read:** `vercel ls --json`, `vercel inspect <url>`, build logs (`vercel logs`/`inspect --logs`). The CLI flags need checking during implementation.
- **Uses in the pipeline:**
  - **Build-error feedback:** a preview build that errors after CI passed loops back to `build`, with the log tail as a finding.
  - **Preview URL to reviewers:** the ux, ui and seo reviewers run Playwright against the preview (screenshots at 375/1280 px, Lighthouse-style checks). That beats reviewing a diff.
  - **Policy rule** `deploy.preview: required | advisory | off`: when required, `decide()` needs `ready` on the reviewed SHA.
  - **Postmerge:** watch the production deployment for the merge SHA. If it fails, use the existing revert path. Promoting or rolling back production is always a human action, or one behind an explicit rule.

### 3.2 Neon (database)
- **Detect:** `DATABASE_URL` pointing at `*.neon.tech` in `.env.example`, `drizzle`/`prisma` config, or a user choice in onboarding.
- **Branch per PR:** create a Neon branch `factory/issue-N` from `main` when the build starts, inject its connection string into the worktree's `.env.local` (git-ignored), run migrations and tests against it, and delete it when the run ends. Neon's Vercel integration can also create preview branches itself; if that's present, read it instead of duplicating it.
- **Migrations:** migration files are already SENSITIVE, so the run escalates. Ship adds evidence for the human reviewer: "migration applied cleanly on branch X, schema diff attached" (the Neon API can compare schemas between branches).
- **Never** touch the production branch automatically.
- **Auth:** `neonctl` login or a Neon API key in the Keychain. During development the Neon MCP server can be used interactively, but the connector uses the CLI/API so it runs headless.

### 3.3 Expo / EAS (mobile builds and OTA updates)
- **Detect:** `app.json`/`app.config.*` with `expo`, plus `eas.json`.
- **Read:** `eas build:list --json --non-interactive` (status, platform, profile, gitCommitHash, artifacts), and `eas update:list --json`.
- **Uses in the pipeline:**
  - **Preview builds:** a rule can ask for an EAS `preview` build or an EAS Update channel per PR. Reviewers get a QR code or install link in the run detail.
  - **Gate signal:** `mobile.build: required` means the build for the reviewed SHA must be `finished`.
  - **Postmerge:** an optional production build. **Store submission is never automatic.** `eas submit` is a "public" action that needs a human click.

### 3.4 App Store Connect / Google Play (store state)
- **Read** through EAS Submit's status, or directly through the App Store Connect API (an API key in the Keychain): TestFlight build processing, review state, released version.
- **Release track view:** build → TestFlight → in review → approved → released. Rejections show the reviewer's message as an escalation.
- Google Play follows the same shape later, through the Play Developer API.

## 4. Where it shows up

- **The Build view** (today's board) gains small chips only: "Preview ready ↗", "EAS build ✓" and "DB branch" on run cards. The run detail gets a "Deploy" section with the preview URL, build log tail, QR code and Neon branch.
- **The new Ship view**, per project:
  - **Environments:** preview, staging, production cards with the current SHA, state, URL and time.
  - **Deployments timeline**, linked back to the run or PR that produced each one.
  - **Mobile release track** per platform.
  - **Database branches:** what exists, which run owns it, age, cleanup state.
  - **Connector health:** logged in or not, last check, rate-limit status.
- **Data path:** the static `dashboard.html` gets a `ship` block in `__FACTORY_DATA__`. In the planned Electron app, `F serve` streams ship events over SSE like the others.

## 5. Onboarding (the wizard, extended)

1. **Local AI.** Detect `claude` and `codex` and their login state (`claude --version`, `codex --version`, `codex login status` if available). Pick the default harness per stage (PR #2 runners).
2. **Repo.** Pick from `F discover`, **or** create one (the idea-to-app flow: `gh repo create --private` under the existing login, confirmed once), **or** clone.
3. **Stack and targets.** Pick what you ship: Web (Vercel), Mobile (Expo/EAS → App Store / Play), API only, and Database (Neon, or none). This is detected when the repo exists, and chosen when it's new.
4. **Connect.** One `ConnectorCard` per target:
   - check the CLI login, or show the exact login command (`vercel login`, `eas login`, `neonctl auth`);
   - link or create the platform project after one confirmation;
   - run a "test connection" read.
5. **Workflow.** Choose the runner per stage and review axis (PR #2).
6. **Rules.** CI required, advisory or skip, with local check commands (PR #4); `deploy.preview`, `mobile.build`, `db.branchPerPR`; auto-merge; guidance text.
7. **Review and start.** Show the resolved plan (`F skills`, `F rules`, `S status`). Offer to run the first issue, or to start from an idea.

The same steps are available as a CLI (`F onboard`). The UI writes only through the token-protected `F ui` endpoints, using the same validated functions.

## 6. Safety rules for Ship (none of them configurable)

| Action | Policy |
|---|---|
| Read status or logs | automatic |
| Create a Neon branch or a preview build for a factory run | automatic, once the project's rule allows it; cleaned up at the end of the run |
| Create a platform project (Vercel, Neon, EAS) | one human confirmation, in onboarding |
| Promote to production, or roll back production | human only, or an explicit per-project rule. Never on an untrusted run |
| Store submission or release | human only |
| Production database migration | human only. Ship only provides evidence |
| Create accounts | never |

## 7. Phases

| Phase | Scope | New credentials | Done when |
|---|---|---|---|
| **0** | `packages/ship` skeleton, connector contract, the **GitHub Deployments** connector, `ship` events, chips plus a Deploy section in run detail, `deploy.preview` rule | none | Euporia's Vercel previews show on runs, and the gate can require "preview ready" |
| **1** | Vercel connector: logs → build loop-back, preview URL → Playwright ux/ui/seo reviewers, production watch → revert | Vercel CLI login | a broken preview build loops a run back with the log as a finding |
| **2** | Onboarding wizard (steps 1–7) and the Ship view in `dashboard.html` | — | a new user goes from zero to a first run with no CLI knowledge |
| **3** | Neon: branch per run, `.env.local` injection, migration evidence, cleanup | Neon login or key | migrations are tested on a branch; branches never leak |
| **4** | Expo/EAS: build status, preview builds with QR codes, update channels; App Store / TestFlight state | EAS login, an ASC key (optional) | the mobile release track renders for an Expo repo |
| **5** | Idea-to-app (see the session brief) using all of the above, then the Electron app's Ship view over `F serve` | — | "factory new: a budget app" ends with merged issues and a live preview URL |

Phases 0 and 1 are the best value. They need no or one credential, and they turn the ux/ui reviews from "read the diff" into "look at the running app".

## 8. Decisions (agreed 2026-11-22)

1. Ship is a separate package (`packages/ship`, CLI `ship.mjs`), with `F ship ...` as a thin alias.
2. For Euporia, production watch follows whatever actually deploys production. Check this in phase 1: Vercel from `main`, or `deploy-prod.yml` with tags.
3. Mobile is Expo/EAS only for now. A bare Xcode project would be one more connector later.
4. The macOS Keychain is acceptable for keys that have no CLI login, such as the ASC `.p8` key.
5. **Start minimal, and make every feature pluggable.** Each provider family has a registry that auto-loads one file per provider, a `_template.mjs`, a recipe doc and a shared contract test that runs against every provider. The core never names a specific provider. The families:
   - Ship connectors;
   - AI harnesses (Claude Code, Codex, ...);
   - repo hosts (GitHub, ...);
   - trackers (GitHub Issues, then Jira or Linear);
   - stack templates, which are data files.

   Every family's tests add a fake extra provider as one file, to prove that no core change is needed.

First three pieces of work, all minimal and all built on PR #4:
- Ship phase 0: the connector registry plus GitHub Deployments, and the `deploy.preview` rule;
- the onboarding wizard with pluggable harness adapters;
- idea-to-app, with pluggable repo-host and tracker adapters, stack templates, and a `--dry-run` example.

## 9. To verify during implementation

These are assumed from memory and must be checked before coding:
- the exact `vercel` CLI JSON flags and log commands;
- the `eas build:list --json` field names;
- `codex login status`;
- the Neon schema-diff API;
- the App Store Connect review-state field names.
