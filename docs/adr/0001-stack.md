# ADR 0001: Stack for the next architecture

- **Status:** proposed (2026-11-22), for the owner to accept.
- **Deciders:** the owner, whose decisions on 2026-11-22 are below.
- **Plan:** [docs/plans/split.md](../plans/split.md)
- **Audit:** [docs/plans/cross-platform-audit.md](../plans/cross-platform-audit.md)

## Context

The Software Factory is a Claude Code skill (`SKILL.md`) plus `F`, a single zero-dependency Node file:
- `packages/factory/factory.mjs`, 2,575 lines including its self-test;
- `project.mjs`, 362 lines;
- a single-file `dashboard.html` of 1,760 lines.

The owner considers big single files an anti-pattern.

`packages/design-system` (React 19, TypeScript, Vitest) already has the factory views: RunCard, StageTrack, Timeline, ReviewMatrix, Sessions and CommandMenu. [docs/research/tauri-vs-electron.md](../research/tauri-vs-electron.md) chose Electron.

The owner decided on 2026-11-22:
- TypeScript is fine, unless another language is clearly better.
- No hosted backend for now. A local backend process talks to the file system and the PC.
- The logic must be cross-platform.
- Keep both the Claude-app flow (the skill) and the Electron app.
- Launch Claude Code or Codex harnesses from the app.

## Decisions

### 1. TypeScript everywhere, run directly by Node

- All new and moved code is TypeScript.
- The Node-side packages (`core`, `cli`, `server`, `adapters`) are **run by Node directly through type stripping, with no build step**. `node packages/factory/factory.mjs` keeps working from a fresh clone with nothing installed.
- **Minimum Node: 24.11** (24 is the current LTS line). Each Node package declares it in `engines`, and `F` checks it at start-up with a clear message.
- **Erasable syntax only.** Node strips types; it does not compile TypeScript. That rules out:
  - `enum`, `namespace` with values, and parameter properties;
  - `import x = require()`;
  - path aliases, because tsconfig is ignored at run time.
  
  Enforce it with `erasableSyntaxOnly`. Imports name the real file (`./derive.ts`), and type-only imports say `import type` (`verbatimModuleSyntax`). The settings are in [split.md §4](../plans/split.md#4-typescript-settings-for-node-run-packages).
- Type-checking is `tsc --noEmit` in `pnpm test` and CI. It is never part of running.
- The browser and Electron-renderer code (`apps/web`, `apps/desktop`) is built with Vite, as `apps/playground` is today.

### 2. The backend is local

- One Node process on the user's machine does all the work: the event log in `~/.claude/factory`, git worktrees, `gh`, and launching Claude Code and Codex.
- The CLI (`F`), `F ui`, Electron's main process and the skill all call the same `core` functions.
- **There is no hosted backend.**
- **The seam for a hosted backend is the `/api/*` layer** from #23 (PR #29): JSON over HTTP, served on loopback with a per-launch token and checks on `Host`, `Origin` and content type. Every UI talks to `core` only through it, except the skill and the CLI, which call `core` in-process. A hosted backend later means serving the same routes elsewhere, plus real authentication. No UI change is needed.

### 3. Cross-platform: Windows, macOS, Linux

- Logic runs on all three.
- OS-specific behaviour lives in one module, `core/src/platform.ts`:
  - spawning CLIs (`.exe` versus `.cmd` shims on Windows);
  - the POSIX shell for `checks.commands`;
  - opening URLs;
  - copy-on-write copies;
  - linking the skill folder.
- Nothing else names an OS.
- CI runs the tests on all three (step X0).
- Today's gaps are listed, with file and line, in the [audit](../plans/cross-platform-audit.md).
- The skill's shell snippets in `SKILL.md` stay POSIX shell. Claude Code's Bash tool provides one on every OS (Git Bash on Windows); see the [verification table](#verification).

### 4. Three UIs over the same local API, one React app

| UI | For | How |
|---|---|---|
| **Electron** (`apps/desktop`) | Launching the factory, watching workflows and sessions, terminals | The main process imports `server` in-process and loads the web build. |
| **`F ui`** in a browser | The same, without installing the app | `server` serves the web build on `127.0.0.1` with a token. |
| **Private claude.ai Artifact** | Phone and web, read-mostly (#18) | A single-file build of the same React app, with the run data injected, published as the owner's private Artifact. |

- **All three are one React 19 app (`apps/web`), built from `packages/design-system`.** Its factory components already exist and take `derive()`'s shapes.
- `dashboard.html` is retired once the web app reaches parity (plan W1–W3).
- Whether a `file://` copy is still needed is an [open question](../plans/split.md#6-open-questions-for-the-owner).

### 5. Launching harnesses from the app

The harness adapter contract (`packages/adapters/harnesses`) gains an optional `launch()`. Each harness offers the modes it supports:

| Harness | Mode | Mechanism |
|---|---|---|
| Claude Code | Interactive terminal | `claude` in a pseudo-terminal through `node-pty` (ConPTY on Windows), shown with xterm.js in Electron. |
| Claude Code | Headless | `claude -p --output-format stream-json --verbose`: NDJSON events. `--input-format stream-json` keeps stdin open for follow-up messages. `--resume <id>` continues a session. The flags are pinned as `headlessArgs()` pins them today (checked against claude 2.1.304). |
| Claude Code | In-process | The Claude Agent SDK for TypeScript, `query()`. |
| Claude Code | Desktop session | Open a Claude desktop Code session by its `claude://claude.ai/epitaxy/local_<id>` link. **Observed, not documented** (see the [verification table](#verification)). Treat it as best-effort: feature-detect it, and fall back to `claude --resume` in a terminal. |
| Codex | Headless | `codex exec --json` (JSONL events), with `--sandbox read-only` or `workspace-write`, `--output-schema`, and `codex exec resume`. |
| Codex | Long-lived session | `codex app-server`: JSON-RPC over stdio. Marked **experimental** in codex-cli 0.141.0. |
| Codex | In-process | The Codex TypeScript SDK. |

**Rules carried over from today's harness code:**
- argv only, never a shell;
- review and verifier runs are read-only;
- never `--dangerously-bypass-approvals-and-sandbox`;
- budget flags come from `F`.

`node-pty` and the SDKs are dependencies of `adapters` only, loaded lazily, so `F` itself stays zero-dependency. `node-pty` is a native module, so Electron needs a matching prebuild or `@electron/rebuild`.

### 6. Why not Rust or Go

**For Rust or Go:**
- a single static binary;
- easy cross-compiling;
- no Node install for end users;
- better raw speed.

The Codex CLI moved to Rust for these reasons.

**Against, for this project:**
- **Electron's main process is Node.** A Rust or Go core would be a second process with its own IPC protocol, or a native addon. Either way the UI and the core would be two languages with a serialization boundary between them.
- **The Claude Agent SDK and the Codex SDK are TypeScript, and `node-pty` is a Node module.** In-process harness control, which the owner asked for, is native only in Node.
- **The skill runs `F` through `node`**, which every Claude Code user already has. A binary would need a per-OS download and signing.
- **It reuses code.** The design system, its model types and the web app are TypeScript, so one language lets `core` export the `Run` shape the UI consumes.
- **The workload is light.** The factory spends its time waiting on `gh`, git and model calls, not on CPU. It does not need Rust's speed.

**Revisit if** the factory has to ship as a standalone binary without Node, or if a CPU-bound part appears, such as large transcript scans. Such a part could become a Rust or Go helper behind `platform.exec()` without changing the architecture.

**Also considered:**
- **Deno or Bun.** Better TypeScript ergonomics, but Electron and Claude Code users already have Node, and both runtimes add a second one.
- **Tauri.** See the existing research. Its webview cannot host `node-pty` or the Agent SDK without a Node sidecar.

### 7. Repo tooling

- Plain pnpm workspaces, as [architecture.md](../architecture.md) records.
- Libraries go in `packages/` and apps in `apps/`.
- Nx is not part of this decision. Whether it stays out is an [open question](../plans/split.md#6-open-questions-for-the-owner).

## Consequences

- `factory.mjs` stays at its path as a thin entry, because `SKILL.md` and every session call it there. It reaches the packages through relative imports, so no install step is needed.
- The skill folder must be a link, never a copy: a symlink on macOS and Linux, a junction on Windows (`F install-skill`).
- The split is about ten move-only PRs, gated by the existing self-test ([split.md §2](../plans/split.md#2-rules-for-every-move-pr)). They escalate to a human merge by design.
- Node 24.11 becomes a hard requirement. Today any Node with ESM works.
- `adapters` gains native and SDK dependencies (`node-pty`, the Agent SDK, the Codex SDK). `core`, `cli` and `server` stay dependency-free.

## Verification

Checked on 2026-11-22. "Local" means it was run on this machine; a URL means the current docs.

| Claim | Source | Result |
|---|---|---|
| Node 24.11 runs `.ts` with no flag and no warning; `enum` is rejected | Local: `node v24.11.1` | Confirmed |
| `claude -p --output-format stream-json` and `--input-format stream-json`, `--resume` | Local: `claude --help`, Claude Code 2.1.304 | Confirmed |
| `stream-json` under `-p` is used with `--verbose` | [docs/research/claude-code-platform.md](../research/claude-code-platform.md) | Confirmed |
| `codex exec` with `--json`, `-s/--sandbox`, `--output-schema`, `resume` | Local: `codex exec --help`, codex-cli 0.141.0 | Confirmed |
| `codex app-server` exists and is `[experimental]` | Local: `codex --help`, codex-cli 0.141.0 | Confirmed |
