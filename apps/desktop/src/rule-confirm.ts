import { RUN_CAPS, ruleChange, setRule, unsetRule, type RuleRequest } from '../../../packages/core/src/rules.ts';
import type { ShowBox } from './approve-menu.ts';

// A guarded rule write the page requested (docs/plans/pipelines.md §5: turning a step off, raising a cap), confirmed in a native
// dialog that belongs to this process. The server calls it in-process (server.ts guarded.request): no IPC channel or preload.
// What the dialog says is F's own reading of the change (ruleChange: scope, key, stored value, new value), never the page's
// words; the one exception is the reason, which is the page's and is shown last, labelled, without control characters.
// Cancel is the default and the Escape answer. One dialog at a time: a request while one is open is dropped.
let open = false;
const WORDS: Record<string, [message: (scope: string) => string, button: string, meaning: string]> = {
  'steps.off': [(s) => `Turn review steps off for ${s}?`, 'Turn them off',
    'The factory stops running these reviews on this project from its next review. Code and security reviews always run. It is audited, and F rules unset turns them back on.'],
  'run.loops': [(s) => `Raise a cap for ${s}?`, 'Raise it', 'Runs on this project may loop back more times before they escalate to you. It is audited.'],
  'run.budgetUsd': [(s) => `Raise a cap for ${s}?`, 'Raise it', 'Runs on this project may spend more before they escalate to you. It is audited.'],
};
const shown = (key: string, v: unknown) => v === undefined ? (Object.hasOwn(RUN_CAPS, key) ? `the built-in (${RUN_CAPS[key]})` : 'nothing') : Array.isArray(v) ? v.join(', ') : String(v);
const clean = (s: unknown) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]/g, ' ').slice(0, 200);

export async function confirmRule(req: RuleRequest, show: ShowBox) {
  if (open) return null;
  open = true;
  try {
    const raw = req.unset ? undefined : req.raw, at = { reason: req.reason, until: req.until };
    const c = ruleChange(req.scope, req.key, raw, at), w = WORDS[c.key];
    if (!c.doing || !w) throw new Error(`${c.key} needs no confirmation: nothing to do here`); // the route only requests what loosens
    const ok = (await show({ type: 'warning', title: 'Confirm a rule change', message: w[0](c.scope),
      detail: `Project: ${c.scope}\nRule: ${c.key}\n${c.key === 'steps.off' ? 'Now off' : 'Now'}: ${shown(c.key, c.stored)}\nAfter: ${shown(c.key, c.value)}${c.until ? `\nUntil: ${c.until}` : ''}\n\n${w[2]}${req.unset ? '' : `\n\nReason, as typed on the page: ${clean(req.reason)}`}`,
      buttons: ['Cancel', w[1]], defaultId: 0, cancelId: 0, noLink: true })).response === 1;
    if (!ok) return null;
    if (JSON.stringify(ruleChange(req.scope, req.key, raw, at).stored) !== JSON.stringify(c.stored)) throw new Error('the rule changed while the dialog was open: nothing was written. Request it again to see the new value.');
    return req.unset ? unsetRule(c.scope, c.key, { reason: req.reason }) : setRule(c.scope, c.key, req.raw, at);
  } catch (e) {
    await show({ type: 'error', title: 'Rule change', message: 'Nothing was changed.', detail: (e as Error).message, buttons: ['OK'] });
    return null;
  } finally { open = false; }
}
