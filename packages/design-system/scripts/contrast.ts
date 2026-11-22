// WCAG 2.x contrast check over every text/graphic pairing the components use, in both themes.
// Exits 1 on any violation. Run with `pnpm contrast`.
import { color, type ColorToken, type Theme } from '../src/tokens.ts';

const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const surfaces: ColorToken[] = ['bg', 'surface', 'sunken'];
// [foreground, backgrounds, minimum, why]
const rules: [ColorToken[], ColorToken[], number, string][] = [
  [['ink', 'ink2', 'ink3', 'accent', 'ok', 'bad', 'warn'], surfaces, 4.5, 'text (1.4.3)'],
  [['bg'], ['ink'], 4.5, 'inverted text: primary button, tooltip'],
  [['accent', 'ok', 'bad', 'warn', 'idle', 'control', 'ink3'], surfaces, 3, 'graphics: status dots, focus ring, control borders (1.4.11)'],
];

let fails = 0;
for (const theme of Object.keys(color) as Theme[]) {
  const p = color[theme];
  for (const [fgs, bgs, min, why] of rules) {
    for (const fg of fgs) for (const bg of bgs) {
      const r = ratio(p[fg], p[bg]);
      if (r < min) { fails++; console.error(`✕ ${theme}: ${fg} ${p[fg]} on ${bg} ${p[bg]} = ${r.toFixed(2)} < ${min} (${why})`); }
    }
  }
}
// Self-check of the formula against known values.
if (Math.abs(ratio('#000000', '#ffffff') - 21) > 0.01 || Math.abs(ratio('#777777', '#ffffff') - 4.48) > 0.01) {
  console.error('contrast formula self-check failed'); process.exit(1);
}
if (fails) { console.error(`\n${fails} contrast violation(s).`); process.exit(1); }
console.log('✓ contrast: all pairs pass WCAG AA in light and dark');
