# @software-factory/design-system

Tokens and React components for the Software Factory desktop app (Electron + Vite + React). Extracted from the factory's
redesigned `dashboard.html`, so the app looks like the dashboard people already use.

```bash
pnpm dev            # playground at http://localhost:5199 (?theme=light|dark)
pnpm test           # contrast check + Vitest
pnpm build          # token drift check + typecheck + playground build
pnpm screenshots    # with `pnpm dev` running: light/dark × desktop/375px into apps/playground/screenshots/
```

## Principles

- **Monochrome with one accent.** Ink on near-white (or near-black). Blue (`accent`) only means "live / running" and focus. Every
  other colour is a state: `ok`, `bad`, `warn`, `idle`.
- **Hairlines and whitespace instead of boxes and shadows.** 1px `line` borders, 6px radius, shadows only on things that float
  (tooltip, dialog, sheet, toast).
- **Precise type.** Geist for prose, Geist Mono for ids, metadata, labels and numbers (tabular figures). 13–14px body, 11px
  uppercase mono labels, large light numerals for metrics.
- **Calm status.** State is a 6px dot plus a word. Colour is never the only signal, and badges are outlined rather than filled.
- **Fast, subtle motion.** 120–200ms, `ease-out`, transform and opacity only. `prefers-reduced-motion` turns it all off.
- **Keyboard first.** ⌘K command menu, roving-tabindex tabs, ⌘↵ to submit onboarding, Escape closes anything, and a visible
  2px accent focus ring everywhere.
- **Native where the platform is right.** `<dialog>` (focus trap, Escape, inert background), `<select>`, `<input type=checkbox>`,
  `<progress>`. No UI-library dependency, no Tailwind: plain CSS on custom properties, `sf-` class prefix.
- **Accessible by test.** `pnpm contrast` fails on any WCAG AA violation in either theme: text at 4.5:1, status dots, control
  borders and focus ring at 3:1. Every component works at 375px.

## Tokens

`src/tokens.ts` is the source. `src/tokens.css` is generated from it (`pnpm tokens`), and the build fails if the two drift.

| Kind | CSS variable | Example |
|---|---|---|
| Colour (themed) | `--sf-color-<name>` | `--sf-color-ink-3`, `--sf-color-line`, `--sf-color-accent` |
| Tone | `--sf-tone-<tone>` | `neutral`, `run`, `ok`, `bad`, `warn`, `idle` |
| Factory state | `--sf-<group>-<state>` | `--sf-stage-active`, `--sf-outcome-needs-info`, `--sf-verdict-dismissed`, `--sf-source-codex` |
| Type | `--sf-font-*`, `--sf-text-*`, `--sf-weight-*`, `--sf-leading-*`, `--sf-tracking-*` | `--sf-text-md` (13px) |
| Space (4px grid) | `--sf-space-<n>` | `--sf-space-4` = 16px, `--sf-space-1-5` = 6px |
| Radius / shadow / motion / z | `--sf-radius-*`, `--sf-shadow-*`, `--sf-motion-*`, `--sf-z-*` | `--sf-motion-duration-fast` |

State groups: `stage` (pending, active, done, failed, warn, skipped), `outcome` (in-progress, merged, escalated, rejected,
needs-info, closed, awaiting-approval, split, reverted), `verdict` (passed, failed, pending, dismissed, not-reviewed), and
`source` (factory, claude-code, codex, human, none). Components read the state variables, so retuning a state is a one-line
change in `tokens.ts`.

**Themes.** Light is the default. Dark follows `prefers-color-scheme`. `data-theme="light|dark"` on `<html>` overrides the
system; on any other element it themes that subtree, which is how the playground shows both palettes side by side.

The palette matches the reference dashboard, except that light `warn` (`#946003`) and light `idle` (`#8c8c85`) are darker so they
pass AA. `control` is new: a 3:1 border for inputs and checkboxes.

## Components

- **Basics:** `Button`, `IconButton`, `Input`, `Select`, `Checkbox`, `Badge`, `Dot`, `Kbd`, `Tooltip`, `Dialog` / `Sheet`,
  `Tabs`, `Table`, `Card`, `EmptyState`, `Skeleton`, `ToastProvider` / `useToast`, `ThemeToggle`.
- **Factory:** `StageTrack`, `RunCard`, `ReviewMatrix`, `MetricStat` / `MetricStrip`, `SourceChip`, `OutcomePill`, `Timeline`,
  `CommandMenu`, and `SessionLink` / `SessionList` / `SessionsChip`, which show local Claude Code and Codex sessions on a
  run's branch and copy the resume command. `resumeCommand()` quotes the paths and ids.
- **Onboarding:** `ProjectPicker` (discover, then multi-select) and `IngestProgress` (per-project import with PR and session
  counts).

The factory components take `factory.mjs` objects as they are: `Run` from `derive()`, `Metrics` from `metrics()`,
`DiscoveredRepo` from `discover()`, and `SyncResult` from `sync()` (converted by `syncCounts()`). `Run` and `Metrics` are core's
own types (`@software-factory/core/types`, a type-only import, so no runtime dependency), read with every field optional. The types and the dashboard's
presentation rules (`stageState`, `runTone`, `reviewFailed`, the formatters) live in `src/factory/model.ts`. Components are
presentational: they hold no fetching and no IPC.

## Consuming it from the Electron app

The package ships TypeScript and CSS source (an internal "just-in-time" workspace package). The app's Vite build compiles it,
so there is no separate library build to keep in sync.

```jsonc
// apps/desktop/package.json
"dependencies": { "@software-factory/design-system": "workspace:*" }
```

```tsx
// renderer entry
import '@software-factory/design-system/styles.css'; // tokens, self-hosted Geist, base, all component CSS
import { ToastProvider, RunCard, CommandMenu } from '@software-factory/design-system';
```

- The source uses `.ts` extensions in imports, so the app's tsconfig needs `moduleResolution: "Bundler"`,
  `allowImportingTsExtensions` and `noEmit`. Extending `tsconfig.base.json` covers all three.
- Set `base: './'` in the renderer's Vite config so fonts and assets resolve under `file://`.
- Fonts are bundled (`src/fonts/`, SIL OFL), so nothing is fetched at runtime and the app works offline. The screenshot script
  asserts that the playground makes no off-localhost requests.
- For theming, render `<ThemeToggle />`, which offers light, dark and system (the default) and stores the choice in
  `localStorage` under `sf.theme`. To avoid a flash of the wrong theme, inline `themeInitScript` in the renderer's `<head>`
  before the stylesheet. Under a strict CSP, allow that script by its hash.
- For token values in JS (charts, canvas), use `import { color } from '@software-factory/design-system/tokens'`.

`apps/playground/src` is the reference composition. `Board.tsx`, `RunDetail.tsx` and `Onboarding.tsx` are what the app's
screens will look like, with fixture data in place of the `F serve` API.
