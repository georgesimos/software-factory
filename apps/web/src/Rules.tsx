import { Badge, Tooltip, formatClock, shortId } from '@software-factory/design-system';
import { useLayoutEffect, useRef, useState } from 'react';
import { setByText, type FactoryData, type RuleChange } from './data.ts';

// Policy rules in force for the shown project(s), from `F rules set`. Quiet unless expired or ending within 3 days.
const LABEL: Record<string, (v: unknown) => string> = {
  ci: (v) => ({ skip: 'CI skipped', advisory: 'CI advisory', required: 'CI required' } as Record<string, string>)[String(v)] ?? `CI ${v}`,
  'checks.commands': (v) => `Local checks ×${Array.isArray(v) ? v.length : 0}`, diffCap: (v) => `Diff cap ${v}`,
  'project.budgetUsd': (v) => `Project budget $${v}`, 'project.maxIssuesPerSession': (v) => `${v} issues / session`,
  'deploy.preview': (v) => ({ required: 'Preview required', advisory: 'Preview advisory', off: 'Preview off' } as Record<string, string>)[String(v)] ?? `Preview ${v}`,
  artifact: () => 'Publishes to Artifact',
};

/** How many leading chips fit in `avail` px. When not all do, room is kept for the +N chip (`more` px wide). */
export function fitCount(widths: number[], avail: number, gap: number, more: number): number {
  if (widths.reduce((a, w, i) => a + w + (i ? gap : 0), 0) <= avail) return widths.length;
  let used = more, n = 0;
  for (const w of widths) { if (used + gap + w > avail) break; used += gap + w; n++; }
  return n;
}

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
        .map((h) => `${String(h.ts).slice(0, 10)} ${h.status}${h.status === 'set' ? ' ' + JSON.stringify(h.value) : ''} by ${setByText(h)}${h.reason ? ': ' + h.reason : ''}`);
      const text = (project ? '' : (e.scope === 'default' ? 'all' : shortId(String(e.scope))) + ': ') + (gone ? 'Expired: ' : '') + label(e.value) + (short ? ` · ${short}` : '') + (ending ? ` · ends ${until!.slice(5)}` : '');
      const title = `${e.key}=${JSON.stringify(e.value)} for ${e.scope === 'default' ? 'all projects' : e.scope}, set by ${setByText(e)} on ${String(e.setAt).slice(0, 10)}: ${reason}` +
        (until ? `. Until ${until}` : '') + (gone ? '. Expired: no longer applied.' : '') + (history.length ? '\nHistory:\n' + history.join('\n') : '');
      out[gone || ending ? 'unshift' : 'push']({ warn: gone || ending, text, title }); // warnings first: never the one clipped
    }
  }
  if (data.rulesError) out.unshift({ warn: true, text: 'Rules config invalid', title: data.rulesError });
  // One row: the chips that fit, then a +N chip naming the rest. Widths come from a hidden copy of every chip, so the
  // count never feeds back into the width it is measured against.
  const box = useRef<HTMLDivElement>(null), probe = useRef<HTMLDivElement>(null), [fit, setFit] = useState(Infinity);
  const sig = out.map((c) => c.text).join('\n');
  useLayoutEffect(() => {
    const el = box.current, pr = probe.current;
    if (!el || !pr) return;
    const measure = () => {
      const w = [...pr.children].map((c) => c.getBoundingClientRect().width), more = w.pop() ?? 0;
      setFit(fitCount(w, el.clientWidth, parseFloat(getComputedStyle(pr).columnGap) || 0, more));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el); ro.observe(pr); // the probe resizes when the web font arrives
    return () => ro.disconnect();
  }, [sig]);
  if (!out.length) return null;
  const n = Math.max(fit, 1), shown = out.slice(0, n), rest = out.slice(n), warn = rest.some((c) => c.warn); // the first chip always shows, ellipsized if it must
  const tip = (t: string) => <span className="web-rule-tip">{t}</span>;
  return (
    <div className="web-rules">
      <div className="web-rules-row" ref={box} role="group" aria-label="Active rules">
        {shown.map((c, i) => <Tooltip key={i} content={tip(c.title)}><Badge tabIndex={0} tone={c.warn ? 'warn' : 'neutral'} quiet={!c.warn}>{c.text}</Badge></Tooltip>)}
        {rest.length ? (
          <Tooltip content={tip(rest.map((c) => c.title).join('\n\n'))}>
            <button type="button" className="sf-badge web-rules-more" data-tone={warn ? 'warn' : 'neutral'} data-quiet={warn ? undefined : true}
              aria-label={`${rest.length} more rule${rest.length > 1 ? 's' : ''}: ${rest.map((c) => c.text).join('; ')}`}>+{rest.length}</button>
          </Tooltip>
        ) : null}
      </div>
      <div className="web-rules-probe" ref={probe} aria-hidden="true">{out.map((c, i) => <Badge key={i}>{c.text}</Badge>)}<Badge>+{out.length}</Badge></div>
    </div>
  );
}

/** Who changed which rule, when and why: the audit trail from `F rules set|unset`, newest first. */
export function RuleLog({ data, project, keep }: { data: FactoryData; project: string; keep?: (e: RuleChange) => boolean }) {
  const h = (data.ruleHistory ?? []).filter(keep ?? ((e) => !project || e.run === project || e.run === 'default')).slice(-8).reverse();
  if (!h.length) return null;
  return (
    <section className="web-rlog" aria-label="Rule changes">
      <h2 className="sf-label">Rule changes</h2>
      <ul>
        {h.map((e, i) => (
          <li key={i}>
            <time dateTime={e.ts}>{formatClock(e.ts)}</time>
            <b>{e.status} {e.key}</b>{e.status === 'set' ? ` = ${JSON.stringify(e.value)}` : ''}
            {' · '}{e.run === 'default' ? 'all projects' : e.run}{' · by '}{setByText(e)}{e.reason ? ` · ${e.reason}` : ''}{e.until ? ` · until ${e.until}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
