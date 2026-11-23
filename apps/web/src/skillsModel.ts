import { shq } from '@software-factory/design-system';
import type { CatalogEntry, SkillsData, StepRunner } from './data.ts';

// The Skills sheet's rules, ported from dashboard.html so the two agree on what a change writes.
export const F_CMD = 'node ~/.claude/skills/software-factory/factory.mjs'; // the page data's fCmd (a plugin install's real path) wins
const STEP_LABEL: Record<string, string> = { intake: 'Intake', spec: 'Spec', build: 'Build', verifier: 'Verifier', postmerge: 'Post-merge' };
export const stepLabel = (k: string) => STEP_LABEL[k] ?? (k.startsWith('review.') ? 'Review · ' + k.slice(7) : k);
export const SOURCES: [string, string][] = [['all', 'All'], ['builtin', 'Built-in'], ['system', 'Harness tools'], ['global', 'Global'], ['project', 'Project'], ['yours', 'Your briefs']];
export const runnerKey = (x?: StepRunner | null) => [x?.use || 'default', x?.harness ?? '', x?.name ?? '', x?.path ?? ''].join('|');
export const entriesFor = (S: SkillsData, scope: string): CatalogEntry[] => [...(S.catalog?.global ?? []), ...(scope === 'default' ? [] : S.catalog?.projects?.[scope] ?? [])];
const findEntry = (S: SkillsData, scope: string, x: StepRunner) => entriesFor(S, scope).find((e) => runnerKey(e.runner) === runnerKey(x));
export function runnerName(S: SkillsData, scope: string, x: StepRunner) {
  if (!x.use || x.use === 'default') return 'Factory default';
  const e = findEntry(S, scope, x);
  return e ? e.name : x.use === 'brief' ? x.path ?? '' : x.use === 'provider' ? [x.harness, x.name].filter(Boolean).join(': ') : x.name ?? '';
}
export const kindOf = (S: SkillsData, scope: string, x: StepRunner) => findEntry(S, scope, x)?.kind ?? (x.use === 'provider' ? 'tool' : x.use ?? '');

const own = (S: SkillsData, scope: string) => (S.config?.[scope] ?? {}) as Record<string, StepRunner>;
/** Set in this scope; else (a project) copied from global; else nothing. */
export const setHere = (S: SkillsData, scope: string, step: string) => step in own(S, scope);

/**
 * The runner to save when one of model, effort or fallback changes ('' = inherit). A project step it doesn't set starts from
 * the global one. A new model resets fallback to that model's chain; inheriting the model drops effort too. A bare default
 * runner is null, which unsets the step.
 */
export function editStep(S: SkillsData, scope: string, step: string, field: 'model' | 'effort' | 'fallback', v: string): StepRunner | null {
  const src: StepRunner = { use: 'default', ...(setHere(S, scope, step) ? own(S, scope)[step] : scope === 'default' ? {} : own(S, 'default')[step]) };
  const next = { ...src };
  if (field === 'model') { delete next.model; delete next.fallback; if (v) next.model = v; else delete next.effort; }
  else if (field === 'effort') { delete next.effort; if (v) next.effort = v; }
  else { delete next.fallback; if (v) next.fallback = v.split(','); }
  return Object.keys(next).length === 1 && next.use === 'default' ? null : next;
}

/** Where a step's model comes from, for the empty choice and the note under the select. */
export function modelSource(S: SkillsData, scope: string, step: string) {
  const set = setHere(S, scope, step) ? own(S, scope)[step]?.model ?? '' : '';
  const g = scope === 'default' ? undefined : own(S, 'default')[step]?.model;
  const preset = S.presets?.[S.preset ?? '']?.[step]?.[0] ?? '';
  return { set, inherit: g ? `Global (${g})` : `Preset${preset ? ` (${preset})` : ''}`, why: set ? 'set here' : g ? 'from global' : `preset ${S.preset ?? ''}` };
}

export const skillCommand = (scope: string, step: string, runner: unknown, f = F_CMD) => runner === null
  ? `${f} skills unset ${shq(scope)} ${shq(step)}`
  : `${f} skills set ${shq(scope)} ${shq(step)} ${shq(JSON.stringify(runner))}`;
export const presetCommand = (name: string, scope: string, f = F_CMD) => `${f} skills preset ${shq(name)} ${shq(scope)}`;

/**
 * A new runner for a step keeps the model, effort and fallback set on it here, unless it moves to another harness's
 * provider, whose models differ (the server refuses them). Without a carry-over, changing who runs a step reset them.
 */
export function keepModel(old: StepRunner | undefined, next: StepRunner): StepRunner {
  if (!old || (next.use === 'provider' && !(old.use === 'provider' && old.harness === next.harness))) return next;
  const { model, effort, fallback } = old;
  return { ...next, ...(model && { model }), ...(effort && { effort }), ...(fallback && { fallback }) };
}

/** The picker's result, or the reason it can't be saved. Ported from pickRunner's Save. */
export function pickResult(p: { runner: StepRunner | null; axis?: { name: string; globs: string } }): { runner: StepRunner; axis?: string; when?: string[] } | string {
  if (!p.runner) return 'Pick a runner, or fill in the name or path you chose.';
  if (!p.axis) return { runner: p.runner };
  const name = p.axis.name.trim(), when = p.axis.globs.split(',').map((g) => g.trim()).filter(Boolean);
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) return 'Axis name: lowercase letters, digits and dashes, starting with a letter.';
  if (!when.length) return 'Add at least one file pattern, such as **/*.tsx.';
  if (p.runner.use === 'default') return 'An extra axis has no built-in brief: pick a skill, agent, tool or brief.';
  return { runner: p.runner, axis: name, when };
}
