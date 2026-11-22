# Cross-platform audit of today's code

Status: audit only, nothing fixed yet (2026-11-22). The fixes are steps in [split.md](split.md#cross-platform-fixes).

All line numbers are from commit `b9f4e87` (`main`). They will drift as the split moves code, so each fix issue should search for the code again by its text.

**Method:**
- I grepped `packages/factory`, `packages/ship`, `scripts/`, `README.md`, the adapter READMEs and `templates/*.json` for:
  - process spawns;
  - shell use;
  - POSIX paths and separators;
  - `HOME` and `PATH` handling;
  - symlinks;
  - URL handlers and `open`;
  - shell quoting.
- I then read each hit.

**Out of scope:** `packages/design-system` and `apps/playground`. They are browser code. Their `/Users/...` paths are display fixtures only.

**Ratings:**
- **Breaks:** fails or misbehaves on Windows.
- **Degrades:** works, but worse or with a wrong hint.
- **OK:** checked, and already portable.

## 1. Spawning processes

On Windows, `execFileSync('x')` with no shell finds only `x.exe`.

Since the April 2024 security releases (CVE-2024-27980; Node 18.20.2, 20.12.2 and 21.7.3), `spawn` of a `.cmd` or `.bat` file without a shell throws `EINVAL`, and `execFile` cannot launch one at all. npm, pnpm, yarn and npx are `.cmd` shims on Windows, and so is any CLI installed with `npm i -g` (Codex included).

| Where | What | Rating |
|---|---|---|
| `factory.mjs:919` (`deps` → `sh()`) | `pnpm`, `npm` and `yarn` are spawned bare. | Breaks: `F deps` cannot install on Windows. |
| `project.mjs:156` (`sh()`) and `templates/next-web.json:8` | Runs the stack template's `init` argv (`npx --yes create-next-app@15 …`) with no shell. | Breaks: `F new` cannot scaffold on Windows. |
| `factory.mjs:1235` (`evals`) | `claude -p …` is spawned bare. | OK with Claude Code's native installer (`install.ps1` installs `%USERPROFILE%\.local\bin\claude.exe`). Breaks with an npm-installed `claude.cmd`. |
| `harnesses/claude-code.mjs:9`, `harnesses/codex.mjs:9`, `harnesses/_template.mjs:9` | `spawnSync('claude' \| 'codex' \| BIN)` detects installs and logins. | Degrades: a `.cmd` install reports as "not installed". `codex` from `npm i -g @openai/codex` is a `.cmd` shim. |
| `packages/ship/ship.mjs:14` (`exec`) | A connector's CLI is spawned bare. | Breaks for any npm-installed provider CLI, such as `vercel` or `eas`. `gh` is a `.exe`, so it is OK. |
| `factory.mjs:814`, `:858` (`gh`, `git`) | Spawned bare. | OK: both are `.exe`. |

**Fix shape:**
- Add one `platform.exec()` that every caller uses. It still uses no shell.
- On Windows it resolves the command through `PATH` and `PATHEXT`:
  - an `.exe` runs directly;
  - a `.cmd` shim runs through `cmd.exe /d /s /c` only when every argument passes a strict metacharacter-free check, and otherwise fails with a clear message;
  - never `shell: true`, which is deprecated with arguments (DEP0190).
- Do not hand-roll `cmd.exe` escaping. Mistakes there are command injection, and prompts and JSON schemas are passed as arguments.

**Done in X1 (#49):**
- `core/src/platform.ts` holds `command()`, `exec()` and `run()`. `gh`, `git`, `deps`, the `F new` init, the `evals` `claude -p` and ship's `exec` all go through it.
- A shim given an argument that isn't plain fails with a message naming that argument. For example, `claude.cmd` with `evals`' prompt fails that way.
- **Still open:** the harness adapters keep `spawnSync`, because a harness file may live in an outside registry folder and imports only `node:` builtins. A `.cmd` Codex still reports as not installed. H1's contract can hand harnesses a spawn function.

## 2. Shells and shell syntax

| Where | What | Rating |
|---|---|---|
| `factory.mjs:1125` (`localChecks`) | `execFileSync('/bin/sh', ['-c', cmd])` runs the `checks.commands` rule. | Breaks: Windows has no `/bin/sh`. |
| `factory.mjs:933` (`deps`) | `cp -cR` on macOS (APFS clonefile) or `cp -R --reflink=auto` elsewhere copies `node_modules` copy-on-write. | Degrades. On Windows there is no `cp`, so the `catch` falls back to a full install, which is correct but slow. On Linux without reflink support, `cp --reflink=auto` makes a **full copy**, which is slow and uses disk. On BSD `cp`, `--reflink` is rejected and the code falls back to install. |
| `package.json:10` (`packages/factory`) | `"test": "env -u CLAUDE_CODE_SESSION_ID node factory.mjs test"`. | Breaks: `pnpm test` on Windows runs scripts in `cmd.exe`, which has no `env`. |
| `scripts/scrub-factory.sh` | A POSIX `sh` script. | Degrades. It is a one-off maintenance script, so it is fine to leave POSIX-only and say so. |
| `README.md:19` | `FACTORY_DIR=$(mktemp -d) node … demo`. | Degrades: this is POSIX shell syntax. `F demo` already makes its own temp directory when `FACTORY_DIR` is unset (`factory.mjs:2521`), so drop the prefix. |
| `SKILL.md` (heredocs `<<'JSON'`, `$(F dir RUN)`, `\| tail -n 80`, `for l in …; do …`) | The orchestrator's shell snippets. | OK on macOS and Linux. On Windows they need Git Bash: Claude Code uses it when Git for Windows is installed, and otherwise falls back to a PowerShell tool, where these snippets break. The ADR makes Git for Windows a requirement, and `F onboard` should check for it. |
| zsh | No zsh syntax or zsh assumptions were found in code or docs. | None found. |

**Fix shape:**
- **`localChecks`:**
  - On Windows, run the rule's commands through the same POSIX shell Claude Code uses (Git Bash's `bash.exe`) when one is found.
  - Otherwise refuse, with a message that names the missing shell.
  - Never fall back to `cmd.exe`, because the commands are written for `sh`.
- **`deps`:** use `fs.cpSync(src, dst, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true })`:
  - it clones on APFS (macOS) and on btrfs and XFS (Linux);
  - it falls back to a plain copy elsewhere;
  - it needs no `cp`.
  
  Skip the copy on Windows and on non-reflink filesystems, where a full copy is slower than `pnpm`'s hard links. Install there instead.
- **`env -u`:** delete it, and add `delete process.env.CLAUDE_CODE_SESSION_ID` at the top of `test()`. The repo-setup hand-over already proposed this.

## 3. Paths, home directory and separators

| Where | What | Rating |
|---|---|---|
| `factory.mjs:445` (`checkRunner`) | A brief runner's `path` must match `^(\/\|~\/).*\.md$`. | Breaks: `C:\…` and `~\…` are rejected, so no brief runner can be set on Windows. |
| `factory.mjs:519` (`tilde`) | Builds `~` + the rest of the path with the OS separator, which gives `~\…` on Windows. That value then fails the check above. | Breaks, together with `:445`. |
| `factory.mjs:549`, `:556` | Briefs are offered only if their absolute path matches `^[^'"\s]+$`. | Degrades: on every OS, a home directory with a space hides every brief (`C:\Users\Jane Doe\…` on Windows, and some macOS accounts). |
| `factory.mjs:1306` (`F_CMD`) | `node ~/.claude/skills/software-factory/factory.mjs` is printed in `F onboard` hints. | Degrades: neither `cmd.exe` nor PowerShell expands `~` inside an argument passed to `node`. Print the real absolute path. |
| `factory.mjs:1307` (`shq`) and `dashboard.html:980` (`shq`), `:982–986` (`resumeCmd`) | POSIX single-quote escaping in the commands we print, and `cd '…' && claude --resume`. | Degrades: Windows PowerShell 5.1 has no `&&`, and `'\''` is not how PowerShell escapes. The commands are copy-paste hints, not executed, so this is not a security issue. Better: when served by `F ui`/Electron, buttons call the API (#27) instead of copying a shell line. |
| `dashboard.html:1000` (`deepCwd`) | "Open in Claude" requires `^/(?!/)`. | Degrades: drive paths such as `C:\…` never get the button. |
| `factory.mjs:962` (`SKIP_DIRS`) | Skips the macOS folders `Library`, `Applications`, `Pictures`, `Music` and `Movies` while discovering clones. | Degrades: on Windows it walks `AppData` (large and slow). Add `AppData` and `OneDrive`. |
| `project.mjs:68` (`relPath`) | Planned issue files are validated with `/` only. `C:\x` and `..\x` pass. | Degrades. `files` is plan metadata used only for `willEscalate()`. A backslash path such as `src\auth\x.ts` is not matched by `SENSITIVE` and is under-reported at batch approval. The real gate uses `git diff` names, which always use `/`. Reject `\` and drive prefixes. |
| `harnesses/claude-code.mjs:67` | Finds a clone's sessions under `~/.claude/projects/<path with non-alphanumerics replaced by ->`. | Unverified on Windows. Check Claude Code's folder name for `C:\…` against a real install before relying on session import there. |
| `factory.mjs:55` (`sensitive`), `factory.mjs:984`, `codex.mjs:12` | Use `/` on git paths and remote URLs. | OK: git always reports `/`. |
| `factory.mjs:69` (`runDir`) | Run ids become folder names, with every non-alphanumeric character replaced by `-`. | OK: `:` and `#` never reach the file system. |
| `/private/tmp` | No hard-coded `/private/tmp` or `/tmp` path was found in code. | None found. The self-test uses `os.tmpdir()`. On macOS that path's realpath is under `/private/var/…`, so any new test that compares a temp path with a path git printed must `realpathSync` both. |

## 4. Symlinks and install

| Where | What | Rating |
|---|---|---|
| `README.md:25` | `ln -s "$PWD/packages/factory" ~/.claude/skills/software-factory`. | Breaks on Windows: a symlink needs Developer Mode or admin rights. |
| `factory.mjs:2388`, `ship.mjs:85` (`isMain`) | `fs.realpathSync(process.argv[1])` is compared with the module's own path. | OK. Node resolves the main module's symlink, so this also works through a link or a junction. |

**Fix shape:** add `F install-skill`, which creates the skill link itself:
- `fs.symlinkSync(target, link, 'junction')` on Windows: a directory junction, no admin needed;
- a normal symlink elsewhere.

Document it as the one install step. **Never copy** the skill folder: the [split plan](split.md#how-the-thin-entry-reaches-the-packages) relies on relative imports from `packages/factory` into the sibling packages.

## 5. Opening things: URLs, files, apps

| Where | What | Rating |
|---|---|---|
| `SKILL.md:199` | "On the first run, open the dashboard with `open`." | Breaks on Windows (`start`) and Linux (`xdg-open`). |
| `harnesses/claude-code.mjs:59–60` (`notes`) | The `claude-cli://` handler check runs on macOS only (`~/Applications/Claude Code URL Handler.app`). Elsewhere it returns `ok: null`. | Degrades, but fails safely ("unknown"). The handler is documented on Windows and Linux too, so add their checks. |
| `harnesses/claude-code.mjs:40` | The install hint is `curl … install.sh \| bash`. | Degrades: Windows needs `irm https://claude.ai/install.ps1 \| iex`. |
| `harnesses/codex.mjs:17` | The install hint is `npm install -g @openai/codex`. | Degrades: on Windows it installs a `.cmd` shim (see §1). Codex's PowerShell installer is the better hint there. |

**Fix shape:**
- Add `F open [dashboard|url]`, backed by `platform.open()`:
  - `open` on macOS;
  - `cmd /c start "" <url>` on Windows, after validating that the target is an `https:`, `file:` or `claude-cli:` URL;
  - `xdg-open` on Linux.
- Change `SKILL.md` to say `F open dashboard`.
- Make install hints per-OS.

## 6. Tests

| Where | What | Rating |
|---|---|---|
| `factory.mjs:1857`, `:1872`, `:1891`, `:1915` and `test/onboard.e2e.cjs:20` | Test `PATH`s are joined with `:`, and the e2e appends `/usr/bin:/bin`. | Breaks on Windows. Use `path.delimiter`. |
| `factory.mjs:1915`, `:1962`, `test/project.mjs:54` and `onboard.e2e.cjs:16` | The tests fake the home directory with `HOME`. | Breaks on Windows: `os.homedir()` reads `USERPROFILE` there, so the tests read the real home. Set both variables. |
| `test/bin/claude`, `test/bin/codex`, `test/gh-stub.mjs`, `test/git-stub.mjs`, `test/gh-project-stub.mjs`, and the `fake-agent` the test writes at `factory.mjs:1889` | Stubs are executed directly through their `#!/usr/bin/env node` shebang and the executable bit. | Breaks on Windows: a shebang does nothing there. Each stub needs a `.cmd` twin (`@node "%~dp0claude" %*`), or the overrides need to accept `node <stub>`. |
| `factory.mjs:2322` | `deps` asserts "cloned copy-on-write" on macOS only. | OK as written; keep it per-OS when the clone logic changes. |

**There is no CI**, so none of this can be caught today: the repo has no `.github/workflows`. The first fix step adds a Linux, macOS and Windows matrix, which makes this audit enforceable.

## 7. Already portable

- Every spawn uses `execFileSync` or `spawnSync` with an argv array. The only shell is the deliberate `/bin/sh` in `localChecks`.
- `F ui` binds `127.0.0.1` and checks `Host`, `Origin` and a token, on every OS.
- `path.join` and `path.resolve` are used for state paths, and `path.isAbsolute` in `/onboard/sync`, so drive-letter paths work.
- `.git/config` parsing, `runDir` and the JSONL log read and write LF-only files written by the factory itself. `SKILL.md` front-matter parsing already accepts `\r\n` (`factory.mjs:515`).
