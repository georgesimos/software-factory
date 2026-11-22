# budget-app

a personal budget app

This repo was started by the Software Factory from an idea. `PLAN.md` holds the vision, MVP scope, non-goals, stack and milestones. Read it before changing anything.

## Checks

Every change keeps these green. CI runs the same commands:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

Run the app locally with `pnpm dev`.

## Working rules

- One issue, one small PR: at most 300 changed lines, tests included.
- Every source change adds or changes a test.
- No new dependencies without a human. A change to `package.json` or a lockfile always goes to a human for review.
- Stay inside the MVP scope in `PLAN.md`. Its non-goals are out of scope.
