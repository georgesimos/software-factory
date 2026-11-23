import { Badge, formatClock, shortId } from '@software-factory/design-system';
import type { FactoryData } from './data.ts';

// Policy rules in force for the shown project(s), from `F rules set`. Quiet unless expired or ending within 3 days.
const LABEL: Record<string, (v: unknown) => string> = {
  ci: (v) => ({ skip: 'CI skipped', advisory: 'CI advisory', required: 'CI required' } as Record<string, string>)[String(v)] ?? `CI ${v}`,
  'checks.commands': (v) => `Local checks ×${Array.isArray(v) ? v.length : 0}`, diffCap: (v) => `Diff cap ${v}`,
  'project.budgetUsd': (v) => `Project budget $${v}`, 'project.maxIssuesPerSession': (v) => `${v} issues / session`,
  'deploy.preview': (v) => ({ required: 'Preview required', advisory: 'Preview advisory', off: 'Preview off' } as Record<string, string>)[String(v)] ?? `Preview ${v}`,
  artifact: () => 'Publishes to Artifact',
};

export function RuleChips({ data, project, today = new Date().toISOString().slice(0, 10) }: { data: FactoryData; project: string; today?: string }) {
  const seen = new Set<string>(), out: { warn: boolean; text: string; title: string }[] = [];
  for (const [repo, x] of Object.entries(data.rules ?? {})) {
    if (project && repo !== project) continue;
    for (const e of [...Object.entries(x.policy ?? {}).map(([key, r]) => ({ ...r, key })), ...(x.expired ?? [])]) {
      const k = [e.scope, e.key, e.until].join('|'), label = LABEL[e.key ?? ''];
      if (seen.has(k) || !label) continue;
      seen.add(k);
      const until = /^\d{4}-\d{2}-\d{2}$/.test(e.until ?? '') ? e.until! : null;
      const gone = !!until && until < today, ending = !!until && !gone && Date.parse(until) - Date.parse(today) <= 3 * 864e5;
      const reason = String(e.reason ?? ''), short = reason.length > 30 ? reason.slice(0, 30).replace(/\s+\S*$/, '') + '…' : reason;
      const history = (data.ruleHistory ?? []).filter((h) => h.run === e.scope && h.key === e.key)
        .map((h) => `${String(h.ts).slice(0, 10)} ${h.status}${h.status === 'set' ? ' ' + JSON.stringify(h.value) : ''} by ${h.setBy}${h.reason ? ': ' + h.reason : ''}`);
      const text = (project ? '' : (e.scope === 'default' ? 'all' : shortId(String(e.scope))) + ': ') + (gone ? 'Expired: ' : '') + label(e.value) + (short ? ` · ${short}` : '') + (ending ? ` · ends ${until!.slice(5)}` : '');
      const title = `${e.key}=${JSON.stringify(e.value)} for ${e.scope === 'default' ? 'all projects' : e.scope}, set by ${e.setBy} on ${String(e.setAt).slice(0, 10)}: ${reason}` +
        (until ? `. Until ${until}` : '') + (gone ? '. Expired: no longer applied.' : '') + (history.length ? '\nHistory:\n' + history.join('\n') : '');
      out[gone || ending ? 'unshift' : 'push']({ warn: gone || ending, text, title }); // warnings first: never the one clipped
    }
  }
  if (data.rulesError) out.unshift({ warn: true, text: 'Rules config invalid', title: data.rulesError });
  if (!out.length) return null;
  return <div className="web-rules" role="group" aria-label="Active rules">{out.map((c, i) => <Badge key={i} tone={c.warn ? 'warn' : 'neutral'} quiet={!c.warn} title={c.title}>{c.text}</Badge>)}</div>;
}

/** Who changed which rule, when and why: the audit trail from `F rules set|unset`, newest first. */
export function RuleLog({ data, project }: { data: FactoryData; project: string }) {
  const h = (data.ruleHistory ?? []).filter((e) => !project || e.run === project || e.run === 'default').slice(-8).reverse();
  if (!h.length) return null;
  return (
    <section className="web-rlog" aria-label="Rule changes">
      <h2 className="sf-label">Rule changes</h2>
      <ul>
        {h.map((e, i) => (
          <li key={i}>
            <time dateTime={e.ts}>{formatClock(e.ts)}</time>
            <b>{e.status} {e.key}</b>{e.status === 'set' ? ` = ${JSON.stringify(e.value)}` : ''}
            {' · '}{e.run === 'default' ? 'all projects' : e.run}{' · by '}{e.setBy ?? '?'}{e.reason ? ` · ${e.reason}` : ''}{e.until ? ` · until ${e.until}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
