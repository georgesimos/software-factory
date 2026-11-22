# Add an AI harness in 4 steps

A harness (Gemini CLI, Cursor agent, Aider, ...) is **one file plus its stub binary**. The registry (`harnesses/index.mjs`)
loads every `harnesses/*.mjs` by itself. The runner validation, the Skills catalog, session import in `F sync`, the event
stamp, the sensitive paths, `F onboard` and the setup wizard all read it, so nothing else in the repo changes.

1. **Copy the template.** `cp harnesses/_template.mjs harnesses/<id>.mjs`. The `id` must equal the file name. Files starting
   with `_` are never loaded. Import only `node:` builtins, never `factory.mjs`.
2. **Fill in the contract.** Run the CLI only through `spawnSync` with an argv array and a timeout, and read both streams,
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
