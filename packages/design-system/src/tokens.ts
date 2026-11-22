// Single source of truth for design tokens. `pnpm tokens` writes tokens.css from this file;
// `pnpm build` fails if the two drift. Keep colour values as solid hex so the contrast check can compute them.

/** Theme colours. Text tokens: ink, ink2, ink3, accent, ok, bad, warn. Everything else is a surface, line or graphic. */
export const color = {
  light: {
    bg: '#fafaf9',
    surface: '#ffffff',
    sunken: '#f4f4f2',
    ink: '#111110',
    ink2: '#57574f',
    ink3: '#707069',
    line: '#e8e8e4',
    line2: '#d5d5cf',
    control: '#8c8c85',
    accent: '#3550dc',
    ok: '#2c7a51',
    bad: '#bf3d2b',
    warn: '#946003',
    idle: '#8c8c85',
  },
  dark: {
    bg: '#0b0b0c',
    surface: '#121214',
    sunken: '#0f0f11',
    ink: '#ededeb',
    ink2: '#a5a59f',
    ink3: '#82827c',
    line: '#222225',
    line2: '#333337',
    control: '#6a6a65',
    accent: '#8c9dff',
    ok: '#6cbf8f',
    bad: '#ec8b79',
    warn: '#d9ad5e',
    idle: '#67675f',
  },
} as const;

export type Theme = keyof typeof color;
export type ColorToken = keyof typeof color.light;

export const font = {
  sans: '"Geist", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
} as const;

/** Type scale (font-size). The dashboard is dense: 13–14px body, 10.5–12px mono metadata. */
export const text = {
  '2xs': '10.5px',
  xs: '11px',
  sm: '12px',
  md: '13px',
  base: '14px',
  lg: '16px',
  xl: '19px',
  '2xl': '24px',
  display: 'clamp(30px, 3.4vw, 44px)',
} as const;

export const weight = { regular: '400', medium: '500', semibold: '600' } as const;
export const leading = { tight: '1.25', snug: '1.38', normal: '1.5' } as const;
export const tracking = { tight: '-0.02em', snug: '-0.01em', normal: '0', label: '0.08em' } as const;

/** 4px grid, with the 2/6/10px half steps the dense layouts use. */
export const space = {
  '0': '0',
  '0-5': '2px',
  '1': '4px',
  '1-5': '6px',
  '2': '8px',
  '2-5': '10px',
  '3': '12px',
  '4': '16px',
  '5': '20px',
  '6': '24px',
  '8': '32px',
  '10': '40px',
  '16': '64px',
} as const;

export const radius = { xs: '3px', sm: '4px', md: '6px', lg: '8px', xl: '10px', full: '999px' } as const;

export const shadow = {
  light: {
    overlay: '0 8px 24px -8px rgb(0 0 0 / 0.3)',
    panel: '-32px 0 64px -48px rgb(0 0 0 / 0.35)',
    dialog: '0 24px 64px -24px rgb(0 0 0 / 0.3), 0 0 0 1px rgb(0 0 0 / 0.04)',
  },
  dark: {
    overlay: '0 8px 24px -8px rgb(0 0 0 / 0.7)',
    panel: '-32px 0 64px -48px rgb(0 0 0 / 0.9)',
    dialog: '0 24px 64px -24px rgb(0 0 0 / 0.8), 0 0 0 1px rgb(255 255 255 / 0.04)',
  },
} as const;

export const motion = {
  'duration-fast': '120ms',
  'duration-base': '150ms',
  'duration-slow': '200ms',
  'ease-out': 'cubic-bezier(0.2, 0.7, 0.2, 1)',
  'ease-in-out': 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

export const z = { raised: '1', sticky: '30', sheet: '40', dialog: '50', toast: '60', tooltip: '70' } as const;

/** The tones every status maps to. One accent (`run`); the rest are calm state colours. */
export const tones = ['neutral', 'run', 'ok', 'bad', 'warn', 'idle'] as const;
export type Tone = (typeof tones)[number];
export const toneColor: Record<Tone, ColorToken> = { neutral: 'ink2', run: 'accent', ok: 'ok', bad: 'bad', warn: 'warn', idle: 'idle' };

/** Semantic factory states → tone. Components read `--sf-<group>-<state>` so a state can be retuned without touching them. */
export const status = {
  stage: { pending: 'idle', active: 'run', done: 'ok', failed: 'bad', warn: 'warn', skipped: 'idle' },
  outcome: {
    'in-progress': 'run',
    merged: 'ok',
    escalated: 'warn',
    rejected: 'bad',
    'needs-info': 'warn',
    closed: 'idle',
    'awaiting-approval': 'warn',
    split: 'idle',
    reverted: 'bad',
  },
  verdict: { passed: 'ok', failed: 'bad', pending: 'run', dismissed: 'idle', 'not-reviewed': 'idle' },
  source: { factory: 'run', 'claude-code': 'neutral', codex: 'neutral', human: 'neutral', none: 'idle' },
} as const satisfies Record<string, Record<string, Tone>>;

/** Turns a token key into its CSS custom property name, e.g. cssVar('color', 'ink2') → '--sf-color-ink-2'. */
export const cssVar = (group: string, key: string) => `--sf-${group}-${key.replace(/([a-z])(\d)/g, '$1-$2')}`;
