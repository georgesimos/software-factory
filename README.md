# Software Factory

A Claude Code skill that takes a GitHub issue through intake, spec, build, a multi-axis review gate and approval, ending in a merged PR or a human escalation. It keeps a live dashboard of every run.

| Path | What |
|---|---|
| [`packages/factory`](packages/factory) | The skill (`SKILL.md`) and its zero-dependency CLI, `factory.mjs` |
| [`packages/design-system`](packages/design-system) | Design tokens and React components for the planned desktop app |
| [`apps/playground`](apps/playground) | Vite playground for the design system, with board and run-detail mocks |
| [`docs/architecture.md`](docs/architecture.md) | Folder structure, components, data model, flows, CLI examples |
| [`docs/research`](docs/research) | Background research reports |

## Quick start

```bash
pnpm install
pnpm build                                       # every package's build
pnpm test                                        # design-system contrast + every package's tests
pnpm dev                                         # design-system playground at http://localhost:5199
pnpm --filter @software-factory/factory test     # factory self-test only
node packages/factory/factory.mjs demo           # sample dashboard in a temp dir, no GitHub needed
```

## Install

**Claude Code plugin** (no clone, no pnpm; needs Node 24.12 or newer):

```
/plugin marketplace add georgesimos/software-factory
/plugin install software-factory@software-factory
```

Or in one step on Claude Code 2.1.275 or later: `/plugin install software-factory --marketplace georgesimos/software-factory`.
While the repository is private, this needs git credentials that can read it (`gh auth login`, then `gh auth setup-git`).
The skill is then `/software-factory:software-factory`, and it finds its CLI through `${CLAUDE_SKILL_DIR}`.

**Codex:** clone the repo, then link the skill into `~/.agents/skills`, where Codex looks for personal skills:

```bash
node packages/factory/factory.mjs install-skill --codex
```

**From a clone (contributors):** to use the skill in Claude Code, link it into your skills folder. This makes a symlink, or a junction on Windows, which needs no admin rights. Never copy the folder: it imports the sibling packages by relative path.

```bash
node packages/factory/factory.mjs install-skill
```

On Windows the skill's shell steps need Git for Windows (Git Bash), which Claude Code also uses.

Then say "factory owner/repo#123" in Claude Code. See [docs/architecture.md](docs/architecture.md) for details.

## Monorepo

A plain pnpm workspace. Each package owns its scripts, and the root `pnpm build` and `pnpm test` run them across the workspace
(`pnpm -r`). Desktop work will land in `apps/desktop` (Electron, planned) and consume `packages/design-system`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

![The design-system playground's board mock, built from the components](docs/screenshots/playground-board.png)

## License

[Apache-2.0](LICENSE).
