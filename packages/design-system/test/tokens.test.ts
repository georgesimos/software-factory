// @vitest-environment node
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tokensCss } from '../scripts/tokens-css.ts';
import { color, status, tones } from '../src/tokens.ts';

describe('tokens', () => {
  it('tokens.css is generated from tokens.ts', () => {
    expect(fs.readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8')).toBe(tokensCss());
  });
  it('both themes define the same colours and every state maps to a tone', () => {
    expect(Object.keys(color.dark)).toEqual(Object.keys(color.light));
    for (const group of Object.values(status)) for (const t of Object.values(group)) expect(tones).toContain(t);
    expect(Object.keys(status.source)).toEqual(expect.arrayContaining(['factory', 'claude-code', 'codex', 'none']));
    expect(Object.keys(status.verdict)).toContain('dismissed');
  });
});
