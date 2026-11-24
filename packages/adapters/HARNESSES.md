# Add an AI harness in 4 steps

A harness (Gemini CLI, Cursor agent, Aider, ...) is **one file plus its stub binary**. The registry (`harnesses/index.mjs`)
loads every `harnesses/<id>.mjs` (or `<id>.ts`) by itself. The runner validation, the Skills catalog, session import in `F sync`, the event
stamp, the sensitive paths, `F onboard` and the setup wizard all read it, so nothing else in the repo changes.

**`.mjs` or `.ts`.** A harness is `<id>.mjs`, or `<id>.ts` where Node strips types: not under `node_modules`, not in a
`"type": "commonjs"` package, and on a Node with `process.features.typescript` on (Node 24 has it; F refuses a `.ts` file
on a Node without it and says to use `.mjs`). `.mjs` loads everywhere, so it is the safe format for a harness kept outside
this repo. Never keep `<id>.ts` and `<id>.mjs` side by side (a compiled twin): the registry refuses the folder and says to
remove one. `index.*`, `_*` and declaration files (`*.d.ts`, `*.d.mts`) are never loaded.
Node only strips types, it compiles nothing: a `.ts` file must use erasable syntax only (no `enum`, `namespace`,
parameter properties or other TypeScript that emits code; type-only imports as `import type`). The desktop build
would compile those, but F under Node fails on them, naming the file.

1. **Copy the template.** `cp harnesses/_template.mjs harnesses/<id>.mjs`. The `id` must equal the file name without its extension.
   Files starting with `_` are never loaded. Import only `node:` builtins, never `factory.mjs`.
2. **Fill in the contract.** Run the CLI only through `spawnSync` with an argv array and a timeout, on Windows only through the template's `spawnFor()` (an `.exe` or npm `.cmd` shim found on PATH, never a bare name that Windows looks up in the current folder first), and read both streams,
   since some CLIs print status to stderr. `detect()` and `login()` must never throw.

   | field | required | what it is |
   |---|---|---|
   | `id`, `label` | yes | stored in `skills.json` as `{"use":"provider","harness":"<id>"}`; the label is shown in the UI |
   | `install` | yes | the install command the wizard shows when the binary is missing |
   | `detect()` | yes | `{installed, version}` (e.g. from `<bin> --version`) |
   | `login()` | yes | `{ok, hint}`; when `!ok`, `hint` is the login command |
   | `headless()` | no | `{cmd, args, note}`: how the orchestrator runs it unattended (display only) |
   | `headlessArgs(opts)` | no | the host harness only: pinned unattended flags `F headless-args` prints (`{schema, budget, write, model, effort, fallback}`) |
| `providerTools()` | no | `[{name, desc, tool?}]` for the runner picker. The core builds the runner, so a harness can only offer itself. Return `[]` when not installed |
   | `modes`, `launch({mode, prompt, resume, budget, write})` | no | the modes it can start (`headless`, `terminal`, `sdk`) and, for one, `{cmd, args, stdin?}` (`headless`, `terminal`) or `{module, prompt, options}` (`sdk`: the SDK package and its `query()` options). Put a prompt in `stdin`, never in `args`: on Windows a `.cmd` shim can't take an argument with a space or `#`. `terminal` takes no prompt; a person types it. It only describes what to run; `packages/adapters/sessions.mjs` runs it, behind `POST /api/sessions` |
   | `openDesktop(id)` | no | a link that opens one of its sessions in its desktop app, or `null` (callers fall back to resuming in a terminal) |
   | `sessions(repoPath, remoteUrl)` | no | `[{branch, id, cwd, last}]` from its local logs, so `F sync` imports work in flight. Branch names and times only, never prompt text |
   | `notes()` | no | `[{label, ok: true/false/null, hint}]`: extra setup checks for the wizard (Claude Code's `claude-cli://` handler) |
   | `models()` | no | `[{id, alias, label, minVersion?}]`: the aliases a runner on this harness may set as `model` and `fallback` (`F skills set` refuses others). A CLI older than `minVersion` falls down the step's `fallback` chain. Without it, runners on this harness can't set a model |
   | `efforts` | no | the `effort` levels its runners may set, e.g. `["low", "medium", "high"]` |
| `current()` | no | the session id when `F` runs inside this harness (from its env), stamped on events |
   | `configDirs` | no | repo folders with its config (e.g. `[".gemini"]`). A PR that touches them never auto-merges |
   | `host` | no | `true` only for the harness that runs the factory skill itself: plugin agents next to its skills run on it |

3. **Add its stub,** `test/bin/<binary>`, an executable script that answers `--version` and the login-status command.
   `STUB_LOGGED_OUT=1` must make it report signed out. Check the real flags on your machine first
   (`<bin> --help`, `<bin> --version`, the logged-out output and exit code), and note the version in the file's first line.
4. **Check it.** `pnpm --filter @software-factory/factory test` runs the shared contract against every adapter, the new one
   included: installed and signed in with the stub, signed out with `STUB_LOGGED_OUT=1`, not installed with an empty PATH,
   tools that pass runner validation, and no sessions on an empty HOME. Then, for real: `F onboard` and `F skills catalog`.

The self-test also adds a fake third harness as a single file in a temp registry (`FACTORY_HARNESSES`). It proves that the
CLI, the catalog, `skills set`, `sync`, the event stamp and the sensitive paths pick it up with no core edit.
