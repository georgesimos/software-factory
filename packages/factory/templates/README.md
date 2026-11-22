# Stack templates

A stack template is data only: what `F new` runs and writes in the empty new repo. `next-web.json` and `expo-mobile.json` ship. Files starting with `_` are skipped.

## Add one

Copy `_template.json` to `<id>.json` (the file name must equal `id`) and fill in:

| Field | What |
|---|---|
| `init` | argv lists, run in order in the new repo with no shell (output goes to `scaffold.log` in the project folder). Pin major versions. |
| `checks` | The commands every issue must pass. `F new` saves them as the project's `checks.commands` rule, and `F project` turns them into the `/goal` condition for the build step. |
| `files` | Path to text, written after `init`. Ship at least `AGENTS.md`, `CLAUDE.md`, `README.md`, one smoke test and a CI workflow (a repo with no CI escalates at approve). Placeholders: `{{name}} {{repo}} {{idea}} {{stack}} {{checks}}`. |

Use it: `F new "<idea>" --stack <id>`. Preview without creating anything: add `--dry-run --out <dir>`.

## Test

`node factory.mjs test` validates every template here (known fields only, argv lists with no shell, relative file paths outside `.git/`) and runs a fake extra stack from a temp dir end to end. It does not execute `init`: those commands need the network, so try a new template once by hand in a scratch folder.

Point `FACTORY_TEMPLATES` at another folder to load templates from there instead.
