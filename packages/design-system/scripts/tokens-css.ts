// Writes src/tokens.css from src/tokens.ts. `--check` exits 1 if the committed file is stale.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as t from '../src/tokens.ts';

const OUT = fileURLToPath(new URL('../src/tokens.css', import.meta.url));
const decl = (group: string, o: Record<string, string>) => Object.entries(o).map(([k, v]) => `  ${t.cssVar(group, k)}: ${v};`);

function themed(theme: t.Theme) {
  return [
    `  color-scheme: ${theme};`,
    ...decl('color', t.color[theme]),
    ...decl('shadow', t.shadow[theme]),
  ].join('\n');
}

export function tokensCss() {
  const tone = (tn: t.Tone) => `var(${t.cssVar('color', t.toneColor[tn])})`;
  const semantic = Object.entries(t.status).flatMap(([group, states]) =>
    Object.entries(states as Record<string, t.Tone>).map(([s, tn]) => `  --sf-${group}-${s}: ${tone(tn)};`));
  const tones = t.tones.map((tn) => `  --sf-tone-${tn}: ${tone(tn)};`);
  return `/* Generated from tokens.ts by \`pnpm tokens\`. Do not edit by hand. */
:root {
${decl('font', t.font).join('\n')}
${decl('text', t.text).join('\n')}
${decl('weight', t.weight).join('\n')}
${decl('leading', t.leading).join('\n')}
${decl('tracking', t.tracking).join('\n')}
${decl('space', t.space).join('\n')}
${decl('radius', t.radius).join('\n')}
${decl('motion', t.motion).join('\n')}
${decl('z', t.z).join('\n')}
}

/* Light is the default; a [data-theme] attribute on any element themes that subtree. */
:root,
[data-theme="light"] {
${themed('light')}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${themed('dark').replace(/^/gm, '  ')}
  }
}
[data-theme="dark"] {
${themed('dark')}
}

/* Semantic state tokens. Declared on every themed element so they resolve against that element's palette. */
:root,
[data-theme] {
${tones.join('\n')}
${semantic.join('\n')}
}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = tokensCss();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== css) { console.error('tokens.css is out of date with tokens.ts: run `pnpm tokens`.'); process.exit(1); }
  } else {
    fs.writeFileSync(OUT, css);
    console.log('wrote', OUT);
  }
}
