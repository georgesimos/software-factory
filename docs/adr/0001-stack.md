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
- **Minimum Node: 24.12.** That is where type stripping became stable in the 24 line. It has been on by default since 23.6 and 22.18, with no warning since 24.3. Node 24 is Maintenance LTS and Node 26 is Active LTS (since 2026-10-28). CI tests both. Each Node package declares the minimum in `engines`, and `F` checks it at start-up with a clear message.
- **Type stripping never applies under `node_modules`.** A pnpm workspace link resolves to its real path, so it is stripped. But a packaged Electron app copies packages into `node_modules`, so `apps/desktop` bundles its main process with Vite instead of relying on stripping.
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
- The skill's shell snippets in `SKILL.md` stay POSIX shell.
- On Windows, Claude Code uses Git Bash for its Bash tool when Git for Windows is installed. Without it, Claude Code falls back to a PowerShell tool.
- The factory already needs git, so the Windows requirement is **Git for Windows**, which gives Claude Code its Bash tool and gives `localChecks` its `sh`. `F onboard` checks for it.

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
| Claude Code | In-process | The Claude Agent SDK for TypeScript, `@anthropic-ai/claude-agent-sdk`, through `query()`. It ships its own Claude Code binary and runs it as a subprocess, so "in-process" means one Node API, not one OS process. |
| Claude Code | Open in an app | Documented routes:<ul><li>`claude-cli://open?cwd=…&q=…` opens a new terminal session, on macOS, Windows and Linux once the handler is registered;</li><li>`claude --desktop` opens the desktop app;</li><li>`claude://code/new` opens Desktop's new-session page, documented only for SSH folders.</li></ul> Opening an **existing** desktop session by its `claude://claude.ai/epitaxy/local_<id>` link is **observed, not documented**. Treat it as best-effort and fall back to `claude --resume <id>` in a terminal. |
| Codex | Headless | `codex exec --json` (JSONL events), with `--sandbox read-only` or `workspace-write`, `--output-schema`, and `codex exec resume`. |
| Codex | Long-lived session | `codex app-server`, which drives the VS Code extension: JSON-RPC 2.0 messages, without the `jsonrpc` field, as JSONL over stdio. It is documented, but `codex --help` in 0.141.0 still labels it `[experimental]`, so pin the version and generate the protocol types with `codex app-server generate-ts`. |
| Codex | In-process | The Codex TypeScript SDK, `@openai/codex-sdk`: `new Codex().startThread().run()`. It spawns the `codex` CLI and exchanges JSONL with it. |

**Rules carried over from today's harness code:**
- argv only, never a shell;
- review and verifier runs are read-only;
- never `--dangerously-bypass-approvals-and-sandbox`;
- budget flags come from `F`.

`node-pty` and the SDKs are dependencies of `apps/desktop`, which hands them to the session runner (`packages/adapters/sessions.mjs`, through the server's `hostModules`). `adapters` stays dependency-free and otherwise imports them lazily by name, so `F` itself stays zero-dependency. Decided in H1 (#79): the Agent SDK pulls a 361 MB platform binary into every install, and pnpm 10 blocks `node-pty`'s build script unless the root config allows it.

`node-pty` notes:
- It is an N-API native module, so one build works in Node and in Electron.
- On Windows it uses ConPTY and needs Windows 10 1809 or later.
- npm ships prebuilds for macOS and Windows only. Linux compiles it from source, which needs a C++ toolchain, so the desktop build for Linux needs one too.

Both harnesses now install natively on Windows:
- Claude Code: `irm https://claude.ai/install.ps1 | iex`, which installs `claude.exe`.
- Codex: its own PowerShell installer, or npm, which installs a `.cmd` shim (see the audit, §1).

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
- Node 24.12 becomes a hard requirement. Today any Node with ESM works.
- `apps/desktop` carries the native and SDK dependencies (`node-pty`, the Agent SDK, the Codex SDK). `core`, `cli`, `server` and `adapters` stay dependency-free.

## Verification

Checked on 2026-11-22. "Local" means it was run on this machine; a URL means the current docs.

| Claim | Source | Result |
|---|---|---|
| Type stripping: on by default since 23.6 / 22.18, no warning since 24.3, stable since 24.12 / 25.2; erasable syntax only; tsconfig ignored; explicit `.ts` extensions; refused under `node_modules` | https://nodejs.org/api/typescript.html; local `node v24.11.1` runs `.ts` with no warning and rejects `enum` | Confirmed |
| A pnpm workspace link (a symlink) is stripped, because its realpath is outside `node_modules` | Local test on 24.11.1. The docs say nothing about it. | Observed |
| Node 24 is Maintenance LTS and Node 26 is Active LTS (since 2026-10-28) | https://github.com/nodejs/Release (`schedule.json`) | Confirmed |
| Electron 45.4.1 (stable) bundles Node 24.22.3. Type stripping is on, but `enum` and `namespace` need a compiler | https://releases.electronjs.org/releases.json; electron `docs/breaking-changes.md` | Confirmed |
| `claude -p --output-format stream-json` requires `--verbose`; `--input-format stream-json`; `--resume <id>` | https://code.claude.com/docs/en/cli-reference, /headless; local Claude Code 2.1.304 prints "requires --verbose" | Confirmed |
| Agent SDK: `@anthropic-ai/claude-agent-sdk`, `query()`, Node 18.14+, bundles and spawns a Claude Code binary | https://code.claude.com/docs/en/agent-sdk/typescript | Confirmed |
| Windows: Git for Windows is optional (Git Bash if present, otherwise a PowerShell tool); `install.ps1` installs `claude.exe` | https://code.claude.com/docs/en/setup | Confirmed |
| `claude-cli://open` (`q`, `cwd`, `repo`) registers on macOS, Windows and Linux | https://code.claude.com/docs/en/deep-links | Confirmed |
| `claude://code/new` (SSH only) and `claude --desktop` are documented; `claude://claude.ai/epitaxy/local_<id>` is not | https://code.claude.com/docs/en/desktop | Not documented: observed in this project's sessions (#26) |
| `codex exec` with `--json` JSONL events, `--sandbox`, `--output-schema`, `exec resume` | https://learn.chatgpt.com/docs/non-interactive-mode; local codex-cli 0.141.0 | Confirmed |
| `codex app-server`: JSON-RPC over stdio JSONL, used by the IDE extension | https://learn.chatgpt.com/docs/app-server; local `codex --help` labels it `[experimental]` | Confirmed |
| Codex SDK `@openai/codex-sdk` wraps the CLI; Codex is Rust; Windows is native (sandboxed), with WSL optional | https://learn.chatgpt.com/docs/codex-sdk, /docs/windows/windows-sandbox; github.com/openai/codex | Confirmed. The repo's `install.md` still says WSL2. |
| node-pty: ConPTY on Windows 10 1809+, N-API, prebuilds for macOS and Windows only | https://github.com/microsoft/node-pty | Confirmed |
| Since 18.20.2 / 20.12.2 / 21.7.3, `spawn` of `.cmd`/`.bat` without a shell throws `EINVAL`; `execFile` cannot launch them; `shell: true` with args is deprecated (DEP0190) | https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2, https://nodejs.org/api/child_process.html | Confirmed |

The OpenAI Codex docs moved from developers.openai.com to learn.chatgpt.com (308 redirect).
