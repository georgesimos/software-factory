# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Setup

```bash
pnpm install
pnpm build    # every package
pnpm test     # design-system WCAG contrast check, then every package's tests
pnpm dev      # design-system playground at http://localhost:5199
```

The repo is a plain pnpm workspace. Each package's own `package.json` scripts are the source of truth.

## Guidelines

- Keep changes lean: no new dependency for something a few lines can do, and no speculative options.
- Every interactive component gets a Vitest + Testing Library test. UI changes must pass `pnpm test`, including contrast, and
  work at 375px (`pnpm screenshots` checks overflow).
- The dashboard ships as one generated file, `packages/factory/app.html`. After changing `apps/web` or the design system, run
  `pnpm --filter @software-factory/web dashboard` and commit the result. Never edit it by hand, and on a merge conflict in it,
  rebuild it.
- The desktop app (`apps/desktop`): `pnpm --filter @software-factory/desktop start` runs it on your real factory state;
  `e2e` drives it on a temp one; `package` then `smoke` make and check an unsigned build for your OS (`out/`, not committed).
- Colours come from tokens. Edit `packages/design-system/src/tokens.ts`, then run `pnpm tokens`. Never edit `tokens.css` by hand.
- No personal data in code, fixtures, screenshots or docs. Use neutral names like `acme/shop` and `/home/dev`.
- Write commit messages in the imperative mood, and explain why the change is needed in the body.

## Reporting bugs

Open an issue with steps to reproduce. For security problems, see [SECURITY.md](SECURITY.md) instead.
