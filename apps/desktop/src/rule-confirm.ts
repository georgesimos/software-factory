import { routesText, ruleChange, setRule, shownNow, shownRule as shown, unsetRule, type RuleRequest } from '../../../packages/core/src/rules.ts';
import { setSkill, shownSkill, skillChange } from '../../../packages/core/src/skills.ts';
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
  // routing (§7.3): asked only while two pipelines differ in what a run gets; the routes above it are F's reading of the result
  pipelines: [(s) => `Change how issues are routed for ${s}?`, 'Change routing', 'Issues may go to a pipeline that runs fewer reviews or has other caps, from their next review. It is audited.'],
  match: [(s) => `Change how issues are routed for ${s.split('@')[0]}?`, 'Change routing', 'Issues may go to a pipeline that runs fewer reviews or has other caps, from their next review. It is audited.'],
};
// skills.json keys (slice 5, req.skill): removing what a project or pipeline added, through setSkill
const SKILL_WORDS: Record<string, [message: (scope: string) => string, button: string, meaning: string]> = {
  'steps.custom': [(s) => `Remove custom steps for ${s}?`, 'Remove them', 'The factory stops running these checks on this project from its next run. It is audited.'],
  'axes.on': [(s) => `Remove added reviews for ${s}?`, 'Remove them', 'The factory stops running these reviews on this pipeline from its next review. Code and security reviews always run. It is audited.'],
  'axes.extra': [(s) => `Remove added reviews for ${s}?`, 'Remove them', 'The factory stops running these reviews on this pipeline from its next review. Code and security reviews always run. It is audited.'],
};
const clean = (s: unknown) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]/g, ' ').slice(0, 200);

/** The server's guarded.request: false while a dialog is open, so the route refuses rather than answering "requested". */
export function requestRule(req: RuleRequest, show: ShowBox) {
  if (open) return false;
  void confirmRule(req, show);
  return true;
}
export async function confirmRule(req: RuleRequest, show: ShowBox) {
  if (open) return null;
  open = true;
  try {
    if (req.skill) return await confirmSkill(req, show);
    const raw = req.unset ? undefined : req.raw, at = { reason: req.reason, until: req.until };
    const c = ruleChange(req.scope, req.key, raw, at), w = WORDS[c.key];
    if (!c.doing || !w) throw new Error(`${c.key} needs no confirmation: nothing to do here`); // the route only requests what loosens
    const ok = (await show({ type: 'warning', title: 'Confirm a rule change', message: w[0](c.scope),
      detail: `Project: ${c.scope}\nRule: ${c.key}\n${c.key === 'steps.off' ? 'Now off' : 'Now'}: ${shownNow(c.key, c.stored === undefined ? undefined : { value: c.stored, until: c.storedUntil })}\nAfter: ${shown(c.key, c.value)}${c.until ? `\nUntil: ${c.until}` : ''}\n\n${c.routes.length ? `${routesText(c.routes)}\n` : ''}${w[2]}${req.unset ? '' : `\n\nReason, as typed on the page: ${clean(req.reason)}`}`,
      buttons: ['Cancel', w[1]], defaultId: 0, cancelId: 0, noLink: true })).response === 1;
    if (!ok) return null;
    const was = (x: typeof c) => JSON.stringify([x.stored, x.storedUntil, x.routes]); // the routes shown are part of what was confirmed
    if (was(ruleChange(req.scope, req.key, raw, at)) !== was(c)) throw new Error('the rule changed while the dialog was open: nothing was written. Request it again to see the new value.');
    const ask = () => c.scope; // the dialog was the confirmation: core's typed one would need a terminal the app has none of
    return req.unset ? unsetRule(c.scope, c.key, { reason: req.reason, ask }) : setRule(c.scope, c.key, req.raw, { ...at, ask });
  } catch (e) {
    await show({ type: 'error', title: 'Rule change', message: 'Nothing was changed.', detail: (e as Error).message, buttons: ['OK'] });
    return null;
  } finally { open = false; }
}
async function confirmSkill(req: RuleRequest, show: ShowBox) {
  const value = req.unset || req.raw === undefined ? undefined : JSON.parse(req.raw);
  const c = skillChange(req.scope, req.key, value), w = SKILL_WORDS[c.key];
  if (!c.doing || !w) throw new Error(`${c.key} needs no confirmation: nothing to do here`);
  const ok = (await show({ type: 'warning', title: 'Confirm a pipeline change', message: w[0](c.scope),
    detail: `Project: ${c.scope}\nSetting: ${c.key}\nNow: ${shownSkill(c.key, c.stored)}\nAfter: ${shownSkill(c.key, c.value)}\n\n${w[2]}\n\nReason, as typed on the page: ${clean(req.reason)}`,
    buttons: ['Cancel', w[1]], defaultId: 0, cancelId: 0, noLink: true })).response === 1;
  if (!ok) return null;
  if (JSON.stringify(skillChange(req.scope, req.key, value).stored) !== JSON.stringify(c.stored)) throw new Error('the setting changed while the dialog was open: nothing was written. Request it again to see the new value.');
  return setSkill(c.scope, c.key, value, { reason: req.reason, ask: () => c.scope }); // the dialog was the confirmation
}
