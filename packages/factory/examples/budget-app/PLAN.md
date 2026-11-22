# Budget app: plan

Idea: "a personal budget app". Clarifying questions were answered with the defaults:

| Question | Answer (default) |
|---|---|
| Web or mobile? | Web (`next-web` stack) |
| Who uses it? | One person, on one device. No accounts. |
| Where does the data live? | In the browser (`localStorage`), with a JSON export and import |
| Which currency? | One display currency, chosen in settings (default USD). Amounts are stored as integer cents. |
| What must the first version do? | Record expenses and income, set a monthly budget per category, and show what is left this month |

## Vision

A calm, private place to see where my money goes each month. I add what I spend in a few seconds, set a budget per category, and always know how much is left, without signing up or sending my data anywhere.

## MVP scope

- Add, edit and delete expenses and income, each with an amount, a date, a category and an optional note.
- A default set of categories (Groceries, Rent, Transport, Eating out, Fun, Other income).
- A list of the selected month's transactions, newest first, and a way to switch months.
- A monthly budget per category, with spent, remaining and a clear over-budget warning.
- Export all data to a JSON file and import it back.
- A display currency setting.

## Non-goals

- Accounts, sign-in, sync between devices or any server-side storage.
- Bank connections, CSV bank imports or receipt scanning.
- Shared or family budgets.
- Charts beyond the per-category summary.
- Multiple currencies at once, or exchange rates.
- A mobile app (the web app should still work on a phone-sized screen).

## Stack

- `next-web` stack template: Next.js App Router, TypeScript, ESLint, pnpm, Vitest with Testing Library, and a CI workflow that runs `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.
- No dependencies beyond the template. Dates use `Intl.DateTimeFormat` and amounts use `Intl.NumberFormat`.
- Data is one versioned JSON document in `localStorage`, read and written only through `src/lib/store.ts`.
- File names avoid the factory's sensitive path words (auth, session, payments, billing, money, migrations), so every issue can merge without a human.

## Milestones

1. **M1 Track**: add, list, edit and delete transactions in categories.
2. **M2 Budget**: monthly budgets per category, spent and remaining, over-budget warning, month switcher.
3. **M3 Own your data**: JSON export and import, and the display currency setting.

Each issue is one small pull request: at most 300 changed lines including tests, one concern, and testable acceptance criteria.
