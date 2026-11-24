// No CI: nothing ever passes, so with the ci rule at required every merge escalates.
export const id = 'none';

export const checks = () => ({ state: 'none' as const, detail: 'no CI provider (ci none): set ci local with a checks.commands rule' });
