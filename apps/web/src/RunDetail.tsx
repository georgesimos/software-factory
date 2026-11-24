import {
  ArrowUpRightIcon, Badge, Button, Dot, MetricStat, OutcomePill, ReviewMatrix, STAGES, SessionList, SourceChip, type AgentSession, StageTrack, Timeline,
  burnText, costText, formatAgo, isDone, formatClock, formatDuration, formatMoney, formatTokens, outcomeOf, previewOf, repoOf, shortId, type Run,
} from '@software-factory/design-system';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { post } from './data.ts';
import { Cmd } from './Setup.tsx';

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="web-sec"><h3 className="sf-label">{title}</h3>{children}</section>
);
/** Only https links are rendered: run data comes from GitHub and local logs. */
const Ext = ({ url, children }: { url?: string; children: ReactNode }) =>
  /^https:\/\//.test(url ?? '') ? <a href={url} target="_blank" rel="noreferrer">{children} <ArrowUpRightIcon /></a> : null;

/** Measured burn wins over reported numbers, as gate.ts spent() does. */
export const spent = (r: Run) => r.burn?.total ?? { tokens: r.tokens, costUsd: r.costUsd };

function Decision({ run: r }: { run: Run }) {
  const o = outcomeOf(r);
  const last = (s: string) => (r.events ?? []).filter((e) => e.status === s).pop();
  const rejected = last('rejected');
  const decided = r.decision?.reasons;
  const [tone, head, reasons] =
    o === 'rejected' ? ['bad', 'Rejected at intake', rejected?.reason ? [rejected.reason] : rejected?.reasons]
    : o === 'needs-info' ? ['warn', 'Waiting on the reporter', last('needs-info')?.questions]
    : o === 'awaiting-approval' ? ['warn', 'Spec awaiting human approval', last('awaiting-approval')?.reasons]
    : o === 'split' ? ['idle', `Split into ${r.children?.length || 'several'} runs`, last('split')?.reasons]
    : o === 'merged' ? ['ok', 'Merged', decided]
    : o === 'escalated' ? ['warn', 'Escalated to a human', decided]
    : o === 'closed' ? ['idle', 'Closed', decided]
    : r.imported ? ['idle', 'Tracked, not driven', ['The factory will not build or merge it.']]
    : r.decision ? (r.decision.action === 'merge' ? ['run', 'Merging', decided] : ['warn', 'Escalating', decided])
    : [null, 'No decision yet', []];
  if (!tone) return <p className="sf-muted">{head}.</p>;
  const list = (reasons ?? []).filter(Boolean);
  return (
    <>
      <div className="web-verdict"><Dot tone={tone as 'ok'} />{head}</div>
      {list.length ? <ul className="web-reasons">{list.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
      {/* Approval is never taken from the page (#21): an escalated run is reviewed and merged on GitHub. */}
      {o === 'escalated' && /^https:\/\//.test(r.pr ?? '') ? <p className="web-links"><Ext url={r.pr}>Review and merge on GitHub</Ext></p> : null}
      {r.reverted ? (
        <div className="web-callout">
          <b>Reverted</b>{r.reverted.reason ? ` · ${r.reverted.reason}` : null}
          {/^https:\/\//.test(r.reverted.pr ?? '') ? <> · <a href={r.reverted.pr} target="_blank" rel="noreferrer">revert PR</a></> : null}
        </div>
      ) : null}
    </>
  );
}

function Burn({ run: r }: { run: Run }) {
  const b = r.burn;
  if (!b?.total.tokens) return null;
  const by = b.byStage ?? {}, parts = STAGES.filter((s) => (by[s]?.tokens ?? 0) > 0);
  const iters = Object.keys(b.byIteration ?? {}).sort((x, y) => Number(x) - Number(y));
  const note = [b.measured ? 'Measured from session transcripts' : 'Reported by subagents (other work not counted)',
    b.measured && b.reported ? `subagents reported ${formatTokens(b.reported.tokens)}` : null,
    b.total.unpriced ? `${formatTokens(b.total.unpriced)} on unpriced models` : null].filter(Boolean).join(' · ');
  return (
    <Section title="Burn">
      <div className="web-burn-h"><span className="web-v">{formatTokens(b.total.tokens)} tokens</span><span>{costText(b.total)}</span>
        <Badge tone={b.measured ? 'run' : 'neutral'} quiet={!b.measured}>{b.measured ? 'Measured' : 'Reported'}</Badge></div>
      <p className="sf-muted web-burn-src">{note}</p>
      <div className="web-burn-bar" role="img" aria-label={'Tokens by stage: ' + parts.map((s) => `${s} ${formatTokens(by[s]!.tokens)}`).join(', ')}>
        {parts.map((s) => <i key={s} data-stage={s} style={{ flex: by[s]!.tokens } as CSSProperties} />)}
      </div>
      <ul className="web-burn-legend">{parts.map((s) => <li key={s}><span className="web-sw" data-stage={s} aria-hidden="true" /><b>{s}</b> {burnText(by[s]!)}</li>)}</ul>
      {iters.length > 1 ? (
        <ul className="web-burn-iters" aria-label="Tokens by iteration">
          {iters.map((i) => <li key={i}><span>{i === '0' ? 'Before build' : `Iteration ${i}`}</span><span>{burnText(b.byIteration![i]!)}</span></li>)}
        </ul>
      ) : null}
    </Section>
  );
}

/** Environments per connector: the latest state of each, newest first. */
function Deploys({ run: r }: { run: Run }) {
  if (!r.deploys?.length) return null;
  const by = new Map<string, NonNullable<Run['deploys']>>();
  for (const d of r.deploys.slice().sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0))) by.set(d.connector!, [...(by.get(d.connector!) ?? []), d]);
  return (
    <Section title="Deploy">
      {[...by].map(([name, list]) => (
        <div key={name} className="web-group">
          <div className="sf-label">{name}</div>
          <ul className="web-kids">
            {list.map((d, i) => (
              <li key={i} className="web-kid">
                <span className="web-mono">{d.env}</span><span className="web-t" title={d.detail}>{d.detail || (d.at ? formatAgo(d.at) : '')}</span>
                {d.sha ? <span className="web-mono" title={d.sha}>{d.sha.slice(0, 7)}</span> : null}
                <span className="web-links"><Ext url={d.url}>Open</Ext></span>
                <Badge tone={d.status === 'passed' ? 'ok' : d.status === 'failed' ? 'bad' : 'neutral'}>{d.state}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

function Epic({ run: r, find, href }: { run: Run; find: (id: string) => Run | undefined; href: (id: string) => string }) {
  if (!r.parent && !r.children?.length) return null;
  const row = (id: string) => {
    const c = find(id);
    const kids = <><span className="web-mono">{shortId(id)}</span><span className="web-t">{c ? c.title : 'not tracked'}</span>{c ? <OutcomePill outcome={outcomeOf(c)} reverted={!!c.reverted} /> : null}</>;
    return <li key={id} className="web-kid">{c ? <a href={href(id)}>{kids}</a> : kids}</li>;
  };
  return (
    <Section title="Epic">
      {r.parent ? <div className="web-group"><div className="sf-label">Part of</div><ul className="web-kids">{row(String(r.parent))}</ul></div> : null}
      {r.children?.length ? <div className="web-group"><div className="sf-label">Split into</div><ul className="web-kids">{r.children.map((c) => row(String(c)))}</ul></div> : null}
    </Section>
  );
}

// claude-cli://open: a new Claude Code terminal in the run's worktree (else the latest session's cwd), prompt pre-filled, not sent.
// The handler refuses relative paths, "..", network paths and control/bidi characters; refuse them here too.
const deepCwd = (p: unknown): p is string => typeof p === 'string' && /^(\/(?!\/)|[A-Za-z]:\\)/.test(p) && !p.includes('..') && !/[\p{Cc}\p{Cf}]/u.test(p);
// A run driven from the Claude desktop app opens that session there (#26): F recorded its local_<uuid> with the events.
const HOST_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function openInClaude(r: Run) {
  const last = (r.sessions ?? []).slice().sort((a, b) => (a.last ?? '').localeCompare(b.last ?? '')).at(-1); // the session that drove it most recently
  const host = last?.agent === 'claude-code' && last.hostId && HOST_ID.test(last.hostId) ? last.hostId : undefined;
  if (host) return `claude://claude.ai/epitaxy/${host}`;
  const cwd = [r.worktree, ...(r.sessions ?? []).map((s) => s.cwd)].find(deepCwd);
  if (!cwd || !/^[\w.-]+\/[\w.-]+(#\d+|:[\w./-]+)$/.test(r.id)) return null; // owner/repo#N or an import's owner/repo:branch; it goes into a prompt that runs F
  const q = `Continue factory run ${r.id}. Run F state '${r.id}' first.`;
  if (encodeURIComponent(q).length >= 5000) return null;
  return 'claude-cli://open?' + Object.entries({ cwd, q }).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

// An active run the factory still owns: continue it. Escalated and rejected runs belong to a human, approval stays human-only.
const startable = (r: Run) => !r.imported && !r.archived && /^[\w.-]+\/[\w.-]+#\d+$/.test(r.id) && ['in-progress', 'needs-info'].includes(outcomeOf(r));
export type StartState = { text: string; bad?: boolean; busy?: boolean };
/** Under F ui, for a run whose session here stopped or crashed: POST /api/sessions resumes it headless. */
export type Resume = { go: () => void; state?: StartState };
function Start({ run: r, resume, token }: { run: Run; resume?: Resume; token?: string }) {
  const [own, setOwn] = useState<StartState>();
  if (!resume && !token) return <Cmd cmd={`/software-factory ${r.id}`} />; // the static page: the Claude Code prompt to paste
  // Under F ui, an active run that isn't listed as resumable: F start (POST /api/runs). Whether a session or claim still
  // holds it is the server's call, and its refusal says why ("active run…", "already has a running session…", "F unclaim…").
  const go = resume?.go ?? (async () => {
    if (!token) return;
    setOwn({ text: '', busy: true });
    try {
      const x = await post<{ pid?: number }>('/runs', { issue: r.id }, token);
      setOwn({ text: `Started headless (pid ${x.pid ?? '?'}). It shows here as it records its steps.` });
    } catch (e) { setOwn({ text: (e as Error).message, bad: true }); }
  });
  const st = resume ? resume.state : own, label = resume ? ['Resume factory', 'Resuming…'] : ['Start factory', 'Starting…'];
  return (
    <div className="web-start">
      {st && !st.busy && !st.bad ? null : /* started: the run is live again, so no second button */
        <Button size="sm" disabled={st?.busy} title={resume ? 'Its session here stopped: resume it headless in the attached clone' : 'Start it headless in the attached clone (F start)'} onClick={() => void go()}>{st?.busy ? label[1] : label[0]}</Button>}
      <p className="web-sk-status" role="status" data-bad={st?.bad || undefined}>{st?.busy ? '' : st?.text}</p>
    </div>
  );
}

type Note = NonNullable<Run['notes']>[number];
const NOTE_MAX = 1000; // core/src/notes.ts; the server refuses longer
/**
 * The user's notes for whatever step starts next (F note <run> next). Under F ui (a token) a box records one; the static
 * dashboard lists them read-only. Note text is shown as text, never HTML.
 */
function Notes({ run: r, token }: { run: Run; token?: string }) {
  const [text, setText] = useState(''), [added, setAdded] = useState<Note[]>([]), [st, setSt] = useState<{ text: string; bad?: boolean; busy?: boolean }>();
  const known = new Set((r.notes ?? []).map((n) => n.id)); // a note F already reports, pending or applied, replaces its local copy
  const pending = [...(r.notes ?? []).filter((n) => n.state === 'pending'), ...added.filter((n) => !known.has(n.id))];
  if (isDone(r)) return null; // finished: no next step will take a note, pending or new
  const open = !!token && !r.imported; // F refuses notes for imported runs
  if (!open && !pending.length) return null;
  const send = async () => {
    if (!token) return;
    setSt({ text: '', busy: true });
    try {
      const n = await post<Note & { warning?: string }>('/note', { run: r.id, text }, token);
      setAdded((a) => [...a, { ...n, state: 'pending' }]);
      setText('');
      setSt({ text: n.warning || 'Noted: the next step to start takes it.' });
    } catch (e) {
      setSt({ text: (e as Error).message, bad: true });
    }
  };
  return (
    <Section title="Note for next step">
      <p className="web-sk-note">Applies from the next step or iteration, once: whichever step starts next reads it in its brief.</p>
      {pending.length ? (
        <ul className="web-notes" aria-label="Pending notes">
          {pending.map((n, i) => <li key={n.id ?? i}><p className="web-note-t">{n.text}</p><span className="sf-muted">{n.ts ? formatAgo(n.ts) : 'pending'}</span></li>)}
        </ul>
      ) : null}
      {open ? (
        <form className="web-note-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea className="sf-input web-ob-ta" aria-label="Note for the next step" maxLength={NOTE_MAX} placeholder="e.g. Keep the old endpoint until the client ships." value={text} onChange={(e) => setText(e.target.value)} />
          <div className="web-start">
            <Button size="sm" type="submit" disabled={st?.busy || !text.trim()}>{st?.busy ? 'Saving…' : 'Add note'}</Button>
            <p className="web-sk-status" role="status" data-bad={st?.bad || undefined}>{st?.busy ? '' : st?.text}</p>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

/**
 * Under F ui: opens a session in the Claude desktop app (POST /api/sessions/open, F open). With no desktop link the server
 * answers with the terminal resume command, shown to copy: nothing here launches a terminal. Only a Claude Code session can
 * have a desktop link, so other harnesses' rows say Resume.
 */
function OpenSession({ s, token }: { s: AgentSession; token: string }) {
  const [st, setSt] = useState<{ text: string; bad?: boolean; busy?: boolean; cmd?: string }>();
  const go = async () => {
    setSt({ text: '', busy: true });
    try {
      const x = await post<{ opened?: unknown; resume?: { command?: string; cwd?: string } }>('/sessions/open', { harness: s.agent, id: s.id }, token);
      const cmd = x.resume?.command;
      setSt(cmd ? { text: `No desktop link for this session. Resume it in a terminal${x.resume?.cwd ? ` in ${x.resume.cwd}` : ''}:`, cmd } : { text: 'Opened in the Claude app.' });
    } catch (e) { setSt({ text: (e as Error).message, bad: true }); }
  };
  return (
    <div className="web-start web-sopen">
      <Button size="sm" variant="ghost" disabled={st?.busy} onClick={() => void go()}>{st?.busy ? 'Opening…' : s.agent === 'claude-code' ? 'Open in Claude' : 'Resume…'}</Button>
      <p className="web-sk-status" role="status" data-bad={st?.bad || undefined}>{st?.busy ? '' : st?.text}</p>
      {st?.cmd ? <Cmd cmd={st.cmd} /> : null}
    </div>
  );
}
// The harness session ids this app is running now (GET /api/sessions), re-read on every poll (each one hands RunDetail a new
// run object): no Open for those. A detached F start isn't listed there; for it the server refuses on the run's live claim.
function useRunning(token: string | undefined, key: Run) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    if (!token) return;
    let off = false;
    fetch('/api/sessions', { headers: { 'x-factory-token': token } }).then((x) => (x.ok ? x.json() : null)).then((x: { sessions?: { state?: string; harnessSession?: string }[] } | null) => {
      if (!off) setIds((x?.sessions ?? []).filter((y) => y.state === 'running' && y.harnessSession).map((y) => String(y.harnessSession)));
    }, () => {}); // unknown: show the buttons; the server still refuses a resume while a claim is live
    return () => { off = true; };
  }, [token, key]);
  return ids;
}

export function RunDetail({ run: r, cap, costCap, now, find = () => undefined, href = (id) => '#' + encodeURIComponent(id), resume, token }:
  { run: Run; cap: number; costCap: number; now?: number; find?: (id: string) => Run | undefined; href?: (id: string) => string; resume?: Resume; token?: string }) {
  const d = formatDuration(r.durationMs ?? Date.parse(r.updated ?? '') - Date.parse(r.started ?? ''));
  const { costUsd, tokens } = spent(r), running = useRunning(token, r);
  const src = r.burn ? (r.burn.measured ? 'measured' : 'reported') : '';
  const repo = repoOf(r.id), open = openInClaude(r);
  const closes = /^[\w.-]+\/[\w.-]+$/.test(repo) ? (r.issues ?? []).filter((n) => Number.isInteger(n) && n > 0) : [];
  return (
    <article className="web-detail">
      <div className="web-d-bar">
        <OutcomePill outcome={outcomeOf(r)} reverted={!!r.reverted} />
        {r.imported ? <SourceChip source={r.source ?? 'none'} prefix="Tracked" /> : <SourceChip source="factory" />}
        {r.archived ? <Badge quiet>Archived</Badge> : null}
      </div>
      <h2 className="web-d-title" id="d-title" tabIndex={-1}>{r.title || r.branch || r.id}</h2>
      {r.spec ? <p className="web-d-spec">{r.spec}</p> : null}
      <div className="web-d-meta">
        {r.author ? <span>{r.author}{r.association ? ` · ${r.association.toLowerCase()}` : ''}</span> : null}
        {r.branch ? <span>⎇ {r.branch}</span> : null}
        {r.updated ? <span>updated {formatAgo(r.updated, now)}</span> : null}
      </div>
      <div className="web-links">
        {r.imported ? null : <Ext url={r.url}>Issue</Ext>}
        <Ext url={r.pr}>Pull request</Ext>
        <Ext url={previewOf(r)?.url}>Preview</Ext>
        {closes.map((n) => <Ext key={n} url={`https://github.com/${repo}/issues/${n}`}>Closes #{n}</Ext>)}
        {r.children?.length ? <Badge quiet>{r.children.length} runs</Badge> : null}
      </div>
      <Section title="Pipeline"><StageTrack run={r} /></Section>
      <Section title="Review"><ReviewMatrix run={r} /></Section>
      <Section title="Decision"><Decision run={r} /></Section>
      <Notes key={r.id} run={r} token={token} />
      <Section title="Run">
        <div className="web-facts">
          <MetricStat size="sm" label="Iterations" value={`${r.iteration ?? 0} / ${cap}`} sub={r.loopbacks?.length ? `${r.loopbacks.length} loop-back${r.loopbacks.length > 1 ? 's' : ''}` : 'no loop-backs'} />
          {costUsd != null ? <MetricStat size="sm" label="Cost" value={r.burn ? costText(r.burn.total) : formatMoney(costUsd)} {...(costCap > 0 ? { sub: `of ${formatMoney(costCap)} cap${src ? ` · ${src}` : ''}`, meter: costUsd / costCap } : {})} /> : null}
          {tokens != null ? <MetricStat size="sm" label="Tokens" value={formatTokens(tokens)} sub={src || undefined} /> : null}
          {d ? <MetricStat size="sm" label="Duration" value={d.join('')} sub={r.started ? `since ${formatClock(r.started, now)}` : undefined} /> : null}
        </div>
      </Section>
      <Burn run={r} />
      <Deploys run={r} />
      <Epic run={r} find={find} href={href} />
      {r.sessions?.length || open || startable(r) ? (
        <Section title="Sessions">
          {startable(r) ? <Start run={r} resume={resume} token={token} /> : null}
          {open ? <p className="web-links"><a href={open} title={open.startsWith('claude://') ? 'Opens its session in the Claude desktop app' : 'Opens a new Claude Code terminal here (prompt pre-filled, not sent). Requires the claude-cli handler: send one message in any interactive claude session first.'}>Open in Claude</a></p> : null}
          {r.sessions?.length ? <SessionList sessions={r.sessions} now={now} action={token ? (x) => (running.includes(x.id) ? null : <OpenSession key={x.id} s={x} token={token} />) : undefined} /> : null}
        </Section>
      ) : null}
      <Section title="Timeline"><Timeline events={r.events ?? []} archived={r.archived} now={now} /></Section>
    </article>
  );
}
