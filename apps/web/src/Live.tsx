import { Badge, Button, Dialog, Select, formatAgo } from '@software-factory/design-system';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { post } from './data.ts';

// Sessions this F ui (the desktop app) started, live (#58): factory runs (headless, sdk) and a person's own harness in a
// pseudo-terminal, shown with xterm.js. Start a terminal in an attached repo, stop any session, resume an exited one in a
// terminal, or open it in the Claude desktop app when the harness has a link for it.
export interface LiveSession { id: string; harness: string; mode: string; label: string; state: string; exit?: unknown; started: string; harnessSession?: string }
type Event = { type: string; data?: unknown; code?: unknown; message?: string };

/** A session's server-sent events, read with fetch: EventSource can't send the token. Returns a stop function. */
export function stream(id: string, token: string, on: (e: Event) => void): () => void {
  const ctl = new AbortController();
  (async () => {
    const res = await fetch(`/api/sessions/${id}/events`, { headers: { 'x-factory-token': token }, signal: ctl.signal });
    if (!res.ok || !res.body) return on({ type: 'error', message: `no event stream (${res.status})` });
    const read = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '', ended = false;
    for (;;) {
      const { value, done } = await read.read();
      if (done) { if (!ended) on({ type: 'error', message: 'the event stream ended' }); return; } // the server ends it after exit
      buf += value;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        let e: Event | undefined;
        try { e = data ? JSON.parse(data.slice(6)) as Event : undefined; } catch { /* one bad frame: skip it */ }
        if (e) { ended ||= e.type === 'exit'; on(e); }
      }
    }
  })().catch(() => { if (!ctl.signal.aborted) on({ type: 'error', message: 'the event stream broke off' }); });
  return () => ctl.abort();
}

export function TerminalPane({ session, token }: { session: LiveSession; token: string }) {
  const el = useRef<HTMLDivElement>(null);
  const live = session.state === 'running' && session.mode === 'terminal'; // headless and sdk read no keystrokes
  useEffect(() => {
    const css = getComputedStyle(document.documentElement), v = (k: string) => css.getPropertyValue(k).trim() || undefined;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: v('--sf-font-mono') ?? 'monospace', disableStdin: !live,
      theme: { background: v('--sf-color-sunken'), foreground: v('--sf-color-ink'), cursor: v('--sf-color-ink') } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el.current!);
    const send = (body: object) => { if (live) post('/sessions/input', { id: session.id, ...body }, token).catch(() => { /* exited meanwhile */ }); };
    const size = () => { try { fit.fit(); } catch { /* not laid out yet */ } send({ cols: term.cols, rows: term.rows }); };
    size();
    const keys = term.onData((data) => send({ data }));
    const ro = new ResizeObserver(size);
    ro.observe(el.current!);
    const stop = stream(session.id, token, (e) => {
      if (e.type === 'output' && typeof e.data === 'string') term.write(e.data);
      else if (e.type === 'event') term.write(`${JSON.stringify(e.data).slice(0, 400)}\r\n`); // headless and sdk: one line per event
      else if ((e.type === 'stderr' || e.type === 'text') && typeof e.data === 'string') term.write(`${e.data}\r\n`); // why a failed run failed
      else if (e.type === 'dropped') term.write('[earlier output was dropped]\r\n');
      else if (e.type === 'error') term.write(`\r\n[${e.message}]\r\n`);
      else if (e.type === 'exit') term.write(`\r\n[exited: ${String(e.code)}]\r\n`);
    });
    if (live) term.focus();
    return () => { stop(); ro.disconnect(); keys.dispose(); term.dispose(); };
  }, [session.id, token, live]);
  return <div className="web-term" ref={el} aria-label={`Terminal: ${session.label}`} />;
}

const repoAndIssue = (label: string) => { const [repo, n] = label.split('#'); return { repo: repo!, ...(n && { issue: Number(n) }) }; };

export function LiveSessions({ open, onClose, token, repos, terminal }: { open: boolean; onClose: () => void; token: string; repos: string[]; terminal?: boolean }) {
  const [list, setList] = useState<LiveSession[]>([]);
  const [shown, show] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [repo, setRepo] = useState(repos[0] ?? '');
  const load = () => fetch('/api/sessions', { headers: { 'x-factory-token': token } }).then((r) => r.json()).then((x: { sessions?: LiveSession[] }) => setList([...(x.sessions ?? [])].reverse()), () => {});
  useEffect(() => { if (!open) return; void load(); const t = setInterval(load, 3_000); return () => clearInterval(t); }, [open, token]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (route: string, body: object, done: string, resumable = false) => {
    setMsg(null);
    try {
      const x = await post<{ session?: string; resume?: { command: string; cwd?: string } }>(route, body, token);
      setMsg({ text: !x.resume ? done : resumable ? 'No desktop session for it: Resume continues it here.' // started outside the desktop app
        : `No desktop session for it: run ${x.resume.command} in a terminal${x.resume.cwd ? ` in ${x.resume.cwd}` : ''}.` });
      if (x.session) show(x.session);
      await load();
    }
    catch (e) { setMsg({ text: (e as Error).message, bad: true }); }
  };
  const cur = list.find((s) => s.id === shown), sel = repos.includes(repo) ? repo : repos[0] ?? ''; // repos may arrive after mount
  return (
    <Dialog open={open} onClose={onClose} variant="sheet" title="Sessions" className="web-live"
      description="Sessions this app started: factory runs and your own terminals. They stop when the app quits.">
      {terminal && repos.length ? (
        <div className="web-live-new">
          <Select aria-label="Repo" value={sel} onChange={(e) => setRepo(e.target.value)}>{repos.map((r) => <option key={r}>{r}</option>)}</Select>
          <Button size="sm" onClick={() => act('/sessions/terminal', { repo: sel }, `Terminal started in ${sel}.`)}>New terminal</Button>
        </div>
      ) : null}
      <p className="web-sk-status" role="status" data-bad={msg?.bad || undefined}>{msg?.text}</p>
      {list.length ? (
        <ul className="web-live-list">
          {list.map((s) => (
            <li key={s.id} aria-current={s.id === shown || undefined}>
              <span className="web-live-l"><b>{s.label || s.harness}</b> <Badge>{s.mode}</Badge> <span className="web-s">{s.state === 'running' ? 'running' : `exited ${String(s.exit)}`} · {formatAgo(s.started)}</span></span>
              <span className="web-live-acts">
                <Button size="sm" variant="ghost" onClick={() => show(s.id)}>Show</Button>
                {s.state === 'running' ? <Button size="sm" variant="ghost" onClick={() => act('/sessions/stop', { id: s.id }, `Stopped ${s.label}.`)}>Stop</Button> : null}
                {s.state !== 'running' && s.harnessSession && terminal ? <Button size="sm" variant="ghost" onClick={() => act('/sessions/terminal', { ...repoAndIssue(s.label), harness: s.harness, resume: s.harnessSession }, `Resumed ${s.label} in a terminal.`)}>Resume</Button> : null}
                {s.harnessSession ? <Button size="sm" variant="ghost" onClick={() => act('/sessions/open', { harness: s.harness, id: s.harnessSession }, 'Opened in the Claude app.', s.state !== 'running' && !!terminal)}>Open in Claude</Button> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="web-s">No sessions yet.{terminal ? '' : ' Terminals need the desktop app.'}</p>}
      {cur ? <TerminalPane key={`${cur.id}:${cur.state}`} session={cur} token={token} /> : null}
    </Dialog>
  );
}
