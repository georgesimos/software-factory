import { Badge, formatMoney, formatTokens, type Tone } from '@software-factory/design-system';
import type { CSSProperties, ReactNode } from 'react';
import type { Idea, IdeaIssue } from './data.ts';

// An F new project: phase, milestones, the next issue, project burn and the issues in dependency order.
type ChipTone = Tone | 'quiet';
const PHASE: Record<string, [string, ChipTone]> = { idea: ['Idea', 'quiet'], planned: ['Planned', 'quiet'], repo: ['Repo created', 'run'], issues: ['Issues created', 'run'], running: ['Loop running', 'run'], stopped: ['Loop stopped', 'warn'] };
const ISSUE: Record<string, ChipTone> = { merged: 'ok', escalated: 'warn', 'needs-info': 'warn', 'awaiting-approval': 'warn', rejected: 'bad', reverted: 'bad', 'in-progress': 'run', ready: 'run' };
const chip = (text: string, tone: ChipTone = 'quiet'): ReactNode => <Badge key={text} tone={tone === 'quiet' ? 'neutral' : tone} quiet={tone === 'quiet'}>{text}</Badge>;
const https = (u?: string) => (/^https:\/\//.test(u ?? '') ? u : undefined);
const Bar = ({ part = 0, whole = 0, tone }: { part?: number; whole?: number; tone?: string }) =>
  <div className="web-bar" data-tone={tone} aria-hidden="true"><i style={{ width: `${Math.min(100, whole > 0 ? (part / whole) * 100 : 0)}%` } as CSSProperties} /></div>;

export function IdeaPanel({ idea: p, has, href }: { idea: Idea; has: (id: string) => boolean; href: (id: string) => string }) {
  const issues = p.issues ?? [], byKey = new Map(issues.map((i) => [i.key, i]));
  const ref = (i: IdeaIssue) => {
    const t = i.run ? '#' + String(i.run).split('#').pop() : String(i.key ?? '');
    return i.run && has(i.run) ? <a className="web-k" href={href(i.run)}>{t}</a>
      : https(i.url) ? <a className="web-k" href={i.url} target="_blank" rel="noreferrer">{t}</a> : <span className="web-k">{t}</span>;
  };
  const [phase, tone] = PHASE[p.phase ?? ''] ?? [p.phase || 'Idea', 'quiet'];
  const name = p.repo.split('/').slice(1).join('/') || p.repo, merged = issues.filter((i) => i.state === 'merged').length;
  const loop = p.loop ?? {}, burn = p.burn ?? {}, nx = p.next;
  const nextS = loop.state === 'stopped' ? `Stopped: ${loop.reason ?? ''}` : loop.state === 'running' ? `Loop running · ${loop.picked ?? 0} of ${loop.maxIssuesPerSession ?? '?'} this session` : `factory continue ${p.repo}`;
  return (
    <section className="web-idea" aria-label={`Project ${p.repo}`}>
      <div className="web-idea-h">
        <span className="sf-label">Project</span>
        <h2>{https(p.remote?.url) ? <a href={p.remote!.url} target="_blank" rel="noreferrer">{name}</a> : name}</h2>
        <div className="web-chips">{[chip(phase, tone), p.stack ? chip(p.stack) : null, p.visibility ? chip(p.visibility) : null, p.dryRun && !p.remote ? chip('Dry run') : null]}</div>
      </div>
      {p.idea ? <p className="web-idea-q">“{p.idea}”</p> : null}
      {p.plan?.vision ? <p className="web-idea-v">{p.plan.vision}</p> : null}
      <div className="web-idea-g">
        <div>
          <div className="sf-label">Milestones</div>
          <ul className="web-ms">{(p.milestones ?? []).map((m, i) => <li key={i}><span>{m.name}</span><span className="web-n">{m.merged ?? 0} / {m.total ?? 0}</span><Bar part={m.merged} whole={m.total} tone={m.total && (m.merged ?? 0) >= m.total ? 'full' : undefined} /></li>)}</ul>
          <div className="web-s">{merged} of {issues.length} issues merged</div>
        </div>
        <div>
          <div className="sf-label">Next issue</div>
          <div className="web-v">{nx?.key ? <>{ref(nx)} {nx.title}</> : issues.length ? (merged === issues.length ? 'All issues merged' : 'Nothing ready') : 'No issues yet'}</div>
          <div className="web-s">{nextS}</div>
        </div>
        <div>
          <div className="sf-label">Project burn</div>
          <div className="web-v">{formatMoney(burn.usd ?? 0)} of {formatMoney(burn.budgetUsd ?? 0)}</div>
          <Bar part={burn.usd} whole={burn.budgetUsd} tone={burn.over ? 'over' : undefined} />
          <div className="web-s">{[burn.tokens ? `${formatTokens(burn.tokens)} tokens` : null, 'issue runs only'].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      {issues.length ? (
        <section className="web-order" aria-label="Dependency order">
          <h3 className="sf-label">Dependency order</h3>
          <ol>
            {issues.map((i, n) => (
              <li key={n}>
                {chip(i.state || 'planned', ISSUE[i.state ?? ''] ?? 'quiet')}{ref(i)}<span className="web-t" title={i.title}>{i.title}</span>
                {i.dependsOn?.length ? <span className="web-after">after {i.dependsOn.map((d) => { const x = byKey.get(d); return x?.run ? '#' + String(x.run).split('#').pop() : d; }).join(', ')}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </section>
  );
}
