import { approveSpecDesktop, awaitingSpecs, specPending } from '../../../packages/core/src/approve.ts';

// Run → Approve… (local-first §2.2 step 3): a local item's spec, approved in a native dialog that belongs to the main process
// alone. No IPC channel, preload or server route reaches it, so the page can't open it, and neither can an agent driving the
// page. Cancel is the default and the Escape answer. Like F approve, it's a speed bump, not a security boundary (approve.ts).
export interface Box { type?: 'none' | 'info' | 'error' | 'question' | 'warning'; title?: string; message: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number; noLink?: boolean }
export type ShowBox = (box: Box) => Promise<{ response: number }>;
const MAX_LIST = 8, MAX_SPEC = 3000;
const CMD = 'F approve RUN in your own terminal';

/** The menu item's click: pick a waiting spec, read it, confirm or cancel. Every refusal F approve makes shows as an error box. */
export async function approveFromMenu(show: ShowBox) {
  try {
    const waiting = awaitingSpecs();
    if (!waiting.length) { await show({ type: 'info', title: 'Approve', message: 'No spec is waiting for your approval.', detail: "A GitHub item's spec is approved with a \"/factory approve\" comment on the issue.", buttons: ['OK'] }); return null; }
    const list = waiting.slice(0, MAX_LIST), more = waiting.length - list.length;
    const pick = (await show({ type: 'question', title: 'Approve', message: 'Which spec do you want to read?',
      detail: list.map((w) => `${w.run}: ${w.title}`).join('\n') + (more ? `\n\n${more} more: run ${CMD}.` : ''),
      buttons: ['Cancel', ...list.map((w) => w.run)], defaultId: 0, cancelId: 0, noLink: true })).response;
    if (!pick) return null;
    const p = specPending(list[pick - 1]!.run);
    // The approval covers the whole file, so the dialog approves only a spec it can show in full.
    if (p.spec.length > MAX_SPEC) throw new Error(`this spec is too long to approve here: run F approve ${p.run} in your terminal`);
    const ok = (await show({ type: 'warning', title: 'Approve the spec', message: `Approve the spec for ${p.run}?`,
      detail: `${p.title}\n\nWhy it waits: ${p.reasons.join('; ') || '-'}\n\nSpec ${p.code} (DIR/spec.md):\n${p.spec}\n\nApproving lets the run go on to build this spec. It doesn't merge anything.`,
      buttons: ['Cancel', 'Approve the spec'], defaultId: 0, cancelId: 0, noLink: true })).response === 1;
    return ok ? approveSpecDesktop(p.run, p.sha) : null;
  } catch (e) {
    await show({ type: 'error', title: 'Approve', message: 'Nothing was approved.', detail: (e as Error).message, buttons: ['OK'] });
    return null;
  }
}
