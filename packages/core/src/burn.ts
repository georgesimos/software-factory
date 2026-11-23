// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addBurn, burnOf, finishBurn } from './derive.ts';
import { costOf } from './constants.ts';
import { io, readArchive, stateDir } from './log.ts';
import { ls } from './workspace.ts';

// ---------- measured burn: Claude Code transcripts of the sessions that recorded events ----------
export const projectsRoot = () => io.projects || path.join(os.homedir(), '.claude', 'projects');
export const usageFile = () => path.join(stateDir(), 'usage.json');
export const SUB_AXIS = /^\s*(code|security|ux|ui|seo|docs|[a-z][a-z0-9-]{0,30}(?=\s+review\b))\b/i; // built-ins, or any extra axis in "<axis> review RUN"
// Only token counts, message ids, times and model ids are kept, never message text. Re-reads only bytes appended since last time.
export function scanFile(file, prev) {
  let st;
  try { st = fs.statSync(file); } catch { return prev; } // transcript gone: keep what was measured
  if (prev && st.size === prev.size) return prev;
  const from = prev && st.size > prev.offset ? prev.offset : 0;
  const rows = from ? prev.rows : [];
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  const end = buf.lastIndexOf(10) + 1; // a half-written last line waits for the next scan
  for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.type === 'assistant' ? d.message : null, u = m?.usage;
    if (!u || typeof m.id !== 'string') continue;
    const row = (id, model, x) => {
      const w = x.cache_creation || {};
      const w5 = w.ephemeral_5m_input_tokens ?? (x.cache_creation_input_tokens || 0), w1 = w.ephemeral_1h_input_tokens || 0;
      const t = [x.input_tokens || 0, x.output_tokens || 0, x.cache_read_input_tokens || 0, w5, w1];
      if (t.some((n) => n > 0)) rows.push([d.timestamp, id, String(model || '?').slice(0, 64), ...t, u.speed === 'fast' ? 1 : 0]);
    };
    row(m.id, m.model, u);
    // Advisor-style calls bill another model inside the same message; top-level usage covers only the main model.
    (Array.isArray(u.iterations) ? u.iterations : []).forEach((x, i) => { if (x?.type !== 'message' && x?.model) row(`${m.id}:${i}`, x.model, x); });
  }
  let axis = prev?.axis;
  if (axis === undefined && /[\\/]subagents[\\/]/.test(file)) { // the Agent description names the axis (SKILL.md fixes the wording); only the label is kept
    try {
      const desc = String(JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description || '');
      axis = /^\s*verif/i.test(desc) ? 'verifier' : SUB_AXIS.exec(desc)?.[1].toLowerCase() || 'other';
    } catch { axis = 'other'; }
  }
  return { size: st.size, offset: from + end, rows, ...(axis ? { axis } : {}) };
}
// sessionId -> [{rows, axis, sub}] for every main and subagent transcript of the sessions that wrote events.
export function measure(events) {
  const ids = [...new Set(events.map((e) => e.sessionId).filter((s) => /^[\w-]+$/.test(s || '')))];
  if (!ids.length) return {};
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(usageFile(), 'utf8')); } catch { /* first measure */ }
  const files = (cache.files ||= {}), sessions = (cache.sessions ||= {});
  const before = JSON.stringify(cache);
  const root = projectsRoot(), out = {};
  for (const sid of ids) {
    const s = (sessions[sid] ||= { files: [] });
    if (!s.main || !fs.existsSync(s.main)) { // transcripts sit under the folder of the session's start cwd, which can differ from the event's cwd
      const d = ls(root).find((x) => fs.existsSync(path.join(root, x, `${sid}.jsonl`)));
      if (d) s.main = path.join(root, d, `${sid}.jsonl`);
    }
    if (s.main) {
      const subs = path.join(path.dirname(s.main), sid, 'subagents');
      s.files = [...new Set([s.main, ...s.files, ...ls(subs).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(subs, f))])];
    }
    out[sid] = s.files.map((f) => [f, (files[f] = scanFile(f, files[f]))]).filter(([, x]) => x).map(([f, x]) => ({ rows: x.rows, axis: x.axis, sub: f !== s.main }));
  }
  const text = JSON.stringify(cache);
  if (text !== before) { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(usageFile(), text); }
  return out;
}
// Gives each transcript message to one run and stage, from the session's factory events around it: after a "started"
// event, that stage; otherwise the stage the next event closes. Messages before a session's first event are not factory
// work; those after its last event wait for the next event to close their window. Each subagent transcript goes whole to the slot of its first message.
// shortcut: anything else the session does between two factory events counts too; drive one run per session if that skews it.
export function withMeasured(runs, events, by = measure(events)) {
  if (!Object.keys(by).length) return runs;
  const iter = {}, slots = {};
  // Archived runs keep stubs of their session events so their windows still close; their messages are then dropped (not in runs).
  const stubs = readArchive().flatMap((a) => (a.sessionEvents || []).map((e) => ({ ...e, run: a.id })));
  for (const e of [...events, ...stubs]) {
    if (e.stage === 'build' && e.status === 'started') iter[e.run] = (iter[e.run] || 0) + 1;
    if (e.sessionId && by[e.sessionId]) (slots[e.sessionId] ||= []).push({ t: Date.parse(e.ts), run: e.run, stage: e.stage, status: e.status, iteration: iter[e.run] || 0 });
  }
  const slot = (list, t) => {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t <= t) lo = mid + 1; else hi = mid; }
    const prev = list[lo - 1], next = list[lo];
    return !prev || !next ? null : prev.status === 'started' ? prev : next;
  };
  const got = {};
  for (const [sid, filesOf] of Object.entries(by)) {
    const list = (slots[sid] || []).sort((a, b) => a.t - b.t), seen = new Set();
    for (const f of filesOf) {
      const first = f.sub && f.rows.length ? slot(list, Math.min(...f.rows.map((x) => Date.parse(x[0])))) : null;
      for (const [ts, id, model, ...rest] of f.rows) {
        if (seen.has(id)) continue; // streaming writes one line per content block, all with the same usage
        seen.add(id);
        const at = f.sub ? first : slot(list, Date.parse(ts));
        if (!at || !runs[at.run] || runs[at.run].imported) continue; // the factory did not drive an imported run: sync's events only close windows
        const t = rest.slice(0, 5);
        addBurn((got[at.run] ||= burnOf()), { stage: at.stage, iteration: at.iteration, axis: f.sub ? f.axis : null }, t.reduce((s, n) => s + n, 0), costOf(model, t, rest[5]), t[2], model);
      }
    }
  }
  for (const [id, b] of Object.entries(got)) {
    const reported = runs[id].burn;
    finishBurn(b);
    runs[id].burn = { ...b, measured: true, byAxis: Object.keys(b.byAxis).length ? b.byAxis : reported?.byAxis || {}, reported: reported?.total || null };
  }
  return runs;
}
