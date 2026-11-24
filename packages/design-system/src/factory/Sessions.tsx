import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '../components/Badge.tsx';
import { IconButton } from '../components/Button.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import { CheckIcon, CopyIcon } from '../components/icons.tsx';
import { formatAgo } from './model.ts';
import { SOURCE_LABEL } from './SourceChip.tsx';
import type { Session } from '@software-factory/core/types';

/** A local Claude Code / Codex session: core's Session (agent: the harness id, e.g. claude-code or codex; hostId: its Claude desktop app session). */
export type AgentSession = Session;

// Paths come from local logs: single-quote them for a POSIX shell, so $, `, \ and ! stay literal.
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Shell command that resumes the session, or null for an unknown agent or an odd id (never pasted into a shell). */
export function resumeCommand(s: AgentSession): string | null {
  if (!/^[\w.-]+$/.test(String(s.id))) return null;
  if (s.agent === 'codex') return `codex resume ${s.id}`;
  if (s.agent === 'claude-code') return `${s.cwd ? `cd ${shq(s.cwd)} && ` : ''}claude --resume ${s.id}`;
  return null;
}

const GLYPH: Record<string, string> = { 'claude-code': '●', codex: '■' };
const basename = (p?: string) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : undefined);

/** One session: agent, short id, when and where, and a button that copies the resume command. */
export function SessionLink({ session: s, now }: { session: AgentSession; now?: number }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  useEffect(() => { if (copied === 'idle') return; const t = setTimeout(() => setCopied('idle'), 1600); return () => clearTimeout(t); }, [copied]);
  const cmd = resumeCommand(s);
  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd!); setCopied('ok'); } catch { setCopied('failed'); }
  };
  const where = [s.last ? formatAgo(s.last, now) : null, basename(s.cwd)].filter(Boolean).join(' · ');
  return (
    <div className="sf-session">
      <span className="sf-session-agent"><i aria-hidden="true">{GLYPH[s.agent ?? ''] ?? '◇'}</i>{SOURCE_LABEL[s.agent ?? ''] ?? s.agent}</span>
      <code className="sf-session-id" title={s.id}>{s.id.slice(0, 8)}</code>
      {where ? <span className="sf-session-where" title={s.cwd}>{where}</span> : null}
      {cmd ? (
        <Tooltip content={<code className="sf-session-cmd">{cmd}</code>}>
          <IconButton size="sm" label={copied === 'ok' ? 'Copied resume command' : copied === 'failed' ? 'Copy failed: select the command in the tooltip' : 'Copy resume command'} onClick={copy}>
            {copied === 'ok' ? <CheckIcon /> : <CopyIcon />}
          </IconButton>
        </Tooltip>
      ) : null}
      <span className="sf-sr-only" aria-live="polite">{copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : ''}</span>
    </div>
  );
}

/** A run's sessions, most recent first. */
export function SessionList({ sessions, now, action }: { sessions: AgentSession[]; now?: number; /** Under the row, e.g. the app's "Open in Claude". */ action?: (s: AgentSession) => ReactNode }) {
  if (!sessions.length) return <p className="sf-muted">No local sessions on this branch.</p>;
  const sorted = sessions.slice().sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
  return <ul className="sf-sessions">{sorted.map((s) => <li key={`${s.agent}:${s.id}`}><SessionLink session={s} now={now} />{action?.(s)}</li>)}</ul>;
}

/** Compact "N sessions" chip for list rows and cards. */
export function SessionsChip({ sessions }: { sessions: AgentSession[] }) {
  if (!sessions.length) return null;
  const agents = [...new Set(sessions.map((s) => s.agent ?? ''))];
  return (
    <Badge quiet title={agents.map((a) => SOURCE_LABEL[a] ?? a).join(', ')}>
      <span className="sf-source-glyphs" aria-hidden="true">{agents.map((a) => <i key={a}>{GLYPH[a] ?? '◇'}</i>)}</span>
      {sessions.length} session{sessions.length === 1 ? '' : 's'}
    </Badge>
  );
}
