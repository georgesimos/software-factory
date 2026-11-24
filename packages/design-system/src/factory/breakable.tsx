import type { ReactNode } from 'react';

/** Text with a break opportunity after each - _ : . /, so a long name (pr-review-toolkit:code-reviewer) wraps there first. */
// A capture group, not a lookbehind: Safari before 16.4 can't parse (?<=…), and one SyntaxError blanks the whole app.html.
export const breakable = (t: string) => {
  const p = t.split(/([-_:./])/), out: ReactNode[] = [];
  for (let i = 0; i < p.length; i += 2) out.push(...(i ? [<wbr key={i} />] : []), p[i] + (p[i + 1] ?? ''));
  return out;
};
