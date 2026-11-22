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
pnpm test                                        # design-system contrast + every package's tests
pnpm --filter @software-factory/factory test     # factory self-test only
FACTORY_DIR=$(mktemp -d) node packages/factory/factory.mjs demo   # sample dashboard, no GitHub needed
```

To use the skill in Claude Code, link it into your skills folder:

```bash
ln -s "$PWD/packages/factory" ~/.claude/skills/software-factory
```

Then say "factory owner/repo#123" in Claude Code. See [docs/architecture.md](docs/architecture.md) for details.

## License

TBD. MIT or Apache-2.0 are suggested before the repo goes public.
