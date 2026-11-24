/** Text with a break opportunity after each - _ : . /, so a long name (pr-review-toolkit:code-reviewer) wraps there first. */
export const breakable = (t: string) => t.split(/(?<=[-_:./])/).flatMap((p, i) => (i ? [<wbr key={i} />, p] : [p]));
